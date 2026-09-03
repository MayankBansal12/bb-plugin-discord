import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

test("logs and informational status cannot disclose the live pairing code", () => {
  const announcement = serverSource.match(
    /const announcePairing = \(\): void => \{([\s\S]*?)\n  \};/,
  )?.[1];
  const statusCommand = serverSource.match(
    /if \(command === "status"\) \{([\s\S]*?)\n      if \(command === "pair"\)/,
  )?.[1];

  assert.ok(announcement, "announcePairing implementation should be present");
  assert.ok(statusCommand, "status command implementation should be present");
  assert.doesNotMatch(announcement, /pairingInstructions|formatPairingCode|pendingCode/);
  assert.doesNotMatch(statusCommand, /pairingInstructions|formatPairingCode|pendingCode/);
  assert.match(statusCommand, /one-time code is hidden from status/);
});

test("Discord-backed agent replies have one outbound delivery path", () => {
  const configuration = serverSource.match(
    /bb\.agents\.configure\(\(context\) => \{([\s\S]*?)\n  \}\);/,
  )?.[1];
  const registration = serverSource.match(
    /registerDiscordTools\(bb, \{([\s\S]*?)\n  \}\);/,
  )?.[1];

  assert.ok(configuration, "agent configuration should be present");
  assert.ok(registration, "Discord tool registration should be present");
  assert.match(configuration, /isDiscordAgentConversation/);
  assert.match(configuration, /context\.origin\.pluginId/);
  assert.match(
    configuration,
    /getMapByBbThread\(context\.thread\.id\) !== undefined/,
  );
  assert.match(configuration, /allowSendMessage: !isDiscordConversation/);
  assert.match(registration, /getMapByBbThread\(bbThreadId\) !== undefined/);
});

test("normal assistant output can target only its mapped Discord thread", () => {
  const threadDelivery = serverSource.match(
    /const postToThreadChannel = async \(([\s\S]*?)\n  \};/,
  )?.[1];
  const idleHandler = serverSource.match(
    /bb\.events\.on\("thread\.idle",([\s\S]*?)\n  \}\);\n\n  bb\.events\.on\("thread\.failed"/,
  )?.[1];

  assert.ok(threadDelivery, "mapped-thread delivery should be present");
  assert.ok(idleHandler, "thread.idle handler should be present");
  assert.match(threadDelivery, /map\.discord_thread_id/);
  assert.doesNotMatch(threadDelivery, /discord_parent_channel_id|homeChannelId/);
  assert.match(idleHandler, /postToThreadChannel/);
  assert.doesNotMatch(idleHandler, /sendToDiscord|postToHome|discord_parent_channel_id/);
  assert.doesNotMatch(idleHandler, /MAX_REPLY_CHARS|truncate\(trimmed/);
});
