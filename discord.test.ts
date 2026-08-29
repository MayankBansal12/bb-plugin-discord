import assert from "node:assert/strict";
import test from "node:test";
import { DiscordClient, type DiscordClientOptions } from "./discord.js";

function makeClient(): DiscordClient {
  const opts: DiscordClientOptions = {
    token: "unused-in-unit-tests",
    isAuthorized: () => false,
    isPairingCandidate: () => false,
    botUserId: () => undefined,
    onMessage: () => {},
    onReady: () => {},
    onSuspectedMissingContentIntent: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return new DiscordClient(opts);
}

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
