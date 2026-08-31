import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  UrlLink,
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { discordRpcContract, DiscordPairingStatus } from "./contract.js";
import {
  DISCORD_DEVELOPER_LINKS,
  pairingPanelView,
  pairingSignalReason,
  setupView,
  type SetupStep,
} from "./pairing-ui.js";
import "./app.css";

const REALTIME_CHANNEL = "pairing-state";
const SAFETY_REFRESH_MS = 60_000;

type Rpc = ReturnType<typeof useRpc<typeof discordRpcContract>>;

interface DiscordStatusState {
  status: DiscordPairingStatus | null;
  error: string | null;
  now: number;
  rpc: Rpc;
  refresh: () => Promise<void>;
  setStatus: (next: DiscordPairingStatus) => void;
  setError: (message: string | null) => void;
}

/**
 * Both sections read the same server state. Each keeps its own copy rather
 * than lifting a store into module scope, because the host can mount, unmount
 * and remount sections independently.
 */
function useDiscordStatus(withClock: boolean): DiscordStatusState {
  const rpc = useRpc<typeof discordRpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const [status, setStatus] = useState<DiscordPairingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const hasConnectedOnce = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc.call("getPairingStatus"));
      setError(null);
      setNow(Date.now());
    } catch {
      setError("Discord status is unavailable. Try refreshing this section.");
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const safetyRefresh = window.setInterval(() => void refresh(), SAFETY_REFRESH_MS);
    return () => window.clearInterval(safetyRefresh);
  }, [refresh]);

  // Only the pairing countdown needs a per-second clock; the configuration
  // panel would just be re-rendering itself once a second for nothing.
  useEffect(() => {
    if (!withClock) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(clock);
  }, [withClock]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (pairingSignalReason(payload)) void refresh();
  });

  useEffect(() => {
    if (realtimeState !== "connected") return;
    if (hasConnectedOnce.current) void refresh();
    hasConnectedOnce.current = true;
  }, [realtimeState, refresh]);

  return { status, error, now, rpc, refresh, setStatus, setError };
}

