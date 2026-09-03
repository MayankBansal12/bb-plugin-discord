import assert from "node:assert/strict";
import test from "node:test";
import {
  ActiveThreadWatcher,
  detachUnavailableSession,
  describePendingInteraction,
  discordApprovalActionId,
  discordQuestionActionId,
  discordQuestionControl,
  discordSessionName,
  isAllowedSpawnLocation,
  isDiscordAgentConversation,
  normalizeOptionalDiscordSnowflake,
  prepareDiscordSession,
  rehydrateActiveThreadWatches,
  resolveDiscordInteractionOwner,
  parseDiscordIds,
  pendingInteractionPrompt,
  pendingInteractionReplyInstructions,
  parseDiscordApprovalActionId,
  parseDiscordQuestionActionId,
  InteractionAnnouncementGuard,
  routeDiscordMessage,
  routeCreatesSession,
  resolveInteractionReply,
  resolveApprovalDecision,
  resolveQuestionSelection,
  shouldAlertHomeForFailure,
} from "./bridge.js";

test("Discord agent conversations are recognized before and after mapping", () => {
  assert.equal(isDiscordAgentConversation("discord", "discord", false), true);
  assert.equal(isDiscordAgentConversation("discord", null, true), true);
  assert.equal(isDiscordAgentConversation("discord", "side-chat", false), false);
  assert.equal(isDiscordAgentConversation("discord", null, false), false);
});

test("child and nested worker interactions inherit their Discord session owner", () => {
  const direct = new Set(["discord-root"]);
  const routes = new Map([["child", "discord-root"]]);
  const resolve = (id: string, parentThreadId: string | null) =>
    resolveDiscordInteractionOwner(
      { id, parentThreadId },
      (threadId) => direct.has(threadId),
      (threadId) => routes.get(threadId),
    );

  assert.equal(resolve("discord-root", null), "discord-root");
  assert.equal(resolve("child", "discord-root"), "discord-root");
  assert.equal(resolve("grandchild", "child"), "discord-root");
  assert.equal(resolve("unrelated", null), undefined);
  assert.equal(resolve("unrelated-child", "unrelated"), undefined);
});

test("Discord approval component ids round-trip and reject foreign input", () => {
  const token = "0123456789abcdef01234567";
  const customId = discordApprovalActionId(token, "allow_for_session");
  assert.equal(customId.length < 100, true);
  assert.deepEqual(parseDiscordApprovalActionId(customId), {
    token,
    decision: "allow_for_session",
  });
  assert.equal(parseDiscordApprovalActionId("another-plugin:button"), null);
  assert.equal(
    parseDiscordApprovalActionId(`bb-approval:v1:${token}:full`),
    null,
  );
  assert.throws(
    () => discordApprovalActionId("raw-BB-interaction-id", "allow_once"),
    /Invalid Discord approval action token/,
  );
});

test("Discord question component ids round-trip and reject foreign input", () => {
  const token = "0123456789abcdef01234567";
  assert.equal(discordQuestionActionId(token), `bb-question:v1:${token}`);
  assert.deepEqual(parseDiscordQuestionActionId(`bb-question:v1:${token}`), {
    token,
  });
  assert.equal(parseDiscordQuestionActionId(`bb-question:v2:${token}`), null);
  assert.equal(parseDiscordQuestionActionId("another-plugin:select"), null);
  assert.throws(
    () => discordQuestionActionId("raw-BB-interaction-id"),
    /Invalid Discord question action token/,
  );
});
import {
  DiscordChannelBoundaryError,
  isUnavailableDiscordChannelError,
} from "./discord.js";

test("the active-thread watcher runs one timer only while it has targets", () => {
  const timers = new Set<unknown>();
  let nextTimer = 0;
  const watcher = new ActiveThreadWatcher({
    intervalMs: 5000,
    inspect: async () => {},
    onError: () => {},
    scheduler: {
      setInterval: () => {
        const timer = ++nextTimer;
        timers.add(timer);
        return timer;
      },
      clearInterval: (timer) => timers.delete(timer),
    },
  });

  watcher.start("thread-1");
  watcher.start("thread-2");
  assert.equal(watcher.targetCount, 2);
  assert.equal(watcher.isScheduled, true);
  assert.equal(timers.size, 1);

  watcher.stop("thread-1");
  assert.equal(timers.size, 1);
  watcher.stop("thread-2");
  assert.equal(watcher.isScheduled, false);
  assert.equal(timers.size, 0);
});

