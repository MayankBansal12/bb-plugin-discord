import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client, Events } from "discord.js";
import { createJiti } from "jiti";
import type { BbPluginApi } from "@bb/plugin-sdk";

const jiti = createJiti(import.meta.url, {
  alias: { "@bb/plugin-sdk": new URL("./test-fixtures/plugin-sdk.mjs", import.meta.url).pathname },
});
const { default: plugin } = await jiti.import<typeof import("./server.js")>("./server.ts");
const { DiscordClient } = await jiti.import<typeof import("./discord.js")>("./discord.ts");

type EventHandler = (event: unknown) => void | Promise<void>;
type Service = { start: (signal: AbortSignal) => Promise<void> };

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for mocked lifecycle work");
}

async function fixture(t: TestContext, sqlite = new DatabaseSync(":memory:")) {
  const events = new Map<string, EventHandler>();
  const services = new Map<string, Service>();
  const disposers: Array<() => Promise<void>> = [];
  const controllers: AbortController[] = [];
  const running: Promise<void>[] = [];
  const replies: string[] = [];
  const configurationErrors: string[] = [];
  const outputEvents: Array<{ id: string; seq: number; createdAt: number; type: string; data: unknown }> = [];
  let gateway: InstanceType<typeof DiscordClient> | undefined;
  let failingSends = false;
  let currentTime = 1000;
  let rpc: Record<string, (...args: never[]) => Promise<unknown>>;
  const thread = { id: "bb-1", parentThreadId: null, status: "idle", updatedAt: currentTime };
  t.mock.method(DiscordClient.prototype, "login", async function (this: InstanceType<typeof DiscordClient>) {
    gateway = this;
    (this as unknown as { client: Client }).client.emit(Events.ClientReady,
      { user: { tag: "synthetic-test-bot" } } as Client<true>);
  });
  t.mock.method(DiscordClient.prototype, "sendMessage", async () => {});
  t.mock.method(DiscordClient.prototype, "sendTyping", async () => {});
  t.mock.method(DiscordClient.prototype, "sendReplyChunk", async (_guild: string, channel: string, text: string) => {
    assert.equal(channel, "session-1", "final output must target the mapped thread");
    if (failingSends) throw new Error("simulated outage");
    replies.push(text);
  });
  const db = {
    prepare: (sql: string) => sqlite.prepare(sql),
    transaction: (operation: () => void) => () => {
      sqlite.exec("BEGIN");
      try { operation(); sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const bb = {
    pluginId: "discord",
    storage: {
      database: () => db,
      migrate: (_db: unknown, migrations: string[]) => {
        const applied = sqlite.prepare("PRAGMA user_version").get()!.user_version as number;
        for (const sql of migrations.slice(applied)) sqlite.exec(sql);
        sqlite.exec(`PRAGMA user_version = ${migrations.length}`);
      },
    },
    settings: { define: () => ({ get: async () => ({ botToken: "synthetic-token" }), onChange: () => {} }) },
    realtime: { publish: () => {} },
    rpc: { register: (_contract: unknown, handlers: typeof rpc) => { rpc = handlers; } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    agents: { registerTool: () => {}, configure: () => {} },
    events: { on: (key: string, handler: EventHandler) => events.set(key, handler) },
    cli: { register: () => {} },
    background: { service: (key: string, service: Service) => services.set(key, service), schedule: () => {} },
    onDispose: (fn: () => Promise<void>) => disposers.push(fn),
    status: { needsConfiguration: (message: string) => configurationErrors.push(message) },
    sdk: {
      projects: { list: async () => [] }, hosts: { list: async () => [] },
      system: { config: async () => ({ primaryHostId: null }) },
      providers: { models: async () => ({ providers: [], models: [], permissionCeiling: "auto" }) },
      threads: {
        get: async () => ({ ...thread }),
        interactions: { list: async () => [] },
        events: { list: async ({ beforeSeq }: { beforeSeq?: string }) =>
          [...outputEvents].filter((event) => !beforeSeq || event.seq < Number(beforeSeq)).reverse().slice(0, 100) },
      },
    },
  } as unknown as BbPluginApi;
  await plugin(bb);
  sqlite.prepare("INSERT OR IGNORE INTO discord_pairing (id,guild_id,channel_id,user_id,paired_at) VALUES (1,?,?,?,?)")
    .run("guild-1", "home-1", "user-1", 1);
  sqlite.prepare(`INSERT OR IGNORE INTO discord_threads
    (discord_channel_id,discord_thread_id,discord_parent_channel_id,guild_id,bb_thread_id,created_at,last_activity_at)
    VALUES (?,?,?,?,?,?,?)`).run("session-1", "session-1", "parent-1", "guild-1", "bb-1", 1, 1);
  const start = (name: string) => {
    const controller = new AbortController(); controllers.push(controller);
    running.push(services.get(name)!.start(controller.signal));
  };
  const connect = async () => {
    start("discord-gateway");
    await until(() => gateway?.isReady() === true);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const close = async () => {
    for (const controller of controllers) controller.abort();
    await Promise.all(running);
    for (const dispose of disposers) await dispose();
  };
  t.after(close);
  return {
    sqlite, replies, configurationErrors, start, connect, close,
    failSends: (value: boolean) => { failingSends = value; },
    unpair: () => rpc.unpair!(),
    deleteThread: () => events.get("thread.deleted")!({ thread: { ...thread } }),
    gatewayEvent: (code: number) => {
      (gateway as unknown as { client: Client }).client.emit(Events.ShardDisconnect,
        { code, reason: "", wasClean: true }, 0);
    },
    reconnect: () => {
      const internal = (gateway as unknown as { client: Client }).client;
      internal.emit(Events.ShardReconnecting, 0);
      internal.emit(Events.ShardReady, 0, undefined);
    },
    complete: async (text: string) => {
      currentTime += 10; thread.status = "active"; thread.updatedAt = currentTime;
      await events.get("thread.active")!({ thread: { ...thread } });
      currentTime += 10; thread.status = "idle"; thread.updatedAt = currentTime;
      outputEvents.push({ id: `output-${currentTime}`, seq: currentTime, createdAt: currentTime,
        type: "item/completed", data: { item: { type: "agentMessage", text } } });
      await events.get("thread.idle")!({ thread: { ...thread }, lastAssistantText: text });
    },
    duplicateIdle: (text: string) => events.get("thread.idle")!({ thread: { ...thread }, lastAssistantText: text }),
  };
}

test("server relays identical answers from distinct turns once per stored output", async (t) => {
  const h = await fixture(t); await h.connect();
  await h.complete("Done."); await h.duplicateIdle("Done."); await h.complete("Done.");
  await h.complete("Aa"); await h.complete("BB");
  assert.deepEqual(h.replies, ["Done.", "Done.", "Aa", "BB"]);
});

test("server reconnect replays a final reply whose send failed", async (t) => {
  const h = await fixture(t); await h.connect(); h.failSends(true);
  await h.complete("Finished during outage."); assert.equal(h.replies.length, 0);
  h.failSends(false); h.reconnect();
  await until(() => h.replies.length === 1);
  assert.deepEqual(h.replies, ["Finished during outage."]);
});

test("server restart delivers an idle thread's queued answer", async (t) => {
  const first = await fixture(t); await first.connect(); first.failSends(true);
  await first.complete("Persist me."); await first.close(); t.mock.restoreAll();
  const restarted = await fixture(t, first.sqlite); await restarted.connect();
  await until(() => restarted.replies.length === 1);
  assert.deepEqual(restarted.replies, ["Persist me."]);
});

test("server captures completed output before the gateway has connected", async (t) => {
  const h = await fixture(t);
  await h.complete("Completed offline."); assert.equal(h.replies.length, 0);
  await h.connect(); await until(() => h.replies.length === 1);
  assert.deepEqual(h.replies, ["Completed offline."]);
});

test("unpair removes queued replies so reconnect cannot deliver them", async (t) => {
  const h = await fixture(t); await h.connect(); h.failSends(true);
  await h.complete("Do not send after unpair."); await h.unpair();
  h.failSends(false); h.reconnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.replies.length, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM discord_reply_outbox").get()!.count, 0);
});

test("thread deletion removes queued replies before waiting for its Discord notice", async (t) => {
  const h = await fixture(t); await h.connect(); h.failSends(true);
  await h.complete("Do not send after deletion.");
  assert.equal(h.replies.length, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM discord_reply_outbox").get()!.count, 1);
  h.failSends(false);

  let finishNotice: () => void = () => {};
  const pendingNotice = new Promise<void>((resolve) => { finishNotice = resolve; });
  let noticeStarted = false;
  t.mock.method(DiscordClient.prototype, "sendMessage", async (_guild: string, channel: string, text: string) => {
    assert.equal(channel, "session-1");
    assert.match(text, /linked bb thread was deleted/);
    noticeStarted = true;
    await pendingNotice;
  });

  const deleting = h.deleteThread();
  try {
    assert.equal(noticeStarted, true);
    h.reconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.replies, [], "a reconnect must not deliver output from a deleted thread");
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM discord_reply_outbox").get()!.count, 0);
  } finally {
    finishNotice();
    await deleting;
  }
});

test("post-login fatal gateway errors leave the supervisor in needs-configuration", async (t) => {
  const h = await fixture(t); await h.connect(); h.gatewayEvent(4014);
  await until(() => h.configurationErrors.length > 0);
  assert.match(h.configurationErrors[0]!, /Message Content Intent/);
});

test("reply service retries a REST outage without requiring a gateway reconnect", async (t) => {
  const h = await fixture(t); await h.connect(); h.failSends(true);
  await h.complete("Retry while the gateway stays connected.");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.start("discord-replies");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.replies.length, 0);
  h.failSends(false); t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.replies, ["Retry while the gateway stays connected."]);
});
