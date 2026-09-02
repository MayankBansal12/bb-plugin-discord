// Pure onboarding helpers: pairing codes, bot-invite URLs, permission
// resolution, and Discord error classification.
//
// Deliberately free of discord.js and bb SDK imports so every branch here is
// unit-testable without a gateway connection.

import { randomInt } from "node:crypto";

/** A pairing code is single-use and short-lived. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Crockford-ish alphabet: no I/O/0/1, so codes survive being read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export interface PendingPairingCode {
  code: string;
  expiresAt: number;
}

export function generatePairingCode(
  now: number = Date.now(),
  pick: (max: number) => number = (max) => randomInt(max),
): PendingPairingCode {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  }
  return { code, expiresAt: now + PAIRING_CODE_TTL_MS };
}

/** `ABC123` renders as `ABC-123`; both forms are accepted on the way back in. */
export function formatPairingCode(code: string): string {
  return code.length === CODE_LENGTH
    ? `${code.slice(0, 3)}-${code.slice(3)}`
    : code;
}

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type PairCommand =
  | { kind: "code"; code: string }
  | { kind: "missing-code" }
  | null;

/**
 * Parses the pairing command out of a message whose bot mention has already
 * been stripped. Anything else returns null so unpaired servers stay silent.
 */
export function parsePairCommand(content: string): PairCommand {
  const text = content.trim();
  const withCode = text.match(
    /^(?:bb\s+)?(?:pair|setup|link|connect)\s+([A-Za-z0-9][A-Za-z0-9-]{2,15})$/i,
  );
  if (withCode) return { kind: "code", code: normalizePairingCode(withCode[1]!) };
  if (/^(?:bb\s+)?(?:pair|setup|link|connect)$/i.test(text)) {
    return { kind: "missing-code" };
  }
  return null;
}

export type PairingCheck =
  | { ok: true }
  | { ok: false; reason: "no-code" | "expired" | "mismatch" };

export function verifyPairingCode(
  pending: PendingPairingCode | null,
  supplied: string,
  now: number = Date.now(),
): PairingCheck {
  if (!pending) return { ok: false, reason: "no-code" };
  if (pending.expiresAt <= now) return { ok: false, reason: "expired" };
  if (normalizePairingCode(supplied) !== pending.code) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stored authorization state
// ---------------------------------------------------------------------------

export interface PairingStateDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  transaction<T extends () => void>(operation: T): T;
}

/** Remove the pairing and every guild-bound bridge row in one transaction. */
export function clearStoredPairingState(db: PairingStateDatabase): void {
  db.transaction(() => {
    db.prepare("DELETE FROM discord_pairing WHERE id = 1").run();
    db.prepare("DELETE FROM discord_allowed_users").run();
    db.prepare("DELETE FROM discord_threads").run();
    db.prepare("DELETE FROM discord_posted_replies").run();
    db.prepare("DELETE FROM discord_posted_interactions").run();
    db.prepare("DELETE FROM discord_interaction_actions").run();
  })();
}

/** Lifecycle output is valid only for a mapping in the currently authorized guild. */
export function isActiveMappedGuild(
  mappedGuildId: string,
  effectiveGuildId: string | null,
): boolean {
  return effectiveGuildId !== null && mappedGuildId === effectiveGuildId;
}

export type PairingFailureReason = "no-code" | "expired" | "mismatch";

export function pairingFailureMessage(reason: PairingFailureReason): string {
  switch (reason) {
    case "no-code":
      return "No pairing code is active. Open Settings → Extensions → Plugins → Discord in bb to create one.";
    case "expired":
      return "That pairing code expired. Create a new one in Settings → Extensions → Plugins → Discord in bb.";
    default:
      return "That code does not match. Copy the current command from Settings → Extensions → Plugins → Discord in bb.";
  }
}

// ---------------------------------------------------------------------------
// Bot invite
// ---------------------------------------------------------------------------

/**
 * `messages` is the baseline the bridge needs: read and write messages and
 * threads. `full` additionally lets the agent administer the server.
 */
export type DiscordAccessLevel = "messages" | "full";

/** Verified against discord.js `PermissionFlagsBits` in pairing.test.ts. */
const PERMISSION_BITS = {
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  ManageRoles: 1n << 28n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  SendMessagesInThreads: 1n << 38n,
  ModerateMembers: 1n << 40n,
} as const;

export type PermissionName = keyof typeof PERMISSION_BITS;

export const MESSAGE_PERMISSIONS: PermissionName[] = [
  "AddReactions",
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "AttachFiles",
  "ReadMessageHistory",
  "CreatePublicThreads",
  "SendMessagesInThreads",
];

export const FULL_PERMISSIONS: PermissionName[] = [
  ...MESSAGE_PERMISSIONS,
  "KickMembers",
  "BanMembers",
  "ManageChannels",
  "ManageGuild",
  "ManageMessages",
  "ManageRoles",
  "ManageThreads",
  "CreatePrivateThreads",
  "ModerateMembers",
];

export function permissionBits(names: readonly PermissionName[]): bigint {
  return names.reduce((total, name) => total | PERMISSION_BITS[name], 0n);
}

export function invitePermissions(level: DiscordAccessLevel): bigint {
  return permissionBits(level === "full" ? FULL_PERMISSIONS : MESSAGE_PERMISSIONS);
}

