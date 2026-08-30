import assert from "node:assert/strict";
import test from "node:test";
import {
  ActiveThreadWatcher,
  describePendingInteraction,
  discordSessionName,
  isAllowedSpawnLocation,
  parseDiscordIds,
  pendingInteractionPrompt,
  pendingInteractionReplyInstructions,
  InteractionAnnouncementGuard,
  routeDiscordMessage,
  resolveInteractionReply,
  shouldAlertHomeForFailure,
} from "./bridge.js";

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

test("spawn restriction accepts only the configured parent channel", () => {
  assert.equal(
    isAllowedSpawnLocation(
      { channelId: "parent", parentChannelId: null },
      "parent",
    ),
    true,
  );
  assert.equal(
    isAllowedSpawnLocation(
      { channelId: "thread", parentChannelId: "parent" },
      "parent",
    ),
    false,
  );
  assert.equal(
    isAllowedSpawnLocation(
      { channelId: "other", parentChannelId: null },
      "parent",
    ),
    false,
  );
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
  assert.equal(discordSessionName(" \n "), "BB conversation");
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