test("the active-thread watcher pauses for gateway teardown and disposes cleanly", () => {
  const timers = new Set<unknown>();
  const watcher = new ActiveThreadWatcher({
    intervalMs: 5000,
    inspect: async () => {},
    onError: () => {},
    scheduler: {
      setInterval: () => {
        const timer = {};
        timers.add(timer);
        return timer;
      },
      clearInterval: (timer) => timers.delete(timer),
    },
  });

  watcher.start("thread-1");
  watcher.pause();
  assert.equal(timers.size, 0);
  assert.equal(watcher.targetCount, 1);
  watcher.resume();
  assert.equal(timers.size, 1);
  watcher.dispose();
  assert.equal(timers.size, 0);
  assert.equal(watcher.targetCount, 0);
});

test("restart rehydration watches active threads and pending idle interactions", async () => {
  const watched: string[] = [];
  const errors: string[] = [];
  await rehydrateActiveThreadWatches({
    threadIds: ["active", "starting", "pending-idle", "idle", "missing"],
    inspect: async (threadId) => {
      if (threadId === "missing") throw new Error("not found");
      return {
        status: threadId === "pending-idle" ? "idle" : threadId,
        pendingInteractionCount: threadId === "pending-idle" ? 1 : 0,
      };
    },
    watch: (threadId) => watched.push(threadId),
    onError: (threadId) => errors.push(threadId),
  });

  assert.deepEqual(watched, ["active", "starting", "pending-idle", "missing"]);
  assert.deepEqual(errors, ["missing"]);
});

