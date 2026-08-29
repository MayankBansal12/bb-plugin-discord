import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  applicationIdFromToken,
  buildInviteUrl,
  classifyDiscordError,
  formatPairingCode,
  FULL_PERMISSIONS,
  generatePairingCode,
  invitePermissions,
  MESSAGE_PERMISSIONS,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
  pairingFailureMessage,
  parsePairCommand,
  permissionBits,
  resolveSpawnPermissionMode,
  retryDelayMs,
  verifyPairingCode,
} from "./pairing.js";

test("pairing codes are six unambiguous characters with a bounded lifetime", () => {
  const code = generatePairingCode(1_000, () => 0);
  assert.equal(code.code, "AAAAAA");
  assert.equal(code.expiresAt, 1_000 + PAIRING_CODE_TTL_MS);
  assert.match(generatePairingCode().code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(formatPairingCode("ABC123"), "ABC-123");
});

test("pair command is recognized in the forms a user actually types", () => {
  assert.deepEqual(parsePairCommand("pair ABC-123"), { kind: "code", code: "ABC123" });
  assert.deepEqual(parsePairCommand("  setup abc123 "), { kind: "code", code: "ABC123" });
  assert.deepEqual(parsePairCommand("bb connect ABC-123"), {
    kind: "code",
    code: "ABC123",
  });
  assert.deepEqual(parsePairCommand("setup"), { kind: "missing-code" });
  assert.equal(parsePairCommand("please deploy the website"), null);
  assert.deepEqual(parsePairCommand("pair"), { kind: "missing-code" });
  assert.equal(normalizePairingCode("a b-c1!2"), "ABC12");
});

test("pairing codes are single-use, time-bound, and exact", () => {
  const pending = { code: "ABC123", expiresAt: 5_000 };
  assert.deepEqual(verifyPairingCode(pending, "abc-123", 4_000), { ok: true });
  assert.deepEqual(verifyPairingCode(pending, "abc-124", 4_000), {
    ok: false,
    reason: "mismatch",
  });
  assert.deepEqual(verifyPairingCode(pending, "abc-123", 5_000), {
    ok: false,
    reason: "expired",
  });
  assert.deepEqual(verifyPairingCode(null, "abc-123", 1), {
    ok: false,
    reason: "no-code",
  });
  assert.match(pairingFailureMessage("expired"), /expired/i);
});

test("invite permission bits match discord.js", () => {
  for (const name of FULL_PERMISSIONS) {
    assert.equal(
      permissionBits([name]),
      PermissionFlagsBits[name],
      `${name} bit does not match discord.js`,
    );
  }
  assert.ok(
    invitePermissions("full") > invitePermissions("messages"),
    "full access must be a superset of message access",
  );
  assert.equal(
    invitePermissions("messages"),
    permissionBits(MESSAGE_PERMISSIONS),
  );
});

test("the invite URL is derived from the bot token", () => {
  const applicationId = "123456789012345678";
  const token = `${Buffer.from(applicationId).toString("base64url")}.abcdef.ghijkl`;
  assert.equal(applicationIdFromToken(token), applicationId);
  assert.equal(applicationIdFromToken("not-a-token"), null);

  const url = new URL(buildInviteUrl(applicationId, "messages"));
  assert.equal(url.searchParams.get("client_id"), applicationId);
  assert.equal(url.searchParams.get("scope"), "bot");
  assert.equal(
    url.searchParams.get("permissions"),
    invitePermissions("messages").toString(),
  );
});

test("Discord threads default to the least privileged permission mode", () => {
  assert.equal(resolveSpawnPermissionMode(undefined, "full"), "accept-edits");
  assert.equal(resolveSpawnPermissionMode("accept-edits", "full"), "accept-edits");
  assert.equal(resolveSpawnPermissionMode("project-default", "full"), "full");
  assert.equal(resolveSpawnPermissionMode("auto", "accept-edits"), "auto");
  assert.equal(resolveSpawnPermissionMode("nonsense", "auto"), "accept-edits");
});

test("Discord failures become actionable operator messages", () => {
  const intents = classifyDiscordError(
    Object.assign(new Error("Used disallowed intents"), { code: 4014 }),
  );
  assert.equal(intents.kind, "disallowed-intents");
  assert.equal(intents.needsConfiguration, true);
  assert.match(intents.message, /Message Content Intent/);

  const token = classifyDiscordError(
    Object.assign(new Error("An invalid token was provided."), {
      code: "TokenInvalid",
    }),
  );
  assert.equal(token.kind, "invalid-token");
  assert.equal(token.needsConfiguration, true);

  const permissions = classifyDiscordError(
    Object.assign(new Error("Missing Permissions"), { code: 50013 }),
  );
  assert.equal(permissions.kind, "missing-permissions");
  assert.equal(permissions.needsConfiguration, false);

  const network = classifyDiscordError(
    Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), {
      code: "ENOTFOUND",
    }),
  );
  assert.equal(network.kind, "network");

  const unknown = classifyDiscordError(new Error("something else"));
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.message, "something else");
});

test("reconnect backoff grows and is capped", () => {
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 4_000);
  assert.equal(retryDelayMs(10), 60_000);
});
