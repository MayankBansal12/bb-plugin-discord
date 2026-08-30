import assert from "node:assert/strict";
import test from "node:test";
import {
  describePendingInteraction,
  discordSessionName,
  isAllowedSpawnLocation,
  parseDiscordIds,
  routeDiscordMessage,
  resolveInteractionReply,
} from "./bridge.js";

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
