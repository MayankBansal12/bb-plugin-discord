import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Channel,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { classifyDiscordError } from "./pairing.js";

export interface DiscordInboundMessage {
  messageId: string;
  channelId: string;
  channelName: string | null;
  parentChannelId: string | null;
  guildId: string;
  guildName: string | null;
  authorId: string;
  authorTag: string;
  mentioned: boolean;
  content: string;
}

export interface DiscordClientOptions {
  token: string;
  /**
   * Authorization gate, re-evaluated per message so pairing and settings
   * changes take effect without reconnecting.
   */
  isAuthorized: (guildId: string, authorId: string) => boolean;
  /**
   * Narrow exception to {@link isAuthorized}: while the plugin is unpaired it
   * accepts a mention that looks like a pairing command, and nothing else.
   */
  isPairingCandidate: (content: string) => boolean;
  botUserId: () => string | undefined;
  onMessage: (message: DiscordInboundMessage) => void | Promise<void>;
  onReady: (botTag: string) => void | Promise<void>;
  onConnectionStateChange?: (ready: boolean) => void;
  /** Fired at most once when message content arrives empty (intent is off). */
  onSuspectedMissingContentIntent: () => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface DiscordChannelSummary {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  topic: string | null;
}

export interface DiscordMessageSummary {
  id: string;
  authorId: string;
  authorTag: string;
  createdAt: string;
  content: string;
}

export interface DiscordRoleSummary {
  id: string;
  name: string;
  color: string;
  position: number;
  managed: boolean;
}

export interface DiscordMemberSummary {
  id: string;
  tag: string;
  displayName: string;
  bot: boolean;
  roleIds: string[];
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  ownerId: string;
  memberCount: number;
  channelCount: number;
  roleCount: number;
  createdAt: string;
}

export type CreatableChannelType =
  | "text"
  | "voice"
  | "category"
  | "announcement"
  | "forum"
  | "stage";

const CHANNEL_TYPE_BY_NAME = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
} as const satisfies Record<CreatableChannelType, ChannelType>;

const SEND_ATTEMPTS = 3;

/**
 * Wraps a Discord API failure in the plugin's operator-facing wording while
 * keeping the original as the cause, so tools and the bridge never surface a
 * bare `DiscordAPIError[50013]`.
 */
export function toFriendlyError(error: unknown): Error {
  const classified = classifyDiscordError(error);
  return Object.assign(new Error(classified.message), {
    cause: error,
    discordErrorKind: classified.kind,
  });
}

/**
 * Discord's client-level channel fetch is global across every guild the bot
 * has joined. Keep that lookup from becoming an authorization bypass by
 * binding every fetched channel to the guild selected by the caller.
 */
export function requireChannelInGuild(
  channel: Channel | null,
  channelId: string,
  guildId: string,
): Channel {
  if (
    !channel ||
    channel.isDMBased() ||
    !("guildId" in channel) ||
    channel.guildId !== guildId
  ) {
    throw new Error(
      `Channel ${channelId} is not in the paired Discord server.`,
    );
  }
  return channel;
}

export class DiscordClient {
  private readonly client: Client;
  private readonly opts: DiscordClientOptions;
  private ready = false;
  private reportedMissingContentIntent = false;

  constructor(opts: DiscordClientOptions) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.once(Events.ClientReady, (client) => {
      this.ready = true;
      opts.onConnectionStateChange?.(true);
      opts.log.info(`Discord gateway connected as ${client.user.tag}`);
      void Promise.resolve(opts.onReady(client.user.tag)).catch((error) => {
        opts.log.warn(`Discord ready handler failed: ${errorMessage(error)}`);
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error) => {
        opts.log.error(`Discord message handler failed: ${errorMessage(error)}`);
      });
    });

    this.client.on(Events.Error, (error) => {
      opts.log.error(`Discord client error: ${classifyDiscordError(error).message}`);
    });

