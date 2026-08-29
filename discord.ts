import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Channel,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";

export interface DiscordInboundMessage {
  messageId: string;
  channelId: string;
  parentChannelId: string | null;
  guildId: string;
  authorId: string;
  authorTag: string;
  mentioned: boolean;
  content: string;
}

export interface DiscordClientOptions {
  token: string;
  allowedGuildIds: string[];
  allowedAuthorIds: string[];
  botUserId: () => string | undefined;
  onMessage: (message: DiscordInboundMessage) => void | Promise<void>;
  onReady: () => void | Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const SEND_ATTEMPTS = 3;

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
      void Promise.resolve(opts.onReady()).catch((error) => {
        opts.log.warn(`Discord ready handler failed: ${errorMessage(error)}`);
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error) => {
        opts.log.error(`Discord message handler failed: ${errorMessage(error)}`);
      });
    });

    this.client.on(Events.Error, (error) => {
      opts.log.error(`Discord client error: ${errorMessage(error)}`);
    });

    this.client.on(Events.ShardDisconnect, (event) => {
      this.ready = false;
      opts.log.warn(`Discord shard disconnected (${event.code}); will resume`);
    });
    this.client.on(Events.ShardResume, () => {
      this.ready = true;
      opts.log.info("Discord shard resumed");
    });
  }

  async login(): Promise<void> {
    await this.client.login(this.opts.token);
  }

  isReady(): boolean {
    return this.ready;
  }

  getUserId(): string | undefined {
    return this.client.user?.id;
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
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

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.fetchChannel(channelId);
    if (!channel || !("messages" in channel)) return;
    try {
      const message = await (
        channel as TextChannel | ThreadChannel
      ).messages.fetch(messageId);
      await message.react(emoji);
    } catch (error) {
      this.opts.log.warn(
        `Could not react to ${messageId}: ${errorMessage(error)}`,
      );
    }
  }

  async destroy(): Promise<void> {
    this.ready = false;
    this.client.destroy();
  }

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
        if (attempt === SEND_ATTEMPTS) break;
        const delayMs = 250 * 2 ** (attempt - 1);
        this.opts.log.warn(
          `Discord send to ${channelId} failed (attempt ${attempt}/${SEND_ATTEMPTS}); retrying in ${delayMs}ms`,
        );
        await delay(delayMs);
      }
    }
    throw lastError;
  }

  private async fetchChannel(channelId: string): Promise<Channel | null> {
    try {
      return await this.client.channels.fetch(channelId);
    } catch (error) {
      this.opts.log.warn(
        `Could not fetch channel ${channelId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async handleMessage(message: Message<boolean>): Promise<void> {
    if (message.author.bot) return;
    const guildId = message.guildId;
    if (!guildId) return;
    if (!this.opts.allowedGuildIds.includes(guildId)) return;
    if (!this.opts.allowedAuthorIds.includes(message.author.id)) return;

    const botId = this.opts.botUserId();
    const mentioned = message.mentions.has(botId ?? "", {
      ignoreRoles: true,
      ignoreEveryone: true,
    });
    const content = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()
      : message.content.trim();

    await this.opts.onMessage({
      messageId: message.id,
      channelId: message.channelId,
      parentChannelId: message.channel.isThread()
        ? message.channel.parentId
        : null,
      guildId,
      authorId: message.author.id,
      authorTag: message.author.displayName,
      mentioned,
      content,
    });
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
