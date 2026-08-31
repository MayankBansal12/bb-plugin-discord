// Source-level invariants for the declarative settings and the one settings
// key the plugin writes for itself. These are checked against the text of
// server.ts because the settings block is plain data handed to the host: there
// is no runtime seam to call without booting a whole plugin host.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

function descriptor(key: string): string {
  const match = serverSource.match(
    new RegExp(`\\n    ${key}: \\{([\\s\\S]*?)\\n    \\},`),
  );
  assert.ok(match, `settings descriptor \`${key}\` should be defined`);
  return match[1]!;
}

test("Discord threads default to the auto permission mode", () => {
  const permissionMode = descriptor("permissionMode");
  assert.match(permissionMode, /default: "auto"/);
  // The first option is what the host preselects for an operator who has never
  // opened the field, so it has to agree with the default.
  assert.match(permissionMode, /options: \["auto",/);
});

test("server access and destructive actions default to the least privilege", () => {
  assert.match(descriptor("serverAccess"), /default: "messages"/);
  assert.match(descriptor("allowDestructiveServerActions"), /default: false/);
});

test("execution selection settings are optional so defaults stay automatic", () => {
  for (const key of ["defaultProjectId", "machineHostId", "providerId", "model"]) {
    assert.doesNotMatch(
      descriptor(key),
      /default:/,
      `\`${key}\` must have no default, or it stops meaning "automatic"`,
    );
  }
});

test("the connection setting comes before the configuration settings", () => {
  const order = [
    "botToken",
    "permissionMode",
    "serverAccess",
    "allowDestructiveServerActions",
  ].map((key) => serverSource.indexOf(`\n    ${key}: {`));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "settings are rendered in declaration order",
  );
});

test("the destructive-actions handler writes that key and nothing else", () => {
  const handler = serverSource.match(
    /async setDestructiveActions\(\{ enabled \}\) \{([\s\S]*?)\n    \},/,
  )?.[1];
  assert.ok(handler, "setDestructiveActions handler should be present");

  const updateCall = handler.match(/values: \{([\s\S]*?)\},/)?.[1];
  assert.ok(updateCall, "the handler should call updateSettings with a values object");
  assert.deepEqual(
    updateCall
      .split(",")
      .map((entry) => entry.split(":")[0]!.trim())
      .filter(Boolean),
    ["allowDestructiveServerActions"],
    "enabling destructive actions must never carry another setting with it",
  );
  // The reported regression: the control escalated Discord server access.
  assert.doesNotMatch(handler, /serverAccess: /);
  assert.match(handler, /accessLevel\(\) !== "full"/);
});

test("nothing in the plugin ever assigns Discord server access", () => {
  // `serverAccess` is read in several places; it must never be written, or the
  // destructive toggle could escalate it again by a different route.
  assert.doesNotMatch(serverSource, /serverAccess\s*[:=]\s*"full"/);
  assert.doesNotMatch(serverSource, /values: \{[^}]*serverAccess/);
});

test("the live bot token never reaches the frontend or the logs", () => {
  // Only the mask helper and the two derivations that need the raw value may
  // touch `cached.botToken`.
  const rawUses = [...serverSource.matchAll(/cached\.botToken/g)].length;
  const allowed = [
    /maskBotToken\(cached\.botToken\)/,
    /inviteUrlFromToken\(\s*cached\.botToken/,
    /Boolean\(cached\.botToken\)/,
  ];
  const guarded = allowed.filter((pattern) => pattern.test(serverSource)).length;
  assert.ok(rawUses > 0 && guarded >= 3);
  assert.doesNotMatch(serverSource, /bb\.log\.[a-z]+\([^)]*botToken/);
});

test("the execution-selection handler writes only the three execution keys", () => {
  const handler = serverSource.match(
    /async setExecutionSelection\(request\) \{([\s\S]*?)\n    \},/,
  )?.[1];
  assert.ok(handler, "setExecutionSelection handler should be present");

  const updateCall = handler.match(/values: \{([\s\S]*?)\n          \},/)?.[1];
  assert.ok(updateCall, "the handler should call updateSettings with a values object");
  assert.deepEqual(
    updateCall
      .split("\n")
      .map((line) => line.trim().split(":")[0])
      .filter((key): key is string => Boolean(key)),
    ["machineHostId", "providerId", "model"],
    "the machine and model pickers must not carry any other setting with them",
  );

  // The picker sits next to the access controls; it must never reach them.
  for (const key of [
    "serverAccess",
    "allowDestructiveServerActions",
    "permissionMode",
    "botToken",
    "guildId",
    "allowedUserIds",
    "homeChannelId",
    "spawnChannelId",
    "defaultProjectId",
  ]) {
    assert.doesNotMatch(
      handler,
      new RegExp(`${key}\\s*:`),
      `setExecutionSelection must not write \`${key}\``,
    );
  }

  // Stale options posted from a minute-old render are re-checked server-side.
  assert.match(handler, /validateSelectionRequest\(/);
  assert.match(handler, /if \(!check\.ok\)/);
});

test("the provider example names a provider BB actually ships", () => {
  const provider = descriptor("providerId");
  assert.match(provider, /claude-code|codex/);
  assert.doesNotMatch(provider, /`anthropic`/);
});
