import type { DiscordPairingStatus } from "./contract.js";
import { formatPairingCode, type PendingPairingCode } from "./pairing.js";

export interface StoredPairingStatus {
  guildId: string;
  guildName: string | null;
  channelId: string;
  channelName: string | null;
  userId: string;
  userTag: string | null;
  pairedAt: number;
}

export interface PairingStatusInput {
  gatewayState: DiscordPairingStatus["gateway"]["state"];
  gatewayMessage: string | null;
  botUserId: string | null;
  botTag: string | null;
  tokenConfigured: boolean;
  storedPairing: StoredPairingStatus | null;
  legacyGuildId: string | null;
  pairingCode: PendingPairingCode | null;
  inviteUrl: string | null;
  notice?: string | null;
}

export function pairingCommand(
  botUserId: string | null,
  formattedCode: string,
): string | null {
  return botUserId ? `<@${botUserId}> pair ${formattedCode}` : null;
}

/** Shape SQLite and secret-derived state into the strict, secret-free RPC DTO. */
export function buildPairingStatus(
  input: PairingStatusInput,
): DiscordPairingStatus {
  const activeGuildId = input.storedPairing?.guildId ?? input.legacyGuildId;
  const formattedCode = input.pairingCode
    ? formatPairingCode(input.pairingCode.code)
    : null;

  return {
    gateway: {
      state: input.gatewayState,
      botTag: input.botTag,
      message: input.gatewayMessage,
    },
    tokenConfigured: input.tokenConfigured,
    paired: activeGuildId !== null,
    pairing: input.storedPairing
      ? {
          source: "pairing",
          guildId: input.storedPairing.guildId,
          guildName: input.storedPairing.guildName,
          channelId: input.storedPairing.channelId,
          channelName: input.storedPairing.channelName,
          userId: input.storedPairing.userId,
          userTag: input.storedPairing.userTag,
          pairedAt: input.storedPairing.pairedAt,
        }
      : input.legacyGuildId
        ? {
            source: "legacy-settings",
            guildId: input.legacyGuildId,
            guildName: null,
            channelId: null,
            channelName: null,
            userId: null,
            userTag: null,
            pairedAt: null,
          }
        : null,
    pairingCode:
      input.pairingCode && formattedCode
        ? {
            code: formattedCode,
            expiresAt: input.pairingCode.expiresAt,
            command: pairingCommand(input.botUserId, formattedCode),
          }
        : null,
    inviteUrl: input.inviteUrl,
    legacySettingsRequireCleanup: input.legacyGuildId !== null,
    notice: input.notice ?? null,
  };
}
