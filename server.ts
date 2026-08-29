// bb-plugin-discord — drive BB agent threads from a paired Discord server.

import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  describePendingInteraction,
  isAllowedSpawnLocation,
  parseDiscordIds,
  resolveInteractionReply,
  type PendingInteractionLike,
} from "./bridge.js";
import { DiscordClient, type DiscordInboundMessage } from "./discord.js";
import {
  classifyDiscordError,
  formatPairingCode,
  generatePairingCode,
  inviteUrlFromToken,
  pairingFailureMessage,
  parsePairCommand,
  resolveSpawnPermissionMode,
  retryDelayMs,
  verifyPairingCode,
  type BbPermissionMode,
  type DiscordAccessLevel,
  type PendingPairingCode,
} from "./pairing.js";
import { availableToolNames, registerDiscordTools } from "./tools.js";

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

interface PairingRow {
  id: number;
  guild_id: string;
  guild_name: string | null;
  channel_id: string;
  channel_name: string | null;
  user_id: string;
  user_tag: string | null;
  paired_at: number;
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
        "The only required setting. Paste it, then run `bb discord pair` to link a server. Stored in a permission-restricted secret file and never sent to the frontend.",
    },
    defaultProjectId: {
      type: "project",
      label: "Default BB project",
      description:
        "Project used for Discord-started BB threads. Leave empty to use your personal project.",
    },
    permissionMode: {
      type: "select",
      label: "Permission mode for Discord threads",
      options: ["accept-edits", "auto", "full", "project-default"],
      default: "accept-edits",
      description:
        "Discord is the least trusted input BB takes, so threads started from it run in the least privileged mode by default.",
    },
    serverAccess: {
      type: "select",
      label: "Discord server access",
      options: ["messages", "full"],
      default: "messages",
      description:
        "messages: the agent can read and post messages and threads. full: the agent can also administer channels, roles and members of the paired server.",
    },
    allowDestructiveServerActions: {
      type: "boolean",
      label: "Allow destructive server actions",
      default: false,
      description:
        "Permits deleting channels and kicking, banning or timing out members. Requires full server access.",
    },
    spawnChannelId: {
      type: "string",
      label: "Restrict new conversations to a channel",
      description:
        "Optional. Leave empty to let the bot start conversations anywhere in the paired server.",
    },
    homeChannelId: {
      type: "string",
      label: "Home channel ID",
      description:
        "Optional. Bridge status and failure alerts go here; defaults to the channel you paired in.",
    },
    guildId: {
      type: "string",
      label: "Advanced: server (guild) ID",
      description:
        "Normally filled in by pairing. Set this only to pin a server by hand.",
    },
    allowedUserIds: {
      type: "string",
      label: "Advanced: additional Discord user IDs",
      description:
        "Optional. Comma- or space-separated. The user who paired is always allowed; `bb discord allow <id>` is the easier way to add more.",
    },
  });

  type SettingsValues = Awaited<ReturnType<typeof settings.get>>;

  let cached: SettingsValues = await settings.get();
  let client: DiscordClient | null = null;
  let pendingCode: PendingPairingCode | null = null;
  let lastStatusMessage: string | null = null;
  let botTag: string | null = null;

  // Waiters are released on abort, on a bot-token change, or on a timeout, so
  // the gateway can reconnect without `bb plugin reload discord`.
  const waiters = new Set<() => void>();
  const wakeAll = (): void => {
    for (const wake of [...waiters]) wake();
  };

  const waitForWake = (signal: AbortSignal, ms?: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (ms !== undefined) timer = setTimeout(done, ms);
    });

  settings.onChange((next, prev) => {
    cached = next;
    if (next.botToken !== prev.botToken) {
      // Only the token requires a new gateway connection; everything else is
      // read per message.
      lastStatusMessage = null;
      wakeAll();
    }
  });

  const setNeedsConfiguration = (message: string): void => {
    if (message === lastStatusMessage) return;
    lastStatusMessage = message;
    bb.status.needsConfiguration(message);
  };

  // ---------------------------------------------------------------------
  // Pairing state
  // ---------------------------------------------------------------------

  const getPairing = (): PairingRow | undefined =>
    db.prepare("SELECT * FROM discord_pairing WHERE id = 1").get() as
      | PairingRow
      | undefined;

  const savePairing = (row: Omit<PairingRow, "id">): void => {
    db.prepare(
      `INSERT INTO discord_pairing
        (id, guild_id, guild_name, channel_id, channel_name, user_id, user_tag, paired_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         guild_id = excluded.guild_id,
         guild_name = excluded.guild_name,
         channel_id = excluded.channel_id,
         channel_name = excluded.channel_name,
         user_id = excluded.user_id,
         user_tag = excluded.user_tag,
         paired_at = excluded.paired_at`,
    ).run(
      row.guild_id,
      row.guild_name,
      row.channel_id,
      row.channel_name,
      row.user_id,
      row.user_tag,
      row.paired_at,
    );
  };

  const clearPairing = (): void => {
    db.prepare("DELETE FROM discord_pairing WHERE id = 1").run();
    db.prepare("DELETE FROM discord_allowed_users").run();
  };

  const extraAllowedUsers = (): string[] =>
    (
      db.prepare("SELECT user_id FROM discord_allowed_users").all() as Array<{
        user_id: string;
      }>
    ).map((row) => row.user_id);

  /**
   * Pairing is the normal path; the legacy `guildId` + `allowedUserIds`
   * settings still work so upgrades do not lose a working configuration.
   */
  const effectiveGuildId = (): string | null => {
    const pairing = getPairing();
    if (pairing) return pairing.guild_id;
    const legacy = cached.guildId?.trim();
    return legacy && parseDiscordIds(cached.allowedUserIds).length > 0
      ? legacy
      : null;
  };

  const effectiveAllowedUsers = (): string[] => {
    const pairing = getPairing();
    const ids = new Set<string>(parseDiscordIds(cached.allowedUserIds));
    for (const id of extraAllowedUsers()) ids.add(id);
    if (pairing) ids.add(pairing.user_id);
    return [...ids];
  };

  const isPaired = (): boolean => effectiveGuildId() !== null;

  const isAuthorized = (guildId: string, authorId: string): boolean => {
    const allowedGuild = effectiveGuildId();
    if (!allowedGuild || guildId !== allowedGuild) return false;
    return effectiveAllowedUsers().includes(authorId);
  };

  const isPairingCandidate = (content: string): boolean =>
    !isPaired() && parsePairCommand(content) !== null;

  const ensurePairingCode = (): PendingPairingCode => {
    if (!pendingCode || pendingCode.expiresAt <= Date.now()) {
      pendingCode = generatePairingCode();
    }
    return pendingCode;
  };

  const pairingInstructions = (): string => {
    const code = ensurePairingCode();
    const invite = inviteUrlFromToken(
      cached.botToken,
      cached.serverAccess === "full" ? "full" : "messages",
    );
    const minutes = Math.max(
      1,
      Math.round((code.expiresAt - Date.now()) / 60_000),
    );
    return [
      botTag
        ? `Discord connected as ${botTag}.`
        : "Discord bot token saved.",
      invite ? `Invite the bot: ${invite}` : null,
      `Then send this in the channel you want to authorize:`,
      `    @${botTag ?? "your bot"} pair ${formatPairingCode(code.code)}`,
      `The code is single-use and expires in ${minutes} minute${minutes === 1 ? "" : "s"}. Run \`bb discord pair\` for a fresh one.`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  };

  const announcePairing = (): void => {
    const text = pairingInstructions();
    bb.log.info(text);
    setNeedsConfiguration(text.replace(/\n+/g, " "));
  };

  // ---------------------------------------------------------------------
  // Thread mapping
  // ---------------------------------------------------------------------

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
    guildId: string,
    channelId: string,
    text: string,
  ): Promise<boolean> => {
    if (!client) return false;
    try {
      await client.sendMessage(guildId, channelId, text);
      return true;
    } catch (error) {
      bb.log.warn(
        `Discord send failed (${channelId}): ${classifyDiscordError(error).message}`,
      );
      return false;
    }
  };

  const postToThreadChannel = async (
    bbThreadId: string,
    text: string,
  ): Promise<boolean> => {
    const map = getMapByBbThread(bbThreadId);
    return map
      ? sendToDiscord(map.guild_id, map.discord_channel_id, text)
      : false;
  };

  const homeChannelId = (): string | null =>
    cached.homeChannelId?.trim() || getPairing()?.channel_id || null;

  const postToHome = async (text: string): Promise<boolean> => {
    const channelId = homeChannelId();
    const guildId = effectiveGuildId();
    return channelId && guildId
      ? sendToDiscord(guildId, channelId, text)
      : false;
  };

  /**
   * Personal project only. "First available project" used to be the fallback,
   * which meant an arbitrary repository could be driven from Discord.
   */
  const resolveProjectId = async (configured?: string): Promise<string> => {
    if (configured) return configured;
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((project) => project.kind === "personal");
    if (!personal) {
      throw new Error(
        "No personal BB project is available. Pick a default project in Settings → Plugins → Discord.",
      );
    }
    return personal.id;
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

    const permissionMode: BbPermissionMode = resolveSpawnPermissionMode(
      values.permissionMode,
      defaults.permissionMode,
    );

    const attributedPrompt = `Discord request from ${message.authorTag} (${message.authorId}):\n\n${prompt}`;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      providerId: defaults.providerId,
      model: defaults.model,
      reasoningLevel: defaults.reasoningLevel,
      permissionMode,
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
        message.guildId,
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
      await sendToDiscord(message.guildId, message.channelId, `⚠️ ${action.message}`);
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
    await client?.react(
      message.guildId,
      message.channelId,
      message.messageId,
      "✅",
    );
    return true;
  };

  const handlePairingMessage = async (
    message: DiscordInboundMessage,
  ): Promise<void> => {
    const command = parsePairCommand(message.content);
    if (!command) return;
    if (!markMessageSeen(message.messageId, message.channelId)) return;

    if (command.kind === "missing-code") {
      await sendToDiscord(
        message.guildId,
        message.channelId,
        "👋 Run `bb discord pair` in BB to get a pairing code, then send `pair <code>` here.",
      );
      return;
    }

    const check = verifyPairingCode(pendingCode, command.code);
    if (!check.ok) {
      await sendToDiscord(
        message.guildId,
        message.channelId,
        `⚠️ ${pairingFailureMessage(check.reason)}`,
      );
      return;
    }

    // Single-use: burn the code before anything else can consume it.
    pendingCode = null;
    savePairing({
      guild_id: message.guildId,
      guild_name: message.guildName,
      channel_id: message.channelId,
      channel_name: message.channelName,
      user_id: message.authorId,
      user_tag: message.authorTag,
      paired_at: Date.now(),
    });
    lastStatusMessage = null;

    const summary = [
      "✅ **Paired with BB.**",
      `• Server: ${message.guildName ?? message.guildId}`,
      `• Authorized user: ${message.authorTag}`,
      `• Home channel: #${message.channelName ?? message.channelId}`,
      "",
      "Mention me anywhere in this server to start a BB thread. Add more people with `bb discord allow <user id>`, or undo this with `bb discord unpair`.",
    ].join("\n");
    bb.log.info(
      `Discord paired: guild=${message.guildId} user=${message.authorId} channel=${message.channelId}`,
    );
    await sendToDiscord(message.guildId, message.channelId, summary);
  };

  const handleInbound = async (
    message: DiscordInboundMessage,
  ): Promise<void> => {
    if (!message.content.trim()) return;

    if (!isPaired()) {
      await handlePairingMessage(message);
      return;
    }
    // Defense in depth: the gateway already gated this, but pairing state can
    // change between the gateway check and here.
    if (!isAuthorized(message.guildId, message.authorId)) return;

    const existing = getMapByDiscordChannel(message.channelId);

    // Existing mapped channels accept ordinary replies. New conversations
    // require an explicit bot mention.
    if (!existing && !message.mentioned) return;
    if (message.content.length > MAX_PROMPT_CHARS) {
      await sendToDiscord(
        message.guildId,
        message.channelId,
        `⚠️ Prompt is too long (max ${MAX_PROMPT_CHARS} characters).`,
      );
      return;
    }
    if (!markMessageSeen(message.messageId, message.channelId)) return;

    if (existing) {
      try {
        if (await handleInteractionReply(existing, message)) return;
        await client?.react(
          message.guildId,
          message.channelId,
          message.messageId,
          "👍",
        );
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
          message.guildId,
          message.channelId,
          `⚠️ Could not send your message to BB: ${errorMessage(error)}`,
        );
      }
      return;
    }

    const values = await settings.get();
    if (!isAllowedSpawnLocation(message, values.spawnChannelId)) {
      await sendToDiscord(
        message.guildId,
        message.channelId,
        "⚠️ New BB conversations are not allowed in this channel.",
      );
      return;
    }

    await client?.react(
      message.guildId,
      message.channelId,
      message.messageId,
      "🚀",
    );
    try {
      const bbThreadId = await spawnThread(message.content, message);
      const thread = await bb.sdk.threads.get({ threadId: bbThreadId });
      await sendToDiscord(
        message.guildId,
        message.channelId,
        `✅ Started BB thread \`${bbThreadId}\`${thread.title ? ` — ${thread.title}` : ""}. Future replies in this Discord channel will be forwarded without another mention.`,
      );
    } catch (error) {
      retryMessage(message.messageId);
      await sendToDiscord(
        message.guildId,
        message.channelId,
        `⚠️ Could not start a BB thread: ${errorMessage(error)}`,
      );
    }
  };

  // ---------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------

  const accessLevel = (): DiscordAccessLevel =>
    cached.serverAccess === "full" ? "full" : "messages";

  registerDiscordTools(bb, {
    getClient: () => client,
    getGuildId: () => effectiveGuildId(),
    getAccessLevel: accessLevel,
    allowsDestructive: () => cached.allowDestructiveServerActions === true,
  });

  bb.agents.configure(() => ({
    tools: availableToolNames(
      accessLevel(),
      cached.allowDestructiveServerActions === true,
      isPaired(),
    ),
    skills: [],
  }));

  // ---------------------------------------------------------------------
  // Thread lifecycle
  // ---------------------------------------------------------------------

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
      map.guild_id,
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

  // ---------------------------------------------------------------------
  // CLI
  // ---------------------------------------------------------------------

  bb.cli.register({
    name: "discord",
    summary: "Manage the Discord BB bridge",
    commands: [
      {
        name: "status",
        summary: "Show connection, pairing, and recent mapped threads",
        usage: "bb discord status",
      },
      {
        name: "pair",
        summary: "Show a one-time pairing code to send in Discord",
        usage: "bb discord pair",
      },
      {
        name: "unpair",
        summary: "Forget the paired server and allowed users",
        usage: "bb discord unpair",
      },
      {
        name: "invite",
        summary: "Print the bot invite URL for this token",
        usage: "bb discord invite [--full]",
      },
      {
        name: "allow",
        summary: "Authorize another Discord user",
        usage: "bb discord allow <user-id>",
      },
      {
        name: "revoke",
        summary: "Remove an authorized Discord user",
        usage: "bb discord revoke <user-id>",
      },
    ],
    async run(argv) {
      const [command = "status", ...rest] = argv;

      if (command === "status") {
        const pairing = getPairing();
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
            `Discord gateway: ${client?.isReady() ? `connected as ${botTag ?? "?"}` : "not connected"}`,
            pairing
              ? `Paired: ${pairing.guild_name ?? pairing.guild_id} · #${pairing.channel_name ?? pairing.channel_id} · ${pairing.user_tag ?? pairing.user_id}`
              : cached.botToken
                ? "Paired: no — run `bb discord pair`"
                : "Paired: no — add the bot token in Settings → Plugins → Discord",
            `Authorized users: ${effectiveAllowedUsers().join(", ") || "(none)"}`,
            `Server access: ${accessLevel()}${cached.allowDestructiveServerActions ? " (destructive actions enabled)" : ""}`,
            `Thread permission mode: ${cached.permissionMode ?? "accept-edits"}`,
            lines.length > 0
              ? `Recent mappings:\n${lines.join("\n")}`
              : "No Discord-bridged threads yet.",
          ].join("\n"),
        };
      }

      if (command === "pair") {
        if (!cached.botToken) {
          return {
            exitCode: 1,
            stderr:
              "No bot token yet. Add it in Settings → Plugins → Discord, then run `bb discord pair`.",
          };
        }
        const pairing = getPairing();
        if (pairing) {
          return {
            exitCode: 0,
            stdout: `Already paired with ${pairing.guild_name ?? pairing.guild_id}. Run \`bb discord unpair\` first to pair somewhere else.`,
          };
        }
        return { exitCode: 0, stdout: pairingInstructions() };
      }

      if (command === "unpair") {
        const pairing = getPairing();
        if (!pairing) return { exitCode: 0, stdout: "Not paired." };
        clearPairing();
        pendingCode = null;
        lastStatusMessage = null;
        return {
          exitCode: 0,
          stdout: `Unpaired from ${pairing.guild_name ?? pairing.guild_id}. Run \`bb discord pair\` to link a server again.`,
        };
      }

      if (command === "invite") {
        const level =
          rest.includes("--full") || accessLevel() === "full" ? "full" : "messages";
        const url = inviteUrlFromToken(cached.botToken, level);
        if (!url) {
          return {
            exitCode: 1,
            stderr:
              "Could not derive the application id from the bot token. Check the token in Settings → Plugins → Discord.",
          };
        }
        return {
          exitCode: 0,
          stdout: `Invite URL (${level} access):\n${url}`,
        };
      }

      if (command === "allow" || command === "revoke") {
        const [userId] = parseDiscordIds(rest.join(" "));
        if (!userId) {
          return {
            exitCode: 2,
            stderr: `Usage: bb discord ${command} <discord-user-id>`,
          };
        }
        if (command === "allow") {
          db.prepare(
            "INSERT OR IGNORE INTO discord_allowed_users (user_id, user_tag, added_at) VALUES (?, ?, ?)",
          ).run(userId, null, Date.now());
          return { exitCode: 0, stdout: `Authorized ${userId}.` };
        }
        const pairing = getPairing();
        if (pairing?.user_id === userId) {
          return {
            exitCode: 1,
            stderr:
              "That user paired this server and cannot be revoked. Run `bb discord unpair` instead.",
          };
        }
        db.prepare("DELETE FROM discord_allowed_users WHERE user_id = ?").run(userId);
        return { exitCode: 0, stdout: `Revoked ${userId}.` };
      }

      return {
        exitCode: 2,
        stderr:
          "Usage: bb discord <status|pair|unpair|invite|allow|revoke>",
      };
    },
  });

  // ---------------------------------------------------------------------
  // Gateway service
  // ---------------------------------------------------------------------

  const runGateway = async (
    token: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const created = new DiscordClient({
      token,
      isAuthorized,
      isPairingCandidate,
      botUserId: getBotUserId,
      onMessage: handleInbound,
      onReady: async (tag) => {
        botTag = tag;
        if (isPaired()) {
          await postToHome(`🟢 Discord BB bridge is online as ${tag}.`);
        } else {
          announcePairing();
        }
      },
      onSuspectedMissingContentIntent: () => {
        const message =
          "Discord messages are arriving without text. Enable Message Content Intent in the Discord Developer Portal → your application → Bot, then reconnect.";
        bb.log.warn(message);
        void postToHome(`⚠️ ${message}`);
      },
      log: {
        info: (message) => bb.log.info(message),
        warn: (message) => bb.log.warn(message),
        error: (message) => bb.log.error(message),
      },
    });

    client = created;
    try {
      await created.login();
    } catch (error) {
      client = null;
      await created.destroy().catch(() => {});
      throw error;
    }

    await waitForWake(signal);
    client = null;
    botTag = null;
    await created.destroy().catch(() => {});
  };

  bb.background.service("discord-gateway", {
    async start(signal) {
      let attempt = 0;
      while (!signal.aborted) {
        const values = await settings.get();
        cached = values;

        if (!values.botToken) {
          setNeedsConfiguration(
            "Add your Discord bot token in Settings → Plugins → Discord. That is the only setting needed to begin; pairing does the rest.",
          );
          await waitForWake(signal);
          continue;
        }

        try {
          await runGateway(values.botToken, signal);
          attempt = 0;
        } catch (error) {
          const classified = classifyDiscordError(error);
          bb.log.error(`Discord gateway stopped: ${classified.message}`);
          if (classified.needsConfiguration) {
            // Retrying cannot help until the operator changes something.
            setNeedsConfiguration(classified.message);
            await waitForWake(signal);
            attempt = 0;
            continue;
          }
          attempt += 1;
          const delayMs = retryDelayMs(attempt);
          bb.log.warn(
            `Reconnecting to Discord in ${Math.round(delayMs / 1000)}s (attempt ${attempt}).`,
          );
          await waitForWake(signal, delayMs);
        }
      }
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
    wakeAll();
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }
  });

  bb.log.info("Discord plugin loaded");
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
