import assert from "node:assert/strict";
import test from "node:test";
import {
  availableToolNames,
  DESTRUCTIVE_TOOL_NAMES,
  discordAuditReason,
  MANAGEMENT_TOOL_NAMES,
  MESSAGE_TOOL_NAMES,
} from "./tools.js";

test("no Discord tools are offered before pairing", () => {
  assert.deepEqual(availableToolNames("full", true, false), []);
});

test("Discord audit reasons identify the originating bb thread", () => {
  assert.equal(
    discordAuditReason("thread-123"),
    "Requested through bb's Discord plugin by thread thread-123",
  );
});

test("message access covers messages and threads only", () => {
  const names = availableToolNames("messages", true, true);
  assert.deepEqual([...names], [...MESSAGE_TOOL_NAMES]);
  for (const managed of [...MANAGEMENT_TOOL_NAMES, ...DESTRUCTIVE_TOOL_NAMES]) {
    assert.ok(!names.includes(managed), `${managed} must need full access`);
  }
});

test("full access adds administration but withholds destructive tools", () => {
  const names = availableToolNames("full", false, true);
  for (const managed of MANAGEMENT_TOOL_NAMES) assert.ok(names.includes(managed));
  for (const destructive of DESTRUCTIVE_TOOL_NAMES) {
    assert.ok(
      !names.includes(destructive),
      `${destructive} must need the destructive opt-in`,
    );
  }
});

test("destructive tools appear only with full access and the explicit opt-in", () => {
  const names = availableToolNames("full", true, true);
  for (const destructive of DESTRUCTIVE_TOOL_NAMES) {
    assert.ok(names.includes(destructive));
  }
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
});
