// Agent tools that let a bb thread operate the paired Discord server.
//
// Access is graduated on purpose:
//   "messages" (default) — read and write messages and threads only.
//   "full"               — plus channel, role and member administration.
//   destructive actions  — deleting channels and kicking/banning members stay
//                          off until the operator separately enables them.

import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { DiscordClient } from "./discord.js";
import type { DiscordAccessLevel } from "./pairing.js";

export interface DiscordToolDeps {
  getClient: () => DiscordClient | null;
  getGuildId: () => string | null;
  getAccessLevel: () => DiscordAccessLevel;
  allowsDestructive: () => boolean;
}

/** Always available once the plugin is paired. */
export const MESSAGE_TOOL_NAMES = [
  "discord_server_info",
  "discord_list_channels",
  "discord_read_channel",
  "discord_send_message",
  "discord_create_thread",
] as const;

/** Added by the "full" access level. */
export const MANAGEMENT_TOOL_NAMES = [
  "discord_list_roles",
  "discord_list_members",
  "discord_create_channel",
  "discord_edit_channel",
  "discord_manage_member_role",
] as const;

/** Added by "full" access plus the destructive-actions opt-in. */
export const DESTRUCTIVE_TOOL_NAMES = [
  "discord_delete_channel",
  "discord_moderate_member",
] as const;

export function availableToolNames(
  level: DiscordAccessLevel,
  allowsDestructive: boolean,
  paired: boolean,
): string[] {
  if (!paired) return [];
  const names: string[] = [...MESSAGE_TOOL_NAMES];
  if (level === "full") {
    names.push(...MANAGEMENT_TOOL_NAMES);
    if (allowsDestructive) names.push(...DESTRUCTIVE_TOOL_NAMES);
  }
  return names;
}

export function discordAuditReason(threadId: string): string {
  return `Requested through bb's Discord plugin by thread ${threadId}`;
}

type ToolResult = string | { content: [{ type: "text"; text: string }]; isError: true };

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

interface Ready {
  client: DiscordClient;
  guildId: string;
}

function ready(deps: DiscordToolDeps, requireFull: boolean): Ready | ToolResult {
  const client = deps.getClient();
  const guildId = deps.getGuildId();
  if (!client || !client.isReady()) {
    return toolError(
      "Discord is not connected. Check the connection panel in Settings → Extensions → Plugins → Discord in bb.",
    );
  }
  if (!guildId) {
    return toolError(
      "Discord is not paired yet. Complete pairing in Settings → Extensions → Plugins → Discord in bb.",
    );
  }
  if (requireFull && deps.getAccessLevel() !== "full") {
    return toolError(
      "This action needs full server access. Set Discord access to \"Full server access\" in Settings → Extensions → Plugins → Discord in bb.",
    );
  }
  return { client, guildId };
}

