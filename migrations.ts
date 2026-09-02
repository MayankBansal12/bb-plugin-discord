// BB uses each statement's array index as its migration id. Keep this v0.0.4
// prefix byte-for-byte and append every new migration after it so upgrades
// cannot reinterpret an already-applied id as a different statement.
export const legacyMigrations = [
  `CREATE TABLE IF NOT EXISTS discord_threads (
    discord_channel_id TEXT PRIMARY KEY,
    discord_thread_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    bb_thread_id TEXT NOT NULL UNIQUE,
    bb_project_id TEXT,
    title TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS discord_threads_bb_idx ON discord_threads(bb_thread_id)`,
  `CREATE TABLE IF NOT EXISTS discord_seen_messages (
    discord_message_id TEXT PRIMARY KEY,
    discord_channel_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS discord_posted_replies (
    bb_thread_id TEXT NOT NULL,
    reply_hash TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (bb_thread_id, reply_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS discord_posted_interactions (
    bb_thread_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (bb_thread_id, interaction_id)
  )`,
  `CREATE TABLE IF NOT EXISTS discord_pairing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    guild_id TEXT NOT NULL,
    guild_name TEXT,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    user_id TEXT NOT NULL,
    user_tag TEXT,
    paired_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS discord_allowed_users (
    user_id TEXT PRIMARY KEY,
    user_tag TEXT,
    added_at INTEGER NOT NULL
  )`,
  `ALTER TABLE discord_threads ADD COLUMN discord_parent_channel_id TEXT`,
  `CREATE TABLE IF NOT EXISTS discord_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    permission_mode TEXT NOT NULL DEFAULT 'auto',
    server_access TEXT NOT NULL DEFAULT 'messages',
    allow_destructive INTEGER NOT NULL DEFAULT 0,
    default_project_id TEXT,
    machine_host_id TEXT,
    provider_id TEXT,
    model TEXT,
    spawn_channel_id TEXT,
    home_channel_id TEXT
  )`,
  `ALTER TABLE discord_config ADD COLUMN reasoning_level TEXT`,
  `ALTER TABLE discord_config ADD COLUMN service_tier TEXT`,
] as const;

export const interactionActionMigrations = [
  `CREATE TABLE IF NOT EXISTS discord_interaction_actions (
    token TEXT PRIMARY KEY,
    bb_thread_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decision TEXT,
    resolved_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS discord_interaction_actions_thread_idx
    ON discord_interaction_actions(bb_thread_id, interaction_id)`,
] as const;

export const migrations = [...legacyMigrations, ...interactionActionMigrations];
