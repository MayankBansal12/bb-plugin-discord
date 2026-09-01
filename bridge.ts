export interface DiscordMessageLocation {
  channelId: string;
  parentChannelId: string | null;
}

export interface DiscordRouteMapping {
  /** Discord channel or thread that currently owns the BB conversation. */
  discordChannelId: string;
  /** Null identifies a pre-session row created by older plugin versions. */
  discordParentChannelId: string | null;
}

export type DiscordInboundRoute =
  | { kind: "ignore" }
  | { kind: "start-session" }
  | { kind: "forward-session" }
  | { kind: "migrate-legacy-session" };

export interface ApprovalPayload {
  kind: "approval";
  availableDecisions: ApprovalDecision[];
  reason: string | null;
  subject?: {
    kind?: string;
    command?: string;
    plan?: string;
    tool?: string;
  };
}

export type ApprovalDecision = "allow_once" | "allow_for_session" | "deny";

export interface DiscordApprovalAction {
  token: string;
  decision: ApprovalDecision;
}

export interface UserQuestionPayload {
  kind: "user_question";
  questions: Array<{
    id: string;
    prompt: string;
    allowFreeText: boolean;
    multiSelect: boolean;
    options?: Array<{ label: string; value: string }>;
  }>;
}

export interface RequestPayload {
  kind: string;
  title?: string;
}

export interface PendingInteractionLike {
  id: string;
  status: string;
  payload: ApprovalPayload | UserQuestionPayload | RequestPayload;
  origin?: { kind?: string };
}

export type InteractionResolution =
  | {
      kind: "resolve";
      resolution:
        | { decision: "allow_once" | "allow_for_session"; grantedPermissions: null }
        | { decision: "deny" }
        | {
            kind: "user_answer";
            answers: Record<string, { selected: string[]; freeText?: string }>;
          }
        | { kind: "request_answer"; value: string };
    }
  | { kind: "respond"; value: string }
  | { kind: "error"; message: string };