/**
 * Discord bot tokens are `base64url(applicationId).<timestamp>.<hmac>`, so the
 * invite URL can be built from the token the user already pasted instead of
 * sending them back to the Developer Portal's URL generator.
 */
export function applicationIdFromToken(token: string): string | null {
  const first = token.trim().split(".")[0];
  if (!first) return null;
  try {
    const decoded = Buffer.from(first, "base64url").toString("utf8");
    return /^\d{15,22}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function buildInviteUrl(
  applicationId: string,
  level: DiscordAccessLevel,
): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: "bot",
    permissions: invitePermissions(level).toString(),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function inviteUrlFromToken(
  token: string | undefined,
  level: DiscordAccessLevel,
): string | null {
  if (!token) return null;
  const applicationId = applicationIdFromToken(token);
  return applicationId ? buildInviteUrl(applicationId, level) : null;
}

// ---------------------------------------------------------------------------
// Permission mode for Discord-started threads
// ---------------------------------------------------------------------------

export type BbPermissionMode = "accept-edits" | "auto" | "full";
export type PermissionModeSetting = BbPermissionMode | "project-default";

/**
 * Auto keeps workspace sandboxing while avoiding routine user prompts, which
 * makes it the practical default for a remote Discord conversation. Existing
 * explicit choices always win.
 */
export function resolveSpawnPermissionMode(
  configured: string | undefined,
  projectDefault: BbPermissionMode,
): BbPermissionMode {
  if (configured === "project-default") return projectDefault;
  if (configured === "accept-edits" || configured === "auto" || configured === "full") {
    return configured;
  }
  return "auto";
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type DiscordErrorKind =
  | "invalid-token"
  | "disallowed-intents"
  | "missing-members-intent"
  | "missing-permissions"
  | "not-found"
  | "rate-limited"
  | "network"
  | "unknown";

/** Kinds that a retry cannot fix; the operator has to change something. */
const NEEDS_CONFIGURATION: ReadonlySet<DiscordErrorKind> = new Set([
  "invalid-token",
  "disallowed-intents",
]);

export function needsConfigurationFor(kind: DiscordErrorKind): boolean {
  return NEEDS_CONFIGURATION.has(kind);
}

export interface ClassifiedDiscordError {
  kind: DiscordErrorKind;
  /** Operator-facing sentence, safe to show in bb status and in Discord. */
  message: string;
  /** True when retrying without a configuration change cannot help. */
  needsConfiguration: boolean;
}

function errorCode(error: unknown): string | number | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") return code;
  }
  return undefined;
}

export function classifyDiscordError(error: unknown): ClassifiedDiscordError {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();
  const code = errorCode(error);

  const tagged =
    error && typeof error === "object" && "discordErrorKind" in error
      ? (error as { discordErrorKind?: DiscordErrorKind }).discordErrorKind
      : undefined;
  if (tagged) {
    return {
      kind: tagged,
      message: raw,
      needsConfiguration: needsConfigurationFor(tagged),
    };
  }

  if (code === 4014 || text.includes("disallowed intents")) {
    return {
      kind: "disallowed-intents",
      message:
        "Discord rejected the connection because a privileged intent is off. Open the Developer Portal → your application → Bot and enable Message Content Intent, then try again.",
      needsConfiguration: needsConfigurationFor("disallowed-intents"),
    };
  }
  if (
    code === "TokenInvalid" ||
    code === 4004 ||
    text.includes("an invalid token was provided") ||
    text.includes("unauthorized")
  ) {
    return {
      kind: "invalid-token",
      message:
        "Discord rejected the bot token. Copy it again from the Developer Portal → Bot → Reset Token and paste it into the Discord plugin settings.",
      needsConfiguration: needsConfigurationFor("invalid-token"),
    };
  }
  if (code === 50001 || code === 50013 || text.includes("missing permissions") || text.includes("missing access")) {
    return {
      kind: "missing-permissions",
      message:
        "The bot lacks permission for that action. Open Settings → Extensions → Plugins → Discord in bb and use the invite link again, or update the bot role in Discord.",
      needsConfiguration: needsConfigurationFor("missing-permissions"),
    };
  }
  if (text.includes("guildmembers") || text.includes("members intent")) {
    return {
      kind: "missing-members-intent",
      message:
        "Listing members needs Server Members Intent, which is off. Enable it in the Developer Portal → Bot, or skip member operations.",
      needsConfiguration: needsConfigurationFor("missing-members-intent"),
    };
  }
  if (code === 10003 || code === 10004 || code === 10007 || code === 10011 || code === 10008) {
    return {
      kind: "not-found",
      message: `Discord could not find that resource: ${raw}`,
      needsConfiguration: needsConfigurationFor("not-found"),
    };
  }
  if (code === 429 || text.includes("rate limit")) {
    return {
      kind: "rate-limited",
      message: "Discord is rate limiting the bot. Retrying shortly.",
      needsConfiguration: needsConfigurationFor("rate-limited"),
    };
  }
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    text.includes("network") ||
    text.includes("fetch failed")
  ) {
    return {
      kind: "network",
      message: `Could not reach Discord: ${raw}`,
      needsConfiguration: needsConfigurationFor("network"),
    };
  }
  return {
    kind: "unknown",
    message: raw,
    needsConfiguration: needsConfigurationFor("unknown"),
  };
}

/** Exponential backoff with a ceiling, used between gateway login attempts. */
export function retryDelayMs(attempt: number): number {
  const base = 2_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 60_000);
}
