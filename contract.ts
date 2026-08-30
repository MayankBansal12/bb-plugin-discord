import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

const pairingStatusSchema = z.object({
  gateway: z.object({
    state: z.enum(["disconnected", "connecting", "connected", "failed"]),
    botTag: z.string().nullable(),
    message: z.string().nullable(),
  }).strict(),
  tokenConfigured: z.boolean(),
  paired: z.boolean(),
  pairing: z.object({
    source: z.enum(["pairing", "legacy-settings"]),
    guildId: z.string(),
    guildName: z.string().nullable(),
    channelId: z.string().nullable(),
    channelName: z.string().nullable(),
    userId: z.string().nullable(),
    userTag: z.string().nullable(),
    pairedAt: z.number().int().nullable(),
  }).strict().nullable(),
  pairingCode: z.object({
    code: z.string(),
    expiresAt: z.number().int(),
    command: z.string().nullable(),
  }).strict().nullable(),
  inviteUrl: z.string().url().nullable(),
  legacySettingsRequireCleanup: z.boolean(),
  notice: z.string().nullable(),
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
});

export type DiscordPairingStatus = z.infer<typeof pairingStatusSchema>;