function isReady(value: Ready | ToolResult): value is Ready {
  return typeof value === "object" && "client" in value;
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerDiscordTools(bb: BbPluginApi, deps: DiscordToolDeps): void {
  bb.agents.registerTool({
    name: "discord_server_info",
    description:
      "Summarize the paired Discord server: name, owner, member count, channel count and role count.",
    parameters: z.object({}),
    presentation: {
      label: { pending: "Reading Discord server", completed: "Read Discord server" },
    },
    async execute() {
      const state = ready(deps, false);
      if (!isReady(state)) return state;
      return guarded(async () => json(await state.client.guildInfo(state.guildId)));
    },
  });

  bb.agents.registerTool({
    name: "discord_list_channels",
    description:
      "List every channel in the paired Discord server with its id, type, category and topic.",
    parameters: z.object({}),
    presentation: {
      label: { pending: "Listing Discord channels", completed: "Listed Discord channels" },
    },
    async execute() {
      const state = ready(deps, false);
      if (!isReady(state)) return state;
      return guarded(async () => json(await state.client.listChannels(state.guildId)));
    },
  });

  bb.agents.registerTool({
    name: "discord_read_channel",
    description:
      "Read recent messages from a Discord channel or thread, oldest first.",
    parameters: z.object({
      channelId: z.string().describe("Channel or thread id to read."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("How many recent messages to fetch (default 25, max 100)."),
    }),
    presentation: {
      label: { pending: "Reading Discord channel", completed: "Read Discord channel" },
    },
    async execute({ channelId, limit }) {
      const state = ready(deps, false);
      if (!isReady(state)) return state;
      return guarded(async () =>
        json(
          await state.client.fetchMessages(
            state.guildId,
            channelId,
            limit ?? 25,
          ),
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "discord_send_message",
    description:
      "Post a message to a channel or thread in the paired Discord server. Long messages are split automatically.",
    parameters: z.object({
      channelId: z.string().describe("Channel or thread id to post into."),
      content: z.string().min(1).max(8000).describe("Message text to send."),
    }),
    presentation: {
      label: { pending: "Sending Discord message", completed: "Sent Discord message" },
    },
    async execute({ channelId, content }) {
      const state = ready(deps, false);
      if (!isReady(state)) return state;
      return guarded(async () => {
        await state.client.sendMessage(state.guildId, channelId, content);
        return `Sent to ${channelId}.`;
      });
    },
  });

  bb.agents.registerTool({
    name: "discord_create_thread",
    description:
      "Create a thread under a Discord text channel, optionally seeding it with a first message.",
    parameters: z.object({
      channelId: z.string().describe("Parent text channel id."),
      name: z.string().min(1).max(100).describe("Thread name."),
      message: z.string().max(4000).optional().describe("Optional first message."),
    }),
    presentation: {
      label: { pending: "Creating Discord thread", completed: "Created Discord thread" },
    },
    async execute({ channelId, name, message }) {
      const state = ready(deps, false);
      if (!isReady(state)) return state;
      return guarded(async () =>
        json(
          await state.client.createThread(
            state.guildId,
            channelId,
            name,
            message,
          ),
        ),
      );
    },
  });

  // -- full access ----------------------------------------------------------

  bb.agents.registerTool({
    name: "discord_list_roles",
    description: "List the roles in the paired Discord server, highest position first.",
    parameters: z.object({}),
    presentation: {
      label: { pending: "Listing Discord roles", completed: "Listed Discord roles" },
    },
    async execute() {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      return guarded(async () => json(await state.client.listRoles(state.guildId)));
    },
  });

  bb.agents.registerTool({
    name: "discord_list_members",
    description:
      "List members of the paired Discord server through Discord's REST API. Requires Server Members Intent to be enabled for the application in the Developer Portal, but the bridge does not request member gateway events.",
    parameters: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    }),
    presentation: {
      label: { pending: "Listing Discord members", completed: "Listed Discord members" },
    },
    async execute({ limit }) {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      return guarded(async () =>
        json(await state.client.listMembers(state.guildId, limit ?? 50)),
      );
    },
  });

  bb.agents.registerTool({
    name: "discord_create_channel",
    description: "Create a channel in the paired Discord server.",
    parameters: z.object({
      name: z.string().min(1).max(100),
      type: z
        .enum(["text", "voice", "category", "announcement", "forum", "stage"])
        .optional()
        .describe("Defaults to text."),
      topic: z.string().max(1024).optional(),
      parentId: z.string().optional().describe("Category id to nest under."),
    }),
    presentation: {
      label: { pending: "Creating Discord channel", completed: "Created Discord channel" },
    },
    async execute({ name, type, topic, parentId }, ctx) {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      return guarded(async () =>
        json(
          await state.client.createChannel(state.guildId, {
            name,
            type,
            topic,
            parentId,
            reason: discordAuditReason(ctx.threadId),
          }),
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "discord_edit_channel",
    description: "Rename a Discord channel or change its topic or slowmode.",
    parameters: z.object({
      channelId: z.string(),
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(1024).optional(),
      slowmodeSeconds: z.number().int().min(0).max(21600).optional(),
    }),
    presentation: {
      label: { pending: "Editing Discord channel", completed: "Edited Discord channel" },
    },
    async execute({ channelId, name, topic, slowmodeSeconds }, ctx) {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      return guarded(async () =>
        json(
          await state.client.editChannel(state.guildId, channelId, {
            name,
            topic,
            slowmodeSeconds,
            reason: discordAuditReason(ctx.threadId),
          }),
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "discord_manage_member_role",
    description: "Add or remove one role on one member of the paired Discord server.",
    parameters: z.object({
      userId: z.string(),
      roleId: z.string(),
      action: z.enum(["add", "remove"]),
    }),
    presentation: {
      label: { pending: "Updating Discord roles", completed: "Updated Discord roles" },
    },
    async execute({ userId, roleId, action }, ctx) {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      return guarded(async () => {
        await state.client.setMemberRole(
          state.guildId,
          userId,
          roleId,
          action,
          discordAuditReason(ctx.threadId),
        );
        return `Role ${roleId} ${action === "add" ? "added to" : "removed from"} ${userId}.`;
      });
    },
  });

  // -- destructive ----------------------------------------------------------

  bb.agents.registerTool({
    name: "discord_delete_channel",
    description:
      "Permanently delete a Discord channel and its message history. Irreversible.",
    instructions:
      "Before calling discord_delete_channel, tell the user exactly which channel will be deleted and get their explicit go-ahead in this thread. Only then set confirm to true.",
    parameters: z.object({
      channelId: z.string(),
      confirm: z
        .literal(true)
        .describe("Set only after the user explicitly approved deleting this channel."),
    }),
    presentation: {
      label: { pending: "Deleting Discord channel", completed: "Deleted Discord channel" },
    },
    async execute({ channelId }, ctx) {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      if (!deps.allowsDestructive()) {
        return toolError(
          "Destructive Discord actions are disabled. Enable \"Destructive actions\" in Settings → Extensions → Plugins → Discord in bb first.",
        );
      }
      return guarded(async () => {
        const name = await state.client.deleteChannel(
          state.guildId,
          channelId,
          discordAuditReason(ctx.threadId),
        );
        return `Deleted channel #${name} (${channelId}).`;
      });
    },
  });

  bb.agents.registerTool({
    name: "discord_moderate_member",
    description:
      "Kick, ban, or time out a member of the paired Discord server. Kicks and bans are not reversible from here.",
    instructions:
      "Before calling discord_moderate_member, state who will be affected and what the action does, and get the user's explicit go-ahead in this thread. Only then set confirm to true.",
    parameters: z.object({
      userId: z.string(),
      action: z.enum(["kick", "ban", "timeout"]),
      reason: z.string().min(1).max(400).describe("Audit-log reason."),
      timeoutMinutes: z
        .number()
        .int()
        .min(1)
        .max(40320)
        .optional()
        .describe("Only for action=timeout. Defaults to 10 minutes."),
      confirm: z
        .literal(true)
        .describe("Set only after the user explicitly approved this moderation action."),
    }),
    presentation: {
      label: { pending: "Moderating Discord member", completed: "Moderated Discord member" },
    },
    async execute({ userId, action, reason, timeoutMinutes }, ctx) {
      const state = ready(deps, true);
      if (!isReady(state)) return state;
      if (!deps.allowsDestructive()) {
        return toolError(
          "Destructive Discord actions are disabled. Enable \"Destructive actions\" in Settings → Extensions → Plugins → Discord in bb first.",
        );
      }
      return guarded(async () => {
        await state.client.moderateMember(state.guildId, userId, action, {
          reason: `${reason} — ${discordAuditReason(ctx.threadId)}`,
          timeoutMinutes,
        });
        return `Applied ${action} to ${userId}.`;
      });
    },
  });
}
