import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

const valueSourceSchema = z.enum(["setting", "pairing", "default", "none"]);

const channelSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  label: z.string(),
  source: valueSourceSchema,
}).strict();

const executionFieldSchema = z.object({
  label: z.string(),
  value: z.string().nullable(),
  source: z.enum(["setting", "default"]),
  problem: z.string().nullable(),
}).strict();

const configurationSchema = z.object({
  /**
   * The application id (already public in the invite URL) plus dots. The live
   * token never leaves the server.
   */
  botToken: z.object({
    configured: z.boolean(),
    applicationId: z.string().nullable(),
    masked: z.string().nullable(),
  }).strict(),
  permissionMode: z.object({ value: z.string(), label: z.string() }).strict(),
  serverAccess: z.object({
    value: z.enum(["messages", "full"]),
    label: z.string(),
  }).strict(),
  destructiveActions: z.object({
    configured: z.boolean(),
    effective: z.boolean(),
    blockedReason: z.string().nullable(),
  }).strict(),
  homeChannel: channelSchema,
  newConversationChannel: channelSchema,
  guild: z.object({
    value: z.string().nullable(),
    source: valueSourceSchema,
  }).strict(),
  authorizedUsers: z.array(
    z.object({
      id: z.string(),
      tag: z.string().nullable(),
      source: valueSourceSchema,
    }).strict(),
  ),
}).strict();

const executionSchema = z.object({
  project: executionFieldSchema,
  machine: executionFieldSchema,
  model: executionFieldSchema,
  resolvedProviderId: z.string().nullable(),
  resolvedReasoningLevel: z.enum([
    "none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode",
  ]).nullable(),
  resolvedServiceTier: z.enum(["default", "fast"]).nullable(),
  summary: z.string(),
  issues: z.array(z.string()),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["personal", "standard"]),
      /** Machines where this project already has a checkout. */
      hostIds: z.array(z.string()),
      /** Machine used when Discord does not override project routing. */
      defaultHostId: z.string().nullable(),
    }).strict(),
  ),
  /** Enrolled machines, so the panel can name what the settings field takes. */
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["connected", "disconnected"]),
    }).strict(),
  ),
  /** Models the selected (or default) machine can actually serve right now. */
  models: z.array(
    z.object({
      providerId: z.string(),
      providerDisplayName: z.string(),
      model: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
      defaultReasoningLevel: z.enum([
        "none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode",
      ]),
    }).strict(),
  ),
  /** True when the catalog could not be read; the lists above are then stale. */
  catalogUnavailable: z.boolean(),
}).strict();

const pairingStatusSchema = z.object({
  gateway: z.object({
    state: z.enum(["disconnected", "connecting", "connected", "failed"]),
    botTag: z.string().nullable(),
    message: z.string().nullable(),
  }).strict(),
  /** Bot name for copy, or a neutral placeholder before the gateway reports it. */
  botName: z.string(),
  tokenConfigured: z.boolean(),
  paired: z.boolean(),
  pairing: z.object({
    guildId: z.string(),
    guildName: z.string().nullable(),
    channelId: z.string(),
    channelName: z.string().nullable(),
    userId: z.string(),
    userTag: z.string().nullable(),
    pairedAt: z.number().int(),
  }).strict().nullable(),
  pairingCode: z.object({
    code: z.string(),
    expiresAt: z.number().int(),
    command: z.string().nullable(),
  }).strict().nullable(),
  inviteUrl: z.string().url().nullable(),
  notice: z.string().nullable(),
  configuration: configurationSchema,
  execution: executionSchema,
}).strict();

export const discordRpcContract = defineRpcContract({
  getPairingStatus: {
    input: z.null(),
    output: pairingStatusSchema,
  },
  refreshPairingCode: {
    input: z.null(),
    output: pairingStatusSchema,
  },
  unpair: {
    input: z.null(),
    output: pairingStatusSchema,
  },
  /**
   * Writes the four routing keys and nothing else, after checking the project
   * and the machine/model pair against live BB state. `null` means Automatic.
   */
  setExecutionSelection: {
    input: z.object({
      defaultProjectId: z.string().nullable(),
      machineHostId: z.string().nullable(),
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      reasoningLevel: z.enum([
        "none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode",
      ]).nullable(),
      serviceTier: z.enum(["default", "fast"]).nullable(),
    }).strict(),
    output: pairingStatusSchema,
  },
  /**
   * Saves the permission and channel preferences edited in the connected-state
   * panel. Routing lives in `setExecutionSelection`, which validates it.
   */
  setConfiguration: {
    input: z.object({
      permissionMode: z.enum(["auto", "accept-edits", "full", "project-default"]),
      serverAccess: z.enum(["messages", "full"]),
      homeChannelId: z.string().nullable(),
      spawnChannelId: z.string().nullable(),
    }).strict(),
    output: pairingStatusSchema,
  },
  /**
   * Writes exactly one settings key. Server access is deliberately not touched
   * here: enabling destructive actions must never escalate it as a side effect.
   */
  setDestructiveActions: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: pairingStatusSchema,
  },
});

export type DiscordPairingStatus = z.infer<typeof pairingStatusSchema>;
export type DiscordConfigurationStatus = z.infer<typeof configurationSchema>;
export type DiscordExecutionStatus = z.infer<typeof executionSchema>;
