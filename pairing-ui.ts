import type { DiscordPairingStatus } from "./contract.js";

/** Where the Discord Developer Portal actually puts each thing we ask for. */
export const DISCORD_DEVELOPER_LINKS = {
  applications: "https://discord.com/developers/applications",
  botDocs:
    "https://discord.com/developers/docs/quick-start/getting-started#step-1-creating-an-app",
  intentsDocs:
    "https://discord.com/developers/docs/events/gateway#message-content-intent",
} as const;

export interface PairingPanelView {
  connectionLabel: string;
  connectionDetail: string;
  serverLabel: string;
  userLabel: string;
  expiryLabel: string | null;
  setupStep: string;
}

/** Pure display model shared by the untested host slot and unit tests. */
export function pairingPanelView(
  status: DiscordPairingStatus,
  now: number,
): PairingPanelView {
  const connected = status.gateway.state === "connected";
  const pairing = status.pairing;
  const secondsRemaining = status.pairingCode
    ? Math.max(0, Math.ceil((status.pairingCode.expiresAt - now) / 1000))
    : null;

  return {
    connectionLabel:
      status.gateway.state === "connected"
        ? "Connected"
        : status.gateway.state === "connecting"
          ? "Connecting"
          : status.gateway.state === "failed"
            ? "Connection failed"
            : "Disconnected",
    connectionDetail: connected
      ? status.gateway.botTag
        ? `Signed in as ${status.gateway.botTag}`
        : "Discord gateway connected"
      : status.gateway.message ??
        (status.gateway.state === "connecting"
          ? "Trying to connect to Discord"
          : "Add a bot token above to connect"),
    serverLabel: pairing?.guildName ?? (pairing ? "Configured server" : "Not paired"),
    userLabel: pairing
      ? `${pairing.userTag ?? "Discord user"} (${pairing.userId})`
      : "Not connected",
    expiryLabel:
      secondsRemaining === null
        ? null
        : secondsRemaining === 0
          ? "Expired. Generate a new code"
          : `Expires in ${formatDuration(secondsRemaining)}`,
    setupStep: !status.tokenConfigured
      ? "Save your bot token in the field above."
      : status.gateway.state === "failed"
        ? status.gateway.message ?? "Fix the Discord connection settings above."
      : !status.inviteUrl
        ? "Check the bot token above, then save it again."
        : !connected
          ? "Wait for the Discord gateway to connect."
          : "Invite the bot, then send the pairing command in the Discord channel you want to use.",
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}

export function pairingSignalReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("reason" in payload)) {
    return null;
  }
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}
