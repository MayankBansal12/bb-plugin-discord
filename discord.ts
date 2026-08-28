// A thin wrapper over discord.js that owns the Gateway connection and turns
// Discord message/thread events into callbacks the plugin understands. The
// plugin stays free of discord.js types: this module is the only place that
// knows about Discord's wire shapes.

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type Channel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";

export interface DiscordInboundMessage {
  /** Discord message id — used for idempotency on reconnect-redelivery. */
  messageId: string;
  /** The channel/thread the message landed in. */
  channelId: string;
  /** The guild (server) the message came from. */
  guildId: string;
  /** The author's display name for attribution. */
  authorTag: string;
  /** Whether the bot was explicitly mentioned. */
  mentioned: boolean;
  /** Message text with the bot mention stripped. */
  content: string;
  /** True when the message created a brand-new thread (forum post / new thread). */
  isThreadStart: boolean;
}

export interface DiscordClientOptions {
  token: string;
  /** Only messages from these guild ids are processed. Empty = disabled. */
  allowedGuildIds: string[];
  /** Bot user id, resolved after login; used to strip mentions. */
  botUserId: () => string | undefined;
  onMessage: (message: DiscordInboundMessage) => void | Promise<void>;
  onReady: () => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const TEXT_CHANNEL_TYPES = new Set([0, 5, 15]); // GuildText, Forum, Media

export class DiscordClient {
  private readonly client: Client;
  private readonly opts: DiscordClientOptions;
  private ready = false;

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

    this.client.once(Events.ClientReady, () => {
      this.ready = true;
      opts.log.info("Discord gateway connected");
      opts.onReady();
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });

    this.client.on(Events.Error, (error) => {
      opts.log.error(`Discord client error: ${errorMessage(error)}`);
    });

    // discord.js reconnects automatically with exponential backoff; we only
    // surface disconnect/re-resume for observability.
    this.client.on(Events.ShardDisconnect, (event) => {
      opts.log.warn(`Discord shard disconnected (${event.code}); will resume`);
    });
    this.client.on(Events.ShardResume, () => {
      opts.log.info("Discord shard resumed");
    });
  }

  async login(): Promise<void> {
    await this.client.login(this.opts.token);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** The bot's own user id, for mention-stripping. Available after login. */
  getUserId(): string | undefined {
    return this.client.user?.id;
  }

  /** Send a plain message to a channel, splitting long text into chunks. */
  async sendMessage(channelId: string, text: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${channelId} is not text-sendable`);
    }
    const chunks = chunkForDiscord(text);
    for (const chunk of chunks) {
      await (channel as TextChannel | ThreadChannel).send(chunk);
    }
  }

  /** Start a Discord thread for a new bb conversation. */
  async startThread(
    parentChannelId: string,
    name: string,
    starterText: string,
  ): Promise<string | null> {
    const channel = await this.fetchChannel(parentChannelId);
    if (!channel) return null;
    if (!("threads" in channel)) return null;
    const parent = channel as TextChannel;
    const thread = await parent.threads.create({
      name: truncate(name, 100),
      message: { content: truncate(starterText, 2000) },
      autoArchiveDuration: 1440,
    });
    return thread.id;
  }

  /** Create a forum post; returns the thread channel id. */
  async startForumPost(
    forumChannelId: string,
    name: string,
    body: string,
  ): Promise<string | null> {
    const channel = await this.fetchChannel(forumChannelId);
    if (!channel) return null;
    if (!("threads" in channel) || !("availableTags" in channel)) return null;
    const forum = channel as unknown as {
      threads: {
        createPost: (opts: {
          name: string;
          message: { content: string };
          autoArchiveDuration: number;
        }) => Promise<{ id: string }>;
      };
    };
    const post = await forum.threads.createPost({
      name: truncate(name, 100),
      message: { content: truncate(body, 2000) },
      autoArchiveDuration: 1440,
    });
    return post.id;
  }

  private async fetchChannel(channelId: string): Promise<Channel | null> {
    try {
      return await this.client.channels.fetch(channelId);
    } catch (error) {
      this.opts.log.warn(`Could not fetch channel ${channelId}: ${errorMessage(error)}`);
      return null;
    }
  }

  private async handleMessage(message: Message<boolean>): Promise<void> {
    if (message.author.bot) return;
    const guildId = message.guildId;
    if (!guildId) return;
    if (this.opts.allowedGuildIds.length > 0 && !this.opts.allowedGuildIds.includes(guildId)) {
      return;
    }
    const botId = this.opts.botUserId();
    const mentioned =
      message.mentions.has(botId ?? "", { ignoreRoles: true, ignoreEveryone: true });
    let content = message.content;
    if (botId) {
      content = content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
    }
    const isThreadStart =
      message.channel.isThread() && message.channel.lastMessageId === message.id &&
      (message.channel as ThreadChannel).messageCount === 0;

    await this.opts.onMessage({
      messageId: message.id,
      channelId: message.channelId,
      guildId,
      authorTag: message.author.displayName,
      mentioned,
      content,
      isThreadStart,
    });
  }

  /** React with a confirmation emoji. */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    if (!channel || !("messages" in channel)) return;
    try {
      const msg = await (channel as TextChannel | ThreadChannel).messages.fetch(messageId);
      await msg.react(emoji);
    } catch (error) {
      this.opts.log.warn(`Could not react to ${messageId}: ${errorMessage(error)}`);
    }
  }

  async destroy(): Promise<void> {
    this.ready = false;
    this.client.destroy();
  }
}

function chunkForDiscord(text: string): string[] {
  const MAX = 1900; // leave headroom under the 2000 limit
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX) {
    let split = rest.lastIndexOf("\n", MAX);
    if (split < MAX / 2) split = MAX;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
