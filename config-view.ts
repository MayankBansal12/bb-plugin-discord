// Pure helpers that turn stored settings plus pairing state into the values
// the settings UI and the CLI show.
//
// Two rules drive everything here:
//   1. Never surface a live secret. The bot token and the pairing code are
//      reduced to recognizable-but-useless fragments; only four trailing
//      token characters are retained so an operator can identify a rotation.
//   2. Show the *effective* value, not the raw setting. An empty home-channel
//      field still resolves to the channel that ran the pairing command, and a
//      user who cannot see that has no way to know where alerts will land.

import type { DiscordAccessLevel } from "./pairing.js";

/** Placeholder used before the gateway has told us who the bot is. */
export const UNKNOWN_BOT_NAME = "the bot";

/**
 * Discord tags are `name` (new usernames) or `name#1234` (legacy). Discord
 * copy should read as the bot the operator invited, not as "bb".
 */
export function botDisplayName(botTag: string | null | undefined): string {
  const trimmed = botTag?.trim();
  if (!trimmed) return UNKNOWN_BOT_NAME;
  const withoutDiscriminator = trimmed.replace(/#\d{1,4}$/, "").trim();
  return withoutDiscriminator || UNKNOWN_BOT_NAME;
}

/** Sentence-leading form of {@link botDisplayName}. */
export function botSentenceName(botTag: string | null | undefined): string {
  const name = botDisplayName(botTag);
  return name === UNKNOWN_BOT_NAME ? "The bot" : name;
}

export interface MaskedToken {
  /** A fixed-width mask plus only the final four characters for recognition. */
  masked: string;
}

/**
 * A configured token renders as dots plus its final four characters. This is
 * enough to distinguish a recently rotated token without showing its public
 * application id or a useful portion of the signing secret.
 */
export function maskBotToken(token: string | undefined): MaskedToken | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  return { masked: `••••••••${trimmed.slice(-4)}` };
}

export type ValueSource = "setting" | "pairing" | "default" | "none";

export interface ChannelDisplay {
  id: string | null;
  name: string | null;
  source: ValueSource;
}

/**
 * Alerts go to the configured channel, else the channel the pairing command
 * ran in. The UI has to render the second case or an empty field reads as
 * "nowhere".
 */
export function effectiveHomeChannel(
  configuredId: string | undefined,
  pairing: { channelId: string | null; channelName: string | null } | null,
): ChannelDisplay {
  const configured = configuredId?.trim();
  if (configured) {
    const matchesPairing = pairing?.channelId === configured;
    return {
      id: configured,
      name: matchesPairing ? pairing?.channelName ?? null : null,
      source: "setting",
    };
  }
  if (pairing?.channelId) {
    return { id: pairing.channelId, name: pairing.channelName, source: "pairing" };
  }
  return { id: null, name: null, source: "none" };
}

/** `#general`, else `<#id>`, else an explicit "not set" the UI can style. */
export function channelLabel(channel: ChannelDisplay): string {
  if (channel.name) return `#${channel.name}`;
  if (channel.id) return `<#${channel.id}>`;
  return "Not set";
}

export interface DerivedIdDisplay {
  value: string | null;
  source: ValueSource;
}

export interface AuthorizedUserDisplay {
  id: string;
  tag: string | null;
  source: ValueSource;
}

/**
 * The person who paired is always authorized and is not in the `bb discord
 * allow` table, so list the union with its provenance.
 */
export function authorizedUsers(
  allowedIds: readonly string[],
  pairing: { userId: string | null; userTag: string | null } | null,
): AuthorizedUserDisplay[] {
  const byId = new Map<string, AuthorizedUserDisplay>();
  if (pairing?.userId) {
    byId.set(pairing.userId, {
      id: pairing.userId,
      tag: pairing.userTag,
      source: "pairing",
    });
  }
  for (const id of allowedIds) {
    if (!byId.has(id)) byId.set(id, { id, tag: null, source: "setting" });
  }
  return [...byId.values()];
}

export interface DestructiveActionsState {
  /** What the operator saved. */
  configured: boolean;
  /** What the agent can actually do right now. */
  effective: boolean;
  /** Set when `configured` is on but `effective` is off, and says why. */
  blockedReason: string | null;
}

/**
 * Destructive actions are gated on full server access. The two settings stay
 * strictly independent: this reports the gate, it never rewrites either value,
 * so toggling one can never silently escalate the other.
 */
export function destructiveActionsState(
  accessLevel: DiscordAccessLevel,
  configured: boolean,
): DestructiveActionsState {
  if (!configured) {
    return { configured: false, effective: false, blockedReason: null };
  }
  if (accessLevel !== "full") {
    return {
      configured: true,
      effective: false,
      blockedReason:
        "Destructive actions stay off until Discord server access is set to Full. Server access was not changed for you.",
    };
  }
  return { configured: true, effective: true, blockedReason: null };
}

/** Human label for the graduated access levels, used in UI and invite copy. */
export function accessLevelLabel(level: DiscordAccessLevel): string {
  return level === "full"
    ? "Full (messages and server administration)"
    : "Messages and threads";
}

export const PERMISSION_MODE_LABELS: Record<string, string> = {
  auto: "Auto (ask before risky actions)",
  "accept-edits": "Accept edits",
  full: "Full (no approval prompts)",
  "project-default": "Project default",
};

export function permissionModeLabel(mode: string | undefined): string {
  return PERMISSION_MODE_LABELS[mode ?? "auto"] ?? PERMISSION_MODE_LABELS.auto!;
}
