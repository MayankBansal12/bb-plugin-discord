import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionView,
  clampPermissionMode,
  readExecutionSelection,
  resolveExecution,
  spawnEnvironmentFor,
  validateSelectionRequest,
  type MachineCatalog,
  type MachineInfo,
  type ProjectExecutionDefaults,
  type ProjectInfo,
} from "./execution.js";

const personal: ProjectInfo = {
  id: "proj_personal",
  name: "Personal",
  kind: "personal",
  hostIds: [],
};

const repo: ProjectInfo = {
  id: "proj_repo",
  name: "Checkout",
  kind: "standard",
  hostIds: ["host_laptop"],
};

const defaults: ProjectExecutionDefaults = {
  providerId: "anthropic",
  model: "claude-sonnet-5",
  reasoningLevel: "medium",
  serviceTier: "default",
  permissionMode: "accept-edits",
};

const laptop: MachineInfo = {
  id: "host_laptop",
  name: "Laptop",
  status: "connected",
  maxPermissionMode: "full",
};

function catalog(overrides: Partial<MachineCatalog> = {}): MachineCatalog {
  return {
    providers: [
      { id: "anthropic", displayName: "Anthropic", available: true },
    ],
    models: [
      {
        model: "claude-opus-5",
        displayName: "Opus 5",
        isDefault: false,
        defaultReasoningEffort: "high",
      },
      {
        model: "claude-sonnet-5",
        displayName: "Sonnet 5",
        isDefault: true,
        defaultReasoningEffort: "medium",
      },
    ],
    permissionCeiling: "full",
    loadError: null,
    ...overrides,
  };
}

test("empty settings mean automatic, not empty strings", () => {
  assert.deepEqual(
    readExecutionSelection({
      defaultProjectId: "",
      machineHostId: "   ",
      providerId: undefined,
      model: "",
    }),
    { projectId: null, hostId: null, providerId: null, model: null },
  );
});

test("no pinned machine or model keeps the host's project defaults", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({}),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: null,
    catalog: null,
  });
  assert.ok(result.ok);
  assert.deepEqual(result.plan.environment, { type: "project-default" });
  assert.equal(result.plan.providerId, "anthropic");
  assert.equal(result.plan.model, "claude-sonnet-5");
  assert.equal(result.plan.permissionMode, "auto");
  assert.deepEqual(result.plan.warnings, []);
});

test("a chosen model is applied to the spawned thread with its reasoning level", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({
      machineHostId: "host_laptop",
      providerId: "anthropic",
      model: "claude-opus-5",
    }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog(),
  });
  assert.ok(result.ok);
  assert.equal(result.plan.model, "claude-opus-5");
  assert.equal(result.plan.reasoningLevel, "high");
});

test("a chosen machine routes the spawned thread to that host", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_laptop" }),
    project: repo,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog(),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.plan.environment, {
    type: "host",
    hostId: "host_laptop",
    workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
  });
});

test("a personal-project thread on a chosen machine has no worktree", () => {
  assert.deepEqual(spawnEnvironmentFor(personal, "host_laptop"), {
    type: "host",
    hostId: "host_laptop",
    workspace: { type: "personal" },
  });
});

test("a model the chosen machine cannot serve is refused, not silently swapped", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({
      machineHostId: "host_laptop",
      providerId: "anthropic",
      model: "claude-retired-3",
    }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog(),
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.problem.setting, "model");
  assert.match(result.problem.message, /claude-retired-3/);
  assert.match(result.problem.message, /Opus 5/);
});

test("a signed-out provider on the chosen machine names the machine", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({
      machineHostId: "host_laptop",
      providerId: "anthropic",
      model: "claude-opus-5",
    }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog({
      providers: [{ id: "anthropic", displayName: "Anthropic", available: false }],
    }),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem.setting, "providerId");
  assert.match(result.problem.message, /Laptop/);
});

