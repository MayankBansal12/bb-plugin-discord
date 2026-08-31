import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedUsers,
  botDisplayName,
  botSentenceName,
  channelLabel,
  derivedGuildId,
  destructiveActionsState,
  effectiveHomeChannel,
  maskBotToken,
  permissionModeLabel,
  UNKNOWN_BOT_NAME,
} from "./config-view.js";

// base64url("123456789012345678") — the shape of a real token's first segment.
const TOKEN = `${Buffer.from("123456789012345678").toString("base64url")}.GhIjKl.mNoPqRsTuVwXyZ`;

test("a configured token shows its application id and never any secret bytes", () => {
  const masked = maskBotToken(TOKEN);
  assert.ok(masked);
  assert.equal(masked.applicationId, "123456789012345678");
  assert.equal(masked.masked, "••••••••••••");
  assert.equal(masked.masked.includes("mNoPqRsTuVwXyZ"), false);
  assert.equal(masked.masked.includes("GhIjKl"), false);
  assert.equal(TOKEN.includes(masked.masked), false);
});

test("an unset token is null rather than a misleading mask", () => {
  assert.equal(maskBotToken(undefined), null);
  assert.equal(maskBotToken("   "), null);
});

test("the bot's own name is used for Discord copy, with a neutral placeholder", () => {
  assert.equal(botDisplayName("nova#4211"), "nova");
  assert.equal(botDisplayName("nova"), "nova");
  assert.equal(botDisplayName(null), UNKNOWN_BOT_NAME);
  assert.equal(botSentenceName(null), "The bot");
  assert.equal(botSentenceName("nova"), "nova");
});

test("an empty home channel resolves to the channel that ran pairing", () => {
  const home = effectiveHomeChannel(undefined, {
    channelId: "chan_1",
    channelName: "agents",
  });
  assert.deepEqual(home, { id: "chan_1", name: "agents", source: "pairing" });
  assert.equal(channelLabel(home), "#agents");
});

test("an explicit home channel wins and is labelled as configured", () => {
  const home = effectiveHomeChannel(" chan_2 ", {
    channelId: "chan_1",
    channelName: "agents",
  });
  assert.deepEqual(home, { id: "chan_2", name: null, source: "setting" });
  assert.equal(channelLabel(home), "<#chan_2>");
});

test("an unpaired plugin with no home channel says so instead of showing nothing", () => {
  const home = effectiveHomeChannel(undefined, null);
  assert.equal(home.source, "none");
  assert.equal(channelLabel(home), "Not set");
});

test("the guild id shows its pairing provenance even with an empty setting", () => {
  assert.deepEqual(derivedGuildId(undefined, "guild_1"), {
    value: "guild_1",
    source: "pairing",
  });
  assert.deepEqual(derivedGuildId("guild_manual", null), {
    value: "guild_manual",
    source: "setting",
  });
  assert.deepEqual(derivedGuildId(" ", null), { value: null, source: "none" });
});

test("the person who paired is listed even when the advanced field is empty", () => {
  assert.deepEqual(
    authorizedUsers([], [], { userId: "user_1", userTag: "mayank" }),
    [{ id: "user_1", tag: "mayank", source: "pairing" }],
  );
});

test("pairing provenance wins over a duplicate entry in the advanced field", () => {
  const users = authorizedUsers(["user_1"], ["user_2"], {
    userId: "user_1",
    userTag: "mayank",
  });
  assert.deepEqual(users, [
    { id: "user_1", tag: "mayank", source: "pairing" },
    { id: "user_2", tag: null, source: "setting" },
  ]);
});

test("destructive actions stay inert without full access, and report why", () => {
  const blocked = destructiveActionsState("messages", true);
  assert.equal(blocked.configured, true);
  assert.equal(blocked.effective, false);
  assert.match(blocked.blockedReason ?? "", /Server access was not changed/);

  assert.deepEqual(destructiveActionsState("full", true), {
    configured: true,
    effective: true,
    blockedReason: null,
  });
  assert.deepEqual(destructiveActionsState("full", false), {
    configured: false,
    effective: false,
    blockedReason: null,
  });
});

test("the permission mode label defaults to auto", () => {
  assert.match(permissionModeLabel(undefined), /^Auto/);
  assert.match(permissionModeLabel("full"), /^Full/);
});
