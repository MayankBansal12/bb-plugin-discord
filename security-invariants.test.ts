import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

test("logs and informational status cannot disclose the live pairing code", () => {
  const announcement = serverSource.match(
    /const announcePairing = \(\): void => \{([\s\S]*?)\n  \};/,
  )?.[1];
  const statusCommand = serverSource.match(
    /if \(command === "status"\) \{([\s\S]*?)\n      if \(command === "pair"\)/,
  )?.[1];

  assert.ok(announcement, "announcePairing implementation should be present");
  assert.ok(statusCommand, "status command implementation should be present");
  assert.doesNotMatch(announcement, /pairingInstructions|formatPairingCode|pendingCode/);
  assert.doesNotMatch(statusCommand, /pairingInstructions|formatPairingCode|pendingCode/);
  assert.match(statusCommand, /one-time code is hidden from status/);
});
