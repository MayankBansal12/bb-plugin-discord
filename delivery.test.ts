import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { ReplyOutbox, resolveReplyOutputId, type PendingReply, type OutputEvent } from "./delivery.js";
import { migrations } from "./migrations.js";
import { clearStoredPairingState } from "./pairing.js";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const sql of migrations) sqlite.exec(sql);
  const db = {
    prepare: (sql: string) => sqlite.prepare(sql),
    transaction: (fn: () => void) => () => {
      sqlite.exec("BEGIN");
      try { fn(); sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as ReturnType<BbPluginApi["storage"]["database"]>;
  const sent: Array<{ threadId: string; text: string; nonce: string }> = [];
  const errors: unknown[] = [];
  const state = { connected: true, authorized: true, failAt: Infinity, identityAvailable: true };
  const make = () => new ReplyOutbox({
    db,
    isConnected: () => state.connected,
    isAuthorized: () => state.authorized,
    resolveOutputId: async (reply) => {
      if (!state.identityAvailable) throw new Error("BB unavailable");
      return `output-${reply.idleAt}`;
    },
    sendChunk: async ({ bbThreadId }, text, nonce) => {
      if (sent.length === state.failAt) throw new Error("Discord unavailable");
      sent.push({ threadId: bbThreadId, text, nonce });
    },
    onError: (_, error) => errors.push(error),
  });
  return { sqlite, db, state, sent, errors, make };
}
const reply = (idleAt: number, text = "Done.", bbThreadId = "bb-1"): PendingReply => ({
  bbThreadId, guildId: "guild-1", channelId: "channel-1", idleAt, text,
});

test("distinct output events deliver identical text and former hash collisions", async () => {
  const h = setup();
  const outbox = h.make();
  for (const [index, text] of ["Done.", "Done.", "Aa", "BB"].entries()) {
    outbox.enqueue(reply(index, text));
    outbox.enqueue(reply(index, text));
  }
  await Promise.all([outbox.flush(), outbox.flush()]);
  assert.deepEqual(h.sent.map(({ text }) => text), ["Done.", "Done.", "Aa", "BB"]);
  assert.equal(new Set(h.sent.map(({ nonce }) => nonce)).size, 4);
  assert.ok(h.sqlite.prepare("SELECT chunks_json FROM discord_reply_outbox").all()
    .every((row) => row.chunks_json === "[]"));
  await outbox.dispose(); h.sqlite.close();
});

test("offline replies survive a new outbox instance and transient BB lookup failures", async () => {
  const h = setup(); h.state.connected = false; h.state.identityAvailable = false;
  const first = h.make(); first.enqueue(reply(1)); await first.flush();
  assert.equal(h.sent.length, 0); assert.equal(h.errors.length, 1);
  await first.dispose();
  const restarted = h.make(); h.state.connected = true; h.state.identityAvailable = true;
  await restarted.flush(); await restarted.flush();
  assert.deepEqual(h.sent.map(({ text }) => text), ["Done."]);
  await restarted.dispose(); h.sqlite.close();
});

test("partial replies resume after restart at the first unacknowledged chunk", async () => {
  const h = setup(); h.state.failAt = 1;
  const first = h.make(); const text = "a".repeat(4500);
  first.enqueue(reply(1, text)); await first.flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sqlite.prepare("SELECT next_chunk FROM discord_reply_outbox").get()!.next_chunk, 1);
  await first.dispose();
  const restarted = h.make(); h.state.failAt = Infinity;
  await restarted.flush();
  assert.equal(h.sent.length, 3); assert.equal(h.sent.map(({ text }) => text).join(""), text);
  await restarted.dispose(); h.sqlite.close();
});

test("failed replies preserve conversation order while other conversations make progress", async () => {
  const h = setup();
  const sent: string[] = []; let failing = true;
  const outbox = new ReplyOutbox({
    db: h.db, isConnected: () => true, isAuthorized: () => true,
    resolveOutputId: async ({ idleAt }) => String(idleAt),
    sendChunk: async ({ bbThreadId }, text) => {
      if (bbThreadId === "bb-1" && failing) throw new Error("outage");
      sent.push(text);
    }, onError: () => {},
  });
  outbox.enqueue(reply(1, "first")); outbox.enqueue(reply(2, "second"));
  outbox.enqueue(reply(3, "other", "bb-2")); await outbox.flush();
  assert.deepEqual(sent, ["other"]);
  failing = false; await outbox.flush(); assert.deepEqual(sent, ["other", "first", "second"]);
  await outbox.dispose(); h.sqlite.close();
});

test("a duplicate idle snapshot for one stored output never resends it", async () => {
  const h = setup();
  const outbox = new ReplyOutbox({
    db: h.db, isConnected: () => true, isAuthorized: () => true,
    resolveOutputId: async () => "same-output-event", sendChunk: async (_, text, nonce) => {
      h.sent.push({ threadId: "bb-1", text, nonce });
    }, onError: () => {},
  });
  outbox.enqueue(reply(1)); await outbox.flush();
  outbox.enqueue(reply(2)); await outbox.flush(); assert.equal(h.sent.length, 1);
  await outbox.dispose(); h.sqlite.close();
});

test("unpair during output lookup prevents pending content from being sent", async () => {
  const h = setup();
  const outbox = new ReplyOutbox({
    db: h.db, isConnected: () => true, isAuthorized: () => true,
    resolveOutputId: async () => { clearStoredPairingState(h.db); return "output"; },
    sendChunk: async () => { assert.fail("unpaired content must not be sent"); }, onError: () => {},
  });
  outbox.enqueue(reply(1)); await outbox.flush();
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM discord_reply_outbox").get()!.count, 0);
  await outbox.dispose(); h.sqlite.close();
});

test("revoked mappings cannot receive a queued answer", async () => {
  const h = setup(); const outbox = h.make(); outbox.enqueue(reply(1));
  h.state.authorized = false; await outbox.flush(); assert.equal(h.sent.length, 0);
  h.state.authorized = true; await outbox.flush(); assert.equal(h.sent.length, 0);
  await outbox.dispose(); h.sqlite.close();
});

test("lost acknowledgements reuse the same Discord nonce", async () => {
  const h = setup(); const attempts: string[] = [];
  const outbox = new ReplyOutbox({
    db: h.db, isConnected: () => true, isAuthorized: () => true,
    resolveOutputId: async () => "output", sendChunk: async (_, __, nonce) => {
      attempts.push(nonce); if (attempts.length === 1) throw new Error("lost response");
    }, onError: () => {},
  });
  outbox.enqueue(reply(1)); await outbox.flush(); await outbox.flush();
  assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]);
  await outbox.dispose(); h.sqlite.close();
});

