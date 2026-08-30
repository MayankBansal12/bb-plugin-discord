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
  availableDecisions: Array<"allow_once" | "allow_for_session" | "deny">;
  reason: string | null;
  subject?: {
    kind?: string;
    command?: string;
    plan?: string;
    tool?: string;
  };
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

export function isAllowedSpawnLocation(
  location: DiscordMessageLocation,
  spawnChannelId: string | undefined,
): boolean {
  if (location.parentChannelId !== null) return false;
  return !spawnChannelId || location.channelId === spawnChannelId;
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

/** A compact Discord-native title; never leaks BB's internal thread id. */
export function discordSessionName(request: string): string {
  const compact = request.replace(/\s+/g, " ").trim();
  return truncate(compact || "BB conversation", 100);
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
      if (!payload.availableDecisions.includes("allow_once")) {
        return { kind: "error", message: "This approval cannot be allowed once." };
      }
      return {
        kind: "resolve",
        resolution: { decision: "allow_once", grantedPermissions: null },
      };
    }
    if (["approve session", "allow session", "always"].includes(normalized)) {
      if (!payload.availableDecisions.includes("allow_for_session")) {
        return {
          kind: "error",
          message: "This approval cannot be allowed for the session.",
        };
      }
      return {
        kind: "resolve",
        resolution: { decision: "allow_for_session", grantedPermissions: null },
      };
    }
    if (["deny", "no", "reject"].includes(normalized)) {
      if (!payload.availableDecisions.includes("deny")) {
        return { kind: "error", message: "This approval cannot be denied." };
      }
      return { kind: "resolve", resolution: { decision: "deny" } };
    }
    return {
      kind: "error",
      message: "Reply `approve`, `approve session`, or `deny` for this request.",
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
