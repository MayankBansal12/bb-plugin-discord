import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  interactionActionMigrations,
  interactionMessageMigrations,
  interactionRouteMigrations,
  legacyMigrations,
  migrations,
} from "./migrations.js";

function applyFrom(
  db: DatabaseSync,
  statements: readonly string[],
  startIndex = 0,
): void {
  db.exec("BEGIN");
  try {
    for (const statement of statements.slice(startIndex)) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function assertCurrentSchema(db: DatabaseSync): void {
  const configColumns = db.prepare("PRAGMA table_info(discord_config)").all() as Array<{
    name: string;
  }>;
  assert.ok(configColumns.some(({ name }) => name === "reasoning_level"));
  assert.ok(configColumns.some(({ name }) => name === "service_tier"));

  const actionTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("discord_interaction_actions") as { name: string } | undefined;
  assert.equal(actionTable?.name, "discord_interaction_actions");
  const actionColumns = db
    .prepare("PRAGMA table_info(discord_interaction_actions)")
    .all() as Array<{ name: string }>;
  assert.ok(actionColumns.some(({ name }) => name === "discord_message_id"));

  const routeTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("discord_interaction_routes") as { name: string } | undefined;
  assert.equal(routeTable?.name, "discord_interaction_routes");
}

test("a fresh database applies the current migration history", () => {
  const db = new DatabaseSync(":memory:");
  applyFrom(db, migrations);
  assertCurrentSchema(db);
  db.close();
});

test("the current history repairs the failed v0.0.4 to v0.0.5 upgrade", () => {
  const db = new DatabaseSync(":memory:");

  // v0.0.4 applied ids 0-10. v0.0.5 inserted two statements at ids 8-9,
  // so its attempt at id 11 tried to add reasoning_level for a second time.
  applyFrom(db, legacyMigrations);
  const brokenV005Migrations = [
    ...legacyMigrations.slice(0, 8),
    ...interactionActionMigrations,
    ...legacyMigrations.slice(8),
  ];
  assert.throws(
    () => applyFrom(db, brokenV005Migrations, legacyMigrations.length),
    /duplicate column name: reasoning_level/,
  );

  // The repaired history keeps ids 0-10 unchanged and adds the new table at
  // ids 11 onward, so it can resume without deleting or rewriting user data.
  applyFrom(db, migrations, legacyMigrations.length);
  assertCurrentSchema(db);
  db.close();
});

test("a database first created by v0.0.5 remains compatible", () => {
  const db = new DatabaseSync(":memory:");
  const brokenV005Migrations = [
    ...legacyMigrations.slice(0, 8),
    ...interactionActionMigrations,
    ...legacyMigrations.slice(8),
  ];

  applyFrom(db, brokenV005Migrations);
  applyFrom(db, migrations, brokenV005Migrations.length);
  assertCurrentSchema(db);
  db.close();
});

test("interaction routes are appended after the already-shipped action migrations", () => {
  assert.equal(
    migrations[legacyMigrations.length],
    interactionActionMigrations[0],
  );
  assert.equal(
    migrations[legacyMigrations.length + interactionActionMigrations.length],
    interactionRouteMigrations[0],
  );
  assert.equal(
    migrations[
      legacyMigrations.length +
        interactionActionMigrations.length +
        interactionRouteMigrations.length
    ],
    interactionMessageMigrations[0],
  );
});
