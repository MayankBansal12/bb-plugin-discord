import assert from "node:assert/strict";
import test from "node:test";
import type { DiscordPairingStatus } from "./contract.js";
import {
  formatDuration,
  pairingPanelView,
  pairingSignalReason,
  resolveDefaultMachineId,
} from "./pairing-ui.js";
import { configurationFixture, executionFixture } from "./test-support.js";

function status(
  overrides: Partial<DiscordPairingStatus> = {},
): DiscordPairingStatus {
  return {
    gateway: { state: "disconnected", botTag: null, message: null },
    botName: "the bot",
    tokenConfigured: false,
    paired: false,
    pairing: null,
    pairingCode: null,
    inviteUrl: null,
    notice: null,
    configuration: configurationFixture(),
    execution: executionFixture(),
    ...overrides,
  };
}

test("the panel gives a terminal-free next step before a token exists", () => {
  const view = pairingPanelView(status(), 1_000);
  assert.equal(view.connectionLabel, "Disconnected");
  assert.equal(view.connectionDetail, "Add a bot token above to connect");
  assert.equal(view.setupStep, "Save your bot token in the field above.");
});

test("the panel shows the bot identity and complete stored pairing", () => {
  const view = pairingPanelView(
    status({
      gateway: { state: "connected", botTag: "BB Bot", message: null },
      tokenConfigured: true,
      paired: true,
      pairing: {
        guildId: "guild-1",
        guildName: "Builders",
        channelId: "channel-1",
        channelName: "agents",
        userId: "user-1",
        userTag: "mayank",
        pairedAt: 500,
      },
    }),
    1_000,
  );
  assert.equal(view.connectionDetail, "Signed in as BB Bot");
  assert.equal(view.serverLabel, "Builders");
  assert.equal(view.userLabel, "mayank (user-1)");
});

test("pairing-code expiry is visible and becomes actionable", () => {
  const active = pairingPanelView(
    status({
      tokenConfigured: true,
      gateway: { state: "connected", botTag: "BB Bot", message: null },
      inviteUrl: "https://discord.com/oauth2/authorize?client_id=1",
      pairingCode: { code: "ABC-123", command: "@BB Bot pair ABC-123", expiresAt: 61_000 },
    }),
    1_000,
  );
  assert.equal(active.expiryLabel, "Expires in 1 min");
  assert.match(active.setupStep, /Invite the bot/);

  const expired = pairingPanelView(
    status({ pairingCode: { code: "ABC-123", command: "pair ABC-123", expiresAt: 1_000 } }),
    1_000,
  );
  assert.equal(expired.expiryLabel, "Expired. Generate a new code");
});

test("a parked configuration failure is distinct from connecting and actionable", () => {
  const message =
    "Discord rejected the bot token. Reset Token in the Discord Developer Portal, save the new token in BB, and reconnect.";
  const view = pairingPanelView(
    status({
      tokenConfigured: true,
      gateway: { state: "failed", botTag: null, message },
    }),
    1_000,
  );
  assert.equal(view.connectionLabel, "Connection failed");
  assert.equal(view.connectionDetail, message);
  assert.equal(view.setupStep, message);
  assert.doesNotMatch(view.connectionDetail, /trying/i);
});

test("duration copy stays compact around the minute boundary", () => {
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(60), "1 min");
  assert.equal(formatDuration(61), "2 min");
});

test("only structured realtime invalidations trigger a refresh", () => {
  assert.equal(pairingSignalReason({ reason: "paired" }), "paired");
  assert.equal(pairingSignalReason({ reason: 42 }), null);
  assert.equal(pairingSignalReason("paired"), null);
  assert.equal(pairingSignalReason(null), null);
});

const PERSONAL: DiscordPairingStatus["execution"]["projects"][number] = {
  id: "proj_personal",
  name: "Personal",
  kind: "personal",
  hostIds: [],
  defaultHostId: null,
};

test("the personal project's default machine is bb's primary host, not an unnamed fallback", () => {
  const execution = executionFixture({
    projects: [PERSONAL],
    machines: [{ id: "host_primary", name: "afdasf", status: "connected" }],
    primaryHostId: "host_primary",
  });
  // Naming it is what lets the panel drop "afdasf" from the rest of the list:
  // the default entry and that row were the same machine.
  assert.equal(resolveDefaultMachineId(execution, ""), "host_primary");
});

test("a project's own default checkout wins over the primary host", () => {
  const execution = executionFixture({
    projects: [
      PERSONAL,
      { id: "proj_1", name: "sage", kind: "standard", hostIds: ["host_other"], defaultHostId: "host_other" },
    ],
    primaryHostId: "host_primary",
  });
  assert.equal(resolveDefaultMachineId(execution, "proj_1"), "host_other");
});

test("a standard project never defaults to a machine it is not checked out on", () => {
  const execution = executionFixture({
    projects: [
      PERSONAL,
      { id: "proj_1", name: "sage", kind: "standard", hostIds: ["host_other"], defaultHostId: null },
    ],
    primaryHostId: "host_primary",
  });
  assert.equal(resolveDefaultMachineId(execution, "proj_1"), null);

  const checkedOut = executionFixture({
    projects: [
      PERSONAL,
      { id: "proj_1", name: "sage", kind: "standard", hostIds: ["host_primary"], defaultHostId: null },
    ],
    primaryHostId: "host_primary",
  });
  assert.equal(resolveDefaultMachineId(checkedOut, "proj_1"), "host_primary");
});

test("an unreadable primary host leaves the default entry unnamed instead of guessing", () => {
  const execution = executionFixture({ projects: [PERSONAL], primaryHostId: null });
  assert.equal(resolveDefaultMachineId(execution, ""), null);
});
