import assert from "node:assert/strict";
import test from "node:test";
import { DiscordClient, type DiscordClientOptions } from "./discord.js";

function makeClient(
  log: DiscordClientOptions["log"] = {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  overrides: Partial<DiscordClientOptions> = {},
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
    ...overrides,
  };
  return new DiscordClient(opts);
}

test("approval requests render only BB-offered Discord buttons", async () => {
  const client = makeClient();
  let sent: unknown;
  const channel = {
    guildId: "guild-1",
    archived: false,
    isDMBased: () => false,
    isThread: () => true,
    send: async (payload: unknown) => {
      sent = payload;
      return { id: "message-1" };
    },
  };
  const internal = client as unknown as {
    client: { channels: { fetch: () => Promise<unknown> } };
  };
  internal.client.channels.fetch = async () => channel;

  const messageId = await client.sendApprovalRequest(
    "guild-1",
    "channel-1",
    "Approve this?",
    {
      token: "0123456789abcdef01234567",
      decisions: ["allow_once", "deny"],
    },
  );

  assert.equal(messageId, "message-1");
  const payload = sent as {
    content: string;
    components: Array<{
      components: Array<{ data: { custom_id: string; label: string } }>;
    }>;
  };
  assert.equal(payload.content, "Approve this?");
  assert.deepEqual(
    payload.components[0]?.components.map((button) => button.data.label),
    ["Approve once", "Deny"],
  );
  assert.deepEqual(
    payload.components[0]?.components.map((button) => button.data.custom_id),
    [
      "bb-approval:v1:0123456789abcdef01234567:allow_once",
      "bb-approval:v1:0123456789abcdef01234567:deny",
    ],
  );
});

test("authorized approval clicks resolve and disable the original buttons", async () => {
  const actions: unknown[] = [];
  const client = makeClient(undefined, {
    isAuthorized: (guildId, userId) =>
      guildId === "guild-1" && userId === "user-1",
    onApprovalAction: async (action) => {
      actions.push(action);
      return { outcome: "resolved", statusText: "✅ Approved once." };
    },
  });
  let deferred = false;
  let edited: unknown;
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1", tag: "person" },
    message: { id: "message-1", content: "Approval requested" },
    deferUpdate: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      edited = payload;
    },
    followUp: async () => {},
    reply: async () => {},
  };
  const invoke = client as unknown as {
    handleApprovalInteraction: (
      interaction: unknown,
      action: { token: string; decision: "allow_once" },
    ) => Promise<void>;
  };

  await invoke.handleApprovalInteraction(interaction, {
    token: "0123456789abcdef01234567",
    decision: "allow_once",
  });

  assert.equal(deferred, true);
  assert.deepEqual(actions, [
    {
      token: "0123456789abcdef01234567",
      decision: "allow_once",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      authorTag: "person",
    },
  ]);
  assert.deepEqual(edited, {
    content: "Approval requested\n\n✅ Approved once.",
    components: [],
  });
});

test("unauthorized approval clicks are ephemeral and never reach BB", async () => {
  let handled = false;
  let reply: unknown;
  const client = makeClient(undefined, {
    isAuthorized: () => false,
    onApprovalAction: async () => {
      handled = true;
      return { outcome: "resolved", statusText: "must not happen" };
    },
  });
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "intruder", tag: "intruder" },
    message: { id: "message-1", content: "Approval requested" },
    reply: async (payload: unknown) => {
      reply = payload;
    },
  };
  const invoke = client as unknown as {
    handleApprovalInteraction: (
      interaction: unknown,
      action: { token: string; decision: "deny" },
    ) => Promise<void>;
  };

  await invoke.handleApprovalInteraction(interaction, {
    token: "0123456789abcdef01234567",
    decision: "deny",
  });

  assert.equal(handled, false);
  assert.deepEqual(reply, {
    content: "You are not authorized to approve this BB request.",
    ephemeral: true,
  });
});

test("temporary BB failures keep approval buttons available for retry", async () => {
  const client = makeClient(undefined, {
    isAuthorized: () => true,
    onApprovalAction: async () => ({
      outcome: "retry",
      errorText: "BB is temporarily unavailable.",
    }),
  });
  let edited = false;
  let followUp: unknown;
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1", tag: "person" },
    message: { id: "message-1", content: "Approval requested" },
    deferUpdate: async () => {},
    editReply: async () => {
      edited = true;
    },
    followUp: async (payload: unknown) => {
      followUp = payload;
    },
    reply: async () => {},
  };
  const invoke = client as unknown as {
    handleApprovalInteraction: (
      interaction: unknown,
      action: { token: string; decision: "allow_once" },
    ) => Promise<void>;
  };

  await invoke.handleApprovalInteraction(interaction, {
    token: "0123456789abcdef01234567",
    decision: "allow_once",
  });

  assert.equal(edited, false);
  assert.deepEqual(followUp, {
    content: "BB is temporarily unavailable.",
    ephemeral: true,
  });
});

test("stale approval clicks close the original Discord controls", async () => {
  const client = makeClient(undefined, {
    isAuthorized: () => true,
    onApprovalAction: async () => ({
      outcome: "stale",
      statusText: "⌛ This BB approval is no longer pending.",
    }),
  });
  let edited: unknown;
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1", tag: "person" },
    message: { id: "message-1", content: "Approval requested" },
    deferUpdate: async () => {},
    editReply: async (payload: unknown) => {
      edited = payload;
    },
    followUp: async () => {},
    reply: async () => {},
  };
  const invoke = client as unknown as {
    handleApprovalInteraction: (
      interaction: unknown,
      action: { token: string; decision: "deny" },
    ) => Promise<void>;
  };

  await invoke.handleApprovalInteraction(interaction, {
    token: "0123456789abcdef01234567",
    decision: "deny",
  });

  assert.deepEqual(edited, {
    content:
      "Approval requested\n\n⌛ This BB approval is no longer pending.",
    components: [],
  });
});

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
