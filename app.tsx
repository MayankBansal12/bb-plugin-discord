import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  UrlLink,
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalProviderModelPickerValue,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { discordRpcContract, DiscordPairingStatus } from "./contract.js";
import {
  DISCORD_DEVELOPER_LINKS,
  pairingPanelView,
  pairingSignalReason,
} from "./pairing-ui.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import "./app.css";

const REALTIME_CHANNEL = "pairing-state";
const SAFETY_REFRESH_MS = 60_000;
const AUTOMATIC = "automatic";

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

function useDiscordStatus(): DiscordStatusState {
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
      setError("Discord status is unavailable. Try again.");
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const safetyRefresh = window.setInterval(() => void refresh(), SAFETY_REFRESH_MS);
    return () => window.clearInterval(safetyRefresh);
  }, [refresh]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(clock);
  }, []);

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

function Icon({ name, className }: { name: "check" | "copy" | "external"; className?: string }) {
  const path = {
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    external: <><path d="M14 5h5v5" /><path d="m10 14 9-9" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  }[name];
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  );
}

function Notice({ children, destructive = false }: { children: ReactNode; destructive?: boolean }) {
  return (
    <div
      role={destructive ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm leading-relaxed",
        destructive
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function LoadingState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <Card aria-live="polite">
      <CardContent className="flex min-h-24 items-center justify-center gap-3 pt-5 text-sm text-muted-foreground">
        <span>{error ?? "Loading Discord status…"}</span>
        {error ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : null}
      </CardContent>
    </Card>
  );
}

function StatusCard({ status, now }: { status: DiscordPairingStatus; now: number }) {
  const view = pairingPanelView(status, now);
  const state = status.gateway.state;
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-5">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full bg-muted-foreground",
            state === "connected" && "bg-primary",
            state === "failed" && "bg-destructive",
            state === "connecting" && "discord-status-pulse",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{view.connectionLabel}</p>
          <p className="truncate text-sm text-muted-foreground">{view.connectionDetail}</p>
        </div>
        {status.paired ? <Badge>Connected</Badge> : null}
      </CardContent>
    </Card>
  );
}

