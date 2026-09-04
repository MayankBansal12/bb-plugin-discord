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

/**
 * The machine a Discord request lands on when nothing is pinned: the selected
 * project's default checkout, or bb's primary host when the project names none
 * (the personal project never does).
 *
 * The panel folds this machine into its single "… (default)" entry and drops
 * it from the rest of the list. Resolving it in one place is what keeps the
 * same machine from being offered twice — once unnamed as the default, and
 * again by name — and keeps a pinned machine that *is* the default collapsed
 * onto that entry instead of selecting an option the list no longer renders.
 */
export function resolveDefaultMachineId(
  execution: DiscordPairingStatus["execution"],
  projectId: string,
): string | null {
  const project = projectId
    ? execution.projects.find((entry) => entry.id === projectId) ?? null
    : execution.projects.find((entry) => entry.kind === "personal") ?? null;
  if (project?.defaultHostId) return project.defaultHostId;
  const primary = execution.primaryHostId;
  if (!primary) return null;
  // A standard project only runs where it is checked out, so bb would not fall
  // back to the primary host there; leave the entry unnamed rather than name a
  // machine the project cannot use.
  if (project?.kind === "standard" && !project.hostIds.includes(primary)) {
    return null;
  }
  return primary;
}
