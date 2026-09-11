import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, Client, Events, MessagePayload } from "discord.js";
import {
  chunkForDiscord,
  DiscordClient,
  resolvedInteractionContent,
  type DiscordClientOptions,
} from "./discord.js";

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

test("option questions render as a Discord select menu", async () => {
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

  await client.sendQuestionRequest("guild-1", "channel-1", "Which flow?", {
    token: "0123456789abcdef01234567",
    multiSelect: false,
    options: [
      { label: "In-workspace edit approval" },
      { label: "Stop testing here", description: "Finish without another check" },
    ],
  });

  const payload = sent as {
    content: string;
    components: Array<{
      components: Array<{
        data: {
          custom_id: string;
          max_values: number;
        };
        toJSON: () => {
          options: Array<{ label: string; value: string; description?: string }>;
        };
      }>;
    }>;
  };
  const select = payload.components[0]!.components[0]!.data;
  assert.equal(payload.content, "Which flow?");
  assert.equal(select.custom_id, "bb-question:v1:0123456789abcdef01234567");
  assert.equal(select.max_values, 1);
  assert.deepEqual(payload.components[0]!.components[0]!.toJSON().options, [
    { label: "In-workspace edit approval", value: "0", emoji: undefined },
    {
      label: "Stop testing here",
      value: "1",
      description: "Finish without another check",
      emoji: undefined,
    },
  ]);
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
    allowedMentions: { parse: [], repliedUser: false },
  });
});

test("authorized question selections resolve and close the select menu", async () => {
  const actions: unknown[] = [];
  const client = makeClient(undefined, {
    isAuthorized: (guildId, userId) =>
      guildId === "guild-1" && userId === "user-1",
    onQuestionAction: async (action) => {
      actions.push(action);
      return { outcome: "resolved", statusText: "✅ Answered by person." };
    },
  });
  let edited: unknown;
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    values: ["2"],
    user: { id: "user-1", tag: "person" },
    message: { id: "message-1", content: "Which flow?" },
    deferUpdate: async () => {},
    editReply: async (payload: unknown) => {
      edited = payload;
    },
    followUp: async () => {},
    reply: async () => {},
  };
  const invoke = client as unknown as {
    handleQuestionInteraction: (
      interaction: unknown,
      action: { token: string },
    ) => Promise<void>;
  };

  await invoke.handleQuestionInteraction(interaction, {
    token: "0123456789abcdef01234567",
  });

  assert.deepEqual(actions, [
    {
      token: "0123456789abcdef01234567",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      authorTag: "person",
      selectedIndices: [2],
    },
  ]);
  assert.deepEqual(edited, {
    content: "Which flow?\n\n✅ Answered by person.",
    components: [],
    allowedMentions: { parse: [], repliedUser: false },
  });
});

test("long messages are split without losing text or Unicode", async () => {
  const client = makeClient();
  const sent: string[] = [];
  const channel = {
    guildId: "guild-1",
    archived: false,
    isDMBased: () => false,
    isThread: () => true,
    send: async (payload: { content: string }) => {
      sent.push(payload.content);
      return { id: `message-${sent.length}` };
    },
  };
  const internal = client as unknown as {
    client: { channels: { fetch: () => Promise<unknown> } };
  };
  internal.client.channels.fetch = async () => channel;
  const text = `${"first line with words ".repeat(110)}\n${"🔥".repeat(1200)}\n${"last line ".repeat(120)}`;

  await client.sendMessage("guild-1", "channel-1", text);

  assert.ok(sent.length > 1);
  assert.ok(sent.every((chunk) => chunk.length <= 1900));
  assert.equal(sent.join(""), text);
  assert.deepEqual(sent, chunkForDiscord(text));
  for (let index = 0; index < sent.length - 1; index += 1) {
    const end = sent[index]!.charCodeAt(sent[index]!.length - 1);
    const start = sent[index + 1]!.charCodeAt(0);
    assert.equal(end >= 0xd800 && end <= 0xdbff && start >= 0xdc00 && start <= 0xdfff, false);
  }
});

test("resolved interaction messages preserve status within Discord's limit", () => {
  const status =
    "✅ Allowed for this bb session. Similar requests may proceed without another prompt.";
  const content = resolvedInteractionContent("🔥".repeat(1200), status);

  assert.ok(content.length <= 2000);
  assert.ok(content.endsWith(status));
  assert.equal(content.includes("\ud83d…"), false);
});

