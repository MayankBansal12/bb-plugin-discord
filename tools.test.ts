import assert from "node:assert/strict";
import test from "node:test";
import {
  availableToolNames,
  DESTRUCTIVE_TOOL_NAMES,
  DISCORD_BRIDGE_AGENT_INSTRUCTIONS,
  DISCORD_BRIDGE_SEND_BLOCKED_MESSAGE,
  discordAuditReason,
  MANAGEMENT_TOOL_NAMES,
  MESSAGE_TOOL_NAMES,
  registerDiscordTools,
  type DiscordToolDeps,
} from "./tools.js";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { DiscordClient } from "./discord.js";

interface CapturedTool {
  name: string;
  instructions?: string;
  execute: (
    params: { channelId: string; content: string },
    context: { threadId: string },
  ) => Promise<unknown>;
}

function captureTools(deps: DiscordToolDeps): CapturedTool[] {
  const tools: CapturedTool[] = [];
  const bb = {
    agents: {
      registerTool(tool: CapturedTool) {
        tools.push(tool);
      },
    },
  } as unknown as BbPluginApi;
  registerDiscordTools(bb, deps);
  return tools;
}

test("no Discord tools are offered before pairing", () => {
  assert.deepEqual(availableToolNames("full", true, false), []);
});

test("Discord audit reasons identify the originating bb thread", () => {
  assert.equal(
    discordAuditReason("thread-123"),
    "Requested through bb's Discord plugin by thread thread-123",
  );
});

test("message access covers messages and threads only", () => {
  const names = availableToolNames("messages", true, true);
  assert.deepEqual([...names], [...MESSAGE_TOOL_NAMES]);
  for (const managed of [...MANAGEMENT_TOOL_NAMES, ...DESTRUCTIVE_TOOL_NAMES]) {
    assert.ok(!names.includes(managed), `${managed} must need full access`);
  }
});

test("Discord-backed conversations cannot cross-post their automatic reply", () => {
  const names = availableToolNames("full", true, true, {
    allowSendMessage: false,
  });

  assert.ok(!names.includes("discord_send_message"));
  for (const retained of MESSAGE_TOOL_NAMES.filter(
    (name) => name !== "discord_send_message",
  )) {
    assert.ok(names.includes(retained), `${retained} should remain available`);
  }
  for (const managed of [...MANAGEMENT_TOOL_NAMES, ...DESTRUCTIVE_TOOL_NAMES]) {
    assert.ok(names.includes(managed), `${managed} should remain available`);
  }
});

test("Discord agents preserve parent routing for delegated interaction UX", () => {
  assert.match(DISCORD_BRIDGE_AGENT_INSTRUCTIONS, /select menus/);
  assert.match(DISCORD_BRIDGE_AGENT_INSTRUCTIONS, /--parent-self/);
  assert.match(DISCORD_BRIDGE_AGENT_INSTRUCTIONS, /do not tell the user/i);
});

test("an already-running Discord conversation is blocked at tool execution", async () => {
  let clientRead = false;
  const tools = captureTools({
    getClient: () => {
      clientRead = true;
      return null;
    },
    getGuildId: () => "guild-1",
    getAccessLevel: () => "messages",
    allowsDestructive: () => false,
    isDiscordConversation: (threadId) => threadId === "bb-discord-thread",
  });
  const send = tools.find((tool) => tool.name === "discord_send_message");

  assert.ok(send);
  const result = await send.execute(
    { channelId: "parent-channel", content: "accidental cross-post" },
    { threadId: "bb-discord-thread" },
  );

  assert.equal(clientRead, false, "the Discord client must not be reached");
  assert.deepEqual(result, {
    content: [
      {
        type: "text",
        text: DISCORD_BRIDGE_SEND_BLOCKED_MESSAGE,
      },
    ],
    isError: true,
  });
});

test("a regular bb thread can still send an explicitly requested message", async () => {
  const sent: Array<{ guildId: string; channelId: string; content: string }> = [];
  const client = {
    isReady: () => true,
    sendMessage: async (guildId: string, channelId: string, content: string) => {
      sent.push({ guildId, channelId, content });
    },
  } as unknown as DiscordClient;
  const tools = captureTools({
    getClient: () => client,
    getGuildId: () => "guild-1",
    getAccessLevel: () => "messages",
    allowsDestructive: () => false,
    isDiscordConversation: () => false,
  });
  const send = tools.find((tool) => tool.name === "discord_send_message");

  assert.ok(send);
  const result = await send.execute(
    { channelId: "announcements", content: "Release is live." },
    { threadId: "regular-bb-thread" },
  );

  assert.equal(result, "Sent to announcements.");
  assert.deepEqual(sent, [
    {
      guildId: "guild-1",
      channelId: "announcements",
      content: "Release is live.",
    },
  ]);
});

test("message-producing tools require an explicit Discord action", () => {
  const tools = captureTools({
    getClient: () => null,
    getGuildId: () => null,
    getAccessLevel: () => "messages",
    allowsDestructive: () => false,
    isDiscordConversation: () => false,
  });

  for (const name of ["discord_send_message", "discord_create_thread"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool?.instructions, `${name} should carry safety instructions`);
    assert.match(tool.instructions, /explicitly asks/);
    assert.match(tool.instructions, /current|reply|final assistant message/);
  }
});

test("full access adds administration but withholds destructive tools", () => {
  const names = availableToolNames("full", false, true);
  for (const managed of MANAGEMENT_TOOL_NAMES) assert.ok(names.includes(managed));
  for (const destructive of DESTRUCTIVE_TOOL_NAMES) {
    assert.ok(
      !names.includes(destructive),
      `${destructive} must need the destructive opt-in`,
    );
  }
});

test("destructive tools appear only with full access and the explicit opt-in", () => {
  const names = availableToolNames("full", true, true);
  for (const destructive of DESTRUCTIVE_TOOL_NAMES) {
    assert.ok(names.includes(destructive));
  }
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
});