export interface ActiveThreadWatcherOptions {
  intervalMs: number;
  inspect: (threadId: string) => Promise<void>;
  onError: (
    threadId: string,
    error: unknown,
  ) => "stop" | void | Promise<"stop" | void>;
  initiallyPaused?: boolean;
  scheduler?: {
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

const APPROVAL_REPLY_BY_DECISION = {
  allow_once: "`approve`",
  allow_for_session: "`approve session`",
  deny: "`deny`",
} as const satisfies Record<ApprovalPayload["availableDecisions"][number], string>;

const APPROVAL_ACTION_PREFIX = "bb-approval:v1";
const APPROVAL_ACTION_TOKEN = /^[a-f0-9]{24}$/;

/** Compact, versioned custom id for Discord buttons (Discord caps it at 100 chars). */
export function discordApprovalActionId(
  token: string,
  decision: ApprovalDecision,
): string {
  if (!APPROVAL_ACTION_TOKEN.test(token)) {
    throw new Error("Invalid Discord approval action token.");
  }
  return `${APPROVAL_ACTION_PREFIX}:${token}:${decision}`;
}

/** Ignore every component id not owned by this bridge, including future versions. */
export function parseDiscordApprovalActionId(
  customId: string,
): DiscordApprovalAction | null {
  const [prefix, version, token, decision, extra] = customId.split(":");
  if (
    prefix !== "bb-approval" ||
    version !== "v1" ||
    extra !== undefined ||
    !token ||
    !APPROVAL_ACTION_TOKEN.test(token) ||
    (decision !== "allow_once" &&
      decision !== "allow_for_session" &&
      decision !== "deny")
  ) {
    return null;
  }
  return { token, decision };
}

/**
 * One bounded timer for every mapped BB thread that is currently working.
 * A tick never overlaps the previous one, even when Discord or BB is slow.
 */
export class ActiveThreadWatcher {
  private readonly targets = new Set<string>();
  private readonly opts: ActiveThreadWatcherOptions;
  private readonly scheduler: NonNullable<ActiveThreadWatcherOptions["scheduler"]>;
  private timer: unknown = null;
  private paused: boolean;
  private inspecting = false;

  constructor(opts: ActiveThreadWatcherOptions) {
    this.opts = opts;
    this.paused = opts.initiallyPaused ?? false;
    this.scheduler = opts.scheduler ?? {
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  start(threadId: string): void {
    this.targets.add(threadId);
    this.reconcileTimer();
  }

  stop(threadId: string): void {
    this.targets.delete(threadId);
    this.reconcileTimer();
  }

  pause(): void {
    this.paused = true;
    this.reconcileTimer();
  }

  resume(): void {
    this.paused = false;
    this.reconcileTimer();
  }

  dispose(): void {
    this.paused = true;
    this.targets.clear();
    this.reconcileTimer();
  }

  async tick(): Promise<void> {
    if (this.paused || this.inspecting || this.targets.size === 0) return;
    this.inspecting = true;
    try {
      for (const threadId of [...this.targets]) {
        if (!this.targets.has(threadId)) continue;
        try {
          await this.opts.inspect(threadId);
        } catch (error) {
          if ((await this.opts.onError(threadId, error)) === "stop") {
            this.stop(threadId);
          }
        }
      }
    } finally {
      this.inspecting = false;
    }
  }

  get targetCount(): number {
    return this.targets.size;
  }

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  private reconcileTimer(): void {
    const shouldRun = !this.paused && this.targets.size > 0;
    if (shouldRun && this.timer === null) {
      this.timer = this.scheduler.setInterval(
        () => void this.tick(),
        this.opts.intervalMs,
      );
    } else if (!shouldRun && this.timer !== null) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Serializes the DB-backed check/post/mark sequence for one interaction. */
export class InteractionAnnouncementGuard {
  private readonly inFlight = new Set<string>();

  async postOnce(options: {
    key: string;
    isPosted: () => boolean;
    post: () => Promise<boolean>;
    markPosted: () => void;
  }): Promise<boolean> {
    if (options.isPosted() || this.inFlight.has(options.key)) return false;
    this.inFlight.add(options.key);
    try {
      if (options.isPosted()) return false;
      const posted = await options.post();
      if (posted) options.markPosted();
      return posted;
    } finally {
      this.inFlight.delete(options.key);
    }
  }
}

/** Stop work and move the notification after a Discord session is unusable. */
export async function detachUnavailableSession(operations: {
  stopBbThread: () => Promise<void>;
  onStopError: (error: unknown) => void;
  unlink: () => void;
  notifyParent: (() => Promise<boolean>) | null;
  notifyHome: () => Promise<void>;
}): Promise<void> {
  try {
    await operations.stopBbThread();
  } catch (error) {
    operations.onStopError(error);
  }
  operations.unlink();
  const parentPosted = operations.notifyParent
    ? await operations.notifyParent()
    : false;
  if (!parentPosted) await operations.notifyHome();
}

export function parseDiscordIds(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => /^\d{15,22}$/.test(part)),
    ),
  );
}

export function normalizeOptionalDiscordSnowflake(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^\d{15,22}$/.test(trimmed)) {
    throw new Error("Expected a Discord channel ID with 15–22 digits.");
  }
  return trimmed;
}

export function isAllowedSpawnLocation(
  location: Pick<DiscordMessageLocation, "channelId">,
  spawnChannelId: string | undefined,
): boolean {
  return !spawnChannelId || location.channelId === spawnChannelId;
}

export function routeCreatesSession(route: DiscordInboundRoute): boolean {
  return route.kind === "start-session" || route.kind === "migrate-legacy-session";
}

/** Spawn BB first so a failed spawn can never leave a Discord session behind. */
export async function prepareDiscordSession<TThread, TSession>(operations: {
  spawnBbThread: () => Promise<TThread>;
  createDiscordSession: () => Promise<TSession>;
  cleanupBbThread: (thread: TThread) => Promise<void>;
}): Promise<{ thread: TThread; session: TSession }> {
  const thread = await operations.spawnBbThread();
  try {
    const session = await operations.createDiscordSession();
    return { thread, session };
  } catch (error) {
    await operations.cleanupBbThread(thread);
    throw error;
  }
}

export function shouldAlertHomeForFailure(
  sessionChannelId: string,
  homeChannelId: string | null,
): boolean {
  return homeChannelId !== null && homeChannelId !== sessionChannelId;
}

/**
 * Decide whether an authorized inbound message belongs to a BB conversation.
 * Normal channels are mention-only launchers; Discord threads are sessions.
 */
export function routeDiscordMessage(
  message: DiscordMessageLocation & { mentioned: boolean },
  mapping: DiscordRouteMapping | null,
): DiscordInboundRoute {
  if (message.parentChannelId !== null) {
    return mapping?.discordChannelId === message.channelId
      ? { kind: "forward-session" }
      : { kind: "ignore" };
  }

  if (!message.mentioned) return { kind: "ignore" };
  if (!mapping) return { kind: "start-session" };

  return mapping.discordParentChannelId === null
    ? { kind: "migrate-legacy-session" }
    : { kind: "ignore" };
}

/**
 * A compact Discord-native title; never leaks BB's internal thread id. The
 * fallback is the bot's own name so an empty request does not produce a thread
 * named after a product nobody in the server recognizes.
 */
export function discordSessionName(
  request: string,
  botName = "BB",
): string {
  const compact = request.replace(/\s+/g, " ").trim();
  return truncate(compact || `${botName} conversation`, 100);
}

export function resolveInteractionReply(
  interaction: PendingInteractionLike,
  rawText: string,
): InteractionResolution {
  const text = rawText.trim();
  const normalized = text.toLowerCase().replace(/^bb\s+/, "");
  const payload = interaction.payload;

  if (payload.kind === "approval" && "availableDecisions" in payload) {
    if (["approve", "allow", "yes", "approve once"].includes(normalized)) {
      return resolveApprovalDecision(interaction, "allow_once");
    }
    if (["approve session", "allow session", "always"].includes(normalized)) {
      return resolveApprovalDecision(interaction, "allow_for_session");
    }
    if (["deny", "no", "reject"].includes(normalized)) {
      return resolveApprovalDecision(interaction, "deny");
    }
    return {
      kind: "error",
      message: pendingInteractionPrompt(interaction),
    };
  }

  if (payload.kind === "user_question" && "questions" in payload) {
    const supplied = parseQuestionAnswers(text, payload.questions.length);
    if (!supplied) {
      return {
        kind: "error",
        message:
          payload.questions.length === 1
            ? "Reply with an answer to the pending BB question."
            : "Reply on separate lines as `1: answer`, `2: answer`, and so on.",
      };
    }

    const answers: Record<string, { selected: string[]; freeText?: string }> = {};
    for (let index = 0; index < payload.questions.length; index += 1) {
      const question = payload.questions[index]!;
      const answer = supplied[index]!.trim();
      const matched = question.options?.filter(
        (option) =>
          option.label.toLowerCase() === answer.toLowerCase() ||
          option.value.toLowerCase() === answer.toLowerCase(),
      );

      if (matched && matched.length > 0) {
        answers[question.id] = {
          selected: question.multiSelect
            ? matched.map((option) => option.value)
            : [matched[0]!.value],
        };
      } else if (question.allowFreeText) {
        answers[question.id] = { selected: [], freeText: answer };
      } else {
        const choices = question.options?.map((option) => option.label).join(", ");
        return {
          kind: "error",
          message: choices
            ? `Choose one of: ${choices}`
            : "That question does not accept free-text answers.",
        };
      }
    }

    return {
      kind: "resolve",
      resolution: { kind: "user_answer", answers },
    };
  }

  if (interaction.origin?.kind === "plugin") {
    return { kind: "respond", value: text };
  }

  return {
    kind: "resolve",
    resolution: { kind: "request_answer", value: text },
  };
}

/** Resolve exactly one decision advertised by BB; shared by text and buttons. */
export function resolveApprovalDecision(
  interaction: PendingInteractionLike,
  decision: ApprovalDecision,
): InteractionResolution {
  const payload = interaction.payload;
  if (
    payload.kind !== "approval" ||
    !("availableDecisions" in payload) ||
    !payload.availableDecisions.includes(decision)
  ) {
    return { kind: "error", message: pendingInteractionPrompt(interaction) };
  }
  if (decision === "deny") {
    return { kind: "resolve", resolution: { decision: "deny" } };
  }
  return {
    kind: "resolve",
    resolution: { decision, grantedPermissions: null },
  };
}

export function describePendingInteraction(
  interaction: PendingInteractionLike,
): string {
  const payload = interaction.payload;
  if (payload.kind === "approval" && "availableDecisions" in payload) {
    const subject = payload.subject;
    const detail = subject?.command ?? subject?.plan ?? subject?.tool ?? subject?.kind;
    return [payload.reason, detail].filter(Boolean).join(" — ") || "Approval requested";
  }
  if (payload.kind === "user_question" && "questions" in payload) {
    return payload.questions
      .map((question, index) => {
        const choices = question.options?.map((option) => option.label).join(" / ");
        return `${index + 1}. ${question.prompt}${choices ? ` (${choices})` : ""}`;
      })
      .join("\n");
  }
  return ("title" in payload ? payload.title : undefined) ??
    `BB is waiting on ${payload.kind}.`;
}

/** The one source of truth for choices advertised in Discord. */
export function pendingInteractionReplyInstructions(
  interaction: PendingInteractionLike,
): string {
  const payload = interaction.payload;
  if (payload.kind !== "approval" || !("availableDecisions" in payload)) {
    return "Reply here to answer.";
  }

  const offered = payload.availableDecisions.map(
    (decision) => APPROVAL_REPLY_BY_DECISION[decision],
  );
  if (offered.length === 0) {
    return "Open BB to answer this approval request.";
  }
  return `Reply ${joinChoices(offered)}.`;
}

/** Subject plus instructions, shared by announcements and reply errors. */
export function pendingInteractionPrompt(
  interaction: PendingInteractionLike,
  maxSubjectChars?: number,
): string {
  const subject = describePendingInteraction(interaction);
  return `${maxSubjectChars ? truncate(subject, maxSubjectChars) : subject}\n_${pendingInteractionReplyInstructions(interaction)}_`;
}

function parseQuestionAnswers(text: string, count: number): string[] | null {
  if (count === 1) return text ? [text] : null;
  const answers = new Array<string | undefined>(count);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+)\s*$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < count) answers[index] = match[2];
  }
  const complete = Array.from({ length: count }, (_, index) => answers[index]);
  return complete.every((answer) => answer?.trim())
    ? (complete as string[])
    : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function joinChoices(choices: string[]): string {
  if (choices.length === 1) return choices[0]!;
  if (choices.length === 2) return `${choices[0]} or ${choices[1]}`;
  return `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`;
}