function SetupStep({
  number,
  title,
  description,
  complete = false,
  children,
}: {
  number: number;
  title: string;
  description: string;
  complete?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3 py-4 first:pt-0 last:pb-0">
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-muted-foreground", complete && "border-primary bg-primary text-primary-foreground")}>
        {complete ? <Icon name="check" /> : number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </li>
  );
}

function TokenSetup({ status, now }: { status: DiscordPairingStatus; now: number }) {
  const view = pairingPanelView(status, now);
  const failed = status.gateway.state === "failed";
  // The token is only "verified" once Discord has accepted it, so a saved but
  // unconfirmed token gets its own honest state rather than a green badge.
  const verifying = status.tokenConfigured && !failed;
  return (
    <div className="discord-enter space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <Badge>Step 1 of 3</Badge>
            {failed ? <Badge className="bg-destructive/10 text-destructive">Needs attention</Badge> : null}
          </div>
          <CardTitle className="pt-2 text-base">
            {verifying ? "Verifying your bot token" : "Add your Discord bot token"}
          </CardTitle>
          <CardDescription>
            {verifying
              ? "The token is saved. The rest of setup appears when Discord accepts it."
              : "Create a Discord app, enable Message Content Intent, then paste the bot token in the secure field above and save it. Nothing else needs configuring yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.configuration.botToken.configured ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Saved token</span>
              <code>{status.configuration.botToken.applicationId}{status.configuration.botToken.masked}</code>
            </div>
          ) : null}
          {failed ? <Notice destructive>{view.setupStep}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <UrlLink className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent" href={DISCORD_DEVELOPER_LINKS.applications}>
              Open Developer Portal <Icon name="external" />
            </UrlLink>
            <UrlLink className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" href={DISCORD_DEVELOPER_LINKS.botDocs}>
              Bot setup guide
            </UrlLink>
            <UrlLink className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" href={DISCORD_DEVELOPER_LINKS.intentsDocs}>
              Message Content Intent
            </UrlLink>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PairingSetup({ state }: { state: DiscordStatusState }) {
  const { status, now, rpc } = state;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!status) return null;
  const view = pairingPanelView(status, now);

  const refreshCode = async () => {
    setBusy(true);
    try {
      state.setStatus(await rpc.call("refreshPairingCode"));
      state.setError(null);
    } catch {
      state.setError("A new pairing code could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async () => {
    const command = status.pairingCode?.command;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      state.setError("The command could not be copied. Select it and copy it manually.");
    }
  };

  return (
    <div className="discord-enter space-y-4">
      <StatusCard status={status} now={now} />
      {status.notice ? <Notice>{status.notice}</Notice> : null}
      {state.error ? <Notice destructive>{state.error}</Notice> : null}
      <Card>
        <CardHeader>
          <Badge className="w-fit">Token verified</Badge>
          <CardTitle className="pt-2 text-base">Connect a Discord server</CardTitle>
          <CardDescription>Invite the verified bot, then authorize one server from the channel you want bb to use for updates.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="divide-y divide-border">
            <SetupStep number={1} title="Bot token" description={`Verified as ${status.gateway.botTag ?? status.botName}`} complete />
            <SetupStep number={2} title="Invite the bot" description="Add the bot to the Discord server you want to connect.">
              {status.inviteUrl ? (
                <UrlLink className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90" href={status.inviteUrl}>
                  Invite to Discord <Icon name="external" />
                </UrlLink>
              ) : <Notice destructive>{view.setupStep}</Notice>}
            </SetupStep>
            <SetupStep number={3} title="Pair the server" description={`Send this one-time command in the channel where ${status.botName} should post status and failure alerts.`}>
              {status.pairingCode?.command ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-foreground">{status.pairingCode.command}</code>
                    <Button variant="outline" size="sm" onClick={() => void copyCommand()}>
                      <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  {view.expiryLabel ? <p className="text-xs tabular-nums text-muted-foreground">{view.expiryLabel}</p> : null}
                </div>
              ) : <p className="text-sm text-muted-foreground">The command appears as soon as Discord identifies the bot.</p>}
              <Button className="mt-2" variant="ghost" size="sm" disabled={busy} onClick={() => void refreshCode()}>
                {busy ? "Creating code…" : "Create a new code"}
              </Button>
            </SetupStep>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The control is a render prop so the visible label and the input can never
 * drift apart: `Field` owns the id and hands it to whatever it wraps.
 */
function Field({ label, description, children }: { label: string; description?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,22rem)] sm:items-start sm:gap-4">
      <div className="space-y-1">
        <Label id={labelId} htmlFor={id}>{label}</Label>
        {description ? <p className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <div className="min-w-0" role="group" aria-labelledby={labelId}>{children(id)}</div>
    </div>
  );
}

interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function Dropdown({
  id,
  value,
  options,
  disabled,
  onValueChange,
}: {
  id: string;
  value: string;
  options: readonly DropdownOption[];
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ConfigDraft {
  defaultProjectId: string;
  machineHostId: string;
  modelValue: ExperimentalProviderModelPickerValue | null;
  modelPinned: boolean;
  permissionMode: "auto" | "accept-edits" | "full" | "project-default";
  serverAccess: "messages" | "full";
  homeChannelId: string;
  spawnChannelId: string;
}

function draftFrom(status: DiscordPairingStatus): ConfigDraft {
  const { configuration } = status;
  const projectId = status.execution.project.source === "setting" ? status.execution.project.value ?? "" : "";
  const activeProject = projectId
    ? status.execution.projects.find((project) => project.id === projectId)
    : status.execution.projects.find((project) => project.kind === "personal");
  const selectedMachineId = status.execution.machine.source === "setting" ? status.execution.machine.value ?? "" : "";
  const modelValue = pickerValueFromExecution(status.execution);
  return {
    defaultProjectId: projectId,
    machineHostId: selectedMachineId === activeProject?.defaultHostId ? "" : selectedMachineId,
    modelValue,
    modelPinned: status.execution.model.source === "setting" && modelValue !== null,
    permissionMode: configuration.permissionMode.value as ConfigDraft["permissionMode"],
    serverAccess: configuration.serverAccess.value,
    homeChannelId: configuration.homeChannel.source === "setting" ? configuration.homeChannel.id ?? "" : "",
    spawnChannelId: configuration.newConversationChannel.source === "setting" ? configuration.newConversationChannel.id ?? "" : "",
  };
}

function pickerValueFromExecution(
  execution: DiscordPairingStatus["execution"],
): ExperimentalProviderModelPickerValue | null {
  if (
    !execution.resolvedProviderId ||
    !execution.model.value ||
    !execution.resolvedReasoningLevel
  ) {
    return null;
  }
  return {
    providerId: execution.resolvedProviderId,
    model: execution.model.value,
    reasoningLevel: execution.resolvedReasoningLevel,
    ...(execution.resolvedServiceTier
      ? { serviceTier: execution.resolvedServiceTier }
      : {}),
  };
}

function RoutingFields({
  status,
  draft,
  disabled,
  edit,
}: {
  status: DiscordPairingStatus;
  draft: ConfigDraft;
  disabled: boolean;
  edit: (patch: Partial<ConfigDraft>) => void;
}) {
  const { execution } = status;
  const standardProjects = execution.projects.filter((project) => project.kind === "standard");
  const personalProject = execution.projects.find((project) => project.kind === "personal") ?? null;
  const activeProject = draft.defaultProjectId
    ? execution.projects.find((project) => project.id === draft.defaultProjectId) ?? null
    : execution.projects.find((project) => project.kind === "personal") ?? null;
  const defaultMachineId = activeProject?.defaultHostId ?? (
    !draft.defaultProjectId && execution.machine.source === "default"
      ? execution.machine.value
      : null
  );
  const defaultMachine = defaultMachineId
    ? execution.machines.find((machine) => machine.id === defaultMachineId) ?? null
    : null;
  const machineCanRunProject = (machineId: string): boolean =>
    activeProject?.kind !== "standard" || activeProject.hostIds.includes(machineId);
  const pickerHostId = draft.machineHostId || defaultMachineId || undefined;

  return (
    <>
      <Field label="Project" description="Where new requests open.">
        {(id) => (
          <Dropdown
            id={id}
            value={draft.defaultProjectId || AUTOMATIC}
            disabled={disabled}
            options={[
              { value: AUTOMATIC, label: personalProject?.name || "Personal" },
              ...standardProjects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            onValueChange={(value) => edit({
              defaultProjectId: value === AUTOMATIC ? "" : value,
              machineHostId: "",
              modelPinned: false,
            })}
          />
        )}
      </Field>
      <Field label="Machine" description={activeProject?.kind === "standard" ? "Machines with this project checked out." : "Where requests run."}>
        {(id) => (
          <Dropdown
            id={id}
            value={draft.machineHostId || AUTOMATIC}
            disabled={disabled}
            options={[
              {
                value: AUTOMATIC,
                label: defaultMachine ? `${defaultMachine.name} (default)` : "Default machine",
              },
              ...execution.machines.filter((machine) => machine.id !== defaultMachineId).map((machine) => {
                const unavailable = !machineCanRunProject(machine.id);
                return {
                  value: machine.id,
                  label: `${machine.name}${unavailable ? " (no checkout)" : machine.status === "connected" ? "" : " (offline)"}`,
                  disabled: unavailable,
                };
              }),
            ]}
            onValueChange={(value) => edit({
              machineHostId: value === AUTOMATIC ? "" : value,
              modelPinned: false,
            })}
          />
        )}
      </Field>
      <Field label="Model" description="Uses the project default unless changed.">
        {(_id) => (
          <div className="space-y-2">
            {draft.modelValue ? (
              <ProviderModelPicker
                value={draft.modelValue}
                routing={pickerHostId ? { kind: "host", hostId: pickerHostId } : undefined}
                disabled={disabled}
                align="end"
                className="w-full justify-between"
                onChange={(value) => {
                  edit({ modelValue: value, modelPinned: true });
                }}
              />
            ) : <Notice destructive>The model list is unavailable.</Notice>}
            {draft.modelPinned ? (
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => edit({ modelPinned: false })}>Use default model</Button>
            ) : null}
          </div>
        )}
      </Field>
      {execution.issues.length > 0 ? <Notice destructive>{execution.issues.join(" ")}</Notice> : null}
    </>
  );
}

function ConnectedPanel({ state }: { state: DiscordStatusState }) {
  const status = state.status!;
  const view = pairingPanelView(status, state.now);
  // Only the fields the operator actually touched are held locally, so an
  // untouched field keeps tracking the server instead of going stale behind a
  // refresh, and a field being edited is never overwritten underneath them.
  const saved = draftFrom(status);
  const [edits, setEdits] = useState<Partial<ConfigDraft>>({});
  const draft: ConfigDraft = { ...saved, ...edits };
  const sameModel = (
    left: ExperimentalProviderModelPickerValue | null,
    right: ExperimentalProviderModelPickerValue | null,
  ) => left?.providerId === right?.providerId &&
    left?.model === right?.model &&
    left?.reasoningLevel === right?.reasoningLevel &&
    left?.serviceTier === right?.serviceTier;
  const dirty = (
    [
      "defaultProjectId",
      "machineHostId",
      "modelPinned",
      "permissionMode",
      "serverAccess",
      "homeChannelId",
      "spawnChannelId",
    ] as const
  ).some((key) => draft[key] !== saved[key]) || (
    draft.modelPinned && !sameModel(draft.modelValue, saved.modelValue)
  );
  const edit = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) =>
    setEdits((current) => ({ ...current, [key]: value }));
  const editMany = (patch: Partial<ConfigDraft>) =>
    setEdits((current) => ({ ...current, ...patch }));

  const [savingConfig, setSavingConfig] = useState(false);
  const [savingDestructive, setSavingDestructive] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [confirmingUnpair, setConfirmingUnpair] = useState(false);
  const busy = savingConfig || savingDestructive || unpairing;

  const run = async (
    setBusy: (value: boolean) => void,
    call: () => Promise<DiscordPairingStatus>,
    failure: string,
    after?: () => void,
  ) => {
    setBusy(true);
    try {
      state.setStatus(await call());
      state.setError(null);
      after?.();
    } catch {
      state.setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const saveConfiguration = () =>
    run(
      setSavingConfig,
      () => state.rpc.call("setConfiguration", {
        defaultProjectId: draft.defaultProjectId || null,
        machineHostId: draft.machineHostId || null,
        providerId: draft.modelPinned ? draft.modelValue?.providerId ?? null : null,
        model: draft.modelPinned ? draft.modelValue?.model ?? null : null,
        reasoningLevel: draft.modelPinned ? draft.modelValue?.reasoningLevel ?? null : null,
        serviceTier: draft.modelPinned ? draft.modelValue?.serviceTier ?? null : null,
        permissionMode: draft.permissionMode,
        serverAccess: draft.serverAccess,
        homeChannelId: draft.homeChannelId || null,
        spawnChannelId: draft.spawnChannelId || null,
      }),
      "Discord configuration could not be saved. Check the fields and try again.",
      () => setEdits({}),
    );

  const toggleDestructive = (enabled: boolean) =>
    run(
      setSavingDestructive,
      () => state.rpc.call("setDestructiveActions", { enabled }),
      "That permission could not be saved. Try again.",
    );

  const unpair = () =>
    run(
      setUnpairing,
      () => state.rpc.call("unpair"),
      "Discord could not be disconnected. Try again.",
      () => setConfirmingUnpair(false),
    );

  const gatewayDown = status.gateway.state !== "connected";

  return (
    <div className="discord-enter space-y-4">
      {status.notice ? <Notice>{status.notice}</Notice> : null}
      {state.error ? <Notice destructive>{state.error}</Notice> : null}
      {gatewayDown ? <Notice destructive>{view.connectionDetail}</Notice> : null}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <div className="flex items-center gap-3 border-b border-border pb-4 sm:col-span-2">
            <span className={cn("size-2 rounded-full", gatewayDown ? "bg-destructive" : "bg-primary")} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Connected to {view.serverLabel}</p>
              <p className="truncate text-sm text-muted-foreground">{view.connectionDetail}</p>
            </div>
            <Badge>Paired</Badge>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Home channel</p>
            <p className="mt-1 text-sm">{status.configuration.homeChannel.label}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Authorized by</p>
            <p className="mt-1 text-sm">{view.userLabel}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bot token</p>
            <code className="mt-1 block text-sm">{status.configuration.botToken.applicationId}{status.configuration.botToken.masked}</code>
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          {confirmingUnpair ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Remove the server connection and conversation links?</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingUnpair(false)}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => void unpair()}>{unpairing ? "Disconnecting…" : "Disconnect"}</Button>
            </div>
          ) : <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setConfirmingUnpair(true)}>Disconnect server</Button>}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where requests run</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RoutingFields status={status} draft={draft} disabled={busy} edit={editMany} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Permissions</CardTitle>
          <CardDescription>Control agent and Discord access.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="bb permission mode" description="Auto asks before risky actions.">
            {(id) => (
              <Dropdown id={id} value={draft.permissionMode} disabled={busy} onValueChange={(value) => edit("permissionMode", value as ConfigDraft["permissionMode"])} options={[
                { value: "auto", label: "Auto (ask before risky actions)" },
                { value: "accept-edits", label: "Accept edits" },
                { value: "full", label: "Full" },
                { value: "project-default", label: "Project default" },
              ]} />
            )}
          </Field>
          <Field label="Discord access" description="Full adds server administration tools.">
            {(id) => (
              <Dropdown id={id} value={draft.serverAccess} disabled={busy} onValueChange={(value) => edit("serverAccess", value as ConfigDraft["serverAccess"])} options={[
                { value: "messages", label: "Messages only" },
                { value: "full", label: "Full server access" },
              ]} />
            )}
          </Field>
          <Field label="Destructive actions" description={status.configuration.serverAccess.value === "full" ? "Allow channel deletion and member moderation. Applies immediately." : "Save Full access first."}>
            {(id) => (
              <div className="flex min-h-9 items-center justify-between rounded-md border border-border px-3">
                <span className="text-sm text-muted-foreground">{status.configuration.destructiveActions.effective ? "Allowed" : "Not allowed"}</span>
                <Switch id={id} checked={status.configuration.destructiveActions.configured} disabled={busy || (status.configuration.serverAccess.value !== "full" && !status.configuration.destructiveActions.configured)} onCheckedChange={(checked) => void toggleDestructive(checked)} />
              </div>
            )}
          </Field>
          {status.configuration.destructiveActions.blockedReason ? <Notice destructive>{status.configuration.destructiveActions.blockedReason}</Notice> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Channels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Status and alerts" description={`Default: ${status.configuration.homeChannel.label}`}>
            {(id) => <Input id={id} inputMode="numeric" value={draft.homeChannelId} disabled={busy} placeholder="Channel ID from pairing" onChange={(event) => edit("homeChannelId", event.target.value)} />}
          </Field>
          <Field label="New conversations" description="Default: any channel">
            {(id) => <Input id={id} inputMode="numeric" value={draft.spawnChannelId} disabled={busy} placeholder="Any channel" onChange={(event) => edit("spawnChannelId", event.target.value)} />}
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {savingConfig ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
        </span>
        <Button disabled={busy || !dirty} onClick={() => void saveConfiguration()}>Save configuration</Button>
      </div>
    </div>
  );
}

function DiscordSettings() {
  const state = useDiscordStatus();
  if (!state.status) return <LoadingState error={state.error} onRetry={() => void state.refresh()} />;
  // A paired install must keep its Disconnect escape hatch even when the
  // gateway is down. Before pairing, only call the token verified once the
  // gateway has actually connected.
  if (!state.status.paired && (
    !state.status.tokenConfigured || state.status.gateway.state !== "connected"
  )) {
    return <TokenSetup status={state.status} now={state.now} />;
  }
  if (!state.status.paired) return <PairingSetup state={state} />;
  return <ConnectedPanel state={state} />;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "setup",
    title: "Discord setup",
    description: "Connect Discord and choose how requests run in bb.",
    component: DiscordSettings,
  });
});