test("an offline or unknown machine is an actionable error", () => {
  const offline = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_laptop" }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: { ...laptop, status: "disconnected" },
    catalog: null,
  });
  assert.ok(!offline.ok);
  assert.equal(offline.problem.setting, "machineHostId");
  assert.match(offline.problem.message, /offline/);

  const unknown = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_gone" }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: null,
    catalog: null,
  });
  assert.ok(!unknown.ok);
  assert.equal(unknown.problem.setting, "machineHostId");
});

test("a project with no checkout on the chosen machine is refused", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_build" }),
    project: repo,
    defaults,
    permissionMode: "auto",
    machine: { ...laptop, id: "host_build", name: "Build box" },
    catalog: catalog(),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem.setting, "machineHostId");
  assert.match(result.problem.message, /no checkout/);
});

test("the machine's permission ceiling lowers the thread and says so", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_laptop" }),
    project: personal,
    defaults,
    permissionMode: "full",
    machine: { ...laptop, maxPermissionMode: "auto" },
    catalog: catalog({ permissionCeiling: "auto" }),
  });
  assert.ok(result.ok);
  assert.equal(result.plan.permissionMode, "auto");
  assert.match(result.plan.warnings[0]!, /lowered from full to auto/);
});

test("permission clamping keeps the lower of request and ceiling", () => {
  assert.equal(clampPermissionMode("full", "accept-edits"), "accept-edits");
  assert.equal(clampPermissionMode("accept-edits", "full"), "accept-edits");
  assert.equal(clampPermissionMode("auto", "auto"), "auto");
});

test("an unreadable catalog warns instead of blocking a pinned model", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({
      machineHostId: "host_laptop",
      model: "claude-opus-5",
    }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: null,
  });
  assert.ok(result.ok);
  assert.equal(result.plan.model, "claude-opus-5");
  assert.match(result.plan.warnings[0]!, /unverified/);
});

test("the view labels automatic values instead of showing blanks", () => {
  const view = buildExecutionView({
    selection: readExecutionSelection({}),
    project: personal,
    machine: null,
    defaults,
    resolution: null,
  });
  assert.equal(view.project.source, "default");
  assert.equal(view.project.label, "Personal (personal)");
  assert.equal(view.machine.label, "Wherever the project runs by default");
  assert.equal(view.model.label, "claude-sonnet-5 (project default)");
  assert.deepEqual(view.issues, []);
  assert.match(view.summary, /Personal/);
});

test("the view attaches a stale-model problem to the model row only", () => {
  const selection = readExecutionSelection({
    machineHostId: "host_laptop",
    providerId: "anthropic",
    model: "claude-retired-3",
  });
  const resolution = resolveExecution({
    selection,
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog(),
  });
  const view = buildExecutionView({
    selection,
    project: personal,
    machine: laptop,
    defaults,
    resolution,
  });
  assert.equal(view.machine.problem, null);
  assert.match(view.model.problem ?? "", /claude-retired-3/);
  assert.equal(view.issues.length, 1);
});


// --- inherited defaults on an explicitly chosen machine ---------------------

test("an inherited project-default model absent on the chosen machine is refused", () => {
  const result = resolveExecution({
    // Machine pinned, model left Automatic. The project default is
    // claude-sonnet-5, which this machine does not offer.
    selection: readExecutionSelection({ machineHostId: "host_laptop" }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog({
      models: [
        {
          model: "claude-opus-5",
          displayName: "Opus 5",
          isDefault: true,
          defaultReasoningEffort: "high",
        },
      ],
    }),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem.setting, "model");
  assert.match(result.problem.message, /project's default model/);
  assert.match(result.problem.message, /claude-sonnet-5/);
  assert.match(result.problem.message, /Opus 5/);
});

test("an inherited provider missing on the chosen machine blames the machine", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_laptop" }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog({ providers: [] }),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem.setting, "machineHostId");
  assert.match(result.problem.message, /Laptop/);
});

test("an inherited model present on the chosen machine resolves normally", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({ machineHostId: "host_laptop" }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: laptop,
    catalog: catalog(),
  });
  assert.ok(result.ok);
  assert.equal(result.plan.model, "claude-sonnet-5");
  assert.deepEqual(result.plan.warnings, []);
});

// --- error copy never names a null machine ---------------------------------