test("watcher ticks do not overlap or fan out beyond active targets", async () => {
  let release: (() => void) | undefined;
  const inspected: string[] = [];
  const watcher = new ActiveThreadWatcher({
    intervalMs: 5000,
    inspect: async (threadId) => {
      inspected.push(threadId);
      if (threadId === "thread-1") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    onError: () => {},
  });
  watcher.start("thread-1");
  watcher.start("thread-2");

  const first = watcher.tick();
  await Promise.resolve();
  await watcher.tick();
  assert.deepEqual(inspected, ["thread-1"]);
  release?.();
  await first;
  assert.deepEqual(inspected, ["thread-1", "thread-2"]);
  watcher.dispose();
});

test("the watcher self-heals a permanently unavailable Discord thread", async () => {
  const errors: unknown[] = [];
  const actions: string[] = [];
  const watcher = new ActiveThreadWatcher({
    intervalMs: 5000,
    inspect: async () => {
      throw new DiscordChannelBoundaryError(
        "Channel session-1 is not in the paired Discord server.",
      );
    },
    onError: async (_threadId, error) => {
      errors.push(error);
      if (!isUnavailableDiscordChannelError(error)) return;
      await detachUnavailableSession({
        stopBbThread: async () => {
          actions.push("stop");
        },
        onStopError: () => {},
        unlink: () => actions.push("unlink"),
        notifyParent: async () => {
          actions.push("notify-parent");
          return true;
        },
        notifyHome: async () => {
          actions.push("notify-home");
        },
      });
      return "stop";
    },
  });

  watcher.start("thread-1");
  await watcher.tick();

  assert.equal(errors.length, 1);
  assert.deepEqual(actions, ["stop", "unlink", "notify-parent"]);
  assert.equal(watcher.targetCount, 0);
  assert.equal(watcher.isScheduled, false);
});

test("an unavailable session falls back to the home channel", async () => {
  const actions: string[] = [];
  await detachUnavailableSession({
    stopBbThread: async () => {
      throw new Error("already stopped");
    },
    onStopError: () => actions.push("stop-warning"),
    unlink: () => actions.push("unlink"),
    notifyParent: async () => {
      actions.push("parent-failed");
      return false;
    },
    notifyHome: async () => {
      actions.push("notify-home");
    },
  });

  assert.deepEqual(actions, [
    "stop-warning",
    "unlink",
    "parent-failed",
    "notify-home",
  ]);
});

test("the same interaction announcement is never posted twice", async () => {
  const guard = new InteractionAnnouncementGuard();
  const posted = new Set<string>();
  let sends = 0;
  let release: (() => void) | undefined;
  const attempt = () =>
    guard.postOnce({
      key: "thread-1:interaction-1",
      isPosted: () => posted.has("interaction-1"),
      post: async () => {
        sends += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return true;
      },
      markPosted: () => posted.add("interaction-1"),
    });

  const first = attempt();
  await Promise.resolve();
  assert.equal(await attempt(), false);
  release?.();
  assert.equal(await first, true);
  assert.equal(await attempt(), false);
  assert.equal(sends, 1);
});

test("a failed interaction announcement is retried by the active watcher", async () => {
  const guard = new InteractionAnnouncementGuard();
  let marked = false;
  let sends = 0;
  const watcher = new ActiveThreadWatcher({
    intervalMs: 5000,
    inspect: async () => {
      await guard.postOnce({
        key: "thread-1:interaction-1",
        isPosted: () => marked,
        post: async () => {
          sends += 1;
          return sends > 1;
        },
        markPosted: () => {
          marked = true;
        },
      });
    },
    onError: () => {},
  });

  watcher.start("thread-1");
  await watcher.tick();
  assert.equal(marked, false);
  await watcher.tick();
  assert.equal(marked, true);
  assert.equal(sends, 2);
  watcher.dispose();
});

test("failure alerts do not duplicate a session message in the home channel", () => {
  assert.equal(shouldAlertHomeForFailure("session", "home"), true);
  assert.equal(shouldAlertHomeForFailure("same-channel", "same-channel"), false);
  assert.equal(shouldAlertHomeForFailure("session", null), false);
});

test("parseDiscordIds accepts Discord snowflakes and deduplicates them", () => {
  assert.deepEqual(
    parseDiscordIds("123456789012345678, 123456789012345678 bad 987654321098765432"),
    ["123456789012345678", "987654321098765432"],
  );
});

test("spawn restriction trims and validates its configured channel", () => {
  assert.equal(
    normalizeOptionalDiscordSnowflake(" 123456789012345678 "),
    "123456789012345678",
  );
  assert.equal(normalizeOptionalDiscordSnowflake("  "), null);
  assert.throws(
    () => normalizeOptionalDiscordSnowflake("not-a-channel"),
    /Discord channel ID/,
  );
});

test("spawn restriction is enforced after routing identifies a launch", () => {
  const canSpawn = (
    message: {
      channelId: string;
      parentChannelId: string | null;
      mentioned: boolean;
    },
    mapping: Parameters<typeof routeDiscordMessage>[1],
    spawnChannelId: string,
  ): boolean => {
    const route = routeDiscordMessage(message, mapping);
    return (
      routeCreatesSession(route) &&
      isAllowedSpawnLocation(message, spawnChannelId)
    );
  };

  assert.equal(
    canSpawn(
      { channelId: "parent", parentChannelId: null, mentioned: true },
      null,
      "parent",
    ),
    true,
  );
  assert.equal(
    canSpawn(
      { channelId: "other", parentChannelId: null, mentioned: true },
      null,
      "parent",
    ),
    false,
  );
  assert.equal(
    canSpawn(
      { channelId: "thread", parentChannelId: "parent", mentioned: true },
      null,
      "thread",
    ),
    false,
  );
});

test("both routes that create sessions require the spawn-channel gate", () => {
  assert.equal(routeCreatesSession({ kind: "start-session" }), true);
  assert.equal(routeCreatesSession({ kind: "migrate-legacy-session" }), true);
  assert.equal(routeCreatesSession({ kind: "forward-session" }), false);
  assert.equal(routeCreatesSession({ kind: "ignore" }), false);
});

test("a failed BB spawn cannot create an orphan Discord session", async () => {
  let discordCreates = 0;
  await assert.rejects(
    prepareDiscordSession({
      spawnBbThread: async () => {
        throw new Error("spawn failed");
      },
      createDiscordSession: async () => {
        discordCreates += 1;
        return { id: "discord-thread" };
      },
      cleanupBbThread: async () => {},
    }),
    /spawn failed/,
  );
  assert.equal(discordCreates, 0);
});

test("a Discord-session failure cleans up the already spawned BB thread", async () => {
  const cleaned: string[] = [];
  await assert.rejects(
    prepareDiscordSession({
      spawnBbThread: async () => ({ id: "bb-thread" }),
      createDiscordSession: async () => {
        throw new Error("thread creation failed");
      },
      cleanupBbThread: async (thread) => {
        cleaned.push(thread.id);
      },
    }),
    /thread creation failed/,
  );
  assert.deepEqual(cleaned, ["bb-thread"]);
});

test("an unmentioned parent-channel message is ignored", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "parent", parentChannelId: null, mentioned: false },
      null,
    ),
    { kind: "ignore" },
  );
});