test("interaction controls can be closed after a typed or in-bb answer", async () => {
  const client = makeClient();
  let edited: unknown;
  const channel = {
    guildId: "guild-1",
    archived: false,
    isDMBased: () => false,
    isThread: () => true,
    messages: {
      fetch: async (messageId: string) => {
        assert.equal(messageId, "message-1");
        return {
          content: "Approval requested",
          edit: async (payload: unknown) => {
            edited = payload;
          },
        };
      },
    },
  };
  const internal = client as unknown as {
    client: { channels: { fetch: () => Promise<unknown> } };
  };
  internal.client.channels.fetch = async () => channel;

  await client.closeInteractionRequest(
    "guild-1",
    "channel-1",
    "message-1",
    "✅ Approved by person.",
  );

  assert.deepEqual(edited, {
    content: "Approval requested\n\n✅ Approved by person.",
    components: [],
    allowedMentions: { parse: [], repliedUser: false },
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
    content: "You are not authorized to approve this bb request.",
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
    allowedMentions: { parse: [], repliedUser: false },
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

test("reconnect and re-identify pause delivery until every affected shard is ready", async () => {
  const states: boolean[] = [];
  const client = makeClient(undefined, { onConnectionStateChange: (ready) => states.push(ready) });
  const internal = (client as unknown as { client: Client }).client;
  internal.emit(Events.ClientReady, { user: { tag: "test-bot" } } as Client<true>);
  internal.emit(Events.ShardReconnecting, 0);
  internal.emit(Events.ShardReconnecting, 1);
  assert.equal(client.isReady(), false);
  internal.emit(Events.ShardReady, 0, undefined);
  assert.equal(client.isReady(), false);
  internal.emit(Events.ShardResume, 1, 0);
  assert.equal(client.isReady(), true);
  assert.deepEqual(states, [true, false, true]);
  await client.destroy();
});

test("fatal closes after login report the classified error to the supervisor", async () => {
  const errors: Error[] = [];
  const client = makeClient(undefined, { onFatalError: (error) => errors.push(error) });
  const internal = (client as unknown as { client: Client }).client;
  internal.emit(Events.ClientReady, { user: { tag: "test-bot" } } as Client<true>);
  internal.emit(Events.ShardDisconnect, { code: 4014, reason: "", wasClean: true }, 0);
  assert.equal(client.isReady(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Message Content Intent/);
  await client.destroy();
  internal.emit(Events.ShardDisconnect, { code: 4014, reason: "", wasClean: true }, 0);
  assert.equal(errors.length, 1, "teardown cannot restart a disposed gateway");
});

test("automatic replies and controls suppress mentions in serialized Discord payloads", async () => {
  const client = makeClient();
  const internal = (client as unknown as { client: Client }).client;
  const sent: Record<string, unknown>[] = [];
  const channel = {
    client: internal,
    guildId: "guild-1",
    isDMBased: () => false,
    isThread: () => false,
    send: async (options: Parameters<typeof MessagePayload.create>[1]) => {
      const payload = MessagePayload.create(channel as never, options);
      payload.resolveBody();
      sent.push({ ...payload.body! });
      return { id: "message-1" };
    },
  };
  (internal.channels as unknown as { fetch: () => Promise<unknown> }).fetch = async () => channel;
  const text = "Quoted: <@123456789012345678> <@&123456789012345679> @everyone";
  await client.sendMessage("guild-1", "channel-1", text);
  await client.sendReplyChunk("guild-1", "channel-1", text, "nonce-1");
  await client.sendApprovalRequest("guild-1", "channel-1", text, {
    token: "0123456789abcdef01234567", decisions: ["allow_once", "deny"],
  });
  for (const payload of sent) {
    assert.equal(payload.content, text);
    assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
  }
  assert.equal(sent[1]!.nonce, "nonce-1");
  assert.equal(sent[1]!.enforce_nonce, true);
  await client.destroy();
});

test("thread seeds use lossless chunking and report an existing thread on partial failure", async () => {
  const client = makeClient();
  const sent: string[] = [];
  let created = 0;
  let failAt = Infinity;
  const channel = {
    guildId: "guild-1",
    type: ChannelType.GuildText,
    isDMBased: () => false,
    threads: {
      create: async () => {
        created += 1;
        return {
          id: `thread-${created}`, name: "Seeded thread",
          send: async (payload: { content: string; allowedMentions: unknown }) => {
            assert.ok(payload.content.length <= 2000);
            assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
            if (sent.length === failAt) throw Object.assign(new Error("Missing permissions"), { code: 50013 });
            sent.push(payload.content);
            return { id: `message-${sent.length}` };
          },
        };
      },
    },
  };
  const internal = client as unknown as { client: { channels: { fetch: () => Promise<unknown> } } };
  internal.client.channels.fetch = async () => channel;
  const text = "seed ".repeat(800);
  assert.deepEqual(await client.createThread("guild-1", "channel-1", "Seeded thread", text), {
    id: "thread-1", name: "Seeded thread",
  });
  assert.equal(sent.join(""), text);
  sent.length = 0;
  failAt = 1;
  const partial = await client.createThread("guild-1", "channel-1", "Seeded thread", text);
  assert.equal(partial.id, "thread-2");
  assert.match(partial.seedError!, /only 1\/3 seed messages/);
  assert.equal(created, 2);
  await client.destroy();
});