    this.client.on(Events.ShardDisconnect, (event) => {
      this.ready = false;
      opts.onConnectionStateChange?.(false);
      opts.log.warn(`Discord shard disconnected (${event.code}); will resume`);
    });
    this.client.on(Events.ShardResume, () => {
      this.ready = true;
      opts.onConnectionStateChange?.(true);
      opts.log.info("Discord shard resumed");
    });
  }

  async login(): Promise<void> {
    try {
      await this.client.login(this.opts.token);
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getUserId(): string | undefined {
    return this.client.user?.id;
  }

  getUserTag(): string | undefined {
    return this.client.user?.tag;
  }

  async sendMessage(
    guildId: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${channelId} is not text-sendable`);
    }

    for (const chunk of chunkForDiscord(text)) {
      await this.sendChunkWithRetry(
        channel as TextChannel | ThreadChannel,
        channelId,
        chunk,
      );
    }
  }

  async sendTyping(guildId: string, channelId: string): Promise<void> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel.isTextBased() || !("sendTyping" in channel)) {
      throw new Error(`Channel ${channelId} does not support typing indicators.`);
    }
    try {
      await (channel as TextChannel | ThreadChannel).sendTyping();
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async react(
    guildId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel || !("messages" in channel)) return;
    try {
      const message = await (
        channel as TextChannel | ThreadChannel
      ).messages.fetch(messageId);
      await message.react(emoji);
    } catch (error) {
      // Reactions are cosmetic; never fail a turn because one could not land.
      this.opts.log.warn(
        `Could not react to ${messageId}: ${classifyDiscordError(error).message}`,
      );
    }
  }

  async destroy(): Promise<void> {
    this.ready = false;
    this.client.destroy();
  }

  // -------------------------------------------------------------------------
  // Server surface used by the agent tools
  // -------------------------------------------------------------------------

  async getGuild(guildId: string): Promise<Guild> {
    try {
      return await this.client.guilds.fetch(guildId);
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async guildInfo(guildId: string): Promise<DiscordGuildSummary> {
    const guild = await this.getGuild(guildId);
    const channels = await this.listChannels(guildId);
    const roles = await this.listRoles(guildId);
    return {
      id: guild.id,
      name: guild.name,
      ownerId: guild.ownerId,
      memberCount: guild.memberCount,
      channelCount: channels.length,
      roleCount: roles.length,
      createdAt: guild.createdAt.toISOString(),
    };
  }

  async listChannels(guildId: string): Promise<DiscordChannelSummary[]> {
    const guild = await this.getGuild(guildId);
    try {
      const channels = await guild.channels.fetch();
      return [...channels.values()]
        .flatMap((channel) => (channel ? [channel] : []))
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: ChannelType[channel.type] ?? String(channel.type),
          parentId: channel.parentId,
          topic:
            "topic" in channel && typeof channel.topic === "string"
              ? channel.topic
              : null,
        }));
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async fetchMessages(
    guildId: string,
    channelId: string,
    limit: number,
  ): Promise<DiscordMessageSummary[]> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${channelId} has no readable message history.`);
    }
    try {
      const messages = await (
        channel as TextChannel | ThreadChannel
      ).messages.fetch({ limit });
      return [...messages.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((message) => ({
          id: message.id,
          authorId: message.author.id,
          authorTag: message.author.tag,
          createdAt: message.createdAt.toISOString(),
          content: message.content,
        }));
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async createThread(
    guildId: string,
    channelId: string,
    name: string,
    seedMessage?: string,
  ): Promise<{ id: string; name: string }> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(
        `Channel ${channelId} is not a text channel, so it cannot hold threads.`,
      );
    }
    try {
      const thread = await (channel as TextChannel).threads.create({
        name,
        autoArchiveDuration: 1440,
      });
      if (seedMessage) await thread.send(seedMessage);
      return { id: thread.id, name: thread.name };
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async listRoles(guildId: string): Promise<DiscordRoleSummary[]> {
    const guild = await this.getGuild(guildId);
    try {
      const roles = await guild.roles.fetch();
      return [...roles.values()]
        .sort((a, b) => b.position - a.position)
        .map((role) => ({
          id: role.id,
          name: role.name,
          color: role.hexColor,
          position: role.position,
          managed: role.managed,
        }));
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async listMembers(
    guildId: string,
    limit: number,
  ): Promise<DiscordMemberSummary[]> {
    const guild = await this.getGuild(guildId);
    try {
      const members = await guild.members.list({ limit });
      return [...members.values()].map((member) => ({
        id: member.id,
        tag: member.user.tag,
        displayName: member.displayName,
        bot: member.user.bot,
        roleIds: [...member.roles.cache.keys()],
      }));
    } catch (error) {
      // The REST endpoint requires the privileged intent to be enabled for the
      // application, but does not require GuildMembers in the gateway identify.
      throw new Error(
        "Could not list members through Discord's REST API. Enable Server Members Intent for this application in the Discord Developer Portal (Bot page); the bridge does not request the GuildMembers gateway intent.",
        { cause: error },
      );
    }
  }

  async createChannel(
    guildId: string,
    options: {
      name: string;
      type?: CreatableChannelType;
      topic?: string;
      parentId?: string;
      reason?: string;
    },
  ): Promise<DiscordChannelSummary> {
    const guild = await this.getGuild(guildId);
    try {
      const channel = await guild.channels.create({
        name: options.name,
        type: CHANNEL_TYPE_BY_NAME[options.type ?? "text"],
        topic: options.topic,
        parent: options.parentId,
        reason: options.reason,
      });
      return {
        id: channel.id,
        name: channel.name,
        type: ChannelType[channel.type] ?? String(channel.type),
        parentId: channel.parentId,
        topic:
          "topic" in channel && typeof channel.topic === "string"
            ? channel.topic
            : null,
      };
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async editChannel(
    guildId: string,
    channelId: string,
    options: {
      name?: string;
      topic?: string;
      slowmodeSeconds?: number;
      reason?: string;
    },
  ): Promise<DiscordChannelSummary> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel || !("edit" in channel) || channel.isDMBased()) {
      throw new Error(`Channel ${channelId} cannot be edited.`);
    }
    try {
      const updated = await (channel as GuildBasedChannel).edit({
        name: options.name,
        topic: options.topic,
        rateLimitPerUser: options.slowmodeSeconds,
        reason: options.reason,
      });
      return {
        id: updated.id,
        name: updated.name,
        type: ChannelType[updated.type] ?? String(updated.type),
        parentId: updated.parentId,
        topic:
          "topic" in updated && typeof updated.topic === "string"
            ? updated.topic
            : null,
      };
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async deleteChannel(
    guildId: string,
    channelId: string,
    reason: string,
  ): Promise<string> {
    const channel = await this.fetchGuildChannel(guildId, channelId);
    if (!channel || channel.isDMBased() || !("delete" in channel)) {
      throw new Error(`Channel ${channelId} cannot be deleted.`);
    }
    const name = (channel as GuildBasedChannel).name;
    try {
      await (channel as GuildBasedChannel).delete(reason);
      return name;
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async setMemberRole(
    guildId: string,
    userId: string,
    roleId: string,
    action: "add" | "remove",
    reason: string,
  ): Promise<void> {
    const guild = await this.getGuild(guildId);
    try {
      if (action === "add") {
        await guild.members.addRole({ user: userId, role: roleId, reason });
      } else {
        await guild.members.removeRole({ user: userId, role: roleId, reason });
      }
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  async moderateMember(
    guildId: string,
    userId: string,
    action: "kick" | "ban" | "timeout",
    options: { reason: string; timeoutMinutes?: number },
  ): Promise<void> {
    const guild = await this.getGuild(guildId);
    try {
      if (action === "kick") {
        await guild.members.kick(userId, options.reason);
        return;
      }
      if (action === "ban") {
        await guild.bans.create(userId, { reason: options.reason });
        return;
      }
      const member = await guild.members.fetch(userId);
      await member.timeout(
        Math.max(1, options.timeoutMinutes ?? 10) * 60_000,
        options.reason,
      );
    } catch (error) {
      throw toFriendlyError(error);
    }
  }

  // -------------------------------------------------------------------------

  private async sendChunkWithRetry(
    channel: TextChannel | ThreadChannel,
    channelId: string,
    text: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        await channel.send(text);
        return;
      } catch (error) {
        lastError = error;
        // A permission or not-found failure will not fix itself; stop early.
        const kind = classifyDiscordError(error).kind;
        if (kind === "missing-permissions" || kind === "not-found") break;
        if (attempt === SEND_ATTEMPTS) break;
        const delayMs = 250 * 2 ** (attempt - 1);
        this.opts.log.warn(
          `Discord send to ${channelId} failed (attempt ${attempt}/${SEND_ATTEMPTS}); retrying in ${delayMs}ms`,
        );
        await delay(delayMs);
      }
    }
    throw toFriendlyError(lastError);
  }

  private async fetchGuildChannel(
    guildId: string,
    channelId: string,
  ): Promise<Channel> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      return requireChannelInGuild(channel, channelId, guildId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Channel ${channelId} is not in the paired Discord server.`
      ) {
        throw error;
      }
      this.opts.log.warn(
        `Could not fetch channel ${channelId}: ${classifyDiscordError(error).message}`,
      );
      throw toFriendlyError(error);
    }
  }

  private async handleMessage(message: Message<boolean>): Promise<void> {
    if (message.author.bot) return;
    const guildId = message.guildId;
    if (!guildId) return;

    const botId = this.opts.botUserId();
    const mentioned = message.mentions.has(botId ?? "", {
      ignoreRoles: true,
      ignoreEveryone: true,
    });
    const content = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()
      : message.content.trim();

    const authorized = this.opts.isAuthorized(guildId, message.author.id);
    // Unpaired: the only message the bridge will look at is a mention that
    // carries a pairing command. Everything else is dropped without a reply.
    if (!authorized) {
      if (!mentioned || !this.opts.isPairingCandidate(content)) return;
    }

    if (authorized && !content && !message.attachments.size) {
      this.noteEmptyContent();
    }

    const channel = message.channel;
    await this.opts.onMessage({
      messageId: message.id,
      channelId: message.channelId,
      channelName: "name" in channel ? channel.name : null,
      parentChannelId: channel.isThread() ? channel.parentId : null,
      guildId,
      guildName: message.guild?.name ?? null,
      authorId: message.author.id,
      authorTag: message.author.displayName,
      mentioned,
      content,
    });
  }

  private noteEmptyContent(): void {
    if (this.reportedMissingContentIntent) return;
    this.reportedMissingContentIntent = true;
    this.opts.onSuspectedMissingContentIntent();
  }
}

export function chunkForDiscord(text: string): string[] {
  const max = 1900;
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let split = rest.lastIndexOf("\n", max);
    if (split < max / 2) split = max;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
