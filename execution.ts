// Where and how a Discord-started BB thread runs.
//
// Project, machine and model are one decision, not three: the project decides
// which checkout the agent gets, the machine decides which host runs it, and
// the model catalog is *per machine* — a provider signed in on your laptop is
// not automatically signed in on a build box. So a stored (machine, model)
// pair can go stale without anything in the settings form changing.
//
// This module is the honest middle: it resolves the three settings against the
// live catalog and either returns a plan or an actionable error naming the
// setting to change. It never silently substitutes a different model for an
// explicitly configured one.

import type { BbPermissionMode } from "./pairing.js";

export type ReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "ultracode";

export type ServiceTier = "default" | "fast";

/** The raw, optional settings an operator can pin. */
export interface ExecutionSettingValues {
  defaultProjectId?: string;
  machineHostId?: string;
  providerId?: string;
  model?: string;
}

export interface ExecutionSelection {
  projectId: string | null;
  hostId: string | null;
  providerId: string | null;
  model: string | null;
}

/** Empty and whitespace-only settings mean "stay automatic". */
export function readExecutionSelection(
  values: ExecutionSettingValues,
): ExecutionSelection {
  const trim = (value: string | undefined): string | null =>
    value?.trim() ? value.trim() : null;
  return {
    projectId: trim(values.defaultProjectId),
    hostId: trim(values.machineHostId),
    providerId: trim(values.providerId),
    model: trim(values.model),
  };
}

export interface MachineInfo {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  maxPermissionMode: BbPermissionMode;
}

export interface CatalogModel {
  /** Provider-scoped model id, i.e. what `threads.spawn` takes as `model`. */
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningLevel;
  routeProviderId?: string;
}

export interface CatalogProvider {
  id: string;
  displayName: string;
  available: boolean;
}

/** One machine's live catalog, as `providers.models({ hostId })` reports it. */
export interface MachineCatalog {
  providers: CatalogProvider[];
  models: CatalogModel[];
  permissionCeiling: BbPermissionMode;
  /** Set when a provider could not enumerate models (auth, missing CLI, …). */
  loadError: { providerId: string; code: string } | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  kind: "personal" | "standard";
  /** Hosts this project has a checkout on. Empty for the personal project. */
  hostIds: string[];
}

export interface ProjectExecutionDefaults {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier;
  permissionMode: BbPermissionMode;
}

export type SpawnEnvironment =
  | { type: "project-default" }
  | {
      type: "host";
      hostId: string;
      workspace:
        | { type: "personal" }
        | { type: "managed-worktree"; baseBranch: { kind: "default" } };
    };

export interface ExecutionPlan {
  projectId: string;
  environment: SpawnEnvironment;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier;
  permissionMode: BbPermissionMode;
  /** Non-fatal adjustments the operator should still know about. */
  warnings: string[];
}

export interface ExecutionProblem {
  /** Which setting the operator has to change. */
  setting: "machineHostId" | "model" | "providerId" | "defaultProjectId";
  message: string;
}

export type ExecutionResolution =
  | { ok: true; plan: ExecutionPlan }
  | { ok: false; problem: ExecutionProblem };

export interface ResolveExecutionInput {
  selection: ExecutionSelection;
  project: ProjectInfo;
  defaults: ProjectExecutionDefaults;
  permissionMode: BbPermissionMode;
  /** Null when no machine is pinned, or when the machine list is unavailable. */
  machine: MachineInfo | null;
  /** Null when no machine is pinned, or when the catalog could not be read. */
  catalog: MachineCatalog | null;
}

const PERMISSION_RANK: Record<BbPermissionMode, number> = {
  "accept-edits": 0,
  auto: 1,
  full: 2,
};

/** A thread cannot exceed the ceiling of the machine it runs on. */
export function clampPermissionMode(
  requested: BbPermissionMode,
  ceiling: BbPermissionMode,
): BbPermissionMode {
  return PERMISSION_RANK[requested] <= PERMISSION_RANK[ceiling]
    ? requested
    : ceiling;
}

