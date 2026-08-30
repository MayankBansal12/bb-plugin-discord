import assert from "node:assert/strict";
import test from "node:test";
import { buildPairingStatus } from "./pairing-status.js";

const base = {
  gatewayState: "disconnected" as const,
  gatewayMessage: null,
  botUserId: null,
  botTag: null,
  tokenConfigured: true,
  storedPairing: null,
  legacyGuildId: null,
  pairingCode: null,
  inviteUrl: "https://discord.com/oauth2/authorize?client_id=1",
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
  assert.equal(JSON.stringify(result).includes("botToken"), false);
  assert.equal(JSON.stringify(result).includes("token-value"), false);
});

test("the RPC never invents a plain-text mention before Discord identifies the bot", () => {
  const result = buildPairingStatus({
    ...base,
    pairingCode: { code: "ABC123", expiresAt: 10_000 },
  });
  assert.equal(result.pairingCode?.command, null);
});

test("stored pairing wins over legacy settings in the RPC status", () => {
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
    legacyGuildId: "legacy-guild",
  });
  assert.equal(result.paired, true);
  assert.equal(result.pairing?.source, "pairing");
  assert.equal(result.pairing?.guildId, "paired-guild");
  assert.equal(result.legacySettingsRequireCleanup, true);
});

test("legacy settings are represented without invented pairing metadata", () => {
  const result = buildPairingStatus({ ...base, legacyGuildId: "legacy-guild" });
  assert.deepEqual(result.pairing, {
    source: "legacy-settings",
    guildId: "legacy-guild",
    guildName: null,
    channelId: null,
    channelName: null,
    userId: null,
    userTag: null,
    pairedAt: null,
  });
});
