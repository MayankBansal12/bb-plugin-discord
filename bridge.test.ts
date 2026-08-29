import assert from "node:assert/strict";
import test from "node:test";
import {
  describePendingInteraction,
  isAllowedSpawnLocation,
  parseDiscordIds,
  resolveInteractionReply,
} from "./bridge.js";

test("parseDiscordIds accepts Discord snowflakes and deduplicates them", () => {
  assert.deepEqual(
    parseDiscordIds("123456789012345678, 123456789012345678 bad 987654321098765432"),
    ["123456789012345678", "987654321098765432"],
  );
});

test("spawn restriction accepts the channel or its parent", () => {
  assert.equal(
    isAllowedSpawnLocation(
      { channelId: "thread", parentChannelId: "parent" },
      "parent",
    ),
    true,
  );
  assert.equal(
    isAllowedSpawnLocation(
      { channelId: "thread", parentChannelId: "other" },
      "parent",
    ),
    false,
  );
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
