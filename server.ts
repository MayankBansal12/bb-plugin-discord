// bb-plugin-discord — drive BB agent threads from an allowlisted Discord account.

import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  describePendingInteraction,
  isAllowedSpawnLocation,
  parseDiscordIds,
  resolveInteractionReply,
  type PendingInteractionLike,
} from "./bridge.js";
import { DiscordClient, type DiscordInboundMessage } from "./discord.js";

const MAX_PROMPT_CHARS = 8000;
const MAX_REPLY_CHARS = 1800;
const MAX_INTERACTION_PROMPT_CHARS = 1800;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const settings = bb.settings.define({
    botToken: {
      type: "string",
      secret: true,
      label: "Discord bot token",
      description:
        "Stored in a permission-restricted secret file and never sent to the frontend.",
    },
    guildId: {
      type: "string",
      label: "Allowed Discord server (guild) ID",
      description: "Only messages from this server are processed.",
    },
    allowedUserIds: {
      type: "string",
      label: "Allowed Discord user IDs",
      description:
        "Required. Comma- or space-separated user IDs allowed to control BB.",
    },
    homeChannelId: {
      type: "string",
      label: "Home channel ID",
      description: "Optional channel for bridge status and lifecycle alerts.",
    },
    spawnChannelId: {
      type: "string",
      label: "Spawn channel ID",
      description:
        "Optional. New BB conversations must start in this channel or one of its threads.",
    },
    defaultProjectId: {
      type: "project",
      label: "Default BB project",
      description: "Project used for new Discord-started BB threads.",
    },
  });

  const initial = await settings.get();
  if (
    !initial.botToken ||
    !initial.guildId ||
    parseDiscordIds(initial.allowedUserIds).length === 0
  ) {
    bb.status.needsConfiguration(
      "Set the Discord bot token, guild ID, and at least one allowed Discord user ID.",
    );
  }

  let client: DiscordClient | null = null;
  const getBotUserId = (): string | undefined => client?.getUserId();

  const getMapByBbThread = (bbThreadId: string): ThreadMapRow | undefined =>
    db
      .prepare("SELECT * FROM discord_threads WHERE bb_thread_id = ?")
      .get(bbThreadId) as ThreadMapRow | undefined;

  const getMapByDiscordChannel = (
    discordChannelId: string,
  ): ThreadMapRow | undefined =>
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
      row.bb_project_id,
      row.title,
      row.created_at,
      row.last_activity_at,
    );
  };

  const touchMap = (bbThreadId: string): void => {
    db.prepare(
      "UPDATE discord_threads SET last_activity_at = ? WHERE bb_thread_id = ?",
    ).run(Date.now(), bbThreadId);
  };

  const markMessageSeen = (messageId: string, channelId: string): boolean => {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO discord_seen_messages (discord_message_id, discord_channel_id, seen_at) VALUES (?, ?, ?)",
      )
      .run(messageId, channelId, Date.now());
    return result.changes > 0;
  };

  const retryMessage = (messageId: string): void => {
    db.prepare("DELETE FROM discord_seen_messages WHERE discord_message_id = ?").run(
      messageId,
    );
  };

  const isReplyPosted = (bbThreadId: string, replyHash: string): boolean =>
    db
      .prepare(
        "SELECT 1 FROM discord_posted_replies WHERE bb_thread_id = ? AND reply_hash = ?",
      )
      .get(bbThreadId, replyHash) !== undefined;

  const markReplyPosted = (bbThreadId: string, replyHash: string): void => {
    const replaceLast = db.transaction(() => {
      db.prepare("DELETE FROM discord_posted_replies WHERE bb_thread_id = ?").run(
        bbThreadId,
      );
      db.prepare(
        "INSERT INTO discord_posted_replies (bb_thread_id, reply_hash, posted_at) VALUES (?, ?, ?)",
      ).run(bbThreadId, replyHash, Date.now());
    });
    replaceLast();
  };

  const isInteractionPosted = (
    bbThreadId: string,
    interactionId: string,
  ): boolean =>
    db
      .prepare(
        "SELECT 1 FROM discord_posted_interactions WHERE bb_thread_id = ? AND interaction_id = ?",
      )
      .get(bbThreadId, interactionId) !== undefined;

  const markInteractionPosted = (
    bbThreadId: string,
    interactionId: string,
  ): void => {
    db.prepare(
      "INSERT OR IGNORE INTO discord_posted_interactions (bb_thread_id, interaction_id, posted_at) VALUES (?, ?, ?)",
    ).run(bbThreadId, interactionId, Date.now());
  };

  const sendToDiscord = async (
    channelId: string,
    text: string,
  ): Promise<boolean> => {
    if (!client) return false;
    try {
      await client.sendMessage(channelId, text);
      return true;
    } catch (error) {
      bb.log.warn(`Discord send failed (${channelId}): ${errorMessage(error)}`);
      return false;
    }
  };

  const postToThreadChannel = async (
    bbThreadId: string,
    text: string,
  ): Promise<boolean> => {
    const map = getMapByBbThread(bbThreadId);
    return map ? sendToDiscord(map.discord_channel_id, text) : false;
  };

  const postToHome = async (text: string): Promise<boolean> => {
    const values = await settings.get();
    return values.homeChannelId
      ? sendToDiscord(values.homeChannelId, text)
      : false;
  };

  const resolveProjectId = async (configured?: string): Promise<string> => {
    if (configured) return configured;
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((project) => project.kind === "personal");
    const projectId = personal?.id ?? projects[0]?.id;
    if (!projectId) {
      throw new Error(
        "No BB project is available. Configure a default project in the Discord plugin settings.",
      );
    }
    return projectId;
  };

  const spawnThread = async (
    prompt: string,
    message: DiscordInboundMessage,
  ): Promise<string> => {
    const values = await settings.get();
    const projectId = await resolveProjectId(values.defaultProjectId);
    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId });
    if (!defaults) {
      throw new Error(
        "The selected BB project has no execution defaults. Open BB once and choose a provider/model for that project.",
      );
    }

    const attributedPrompt = `Discord request from ${message.authorTag} (${message.authorId}):\n\n${prompt}`;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      providerId: defaults.providerId,
      model: defaults.model,
      reasoningLevel: defaults.reasoningLevel,
      permissionMode: defaults.permissionMode,
      serviceTier: defaults.serviceTier,
      environment: { type: "project-default" },
      prompt: attributedPrompt,
      title: truncate(`Discord: ${prompt}`, 100),
      visibility: "hidden",
    });

    const now = Date.now();
    insertMap({
      discord_channel_id: message.channelId,
      discord_thread_id: message.channelId,
      guild_id: message.guildId,
      bb_thread_id: thread.id,
      bb_project_id: projectId,
      title: thread.title ?? null,
      created_at: now,
      last_activity_at: now,
    });
    return thread.id;
  };

  const handleInteractionReply = async (
    map: ThreadMapRow,
    message: DiscordInboundMessage,
  ): Promise<boolean> => {
    const interactions = await bb.sdk.threads.interactions.list({
      threadId: map.bb_thread_id,
    });
    const pending = interactions.filter(
      (interaction) => interaction.status === "pending",
    );
    if (pending.length === 0) return false;
    if (pending.length > 1) {
      await sendToDiscord(
        message.channelId,
        "⚠️ BB has multiple pending interactions. Open the BB thread to answer them unambiguously.",
      );
      return true;
    }

    const interaction = pending[0]!;
    const action = resolveInteractionReply(
      interaction as PendingInteractionLike,
      message.content,
    );
    if (action.kind === "error") {
      await sendToDiscord(message.channelId, `⚠️ ${action.message}`);
      return true;
    }

    if (action.kind === "respond") {
      await bb.sdk.threads.interactions.respond({
        threadId: map.bb_thread_id,
        interactionId: interaction.id,
        value: action.value,
      });
    } else {
      await bb.sdk.threads.interactions.resolve({
        threadId: map.bb_thread_id,
        interactionId: interaction.id,
        resolution: action.resolution,
      });
    }
    touchMap(map.bb_thread_id);
    await client?.react(message.channelId, message.messageId, "✅");
    return true;
  };

  const handleInbound = async (
    message: DiscordInboundMessage,
  ): Promise<void> => {
    if (!message.content.trim()) return;
    const existing = getMapByDiscordChannel(message.channelId);

    // Existing mapped channels accept ordinary replies. New conversations
    // require an explicit bot mention.
    if (!existing && !message.mentioned) return;
    if (message.content.length > MAX_PROMPT_CHARS) {
      await sendToDiscord(
        message.channelId,
        `⚠️ Prompt is too long (max ${MAX_PROMPT_CHARS} characters).`,
      );
      return;
    }
    if (!markMessageSeen(message.messageId, message.channelId)) return;

    if (existing) {
      try {
        if (await handleInteractionReply(existing, message)) return;
        await client?.react(message.channelId, message.messageId, "👍");
        await bb.sdk.threads.send({
          threadId: existing.bb_thread_id,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `Discord follow-up from ${message.authorTag} (${message.authorId}):\n\n${message.content}`,
              mentions: [],
            },
          ],
        });
        touchMap(existing.bb_thread_id);
      } catch (error) {
        retryMessage(message.messageId);
        await sendToDiscord(
          message.channelId,
          `⚠️ Could not send your message to BB: ${errorMessage(error)}`,
        );
      }
      return;
    }

    const values = await settings.get();
    if (!isAllowedSpawnLocation(message, values.spawnChannelId)) {
      await sendToDiscord(
        message.channelId,
        "⚠️ New BB conversations are not allowed in this channel.",
      );
      return;
    }

    await client?.react(message.channelId, message.messageId, "🚀");
    try {
      const bbThreadId = await spawnThread(message.content, message);
      const thread = await bb.sdk.threads.get({ threadId: bbThreadId });
      await sendToDiscord(
        message.channelId,
        `✅ Started BB thread \`${bbThreadId}\`${thread.title ? ` — ${thread.title}` : ""}. Future replies in this Discord channel will be forwarded without another mention.`,
      );
    } catch (error) {
      retryMessage(message.messageId);
      await sendToDiscord(
        message.channelId,
        `⚠️ Could not start a BB thread: ${errorMessage(error)}`,
      );
    }
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const map = getMapByBbThread(thread.id);
    if (!map) return;
    touchMap(thread.id);

    if (lastAssistantText?.trim()) {
      const trimmed = lastAssistantText.trim();
      const replyHash = hashString(trimmed);
      if (!isReplyPosted(thread.id, replyHash)) {
        const posted = await postToThreadChannel(
          thread.id,
          truncate(trimmed, MAX_REPLY_CHARS),
        );
        if (posted) markReplyPosted(thread.id, replyHash);
      }
    }

    try {
      const interactions = await bb.sdk.threads.interactions.list({
        threadId: thread.id,
      });
      for (const interaction of interactions) {
        if (
          interaction.status !== "pending" ||
          isInteractionPosted(thread.id, interaction.id)
        ) {
          continue;
        }
        const summary = describePendingInteraction(
          interaction as PendingInteractionLike,
        );
        const instructions =
          interaction.payload.kind === "approval"
            ? "Reply `approve`, `approve session`, or `deny`."
            : "Reply here to answer.";
        const posted = await postToThreadChannel(
          thread.id,
          `❓ **BB needs you:** ${truncate(summary, MAX_INTERACTION_PROMPT_CHARS)}\n_${instructions}_`,
        );
        if (posted) markInteractionPosted(thread.id, interaction.id);
      }
    } catch (error) {
      bb.log.warn(
        `Could not list interactions for ${thread.id}: ${errorMessage(error)}`,
      );
    }
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    if (!getMapByBbThread(thread.id)) return;
    const reason = error?.trim() || "The BB thread failed.";
    await postToThreadChannel(thread.id, `❌ **BB thread failed:** ${reason}`);
    await postToHome(`❌ Thread \`${thread.id}\` failed: ${reason}`);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    const map = getMapByBbThread(thread.id);
    if (!map) return;
    await sendToDiscord(
      map.discord_channel_id,
      "🗑️ The linked BB thread was deleted. Mention the bot to start a new conversation here.",
    );
    const removeMap = db.transaction(() => {
      db.prepare("DELETE FROM discord_threads WHERE bb_thread_id = ?").run(thread.id);
      db.prepare("DELETE FROM discord_posted_replies WHERE bb_thread_id = ?").run(
        thread.id,
      );
      db.prepare(
        "DELETE FROM discord_posted_interactions WHERE bb_thread_id = ?",
      ).run(thread.id);
    });
    removeMap();
  });

  bb.cli.register({
    name: "discord",
    summary: "Manage the Discord BB bridge",
    commands: [
      {
        name: "status",
        summary: "Show bridge connection and recent mapped threads",
        usage: "bb discord status",
      },
    ],
    async run(argv) {
      if (argv.length > 0 && argv[0] !== "status") {
        return {
          exitCode: 2,
          stderr: "Usage: bb discord status",
        };
      }
      const rows = db
        .prepare(
          "SELECT * FROM discord_threads ORDER BY last_activity_at DESC LIMIT 10",
        )
        .all() as ThreadMapRow[];
      const lines = rows.map(
        (row) =>
          `${row.bb_thread_id} ↔ #${row.discord_thread_id} — ${row.title ?? "(untitled)"}`,
      );
      return {
        exitCode: 0,
        stdout: [
          `Discord gateway: ${client?.isReady() ? "connected" : "not connected"}`,
          lines.length > 0
            ? `Recent mappings:\n${lines.join("\n")}`
            : "No Discord-bridged threads yet.",
        ].join("\n"),
      };
    },
  });

  bb.background.service("discord-gateway", {
    async start(signal) {
      const values = await settings.get();
      const allowedAuthorIds = parseDiscordIds(values.allowedUserIds);
      if (!values.botToken || !values.guildId || allowedAuthorIds.length === 0) {
        throw needsConfigurationError(
          "Set the Discord bot token, guild ID, and at least one allowed Discord user ID.",
        );
      }

      client = new DiscordClient({
        token: values.botToken,
        allowedGuildIds: [values.guildId],
        allowedAuthorIds,
        botUserId: getBotUserId,
        onMessage: handleInbound,
        onReady: async () => {
          await postToHome("🟢 Discord BB bridge is online.");
        },
        log: {
          info: (message) => bb.log.info(message),
          warn: (message) => bb.log.warn(message),
          error: (message) => bb.log.error(message),
        },
      });

      try {
        await client.login();
      } catch (error) {
        await client.destroy();
        client = null;
        throw needsConfigurationError(
          `Discord login failed. Check the bot token: ${errorMessage(error)}`,
        );
      }

      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });

      await client.destroy();
      client = null;
    },
  });

  bb.background.schedule("cleanup", "0 4 * * *", async () => {
    const cutoff = Date.now() - RETENTION_MS;
    db.prepare("DELETE FROM discord_seen_messages WHERE seen_at < ?").run(cutoff);
    db.prepare("DELETE FROM discord_posted_replies WHERE posted_at < ?").run(cutoff);
    db.prepare("DELETE FROM discord_posted_interactions WHERE posted_at < ?").run(
      cutoff,
    );
  });

  bb.onDispose(async () => {
    if (client) {
      await client.destroy();
      client = null;
    }
  });

  bb.log.info("Discord plugin loaded");
}

function needsConfigurationError(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

function hashString(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
