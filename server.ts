// bb-plugin-discord — drive BB agent threads from a Discord server.
//
// One Discord thread ↔ one BB thread. You @bb in a Discord thread, the plugin
// spawns a BB thread and replies with its title. You keep typing in the same
// Discord thread; each message is forwarded as a follow-up to the BB thread.
// When the BB agent goes idle, its reply is posted back into the Discord
// thread. If the agent is asking a question or wants approval, the bot posts
// the prompt and bridges your reply to the interaction. Lifecycle pings
// (idle/failed/deleted) also go to a configured home channel for visibility.

import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { DiscordClient, type DiscordInboundMessage } from "./discord.js";

// ---------------------------------------------------------------------------
// Limits and tuning
// ---------------------------------------------------------------------------

const MAX_PROMPT_CHARS = 8000;
const MAX_REPLY_CHARS = 1800; // per Discord chunk, headroom under 2000
const MAX_INTERACTION_PROMPT_CHARS = 1800;
const HOME_CHANNEL_SUMMARY_EVERY_MS = 60_000;

// ---------------------------------------------------------------------------
// Migrations (append-only — never reorder or edit shipped statements)
// ---------------------------------------------------------------------------

const migrations = [
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
];

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ThreadMapRow {
  discord_channel_id: string;
  discord_thread_id: string;
  guild_id: string;
  bb_thread_id: string;
  bb_project_id: string | null;
  title: string | null;
  created_at: number;
  last_activity_at: number;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  // Secret settings: the bot token is stored in a 0600 secrets file, never in
  // the database or sent to the frontend. The guild allowlist and home channel
  // are plain settings.
  const settings = bb.settings.define({
    botToken: {
      type: "string",
      secret: true,
      label: "Discord bot token",
      description:
        "The bot token from the Discord Developer Portal. Stored encrypted on disk; never shown again after you save it.",
    },
    guildId: {
      type: "string",
      label: "Allowed Discord server (guild) ID",
      description:
        "Only messages from this server are processed. Leave blank to disable the bot.",
    },
    homeChannelId: {
      type: "string",
      label: "Home channel ID",
      description:
        "A Discord channel where the bot posts lifecycle pings and reminders for visibility across all threads.",
    },
    spawnChannelId: {
      type: "string",
      label: "Spawn channel ID (optional)",
      description:
        "When set, new threads may only be started from this channel (e.g. a forum channel). Leave blank to allow any channel.",
    },
    defaultProjectId: {
      type: "project",
      label: "Default BB project",
      description:
        "The BB project new threads are spawned into when none is specified.",
    },
  });

  let client: DiscordClient | null = null;

  const getBotUserId = (): string | undefined => client?.getUserId();

  // --- DB helpers --------------------------------------------------------

  const getMapByBbThread = (bbThreadId: string): ThreadMapRow | undefined =>
    db
      .prepare("SELECT * FROM discord_threads WHERE bb_thread_id = ?")
      .get(bbThreadId) as ThreadMapRow | undefined;

  const getMapByDiscordChannel = (discordChannelId: string): ThreadMapRow | undefined =>
    db
      .prepare("SELECT * FROM discord_threads WHERE discord_channel_id = ?")
      .get(discordChannelId) as ThreadMapRow | undefined;

  const insertMap = (row: ThreadMapRow): void => {
    db.prepare(
      `INSERT INTO discord_threads
        (discord_channel_id, discord_thread_id, guild_id, bb_thread_id, bb_project_id, title, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.discord_channel_id,
      row.discord_thread_id,
      row.guild_id,
      row.bb_thread_id,
      row.bb_project_id ?? null,
      row.title,
      row.created_at,
      row.last_activity_at,
    );
  };

  const touchMap = (bbThreadId: string): void => {
    db.prepare("UPDATE discord_threads SET last_activity_at = ? WHERE bb_thread_id = ?")
      .run(Date.now(), bbThreadId);
  };

  const markMessageSeen = (messageId: string, channelId: string): boolean => {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO discord_seen_messages (discord_message_id, discord_channel_id, seen_at) VALUES (?, ?, ?)",
      )
      .run(messageId, channelId, Date.now());
    return result.changes > 0;
  };

  const isReplyPosted = (bbThreadId: string, replyHash: string): boolean =>
    db
      .prepare("SELECT 1 FROM discord_posted_replies WHERE bb_thread_id = ? AND reply_hash = ?")
      .get(bbThreadId, replyHash) !== undefined;

  const markReplyPosted = (bbThreadId: string, replyHash: string): void => {
    db.prepare(
      "INSERT OR IGNORE INTO discord_posted_replies (bb_thread_id, reply_hash, posted_at) VALUES (?, ?, ?)",
    ).run(bbThreadId, replyHash, Date.now());
  };

  const isInteractionPosted = (bbThreadId: string, interactionId: string): boolean =>
    db
      .prepare(
        "SELECT 1 FROM discord_posted_interactions WHERE bb_thread_id = ? AND interaction_id = ?",
      )
      .get(bbThreadId, interactionId) !== undefined;

  const markInteractionPosted = (bbThreadId: string, interactionId: string): void => {
    db.prepare(
      "INSERT OR IGNORE INTO discord_posted_interactions (bb_thread_id, interaction_id, posted_at) VALUES (?, ?, ?)",
    ).run(bbThreadId, interactionId, Date.now());
  };

  // --- Discord plumbing --------------------------------------------------

  const sendToDiscord = async (channelId: string, text: string): Promise<void> => {
    if (!client) return;
    try {
      await client.sendMessage(channelId, text);
    } catch (error) {
      bb.log.warn(`Discord send failed (${channelId}): ${errorMessage(error)}`);
    }
  };

  const postToThreadChannel = async (bbThreadId: string, text: string): Promise<void> => {
    const map = getMapByBbThread(bbThreadId);
    if (!map) return;
    await sendToDiscord(map.discord_channel_id, text);
  };

  const postToHome = async (text: string): Promise<void> => {
    const values = await settings.get();
    const homeId = values.homeChannelId;
    if (!homeId) return;
    await sendToDiscord(homeId, text);
  };

  // --- Thread spawning ---------------------------------------------------

  const resolveProjectId = async (values: {
    defaultProjectId?: string;
  }): Promise<string> => {
    if (values.defaultProjectId) return values.defaultProjectId;
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const personal = projects.find((p) => p.kind === "personal");
      if (personal) return personal.id;
      if (projects.length > 0) return projects[0]!.id;
    } catch (error) {
      bb.log.warn(`Could not list projects: ${errorMessage(error)}`);
    }
    throw new Error(
      "No default BB project configured. Set one in the Discord plugin settings.",
    );
  };

  const spawnThread = async (
    prompt: string,
    discordChannelId: string,
    discordThreadId: string,
    guildId: string,
  ): Promise<string> => {
    const values = await settings.get();
    const projectId = await resolveProjectId(values);
    const providers = await bb.sdk.providers.list();
    const provider = providers.find((p) => p.available);
    if (!provider) throw new Error("No available BB provider was found");
    const models = await bb.sdk.providers.models({ providerId: provider.id });
    const model = models.models[0];
    if (!model) throw new Error(`Provider ${provider.id} has no models`);

    // ThreadSpawnArgs accepts either an `input` array or a plain `prompt`
    // string. The string form avoids the PromptInput discriminated-union
    // typing and is all a forwarded chat message needs.
    type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
    const spawnArgs = {
      projectId,
      providerId: provider.id,
      model: model.model,
      reasoningLevel: "low" as const,
      permissionMode: "auto" as const,
      environment: { type: "project-default" as const },
      prompt,
      title: truncate(`Discord: ${prompt}`, 100),
      visibility: "hidden" as const,
    } as SpawnArgs;

    const thread = await bb.sdk.threads.spawn(spawnArgs);
    const now = Date.now();
    insertMap({
      discord_channel_id: discordChannelId,
      discord_thread_id: discordThreadId,
      guild_id: guildId,
      bb_thread_id: thread.id,
      bb_project_id: projectId,
      title: thread.title ?? null,
      created_at: now,
      last_activity_at: now,
    });
    return thread.id;
  };

  // --- Inbound message handling -----------------------------------------

  const handleInbound = async (message: DiscordInboundMessage): Promise<void> => {
    if (!message.mentioned) return;
    if (!message.content.trim()) return;
    if (message.content.length > MAX_PROMPT_CHARS) {
      await sendToDiscord(message.channelId, "⚠️ Prompt is too long (max 8000 chars).");
      return;
    }
    // Idempotency: ignore replays of a message we already saw (reconnect
    // redelivery). The UNIQUE constraint on discord_message_id makes this safe.
    if (!markMessageSeen(message.messageId, message.channelId)) return;

    const existing = getMapByDiscordChannel(message.channelId);

    if (existing) {
      // Continuing an existing conversation: forward as a follow-up.
      await client?.react(message.channelId, message.messageId, "👍");
      try {
        type SendArgs = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0];
        await bb.sdk.threads.send({
          threadId: existing.bb_thread_id,
          input: [{ type: "text", text: message.content, mentions: [] }],
        } as SendArgs);
        touchMap(existing.bb_thread_id);
      } catch (error) {
        await sendToDiscord(
          message.channelId,
          `⚠️ Could not send your message to the BB thread: ${errorMessage(error)}`,
        );
      }
      return;
    }

    // New conversation: spawn a thread.
    await client?.react(message.channelId, message.messageId, "🚀");
    try {
      const bbThreadId = await spawnThread(
        message.content,
        message.channelId,
        message.channelId,
        message.guildId,
      );
      const thread = await bb.sdk.threads.get({ threadId: bbThreadId });
      await sendToDiscord(
        message.channelId,
        `✅ Started BB thread \`${bbThreadId}\`${thread.title ? ` — ${thread.title}` : ""}. I'll post the agent's replies here.`,
      );
    } catch (error) {
      await sendToDiscord(
        message.channelId,
        `⚠️ Could not start a BB thread: ${errorMessage(error)}`,
      );
    }
  };

  // --- Lifecycle event bridging -----------------------------------------

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const map = getMapByBbThread(thread.id);
    if (!map) return;
    touchMap(thread.id);

    // Post the agent's reply text, if any, deduplicated by content hash so a
    // repeated idle with the same text doesn't flood the channel.
    if (lastAssistantText && lastAssistantText.trim()) {
      const trimmed = lastAssistantText.trim();
      const replyHash = hashString(trimmed);
      if (!isReplyPosted(thread.id, replyHash)) {
        await postToThreadChannel(thread.id, truncate(trimmed, MAX_REPLY_CHARS));
        markReplyPosted(thread.id, replyHash);
      }
    }

    // Check for pending interactions the agent is waiting on.
    try {
      const interactions = await bb.sdk.threads.interactions.list({ threadId: thread.id });
      for (const interaction of interactions ?? []) {
        if (isInteractionPosted(thread.id, interaction.id)) continue;
        const summary = describeInteraction(interaction);
        if (summary) {
          await postToThreadChannel(
            thread.id,
            `❓ **BB needs you:** ${truncate(summary, MAX_INTERACTION_PROMPT_CHARS)}\n_Reply here to answer, or type \`/bb approve\` or \`/bb deny\`._`,
          );
          markInteractionPosted(thread.id, interaction.id);
        }
      }
    } catch (error) {
      bb.log.warn(
        `Could not list interactions for ${thread.id}: ${errorMessage(error)}`,
      );
    }
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    const map = getMapByBbThread(thread.id);
    if (!map) return;
    const reason = error?.trim() || "The BB thread failed.";
    await postToThreadChannel(thread.id, `❌ **BB thread failed:** ${reason}`);
    await postToHome(`❌ Thread \`${thread.id}\` failed: ${reason}`);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    const map = getMapByBbThread(thread.id);
    if (!map) return;
    db.prepare(
      "UPDATE discord_threads SET bb_project_id = NULL, title = COALESCE(title, 'deleted') WHERE bb_thread_id = ?",
    ).run(thread.id);
    await postToThreadChannel(
      thread.id,
      "🗑️ The linked BB thread was deleted. This Discord thread is no longer connected.",
    );
  });

  // --- CLI for approve/deny/status --------------------------------------

  bb.cli.register({
    name: "discord",
    summary: "Manage the Discord BB bridge",
    commands: [
      { name: "status", summary: "Show Discord bridge status", usage: "bb discord status" },
    ],
    async run() {
      const rows = db
        .prepare("SELECT * FROM discord_threads ORDER BY last_activity_at DESC LIMIT 10")
        .all() as ThreadMapRow[];
      const lines = rows.map(
        (r) =>
          `${r.bb_thread_id} ↔ #${r.discord_thread_id} — ${r.title ?? "(untitled)"}`,
      );
      return {
        exitCode: 0,
        stdout:
          lines.length > 0
            ? `Discord bridge (${rows.length} recent):\n${lines.join("\n")}`
            : "No Discord-bridged threads yet.",
      };
    },
  });

  // --- Background service: the Gateway bot -------------------------------
  //
  // Runs the discord.js client for the lifetime of the plugin. A crash
  // restarts it with capped backoff (owned by the host). We log in once the
  // factory completes and resolve when the signal aborts on dispose/reload.

  bb.background.service("discord-gateway", {
    async start(signal) {
      const values = await settings.get();
      const token = values.botToken;
      const guildId = values.guildId;
      if (!token || !guildId) {
        bb.status.needsConfiguration(
          "Set a Discord bot token and guild ID in the Discord plugin settings.",
        );
        bb.log.warn("Discord bot disabled: missing token or guild ID");
        return;
      }

      client = new DiscordClient({
        token,
        allowedGuildIds: [guildId],
        botUserId: getBotUserId,
        onMessage: (message) => handleInbound(message),
        onReady: async () => {
          await postToHome("🟢 Discord BB bridge is online.");
        },
        log: {
          info: (m) => bb.log.info(m),
          warn: (m) => bb.log.warn(m),
          error: (m) => bb.log.error(m),
        },
      });

      try {
        await client.login();
      } catch (error) {
        bb.log.error(`Discord login failed: ${errorMessage(error)}`);
        bb.status.needsConfiguration("Discord login failed. Check the bot token.");
        return;
      }

      // Keep the service alive until disposed.
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });

      await client.destroy();
      client = null;
    },
  });

  bb.onDispose(async () => {
    if (client) await client.destroy();
  });

  bb.log.info("Discord plugin loaded");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Produce a short human prompt from an interaction's kind/payload. */
function describeInteraction(interaction: {
  id: string;
  kind?: string;
  type?: string;
  message?: string | null;
  prompt?: string | null;
  description?: string | null;
  title?: string | null;
}): string | null {
  const text =
    interaction.message ??
    interaction.prompt ??
    interaction.description ??
    interaction.title ??
    null;
  const label = interaction.kind ?? interaction.type ?? "interaction";
  if (text) return `${label}: ${text}`;
  return `BB is waiting on a ${label}. Open the thread to respond.`;
}