function PanelShell({
  status,
  error,
  onRetry,
  children,
}: {
  status: DiscordPairingStatus | null;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
}): ReactNode {
  if (status) return children;
  return (
    <div className="discord-panel discord-panel--loading" aria-live="polite">
      <span>{error ?? "Loading Discord status…"}</span>
      {error ? (
        <button className="discord-button discord-button--secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function Notices({
  status,
  error,
}: {
  status: DiscordPairingStatus;
  error: string | null;
}): ReactNode {
  return (
    <>
      {status.notice ? <p className="discord-notice">{status.notice}</p> : null}
      {status.legacySettingsRequireCleanup && !status.notice ? (
        <p className="discord-notice">
          This server is authorized by the advanced server and user fields. Clear both to
          fully unpair it.
        </p>
      ) : null}
      {error ? (
        <p className="discord-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function StepBody({
  step,
  status,
  now,
  busy,
  onGenerate,
  onCopy,
  copied,
}: {
  step: SetupStep;
  status: DiscordPairingStatus;
  now: number;
  busy: boolean;
  onGenerate: () => void;
  onCopy: () => void;
  copied: boolean;
}): ReactNode {
  const view = pairingPanelView(status, now);

  if (step.id === "token") {
    return (
      <>
        <p>{step.detail}</p>
        <div className="discord-links">
          <UrlLink className="discord-link" href={DISCORD_DEVELOPER_LINKS.applications}>
            Developer Portal → Applications
          </UrlLink>
          <UrlLink className="discord-link" href={DISCORD_DEVELOPER_LINKS.botDocs}>
            How to create a bot
          </UrlLink>
          <UrlLink className="discord-link" href={DISCORD_DEVELOPER_LINKS.intentsDocs}>
            Message Content Intent
          </UrlLink>
        </div>
      </>
    );
  }

  if (step.id === "invite") {
    return (
      <>
        <p>{step.detail}</p>
        {status.inviteUrl ? (
          <UrlLink className="discord-link discord-link--strong" href={status.inviteUrl}>
            Open the Discord invite
          </UrlLink>
        ) : (
          <p className="discord-hint">{view.setupStep}</p>
        )}
      </>
    );
  }

  return (
    <>
      <p>{step.detail}</p>
      {status.pairingCode?.command ? (
        <>
          <div className="discord-code-row">
            <code>{status.pairingCode.command}</code>
            <button
              className="discord-button discord-button--secondary discord-button--swap"
              onClick={onCopy}
              data-copied={copied ? "true" : "false"}
            >
              {/* Both labels are always mounted and crossfade in place, so the
                  button never changes width mid-transition. */}
              <span className="discord-swap__slot" aria-hidden>
                <span className="discord-swap__label">Copy</span>
                <span className="discord-swap__label discord-swap__label--alt">Copied</span>
              </span>
              <span className="discord-visually-hidden" aria-live="polite">
                {copied ? "Command copied" : "Copy command"}
              </span>
            </button>
          </div>
          {view.expiryLabel ? (
            <p className="discord-expiry">{view.expiryLabel}</p>
          ) : null}
        </>
      ) : (
        <p className="discord-hint">
          {status.pairingCode
            ? "The copyable command appears once the Discord gateway identifies the bot."
            : "A pairing code appears once the token is saved."}
        </p>
      )}
      <button
        className="discord-button discord-button--secondary"
        disabled={!status.tokenConfigured || busy}
        onClick={onGenerate}
      >
        {busy ? "Creating code…" : "Create a new code"}
      </button>
    </>
  );
}

function ConnectionPanel(): ReactNode {
  const state = useDiscordStatus(true);
  const { status, error, now, rpc, refresh } = state;
  const [busy, setBusy] = useState<"code" | "unpair" | null>(null);
  const [confirmingUnpair, setConfirmingUnpair] = useState(false);
  const [copied, setCopied] = useState(false);

  const generateCode = async () => {
    setBusy("code");
    try {
      state.setStatus(await rpc.call("refreshPairingCode"));
      state.setError(null);
    } catch {
      state.setError("A new pairing code could not be created. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const unpair = async () => {
    setBusy("unpair");
    try {
      state.setStatus(await rpc.call("unpair"));
      state.setError(null);
      setConfirmingUnpair(false);
    } catch {
      state.setError("Discord could not be unpaired. Try again, or run `bb discord unpair`.");
    } finally {
      setBusy(null);
    }
  };

  const copyCommand = async () => {
    const command = status?.pairingCode?.command;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      state.setError(null);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      state.setError("The command could not be copied. Select it and copy it manually.");
    }
  };

  const setup = useMemo(() => (status ? setupView(status) : null), [status]);

  return (
    <PanelShell status={status} error={error} onRetry={() => void refresh()}>
      {status && setup ? (
        <div className="discord-panel">
          <section
            className={`discord-gateway discord-gateway--${status.gateway.state}`}
            aria-label="Discord gateway"
          >
            <span className="discord-dot" aria-hidden />
            <div>
              <strong>{pairingPanelView(status, now).connectionLabel}</strong>
              <p>{pairingPanelView(status, now).connectionDetail}</p>
            </div>
            {status.paired ? <span className="discord-badge">Paired</span> : null}
          </section>

          <Notices status={status} error={error} />

          {setup.stage === "paired" ? (
            <>
              <dl className="discord-details">
                <div>
                  <dt>Server</dt>
                  <dd>{pairingPanelView(status, now).serverLabel}</dd>
                </div>
                <div>
                  <dt>Home channel</dt>
                  <dd>{status.configuration.homeChannel.label}</dd>
                </div>
                <div>
                  <dt>Authorized</dt>
                  <dd>{pairingPanelView(status, now).userLabel}</dd>
                </div>
              </dl>
              <details className="discord-disclosure discord-disclosure--danger">
                <summary>Disconnect this server</summary>
                <p>
                  Unpairing removes the authorized users and every Discord-to-BB
                  conversation link. {status.botName} stays in the server until you remove
                  it there.
                </p>
                {confirmingUnpair ? (
                  <div className="discord-actions">
                    <button
                      className="discord-button discord-button--secondary"
                      onClick={() => setConfirmingUnpair(false)}
                      disabled={busy !== null}
                    >
                      Cancel
                    </button>
                    <button
                      className="discord-button discord-button--danger"
                      onClick={() => void unpair()}
                      disabled={busy !== null}
                    >
                      {busy === "unpair" ? "Unpairing…" : "Yes, unpair"}
                    </button>
                  </div>
                ) : (
                  <button
                    className="discord-button discord-button--danger"
                    onClick={() => setConfirmingUnpair(true)}
                  >
                    Unpair server
                  </button>
                )}
              </details>
            </>
          ) : (
            <ol className="discord-steps">
              {setup.steps.map((step, index) => (
                <li
                  key={step.id}
                  className={`discord-step discord-step--${step.state}`}
                  style={{ "--discord-step-index": index } as CSSProperties}
                  aria-current={step.state === "active" ? "step" : undefined}
                >
                  <span className="discord-step__marker" aria-hidden>
                    {step.state === "done" ? "✓" : index + 1}
                  </span>
                  <div className="discord-step__body">
                    <strong>{step.title}</strong>
                    <p className="discord-step__summary">{step.summary}</p>
                    {step.state === "active" || step.state === "blocked" ? (
                      <div className="discord-step__detail">
                        <StepBody
                          step={step}
                          status={status}
                          now={now}
                          busy={busy === "code"}
                          onGenerate={() => void generateCode()}
                          onCopy={() => void copyCommand()}
                          copied={copied}
                        />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  source,
  hint,
  problem,
}: {
  label: string;
  value: ReactNode;
  source?: "setting" | "default" | "pairing" | "none";
  hint?: string | null;
  problem?: string | null;
}): ReactNode {
  const badge =
    source === "setting"
      ? "Configured"
      : source === "pairing"
        ? "From pairing"
        : source === "default"
          ? "Default"
          : null;
  return (
    <div className="discord-row">
      <div className="discord-row__head">
        <span className="discord-row__label">{label}</span>
        {badge ? <span className="discord-badge">{badge}</span> : null}
      </div>
      <span className="discord-row__value">{value}</span>
      {hint ? <p className="discord-hint">{hint}</p> : null}
      {problem ? (
        <p className="discord-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

const AUTOMATIC = "";

function ExecutionSelectors({
  status,
  onSave,
  saving,
}: {
  status: DiscordPairingStatus;
  onSave: (next: {
    machineHostId: string | null;
    providerId: string | null;
    model: string | null;
  }) => void;
  saving: boolean;
}): ReactNode {
  const { execution } = status;
  const selectedMachine = execution.machine.source === "setting" ? execution.machine.value : null;
  const selectedModel = execution.model.source === "setting" ? execution.model.value : null;

  // Options are indexed rather than keyed by model id: two providers on one
  // machine can legitimately offer the same id, and an index cannot collide.
  const modelIndex = execution.models.findIndex((option) => option.model === selectedModel);
  const providersInOrder = [
    ...new Map(
      execution.models.map((option) => [option.providerId, option.providerDisplayName]),
    ).entries(),
  ];

  return (
    <section className="discord-group" aria-labelledby="discord-where" aria-busy={saving}>
      <h4 id="discord-where">Where Discord requests run</h4>
      <p className="discord-group__lede">
        Project, machine and model are one decision. The project picks the checkout, the
        machine picks the computer, and the model list belongs to that machine — a
        provider signed in on your laptop is not signed in on a build box.
      </p>

      <Row
        label="Project"
        value={execution.project.label}
        source={execution.project.source}
        hint="Set this with the “Project for Discord threads” field above."
        problem={execution.project.problem}
      />

      <div className="discord-field">
        <label className="discord-row__label" htmlFor="discord-machine">
          Machine
        </label>
        <select
          id="discord-machine"
          className="discord-select"
          value={selectedMachine ?? AUTOMATIC}
          disabled={saving}
          onChange={(event) =>
            // Changing machine invalidates the model: its catalog is a
            // different machine's. Reset rather than guess a replacement.
            onSave({
              machineHostId: event.target.value || null,
              providerId: null,
              model: null,
            })
          }
        >
          <option value={AUTOMATIC}>Automatic — project default</option>
          {execution.machines.map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
              {machine.status === "connected" ? "" : " — offline"}
            </option>
          ))}
        </select>
        <p className="discord-hint">
          {selectedMachine
            ? "Changing the machine resets the model to Automatic, because model availability is per machine."
            : "Discord threads run wherever the project runs by default."}
        </p>
        {execution.machine.problem ? (
          <p className="discord-error" role="alert">
            {execution.machine.problem}
          </p>
        ) : null}
      </div>

      <div className="discord-field">
        <label className="discord-row__label" htmlFor="discord-model">
          Model
        </label>
        <select
          id="discord-model"
          className="discord-select"
          value={modelIndex >= 0 ? String(modelIndex) : AUTOMATIC}
          // Automatic must remain available even when the catalog is empty or
          // unavailable; it is the recovery path for a stale saved model.
          disabled={saving}
          onChange={(event) => {
            const option = execution.models[Number(event.target.value)];
            onSave({
              machineHostId: selectedMachine,
              providerId: option?.providerId ?? null,
              model: option?.model ?? null,
            });
          }}
        >
          <option value={AUTOMATIC}>Automatic — project default</option>
          {providersInOrder.map(([providerId, providerName]) => (
            <optgroup key={providerId} label={providerName}>
              {execution.models.map((option, index) =>
                option.providerId === providerId ? (
                  <option key={`${providerId}-${option.model}`} value={String(index)}>
                    {option.displayName}
                    {option.isDefault ? " — machine default" : ""}
                  </option>
                ) : null,
              )}
            </optgroup>
          ))}
        </select>
        <p className="discord-hint">
          {execution.catalogUnavailable
            ? "The model list for that machine could not be read, so only Automatic is safe right now."
            : execution.models.length === 0
              ? "No signed-in provider on that machine reports any models."
              : selectedModel
                ? `Pinned. Discord threads use this model instead of the project's.`
                : "Discord threads use the project's default model."}
        </p>
        {selectedModel && modelIndex < 0 && !execution.catalogUnavailable ? (
          <p className="discord-error" role="alert">
            The saved model <code>{selectedModel}</code> is not in this machine&rsquo;s
            list. Pick one below, or set it back to Automatic.
          </p>
        ) : null}
        {execution.model.problem ? (
          <p className="discord-error" role="alert">
            {execution.model.problem}
          </p>
        ) : null}
      </div>

      <p className="discord-hint" role="status">
        {saving ? "Saving…" : execution.summary}
      </p>

      {execution.issues.length > 0 ? (
        <ul className="discord-issues" role="alert">
          {execution.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ConfigurationPanel(): ReactNode {
  const state = useDiscordStatus(false);
  const { status, error, rpc, refresh } = state;
  const [savingDestructive, setSavingDestructive] = useState(false);
  const [savingExecution, setSavingExecution] = useState(false);

  const saveExecution = async (next: {
    machineHostId: string | null;
    providerId: string | null;
    model: string | null;
  }) => {
    setSavingExecution(true);
    try {
      state.setStatus(await rpc.call("setExecutionSelection", next));
      state.setError(null);
    } catch {
      state.setError("That selection could not be saved. Try again.");
    } finally {
      setSavingExecution(false);
    }
  };

  const toggleDestructive = async (enabled: boolean) => {
    setSavingDestructive(true);
    try {
      state.setStatus(await rpc.call("setDestructiveActions", { enabled }));
      state.setError(null);
    } catch {
      state.setError("That change could not be saved. Try again.");
    } finally {
      setSavingDestructive(false);
    }
  };

  return (
    <PanelShell status={status} error={error} onRetry={() => void refresh()}>
      {status ? (
        <div className="discord-panel">
          <Notices status={status} error={error} />

          <ExecutionSelectors
            status={status}
            onSave={(next) => void saveExecution(next)}
            saving={savingExecution}
          />

          <section className="discord-group" aria-labelledby="discord-access">
            <h4 id="discord-access">What the agent may do</h4>
            <Row label="Permission mode" value={status.configuration.permissionMode.label} />
            <Row label="Discord server access" value={status.configuration.serverAccess.label} />
            <div className="discord-row">
              <div className="discord-row__head">
                <span className="discord-row__label">Destructive server actions</span>
                <button
                  role="switch"
                  aria-checked={status.configuration.destructiveActions.configured}
                  aria-label="Allow destructive Discord server actions"
                  className="discord-switch"
                  disabled={
                    savingDestructive ||
                    (status.configuration.serverAccess.value !== "full" &&
                      !status.configuration.destructiveActions.configured)
                  }
                  onClick={() =>
                    void toggleDestructive(
                      !status.configuration.destructiveActions.configured,
                    )
                  }
                >
                  <span className="discord-switch__thumb" aria-hidden />
                </button>
              </div>
              <span className="discord-row__value">
                {status.configuration.destructiveActions.effective
                  ? "On — deleting channels and moderating members is allowed"
                  : "Off — deleting channels and moderating members is refused"}
              </span>
              <p className="discord-hint">
                {status.configuration.serverAccess.value === "full"
                  ? "This toggle writes only this setting. Discord server access is never changed for you."
                  : "Set Discord server access to Full above to enable this. Turning it on here will not change server access."}
              </p>
              {status.configuration.destructiveActions.blockedReason ? (
                <p className="discord-error" role="alert">
                  {status.configuration.destructiveActions.blockedReason}
                </p>
              ) : null}
            </div>
          </section>

          <section className="discord-group" aria-labelledby="discord-channels">
            <h4 id="discord-channels">Channels</h4>
            <Row
              label="Home channel"
              value={status.configuration.homeChannel.label}
              source={status.configuration.homeChannel.source}
              hint={
                status.configuration.homeChannel.source === "pairing"
                  ? "The setting is empty, so status and failure alerts go to the channel the pairing command ran in."
                  : null
              }
            />
            <Row
              label="New conversations"
              value={status.configuration.newConversationChannel.label}
              source={status.configuration.newConversationChannel.source}
              hint={`Where mentioning ${status.botName} may open a new BB conversation. Existing conversation threads keep working wherever they are.`}
            />
          </section>

          <details className="discord-disclosure">
            <summary>Derived identifiers</summary>
            <Row
              label="Machine ID"
              value={status.execution.machine.value ?? "Project default"}
              source={status.execution.machine.source}
            />
            <Row
              label="Server (guild) ID"
              value={status.configuration.guild.value ?? "Not paired"}
              source={status.configuration.guild.source}
            />
            <Row
              label="Bot token"
              value={
                status.configuration.botToken.configured
                  ? `Application ${status.configuration.botToken.applicationId ?? "unknown"} · ${status.configuration.botToken.masked}`
                  : "Not set"
              }
              source={status.configuration.botToken.configured ? "setting" : "none"}
              hint="The token itself never leaves the BB server."
            />
            <Row
              label="Authorized Discord users"
              value={
                status.configuration.authorizedUsers.length > 0
                  ? status.configuration.authorizedUsers
                      .map((user) => `${user.tag ? `${user.tag} · ` : ""}${user.id}`)
                      .join(", ")
                  : "None yet"
              }
              hint="The person who paired is always authorized, even when the advanced field is empty."
            />
          </details>
        </div>
      ) : null}
    </PanelShell>
  );
}

export default definePluginApp((app) => {
  // Connection is registered first so onboarding sits above the settings that
  // only matter once Discord is talking to BB.
  app.slots.settingsSection({
    id: "connection",
    title: "Connection",
    description: "Add the bot token, invite the bot, and pair one Discord server.",
    component: ConnectionPanel,
  });
  app.slots.settingsSection({
    id: "configuration",
    title: "Configuration",
    description: "The values in effect right now, including the ones pairing filled in.",
    component: ConfigurationPanel,
  });
});
