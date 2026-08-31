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
  channelLabel: string;
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
    channelLabel: pairing
      ? pairing.channelName
        ? `#${pairing.channelName}`
        : pairing.source === "legacy-settings"
          ? "Set by advanced settings"
          : "Paired channel"
      : "—",
    userLabel: pairing
      ? pairing.userId
        ? `${pairing.userTag ?? "Discord user"} (${pairing.userId})`
        : pairing.source === "legacy-settings"
          ? "Set by advanced settings"
          : "Pairing owner"
      : "—",
    expiryLabel:
      secondsRemaining === null
        ? null
        : secondsRemaining === 0
          ? "Expired — generate a new code"
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

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export type SetupStepId = "token" | "invite" | "pair";
export type SetupStepState = "done" | "active" | "upcoming" | "blocked";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
  /** One line, shown when the step is collapsed. Carries the masked value. */
  summary: string;
  /** Instructions, shown only while the step is the active one. */
  detail: string;
}

export interface SetupView {
  /** "paired" means onboarding is finished and the panel collapses to status. */
  stage: SetupStepId | "paired";
  steps: SetupStep[];
  /** Progress for the host-agnostic meter, 0…1. */
  progress: number;
}

/**
 * Onboarding is one ordered path — token, invite, pair — and only the step the
 * operator can act on is expanded. Finished steps collapse to the value they
 * produced (masked where it is sensitive) so the panel stays a summary rather
 * than a wall of instructions the second time someone opens it.
 */
export function setupView(status: DiscordPairingStatus): SetupView {
  const tokenDone = status.tokenConfigured;
  const gatewayFailed = status.gateway.state === "failed";
  const connected = status.gateway.state === "connected";
  const inviteReady = Boolean(status.inviteUrl);
  const paired = status.paired;

  const stage: SetupView["stage"] = paired
    ? "paired"
    : !tokenDone || gatewayFailed
      ? "token"
      : !inviteReady || !connected
        ? "invite"
        : "pair";

  const stepState = (id: SetupStepId): SetupStepState => {
    if (paired) return "done";
    if (id === "token") {
      if (gatewayFailed) return "blocked";
      return tokenDone ? "done" : "active";
    }
    if (id === "invite") {
      if (!tokenDone || gatewayFailed) return "upcoming";
      return stage === "invite" ? "active" : "done";
    }
    if (!tokenDone || gatewayFailed) return "upcoming";
    return stage === "pair" ? "active" : "upcoming";
  };

  const applicationId = status.configuration.botToken.applicationId;
  const masked = status.configuration.botToken.masked;

  const steps: SetupStep[] = [
    {
      id: "token",
      title: "Add the bot token",
      state: stepState("token"),
      summary: gatewayFailed
        ? status.gateway.message ?? "Discord rejected this token."
        : tokenDone
          ? applicationId
            ? `Application ${applicationId} · ${masked ?? "token saved"}`
            : masked ?? "Token saved"
          : "Not set",
      detail:
        "Create an application in the Discord Developer Portal, open its Bot tab, turn on Message Content Intent, then Reset Token and copy the value. Paste it into the “Discord bot token” field above and press Save settings.",
    },
    {
      id: "invite",
      title: "Invite the bot to one server",
      state: stepState("invite"),
      summary: !tokenDone
        ? "Waiting for a token"
        : !inviteReady
          ? "The saved token has no readable application id"
          : paired
            ? `Invited to ${status.pairing?.guildName ?? "your server"}`
            : connected
              ? `Ready · ${status.configuration.serverAccess.value === "full" ? "full access" : "message access"}`
              : "Waiting for the Discord gateway",
      detail:
        "Open the invite below and pick the one server this bot should serve. The invite already carries the permissions your Discord server access setting implies.",
    },
    {
      id: "pair",
      title: "Pair from inside Discord",
      state: stepState("pair"),
      summary: paired
        ? `Paired with ${status.pairing?.guildName ?? "your server"}`
        : status.pairingCode?.command
          ? "Send the one-time command in Discord"
          : "Waiting for the earlier steps",
      detail:
        "Send the command below in the channel you want alerts to land in. That channel becomes the home channel, and the person who sends it becomes the authorized user.",
    },
  ];

  const done = steps.filter((step) => step.state === "done").length;
  return { stage, steps, progress: paired ? 1 : done / steps.length };
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