test("a parent-channel mention starts a session", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "parent", parentChannelId: null, mentioned: true },
      null,
    ),
    { kind: "start-session" },
  );
});

test("routine messages inside a mapped session are forwarded", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "session", parentChannelId: "parent", mentioned: false },
      { discordChannelId: "session", discordParentChannelId: "parent" },
    ),
    { kind: "forward-session" },
  );
});

test("mentions inside a mapped session are forwarded without a new session", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "session", parentChannelId: "parent", mentioned: true },
      { discordChannelId: "session", discordParentChannelId: "parent" },
    ),
    { kind: "forward-session" },
  );
});

test("even a mention inside an unbound Discord thread is ignored", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "other-thread", parentChannelId: "parent", mentioned: true },
      null,
    ),
    { kind: "ignore" },
  );
});

test("legacy channel mappings ignore unmentioned parent chatter", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "parent", parentChannelId: null, mentioned: false },
      { discordChannelId: "parent", discordParentChannelId: null },
    ),
    { kind: "ignore" },
  );
});

test("a mention moves a legacy channel mapping into a session", () => {
  assert.deepEqual(
    routeDiscordMessage(
      { channelId: "parent", parentChannelId: null, mentioned: true },
      { discordChannelId: "parent", discordParentChannelId: null },
    ),
    { kind: "migrate-legacy-session" },
  );
});

test("session names are derived from compacted request text", () => {
  assert.equal(
    discordSessionName("  inspect the failing\n\n login tests  "),
    "inspect the failing login tests",
  );
  assert.doesNotMatch(discordSessionName("ship the fix"), /th_[a-z0-9]+/i);
});

test("session names have a useful fallback and Discord's 100-character cap", () => {
  assert.equal(discordSessionName(" \n "), "bb conversation");
  assert.equal(discordSessionName("x".repeat(120)).length, 100);
  assert.match(discordSessionName("x".repeat(120)), /…$/);
});