test("an invalid model with no pinned machine never prints the word null", () => {
  const result = resolveExecution({
    selection: readExecutionSelection({
      providerId: "anthropic",
      model: "claude-retired-3",
    }),
    project: personal,
    defaults,
    permissionMode: "auto",
    machine: null,
    catalog: catalog(),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem.setting, "model");
  assert.doesNotMatch(result.problem.message, /null|undefined/);
  assert.match(result.problem.message, /the project's default machine/);
});

test("no resolution message can name a null machine", () => {
  const clamped = resolveExecution({
    selection: readExecutionSelection({ model: "claude-opus-5", providerId: "anthropic" }),
    project: personal,
    defaults,
    permissionMode: "full",
    machine: null,
    catalog: catalog({ permissionCeiling: "auto", loadError: { providerId: "anthropic", code: "timeout" } }),
  });
  assert.ok(clamped.ok);
  for (const warning of clamped.plan.warnings) {
    assert.doesNotMatch(warning, /null|undefined/);
  }
  assert.ok(clamped.plan.warnings.some((warning) => /default machine/.test(warning)));
});

// --- the selector RPC's validator ------------------------------------------

const machines = [laptop, { ...laptop, id: "host_box", name: "Build box", status: "disconnected" as const }];

test("clearing both selects is accepted and normalizes to Automatic", () => {
  const check = validateSelectionRequest({
    request: { machineHostId: "", providerId: "anthropic", model: "  " },
    machines,
    catalog: catalog(),
  });
  assert.ok(check.ok);
  // A provider without a model is not a choice the UI can express, and keeping
  // one would steer a later automatic model.
  assert.deepEqual(check.selection, {
    machineHostId: null,
    providerId: null,
    model: null,
  });
});

test("a valid machine and model pair is accepted and trimmed", () => {
  const check = validateSelectionRequest({
    request: { machineHostId: " host_laptop ", providerId: "anthropic", model: "claude-opus-5" },
    machines,
    catalog: catalog(),
  });
  assert.ok(check.ok);
  assert.deepEqual(check.selection, {
    machineHostId: "host_laptop",
    providerId: "anthropic",
    model: "claude-opus-5",
  });
  assert.equal(check.notice, null);
});

test("an offline machine saves but says the requests will be refused", () => {
  const check = validateSelectionRequest({
    request: { machineHostId: "host_box", providerId: null, model: null },
    machines,
    catalog: null,
  });
  assert.ok(check.ok);
  assert.equal(check.selection.machineHostId, "host_box");
  assert.match(check.notice ?? "", /offline/);
});

test("a stale option posted from the panel is rejected, not written", () => {
  const goneMachine = validateSelectionRequest({
    request: { machineHostId: "host_removed", providerId: null, model: null },
    machines,
    catalog: null,
  });
  assert.equal(goneMachine.ok, false);

  const goneModel = validateSelectionRequest({
    request: { machineHostId: "host_laptop", providerId: "anthropic", model: "claude-retired-3" },
    machines,
    catalog: catalog(),
  });
  assert.equal(goneModel.ok, false);

  const signedOut = validateSelectionRequest({
    request: { machineHostId: "host_laptop", providerId: "anthropic", model: "claude-opus-5" },
    machines,
    catalog: catalog({
      providers: [{ id: "anthropic", displayName: "Anthropic", available: false }],
    }),
  });
  assert.equal(signedOut.ok, false);
  assert.ok(!signedOut.ok);
  assert.match(signedOut.message, /not signed in/);
});

test("a model without its provider is rejected rather than guessed", () => {
  const check = validateSelectionRequest({
    request: { machineHostId: null, providerId: null, model: "claude-opus-5" },
    machines,
    catalog: catalog(),
  });
  assert.equal(check.ok, false);
  assert.ok(!check.ok);
  assert.match(check.message, /which provider/);
});

test("an unverifiable catalog refuses a model instead of saving it blind", () => {
  const check = validateSelectionRequest({
    request: { machineHostId: "host_laptop", providerId: "anthropic", model: "claude-opus-5" },
    machines,
    catalog: null,
  });
  assert.equal(check.ok, false);
});
