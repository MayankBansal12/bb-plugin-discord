import { createHash } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { chunkForDiscord } from "./discord.js";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export interface ReplyDestination {
  bbThreadId: string;
  guildId: string;
  channelId: string;
}

export interface PendingReply extends ReplyDestination {
  idleAt: number;
  text: string;
}

interface ReplyRow {
  id: number;
  bb_thread_id: string;
  idle_at: number;
  guild_id: string;
  discord_channel_id: string;
  output_id: string | null;
  chunks_json: string;
  next_chunk: number;
}

interface ReplyOutboxOptions {
  db: Database;
  isConnected: () => boolean;
  isAuthorized: (destination: ReplyDestination) => boolean;
  resolveOutputId: (reply: PendingReply, signal: AbortSignal) => Promise<string>;
  sendChunk: (destination: ReplyDestination, text: string, nonce: string) => Promise<void>;
  onError: (threadId: string, error: unknown) => void;
}

/**
 * Persist before any await, then acknowledge one Discord chunk at a time.
 * Completed rows retain only identity/progress, never the delivered text.
 * One drain owns sends across idle events, timer ticks, and reconnects.
 */
export class ReplyOutbox {
  private draining: Promise<void> | null = null;
  private disposed = false;
  private readonly stopped = new AbortController();
  private lastScannedId = 0;

  constructor(private readonly options: ReplyOutboxOptions) {}

  enqueue(reply: PendingReply): void {
    if (this.disposed || !reply.text.trim() || !this.options.isAuthorized(reply)) return;
    this.options.db.prepare(
      `INSERT OR IGNORE INTO discord_reply_outbox
       (bb_thread_id, idle_at, guild_id, discord_channel_id, chunks_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(reply.bbThreadId, reply.idleAt, reply.guildId, reply.channelId,
      JSON.stringify(chunkForDiscord(reply.text.trim())), Date.now());
  }

  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => { this.draining = null; });
    return this.draining;
  }

  stop(): void {
    this.disposed = true;
    this.stopped.abort();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.draining;
  }

  private pending(id: number): boolean {
    return !this.disposed && this.options.db.prepare(
      "SELECT 1 FROM discord_reply_outbox WHERE id = ? AND delivered_at IS NULL",
    ).get(id) !== undefined;
  }

  private async drain(): Promise<void> {
    const { db } = this.options;
    const nextBatch = () => db.prepare(
      "SELECT * FROM discord_reply_outbox WHERE delivered_at IS NULL AND id > ? ORDER BY id LIMIT 100",
    ).all(this.lastScannedId) as ReplyRow[];
    let rows = nextBatch();
    if (rows.length === 0) {
      this.lastScannedId = 0;
      rows = nextBatch();
    }
    const blockedThreads = new Set<string>();
    for (const row of rows) {
      if (this.disposed) return;
      this.lastScannedId = row.id;
      const destination: ReplyDestination = {
        bbThreadId: row.bb_thread_id, guildId: row.guild_id, channelId: row.discord_channel_id,
      };
      if (!this.options.isAuthorized(destination)) {
        db.prepare("DELETE FROM discord_reply_outbox WHERE id = ?").run(row.id);
        continue;
      }
      // Preserve order within a conversation without blocking other channels.
      if (blockedThreads.has(row.bb_thread_id) || !this.pending(row.id)) continue;
      // A previous batch may hold this conversation's failed first reply.
      // Rotate through the queue so those failures cannot starve other threads.
      if (db.prepare(
        "SELECT 1 FROM discord_reply_outbox WHERE bb_thread_id = ? AND id < ? AND delivered_at IS NULL LIMIT 1",
      ).get(row.bb_thread_id, row.id)) continue;
      try {
        const chunks = JSON.parse(row.chunks_json) as string[];
        if (!row.output_id) {
          const outputId = await this.options.resolveOutputId({
            ...destination, idleAt: row.idle_at, text: chunks.join(""),
          }, this.stopped.signal);
          if (!this.pending(row.id)) continue;
          const duplicate = db.prepare(
            "SELECT id FROM discord_reply_outbox WHERE bb_thread_id = ? AND output_id = ? AND id != ?",
          ).get(row.bb_thread_id, outputId, row.id);
          if (duplicate) {
            db.prepare("DELETE FROM discord_reply_outbox WHERE id = ?").run(row.id);
            continue;
          }
          db.prepare("UPDATE discord_reply_outbox SET output_id = ? WHERE id = ?").run(outputId, row.id);
          row.output_id = outputId;
        }
        for (let index = row.next_chunk; index < chunks.length; index += 1) {
          if (!this.pending(row.id) || !this.options.isAuthorized(destination)) break;
          if (!this.options.isConnected()) {
            blockedThreads.add(row.bb_thread_id);
            break;
          }
          // Discord checks nonce uniqueness for a short window. This closes
          // the common lost-acknowledgement retry gap; it is not an unlimited
          // exactly-once guarantee across crashes and extended outages.
          const nonce = createHash("sha256")
            .update(JSON.stringify([row.bb_thread_id, row.output_id, index]))
            .digest("hex").slice(0, 24);
          await this.options.sendChunk(destination, chunks[index]!, nonce);
          if (!this.pending(row.id)) break;
          if (index + 1 === chunks.length) {
            // Checkpoint the last chunk and completion atomically. A crash
            // between separate writes would otherwise strand the queue with
            // every chunk acknowledged but delivered_at still null.
            db.prepare(
              "UPDATE discord_reply_outbox SET next_chunk = ?, delivered_at = ?, chunks_json = '[]' WHERE id = ?",
            ).run(index + 1, Date.now(), row.id);
          } else {
            db.prepare(
              "UPDATE discord_reply_outbox SET next_chunk = ? WHERE id = ?",
            ).run(index + 1, row.id);
          }
        }
      } catch (error) {
        blockedThreads.add(row.bb_thread_id);
        if (!this.disposed) this.options.onError(row.bb_thread_id, error);
      }
    }
  }
}

export interface OutputEvent {
  id: string;
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
}

/** Same output kinds BB uses for /threads/:id/output, bounded to the idle snapshot. */
export async function resolveReplyOutputId(
  reply: PendingReply,
  list: (beforeSeq?: string) => Promise<readonly OutputEvent[]>,
  signal?: AbortSignal,
): Promise<string> {
  let beforeSeq: string | undefined;
  // Page in bounded batches, but do not permanently strand old replies behind
  // a fixed history limit after a long outage. Shutdown can cancel each page.
  while (true) {
    signal?.throwIfAborted();
    const events = await list(beforeSeq);
    signal?.throwIfAborted();
    for (const event of events) {
      if (event.createdAt > reply.idleAt) continue;
      const data = event.data as { text?: unknown; item?: { type?: string; text?: unknown } } | null;
      const text = event.type === "system/manager/user_message"
        ? data?.text
        : event.type === "item/completed" && data?.item?.type === "agentMessage"
          ? data.item.text : null;
      if (typeof text === "string" && text.trim() === reply.text) return event.id;
    }
    if (events.length < 100) break;
    const next = String(events[events.length - 1]!.seq);
    if (next === beforeSeq) break;
    beforeSeq = next;
  }
  // Keep the captured text durable and retry instead of inventing an identity
  // or losing the answer when BB's event API is temporarily unavailable.
  throw new Error("The stored BB output event is unavailable; reply remains queued.");
}
