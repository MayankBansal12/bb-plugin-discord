// Fixtures shared by the unit tests. Not referenced by server.ts or app.tsx,
// so it never reaches a plugin bundle.

import type {
  DiscordConfigurationStatus,
  DiscordExecutionStatus,
} from "./contract.js";

export function configurationFixture(
  overrides: Partial<DiscordConfigurationStatus> = {},
): DiscordConfigurationStatus {
  return {
    botToken: { configured: false, masked: null },
    permissionMode: { value: "auto", label: "Auto" },
    serverAccess: { value: "messages", label: "Messages" },
    destructiveActions: { configured: false, effective: false, blockedReason: null },
    homeChannel: { id: null, name: null, label: "Not set", source: "none" },
    newConversationChannel: {
      id: null,
      name: null,
      label: "Any channel in the paired server",
      source: "none",
    },
    guild: { value: null, source: "none" },
    authorizedUsers: [],
    ...overrides,
  };
}

export function executionFixture(
  overrides: Partial<DiscordExecutionStatus> = {},
): DiscordExecutionStatus {
  return {
    project: {
      label: "Personal",
      value: null,
      source: "default",
      problem: null,
    },
    machine: {
      label: "Wherever the project runs by default",
      value: null,
      source: "default",
      problem: null,
    },
    model: {
      label: "The project's default model",
      value: null,
      source: "default",
      problem: null,
    },
    resolvedProviderId: null,
    resolvedReasoningLevel: null,
    resolvedServiceTier: null,
    summary: "Discord requests open a bb thread in Personal.",
    issues: [],
    projects: [],
    machines: [],
    models: [],
    catalogUnavailable: false,
    ...overrides,
  };
}
