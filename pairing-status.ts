import type {
  DiscordConfigurationStatus,
  DiscordExecutionStatus,
  DiscordPairingStatus,
} from "./contract.js";
import { formatPairingCode, type PendingPairingCode } from "./pairing.js";
import { botDisplayName } from "./config-view.js";

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
  pairingCode: PendingPairingCode | null;
  inviteUrl: string | null;
  configuration: DiscordConfigurationStatus;
  execution: DiscordExecutionStatus;
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
  const formattedCode = input.pairingCode
    ? formatPairingCode(input.pairingCode.code)
    : null;

  return {
    gateway: {
      state: input.gatewayState,
      botTag: input.botTag,
      message: input.gatewayMessage,
    },
    botName: botDisplayName(input.botTag),
    tokenConfigured: input.tokenConfigured,
    paired: input.storedPairing !== null,
    pairing: input.storedPairing
      ? {
          guildId: input.storedPairing.guildId,
          guildName: input.storedPairing.guildName,
          channelId: input.storedPairing.channelId,
          channelName: input.storedPairing.channelName,
          userId: input.storedPairing.userId,
          userTag: input.storedPairing.userTag,
          pairedAt: input.storedPairing.pairedAt,
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
    notice: input.notice ?? null,
    configuration: input.configuration,
    execution: input.execution,
  };
}