test("approval replies produce a supported BB resolution", () => {
  const interaction = {
    id: "i1",
    status: "pending",
    payload: {
      kind: "approval" as const,
      availableDecisions: ["allow_once", "deny"] as Array<
        "allow_once" | "allow_for_session" | "deny"
      >,
      reason: "Run tests",
    },
  };
  assert.deepEqual(resolveInteractionReply(interaction, "approve"), {
    kind: "resolve",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  assert.equal(resolveInteractionReply(interaction, "approve session").kind, "error");
  assert.deepEqual(resolveInteractionReply(interaction, "deny"), {
    kind: "resolve",
    resolution: { decision: "deny" },
  });
});

test("Discord approval buttons can resolve only decisions BB offered", () => {
  const interaction = {
    id: "i-buttons",
    status: "pending",
    payload: {
      kind: "approval" as const,
      availableDecisions: ["allow_once", "deny"] as Array<
        "allow_once" | "allow_for_session" | "deny"
      >,
      reason: "Write the file",
    },
  };

  assert.deepEqual(resolveApprovalDecision(interaction, "allow_once"), {
    kind: "resolve",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  assert.deepEqual(resolveApprovalDecision(interaction, "deny"), {
    kind: "resolve",
    resolution: { decision: "deny" },
  });
  assert.equal(
    resolveApprovalDecision(interaction, "allow_for_session").kind,
    "error",
  );
});

test("approval copy offers only decisions supported by the interaction", () => {
  const interaction = {
    id: "i-copy",
    status: "pending",
    payload: {
      kind: "approval" as const,
      availableDecisions: ["allow_once", "deny"] as Array<
        "allow_once" | "allow_for_session" | "deny"
      >,
      reason: "Read the bb CLI skill",
      subject: { tool: "Read /home/ai/.bb/runtime/global-skills/bb-cli/SKILL.md" },
    },
  };

  const instructions = pendingInteractionReplyInstructions(interaction);
  const announcement = pendingInteractionPrompt(interaction);
  const error = resolveInteractionReply(interaction, "approve session");

  assert.equal(instructions, "Reply `approve` or `deny`.");
  assert.match(announcement, /Read the bb CLI skill/);
  assert.match(announcement, /Read \/home\/ai\/\.bb\/runtime/);
  assert.match(announcement, /Reply `approve` or `deny`\./);
  assert.doesNotMatch(announcement, /session/i);
  assert.deepEqual(error, { kind: "error", message: announcement });
});

test("approval copy includes the session option only when available", () => {
  const interaction = {
    id: "i-session",
    status: "pending",
    payload: {
      kind: "approval" as const,
      availableDecisions: [
        "allow_once",
        "allow_for_session",
        "deny",
      ] as Array<"allow_once" | "allow_for_session" | "deny">,
      reason: "Run the command",
    },
  };

  assert.equal(
    pendingInteractionReplyInstructions(interaction),
    "Reply `approve`, `approve session`, or `deny`.",
  );
});

test("single free-text question becomes a user_answer resolution", () => {
  const interaction = {
    id: "i2",
    status: "pending",
    payload: {
      kind: "user_question" as const,
      questions: [
        {
          id: "branch",
          prompt: "Which branch?",
          allowFreeText: true,
          multiSelect: false,
        },
      ],
    },
  };
  assert.deepEqual(resolveInteractionReply(interaction, "feature/discord"), {
    kind: "resolve",
    resolution: {
      kind: "user_answer",
      answers: {
        branch: { selected: [], freeText: "feature/discord" },
      },
    },
  });
});

test("one option question is eligible for a native Discord select menu", () => {
  const interaction = {
    id: "i-choice",
    status: "pending",
    payload: {
      kind: "user_question" as const,
      questions: [
        {
          id: "flow",
          prompt: "Which approval flow should I exercise next?",
          allowFreeText: false,
          multiSelect: false,
          options: [
            { label: "In-workspace edit approval", value: "workspace" },
            { label: "Stop testing here", value: "stop" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(discordQuestionControl(interaction), {
    questionId: "flow",
    prompt: "Which approval flow should I exercise next?",
    allowFreeText: false,
    multiSelect: false,
    options: interaction.payload.questions[0]!.options,
  });
  assert.deepEqual(resolveQuestionSelection(interaction, [1]), {
    kind: "resolve",
    resolution: {
      kind: "user_answer",
      answers: { flow: { selected: ["stop"] } },
    },
  });
  assert.equal(resolveQuestionSelection(interaction, [2]).kind, "error");
  assert.equal(
    pendingInteractionPrompt(interaction, undefined, true),
    "Which approval flow should I exercise next?\n_Choose an option below._",
  );
});

test("native Discord question controls support multiple selections", () => {
  const interaction = {
    id: "i-multi",
    status: "pending",
    payload: {
      kind: "user_question" as const,
      questions: [
        {
          id: "checks",
          prompt: "Which checks should run?",
          allowFreeText: true,
          multiSelect: true,
          options: [
            { label: "Tests", value: "tests" },
            { label: "Build", value: "build" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(resolveQuestionSelection(interaction, [1, 0, 1]), {
    kind: "resolve",
    resolution: {
      kind: "user_answer",
      answers: { checks: { selected: ["build", "tests"] } },
    },
  });
  assert.match(
    pendingInteractionPrompt(interaction, undefined, true),
    /Choose one or more options below, or reply here with another answer/,
  );
});

test("multiple questions require numbered lines", () => {
  const interaction = {
    id: "i3",
    status: "pending",
    payload: {
      kind: "user_question" as const,
      questions: [
        { id: "one", prompt: "One?", allowFreeText: true, multiSelect: false },
        { id: "two", prompt: "Two?", allowFreeText: true, multiSelect: false },
      ],
    },
  };
  assert.equal(resolveInteractionReply(interaction, "one answer").kind, "error");
  assert.equal(resolveInteractionReply(interaction, "1: A\n2: B").kind, "resolve");
  assert.match(describePendingInteraction(interaction), /1\. One\?/);
});
