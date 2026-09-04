// Source-level invariants for the staged settings architecture. The bot token
// remains in bb's secret store; every non-secret preference lives in the
// plugin-owned config row and is written through narrow RPC handlers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const migrationsSource = readFileSync(new URL("./migrations.ts", import.meta.url), "utf8");

function rpcHandler(name: string): string {
  const match = serverSource.match(
    new RegExp(`async ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\},`),
  );
  assert.ok(match, `RPC handler \`${name}\` should be present`);
  return match[1]!;
}

test("the host-rendered settings form asks for the bot token only", () => {
  const block = serverSource.match(
    /const settings = bb\.settings\.define\(\{([\s\S]*?)\n  \}\);/,
  )?.[1];
  assert.ok(block, "settings definition should be present");
  assert.match(block, /botToken:/);
  assert.match(block, /secret: true/);
  assert.match(block, /label: "Discord bot token"/);
  for (const key of [
    "permissionMode",
    "serverAccess",
    "allowDestructiveServerActions",
    "defaultProjectId",
    "machineHostId",
    "providerId",
    "model",
    "reasoningLevel",
    "serviceTier",
    "spawnChannelId",
    "homeChannelId",
    "guildId",
    "allowedUserIds",
  ]) {
    assert.doesNotMatch(block, new RegExp(`\\b${key}:`));
  }
});

test("durable configuration follows the selected machine and keeps Discord access narrow", () => {
  assert.match(serverSource, /permissionMode: "machine-default"/);
  assert.match(
    serverSource,
    /context\.catalog\?\.permissionCeiling \?\? context\.machine\?\.maxPermissionMode/,
  );
  assert.match(serverSource, /serverAccess: "messages"/);
  assert.match(serverSource, /allowDestructiveServerActions: false/);
  assert.match(migrationsSource, /CREATE TABLE IF NOT EXISTS discord_config/);
});

test("new migrations are appended after the frozen v0.0.4 migration prefix", () => {
  const legacyBlock = migrationsSource.match(
    /export const legacyMigrations = \[([\s\S]*?)\n\] as const;/,
  )?.[1];
  const appendedBlock = migrationsSource.match(
    /export const interactionActionMigrations = \[([\s\S]*?)\n\] as const;/,
  )?.[1];
  const routeBlock = migrationsSource.match(
    /export const interactionRouteMigrations = \[([\s\S]*?)\n\] as const;/,
  )?.[1];

  assert.ok(legacyBlock, "the legacy migration prefix should remain explicit");
  assert.ok(appendedBlock, "the appended migration list should be present");
  assert.ok(routeBlock, "the interaction route migration list should be present");
  assert.match(legacyBlock, /ALTER TABLE discord_config ADD COLUMN reasoning_level TEXT/);
  assert.match(legacyBlock, /ALTER TABLE discord_config ADD COLUMN service_tier TEXT/);
  assert.doesNotMatch(legacyBlock, /discord_interaction_actions/);
  assert.match(appendedBlock, /CREATE TABLE IF NOT EXISTS discord_interaction_actions/);
  assert.match(routeBlock, /CREATE TABLE IF NOT EXISTS discord_interaction_routes/);
  assert.match(
    migrationsSource,
    /\.\.\.legacyMigrations,[\s\S]*\.\.\.interactionActionMigrations,[\s\S]*\.\.\.interactionRouteMigrations/,
  );
});

test("the destructive-actions handler writes exactly one config value", () => {
  const handler = rpcHandler("setDestructiveActions");
  assert.match(handler, /updateConfig\(\{ allowDestructiveServerActions: enabled \}\)/);
  assert.doesNotMatch(handler, /serverAccess\s*:/);
  assert.match(handler, /accessLevel\(\) !== "full"/);
});

test("configuration validates and writes one coherent settings choice", () => {
  const handler = rpcHandler("setConfiguration");
  assert.match(handler, /validateSelectionRequest\(/);
  assert.match(handler, /if \(!check\.ok\)/);
  const patch = handler.match(/updateConfig\(\{([\s\S]*?)\n      \}\);/)?.[1];
  assert.ok(patch);
  assert.deepEqual(
    patch
      .split("\n")
      .map((line) => line.trim().split(":")[0])
      .filter(Boolean),
    [
      "defaultProjectId",
      "machineHostId",
      "providerId",
      "model",
      "reasoningLevel",
      "serviceTier",
      "permissionMode",
      "serverAccess",
      "homeChannelId",
      "spawnChannelId",
    ],
  );
  assert.match(
    handler,
    /loadCatalog\(\s*machine \?\? projectResult\.project\.defaultHostId,\s*request\.providerId/,
  );
});

test("model catalogs are loaded for the selected provider", () => {
  assert.match(serverSource, /bb\.sdk\.providers\.models\(\{\s*hostId,\s*\.\.\.\(providerId \? \{ providerId \} : \{\}\)/);
  assert.match(serverSource, /selection\.providerId \?\? defaults\?\.providerId/);
  assert.match(serverSource, /catalogModelOptions\(context, selection\.providerId\)/);
  assert.match(serverSource, /selectedProviderId \?\? context\.defaults\?\.providerId/);
});

test("the connected configuration handler cannot change token or destructive access", () => {
  const handler = rpcHandler("setConfiguration");
  assert.match(handler, /normalizeOptionalDiscordSnowflake/);
  for (const key of ["botToken", "allowDestructiveServerActions"]) {
    assert.doesNotMatch(handler, new RegExp(`${key}\\s*:`));
  }
});

test("server access is assigned by the connected configuration handler only", () => {
  const configWrites = [...serverSource.matchAll(/updateConfig\(\{([\s\S]*?)\}\);/g)]
    .map((match) => match[1]!)
    .filter((patch) => /serverAccess\s*:/.test(patch));
  assert.equal(configWrites.length, 1);
  assert.match(rpcHandler("setConfiguration"), /serverAccess: request\.serverAccess/);
});

test("the live bot token never reaches the frontend or logs", () => {
  const rawUses = [...serverSource.matchAll(/cached\.botToken/g)].length;
  const guarded = [
    /maskBotToken\(cached\.botToken\)/,
    /inviteUrlFromToken\(\s*cached\.botToken/,
    /Boolean\(cached\.botToken\)/,
  ].filter((pattern) => pattern.test(serverSource)).length;
  assert.ok(rawUses > 0 && guarded >= 3);
  assert.doesNotMatch(serverSource, /bb\.log\.[a-z]+\([^)]*botToken/);
});