test("output lookup uses the stored event ID at the idle snapshot, not text identity", async () => {
  const event = (id: string, seq: number, createdAt: number): OutputEvent => ({
    id, seq, createdAt, type: "item/completed", data: { item: { type: "agentMessage", text: "Done." } },
  });
  const events = [event("later", 3, 30), event("this-turn", 2, 20), event("earlier", 1, 10)];
  assert.equal(await resolveReplyOutputId(reply(20), async () => events), "this-turn");
  assert.equal(await resolveReplyOutputId(reply(30), async () => events), "later");
  await assert.rejects(() => resolveReplyOutputId(reply(5), async () => events), /remains queued/);
});

test("output lookup pages past tools and supports BB manager messages", async () => {
  const pages: Array<string | undefined> = [];
  const output = await resolveReplyOutputId(reply(1000), async (beforeSeq) => {
    pages.push(beforeSeq);
    return beforeSeq ? [{ id: "manager-output", seq: 1, createdAt: 1,
      type: "system/manager/user_message", data: { text: "Done." } }]
      : Array.from({ length: 100 }, (_, i) => ({ id: `tool-${i}`, seq: 101 - i,
        createdAt: 1, type: "item/completed", data: { item: { type: "commandExecution" } } }));
  });
  assert.equal(output, "manager-output"); assert.deepEqual(pages, [undefined, "2"]);
});

test("a full batch of blocked replies cannot starve a later conversation", async () => {
  const h = setup(); const sent: string[] = [];
  const outbox = new ReplyOutbox({
    db: h.db, isConnected: () => true, isAuthorized: () => true,
    resolveOutputId: async ({ idleAt }) => String(idleAt),
    sendChunk: async ({ bbThreadId }, text) => {
      if (bbThreadId === "bb-1") throw new Error("outage");
      sent.push(text);
    }, onError: () => {},
  });
  for (let index = 0; index < 101; index += 1) outbox.enqueue(reply(index, `blocked-${index}`));
  outbox.enqueue(reply(102, "other conversation", "bb-2"));
  await outbox.flush(); await outbox.flush();
  assert.deepEqual(sent, ["other conversation"]);
  await outbox.dispose(); h.sqlite.close();
});

test("disposal during a send prevents later chunks and preserves unacknowledged progress", async () => {
  const h = setup(); let finish: () => void = () => {}; let started = false;
  const outbox = new ReplyOutbox({
    db: h.db, isConnected: () => true, isAuthorized: () => true,
    resolveOutputId: async () => "output",
    sendChunk: async () => { started = true; await new Promise<void>((resolve) => { finish = resolve; }); },
    onError: () => {},
  });
  outbox.enqueue(reply(1, "x".repeat(4500)));
  const flushing = outbox.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  const disposed = outbox.dispose(); finish();
  await Promise.all([flushing, disposed]);
  assert.equal(h.sqlite.prepare("SELECT next_chunk FROM discord_reply_outbox").get()!.next_chunk, 0);
  h.sqlite.close();
  await outbox.flush(); // A disposed worker never touches the now-closed database.
});

test("a failed completion checkpoint leaves the final chunk retryable", async () => {
  const h = setup(); const outbox = h.make();
  h.sqlite.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF delivered_at ON discord_reply_outbox
    BEGIN SELECT RAISE(ABORT, 'simulated checkpoint failure'); END`);
  outbox.enqueue(reply(1)); await outbox.flush();
  assert.equal(h.errors.length, 1);
  const pending = h.sqlite.prepare("SELECT next_chunk, delivered_at FROM discord_reply_outbox").get()!;
  assert.equal(pending.next_chunk, 0); assert.equal(pending.delivered_at, null);
  h.sqlite.exec("DROP TRIGGER fail_receipt"); await outbox.flush();
  assert.equal(h.sent.length, 2); assert.equal(h.sent[0]!.nonce, h.sent[1]!.nonce);
  await outbox.dispose(); h.sqlite.close();
});

test("output lookup recovers beyond ten pages and can be cancelled during shutdown", async () => {
  let page = 0;
  const output = await resolveReplyOutputId(reply(1), async () => {
    page += 1;
    return page === 12 ? [{ id: "old-output", seq: 1, createdAt: 1,
      type: "system/manager/user_message", data: { text: "Done." } }]
      : Array.from({ length: 100 }, (_, i) => ({ id: `new-${page}-${i}`,
        seq: 2000 - page * 100 - i, createdAt: 2, type: "item/completed", data: {} }));
  });
  assert.equal(output, "old-output");
  const controller = new AbortController();
  await assert.rejects(() => resolveReplyOutputId(reply(1), async () => {
    controller.abort(); return [];
  }, controller.signal), { name: "AbortError" });
});
