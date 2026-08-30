import assert from "node:assert/strict";
import test from "node:test";
import { DiscordClient, type DiscordClientOptions } from "./discord.js";

function makeClient(
  log: DiscordClientOptions["log"] = {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
): DiscordClient {
  const opts: DiscordClientOptions = {
    token: "unused-in-unit-tests",
    isAuthorized: () => false,
    isPairingCandidate: () => false,
    botUserId: () => undefined,
    onMessage: () => {},
    onReady: () => {},
    onSuspectedMissingContentIntent: () => {},
    log,
  };
  return new DiscordClient(opts);
}

test("destroy awaits and contains discord.js teardown failures", async () => {
  const warnings: string[] = [];
  const client = makeClient({
    info: () => {},
    warn: (message) => warnings.push(message),
    error: () => {},
  });
  let settled = false;
  const internal = client as unknown as {
    client: { destroy: () => Promise<void> };
  };
  internal.client.destroy = async () => {
    await Promise.resolve();
    settled = true;
    throw new Error("teardown exploded");
  };

  await client.destroy();

  assert.equal(settled, true);
  assert.match(warnings[0] ?? "", /teardown exploded/);
});

test("every channel operation rejects a channel from another guild", async () => {
  const client = makeClient();
  const foreignChannel = {
    id: "channel-1",
    guildId: "guild-2",
    isDMBased: () => false,
  };
  const internal = client as unknown as {
    client: { channels: { fetch: (channelId: string) => Promise<unknown> } };
  };
  internal.client.channels.fetch = async () => foreignChannel;

  const boundary = /not in the paired Discord server/;
  await assert.rejects(
    () => client.sendMessage("guild-1", "channel-1", "hello"),
    boundary,
  );
  await assert.rejects(
    () => client.sendTyping("guild-1", "channel-1"),
    boundary,
  );
  await assert.rejects(
    () => client.react("guild-1", "channel-1", "message-1", "✅"),
    boundary,
  );
  await assert.rejects(
    () => client.fetchMessages("guild-1", "channel-1", 25),
    boundary,
  );
  await assert.rejects(
    () => client.createThread("guild-1", "channel-1", "thread"),
    boundary,
  );
  await assert.rejects(
    () => client.editChannel("guild-1", "channel-1", { name: "renamed" }),
    boundary,
  );
  await assert.rejects(
    () => client.deleteChannel("guild-1", "channel-1", "test"),
    boundary,
  );
});

test("member listing uses the REST list endpoint, not gateway member fetch", async () => {
  const client = makeClient();
  let requestedLimit: number | undefined;
  let fetchCalled = false;
  const member = {
    id: "user-1",
    user: { tag: "person", bot: false },
    displayName: "Person",
    roles: { cache: new Map([["role-1", {}]]) },
  };
  const guild = {
    members: {
      list: async ({ limit }: { limit?: number }) => {
        requestedLimit = limit;
        return new Map([[member.id, member]]);
      },
      fetch: async () => {
        fetchCalled = true;
        throw new Error("gateway fetch must not be used");
      },
    },
  };
  (client as unknown as { getGuild: () => Promise<unknown> }).getGuild =
    async () => guild;

  const members = await client.listMembers("guild-1", 75);

  assert.equal(requestedLimit, 75);
  assert.equal(fetchCalled, false);
  assert.deepEqual(members, [
    {
      id: "user-1",
      tag: "person",
      displayName: "Person",
      bot: false,
      roleIds: ["role-1"],
    },
  ]);
});

test("member-list intent failures reach tools as classified friendly copy", async () => {
  const client = makeClient();
  (client as unknown as { getGuild: () => Promise<unknown> }).getGuild =
    async () => ({
      members: {
        list: async () => {
          throw Object.assign(new Error("Missing access"), { code: 50001 });
        },
      },
    });

  await assert.rejects(
    () => client.listMembers("guild-1", 50),
    /Listing members needs Server Members Intent/,
  );
});

test("an archived linked thread is reopened before sending", async () => {
  const client = makeClient();
  let archiveValue: boolean | undefined;
  let typed = false;
  const thread = {
    guildId: "guild-1",
    archived: true,
    isDMBased: () => false,
    isThread: () => true,
    isTextBased: () => true,
    setArchived: async (value: boolean) => {
      archiveValue = value;
    },
    sendTyping: async () => {
      typed = true;
    },
  };
  const internal = client as unknown as {
    client: { channels: { fetch: () => Promise<unknown> } };
  };
  internal.client.channels.fetch = async () => thread;

  await client.sendTyping("guild-1", "thread-1");

  assert.equal(archiveValue, false);
  assert.equal(typed, true);
});
