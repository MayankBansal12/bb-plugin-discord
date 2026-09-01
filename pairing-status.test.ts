import assert from "node:assert/strict";
import test from "node:test";
import { buildPairingStatus } from "./pairing-status.js";
import { configurationFixture, executionFixture } from "./test-support.js";

/** The signing tail of a Discord bot token; it must never appear in full. */
const SECRET_TOKEN_TAIL = "mNoPqRsTuVwXyZ";

const base = {
  gatewayState: "disconnected" as const,
  gatewayMessage: null,
  botUserId: null,
  botTag: null,
  tokenConfigured: true,
  storedPairing: null,
  pairingCode: null,
  inviteUrl: "https://discord.com/oauth2/authorize?client_id=1",
  configuration: configurationFixture({
    botToken: {
      configured: true,
      masked: "••••••••wXyZ",
    },
  }),
  execution: executionFixture(),
};

test("the RPC status formats a pairing command without exposing a token", () => {
  const result = buildPairingStatus({
    ...base,
    gatewayState: "connected",
    botUserId: "123456789012345678",
    botTag: "BB Bot",
    pairingCode: { code: "ABC123", expiresAt: 10_000 },
  });
  assert.deepEqual(result.pairingCode, {
    code: "ABC-123",
    expiresAt: 10_000,
    command: "<@123456789012345678> pair ABC-123",
  });
  // The DTO carries only a four-character recognition suffix; it must never
  // carry the full signing tail or token.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("token-value"), false);
  assert.equal(serialized.includes(SECRET_TOKEN_TAIL), false);
  assert.equal(result.configuration.botToken.masked, "••••••••wXyZ");
});

test("the RPC never invents a plain-text mention before Discord identifies the bot", () => {
  const result = buildPairingStatus({
    ...base,
    pairingCode: { code: "ABC123", expiresAt: 10_000 },
  });
  assert.equal(result.pairingCode?.command, null);
});

test("stored pairing is represented without inventing metadata", () => {
  const result = buildPairingStatus({
    ...base,
    storedPairing: {
      guildId: "paired-guild",
      guildName: "Builders",
      channelId: "channel-1",
      channelName: "agents",
      userId: "user-1",
      userTag: "mayank",
      pairedAt: 5_000,
    },
  });
  assert.equal(result.paired, true);
  assert.equal(result.pairing?.guildId, "paired-guild");
  assert.equal(result.pairing?.guildName, "Builders");
});