/**
 * Build the environment for a pinned machine. A personal-project thread has no
 * checkout, and a project thread gets BB's managed worktree so a Discord
 * request never lands in whatever state a shared clone happens to be in.
 */
export function spawnEnvironmentFor(
  project: ProjectInfo,
  hostId: string | null,
): SpawnEnvironment {
  if (!hostId) return { type: "project-default" };
  return {
    type: "host",
    hostId,
    workspace:
      project.kind === "personal"
        ? { type: "personal" }
        : { type: "managed-worktree", baseBranch: { kind: "default" } },
  };
}

/**
 * Never let a message read "machine null". With no machine pinned the catalog
 * belongs to whatever host the project resolves to, and the honest way to name
 * that is generically.
 */
function machineLabel(input: Pick<ResolveExecutionInput, "machine" | "selection">): string {
  if (input.machine) return `machine "${input.machine.name}"`;
  if (input.selection.hostId) return `machine \`${input.selection.hostId}\``;
  return "the project's default machine";
}

export function resolveExecution(
  input: ResolveExecutionInput,
): ExecutionResolution {
  const { selection, project, defaults, catalog, machine } = input;
  const warnings: string[] = [];

  if (selection.hostId) {
    if (!machine) {
      return {
        ok: false,
        problem: {
          setting: "machineHostId",
          message: `Machine \`${selection.hostId}\` is not an enrolled BB machine any more. Choose a machine again under Settings → Plugins → Discord → Configuration.`,
        },
      };
    }
    if (machine.status !== "connected") {
      return {
        ok: false,
        problem: {
          setting: "machineHostId",
          message: `Machine "${machine.name}" is offline, so Discord requests cannot start there. Bring it online, or set Machine back to Automatic.`,
        },
      };
    }
    if (project.kind === "standard" && !project.hostIds.includes(machine.id)) {
      return {
        ok: false,
        problem: {
          setting: "machineHostId",
          message: `Project "${project.name}" has no checkout on machine "${machine.name}". Add the project source on that machine, or pick a different machine.`,
        },
      };
    }
  }

  const providerId = selection.providerId ?? defaults.providerId;
  const wantedModel = selection.model ?? defaults.model;
  const modelIsPinned = selection.model !== null;
  let model = wantedModel;
  let reasoningLevel = defaults.reasoningLevel;

  // Validate whenever either half of the pair is pinned. A pinned machine has
  // to be checked even when the model is automatic: inheriting the project's
  // default model only works if that machine's catalog actually offers it, and
  // finding that out at spawn time means a Discord request dies for a reason
  // nothing in the panel ever showed.
  const shouldValidate = selection.hostId !== null || modelIsPinned;
  if (shouldValidate && catalog) {
    const provider = catalog.providers.find((entry) => entry.id === providerId);
    const label = machineLabel(input);

    if (!provider || !provider.available) {
      const providerName = provider?.displayName ?? `\`${providerId}\``;
      const cause = provider
        ? `is not signed in on ${label}`
        : `is not installed on ${label}`;
      // Blame whichever setting the operator actually chose. Pinning the
      // machine is what made an otherwise fine project default unusable.
      return {
        ok: false,
        problem: selection.providerId
          ? {
              setting: "providerId",
              message: `Provider ${providerName} ${cause}. Sign in there, pick a different machine, or set Model back to Automatic.`,
            }
          : {
              setting: "machineHostId",
              message: `The project's provider ${providerName} ${cause}, so Discord threads cannot run there. Pick a different machine, or sign that provider in on it.`,
            },
      };
    }

    const providerModels = catalog.models.filter(
      (entry) => (entry.routeProviderId ?? providerId) === providerId,
    );
    const match = providerModels.find((entry) => entry.model === wantedModel);
    if (!match) {
      const available = providerModels
        .slice(0, 4)
        .map((entry) => entry.displayName)
        .join(", ");
      const availableSuffix = available ? ` Available there: ${available}.` : "";
      return {
        ok: false,
        problem: modelIsPinned
          ? {
              setting: "model",
              message: `Model \`${wantedModel}\` is not offered by ${provider.displayName} on ${label}.${availableSuffix} Pick a different model, or set it back to Automatic.`,
            }
          : {
              // The operator never chose this model — the project did — so the
              // fix is to pin one that exists there rather than to go hunting
              // through project settings.
              setting: "model",
              message: `The project's default model \`${wantedModel}\` is not offered by ${provider.displayName} on ${label}.${availableSuffix} Pick a model explicitly, or choose a different machine.`,
            },
      };
    }
    model = match.model;
    reasoningLevel = match.defaultReasoningEffort;
  } else if (shouldValidate && !catalog) {
    warnings.push(
      `Could not read the model catalog on ${machineLabel(input)}, so \`${wantedModel}\` is being used unverified.`,
    );
  }

  const ceiling = catalog?.permissionCeiling ?? machine?.maxPermissionMode ?? null;
  let permissionMode = input.permissionMode;
  if (ceiling) {
    const clamped = clampPermissionMode(permissionMode, ceiling);
    if (clamped !== permissionMode) {
      warnings.push(
        `Permission mode was lowered from ${permissionMode} to ${clamped} because ${machineLabel(input)} caps it there.`,
      );
      permissionMode = clamped;
    }
  }

  if (catalog?.loadError && catalog.loadError.providerId === providerId) {
    warnings.push(
      `Provider \`${providerId}\` reported \`${catalog.loadError.code}\` while listing models on ${machineLabel(input)}.`,
    );
  }

  return {
    ok: true,
    plan: {
      projectId: project.id,
      environment: spawnEnvironmentFor(project, selection.hostId),
      providerId,
      model,
      reasoningLevel,
      serviceTier: defaults.serviceTier,
      permissionMode,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Selection requests
// ---------------------------------------------------------------------------

export interface SelectionRequest {
  machineHostId: string | null;
  providerId: string | null;
  model: string | null;
}

export type SelectionCheck =
  | { ok: true; selection: SelectionRequest; notice: string | null }
  | { ok: false; message: string };

const blank = (value: string | null): string | null =>
  value && value.trim() ? value.trim() : null;

/**
 * Gate for the panel's selects. The frontend can be stale — a machine can go
 * away or a provider can sign out between the render and the click — so the
 * server checks the requested pair against the catalog it just read rather
 * than trusting the option that was posted.
 *
 * Provider and model travel together: a provider without a model is not a
 * choice the operator can express in the UI, and keeping a lone provider id
 * around would silently steer a later automatic model.
 */
export function validateSelectionRequest(input: {
  request: SelectionRequest;
  machines: readonly MachineInfo[] | null;
  catalog: MachineCatalog | null;
}): SelectionCheck {
  const hostId = blank(input.request.machineHostId);
  const model = blank(input.request.model);
  const providerId = model ? blank(input.request.providerId) : null;

  if (hostId) {
    if (!input.machines) {
      return {
        ok: false,
        message: "The machine list is unavailable right now, so that machine could not be verified. Try again in a moment.",
      };
    }
    const machine = input.machines.find((entry) => entry.id === hostId);
    if (!machine) {
      return {
        ok: false,
        message: "That machine is no longer enrolled with BB. Reload this page and pick again.",
      };
    }
  }

  // A machine that is merely offline is still a legitimate choice — it may be
  // asleep — so it saves, with the consequence spelled out rather than hidden.
  const offlineNotice =
    hostId &&
    input.machines?.find((entry) => entry.id === hostId)?.status === "disconnected"
      ? "Saved. That machine is offline right now, so Discord requests will be refused until it reconnects."
      : null;

  if (!model) {
    return {
      ok: true,
      selection: { machineHostId: hostId, providerId: null, model: null },
      notice: offlineNotice,
    };
  }
  if (!providerId) {
    return {
      ok: false,
      message: "Pick the model from the list so BB knows which provider it belongs to.",
    };
  }
  if (!input.catalog) {
    return {
      ok: false,
      message: "The model catalog for that machine could not be read, so the model could not be verified. Leave Model on Automatic, or try again once the machine is reachable.",
    };
  }
  const provider = input.catalog.providers.find((entry) => entry.id === providerId);
  if (!provider || !provider.available) {
    return {
      ok: false,
      message: provider
        ? `${provider.displayName} is not signed in on that machine, so its models cannot be used there.`
        : "That provider is not installed on the selected machine.",
    };
  }
  const known = input.catalog.models.some(
    (entry) =>
      entry.model === model && (entry.routeProviderId ?? providerId) === providerId,
  );
  if (!known) {
    return {
      ok: false,
      message: "That model is not offered on the selected machine any more. Reload this page and pick again.",
    };
  }

  return {
    ok: true,
    selection: { machineHostId: hostId, providerId, model },
    notice: offlineNotice,
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export type ExecutionSource = "setting" | "default";

export interface ExecutionFieldView {
  /** What the operator sees, already resolved. */
  label: string;
  /** Machine-readable value, for a title attribute or the CLI. */
  value: string | null;
  source: ExecutionSource;
  /** Set when this specific field is what makes the selection unusable. */
  problem: string | null;
}

export interface ExecutionView {
  project: ExecutionFieldView;
  machine: ExecutionFieldView;
  model: ExecutionFieldView;
  /** One sentence tying the three together, always rendered. */
  summary: string;
  /** Empty when the current selection resolves cleanly. */
  issues: string[];
}

export interface BuildExecutionViewInput {
  selection: ExecutionSelection;
  project: ProjectInfo | null;
  machine: MachineInfo | null;
  defaults: ProjectExecutionDefaults | null;
  resolution: ExecutionResolution | null;
  warnings?: readonly string[];
}

/**
 * The panel shows resolved values, not raw fields, so an operator can see that
 * "empty" still means something concrete — and sees a stale pin as a problem
 * on the exact row that causes it, before a Discord request hits it.
 */
export function buildExecutionView(
  input: BuildExecutionViewInput,
): ExecutionView {
  const { selection, project, machine, defaults, resolution } = input;
  const problemFor = (setting: ExecutionProblem["setting"]): string | null =>
    resolution && !resolution.ok && resolution.problem.setting === setting
      ? resolution.problem.message
      : null;

  const projectField: ExecutionFieldView = {
    label: project
      ? project.kind === "personal"
        ? `${project.name} (personal)`
        : project.name
      : selection.projectId ?? "Personal project",
    value: project?.id ?? selection.projectId,
    source: selection.projectId ? "setting" : "default",
    problem: problemFor("defaultProjectId"),
  };

  const machineField: ExecutionFieldView = {
    label: selection.hostId
      ? machine
        ? `${machine.name}${machine.status === "connected" ? "" : " (offline)"}`
        : selection.hostId
      : "Wherever the project runs by default",
    value: selection.hostId,
    source: selection.hostId ? "setting" : "default",
    problem: problemFor("machineHostId"),
  };

  const modelField: ExecutionFieldView = {
    label: selection.model
      ? selection.providerId
        ? `${selection.model} (${selection.providerId})`
        : selection.model
      : defaults
        ? `${defaults.model} (project default)`
        : "The project's default model",
    value: selection.model ?? defaults?.model ?? null,
    source: selection.model ? "setting" : "default",
    problem: problemFor("model") ?? problemFor("providerId"),
  };

  const issues = [
    projectField.problem,
    machineField.problem,
    modelField.problem,
    ...(resolution?.ok ? resolution.plan.warnings : []),
    ...(input.warnings ?? []),
  ].filter((entry): entry is string => Boolean(entry));

  return {
    project: projectField,
    machine: machineField,
    model: modelField,
    summary: `Discord requests open a BB thread in ${projectField.label}, running on ${machineField.label.toLowerCase()}, with ${modelField.label}.`,
    issues,
  };
}
