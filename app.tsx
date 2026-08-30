import { useCallback, useEffect, useRef, useState } from "react";
import {
  UrlLink,
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { discordRpcContract, DiscordPairingStatus } from "./contract.js";
import { pairingPanelView, pairingSignalReason } from "./pairing-ui.js";
import "./app.css";

const REALTIME_CHANNEL = "pairing-state";
const SAFETY_REFRESH_MS = 60_000;

function DiscordSettingsPanel() {
  const rpc = useRpc<typeof discordRpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const [status, setStatus] = useState<DiscordPairingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "unpair" | null>(null);
  const [confirmingUnpair, setConfirmingUnpair] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const hasConnectedOnce = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("getPairingStatus");
      setStatus(next);
      setError(null);
      setNow(Date.now());
    } catch {
      setError("Pairing status is unavailable. Try refreshing this section.");
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const safetyRefresh = window.setInterval(() => void refresh(), SAFETY_REFRESH_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(safetyRefresh);
      window.clearInterval(clock);
    };
  }, [refresh]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (pairingSignalReason(payload)) void refresh();
  });

  useEffect(() => {
    if (realtimeState !== "connected") return;
    if (hasConnectedOnce.current) void refresh();
    hasConnectedOnce.current = true;
  }, [realtimeState, refresh]);

  const generateCode = async () => {
    setBusy("code");
    try {
      setStatus(await rpc.call("refreshPairingCode"));
      setError(null);
      setNow(Date.now());
    } catch {
      setError("A new pairing code could not be created. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const unpair = async () => {
    setBusy("unpair");
    try {
      const next = await rpc.call("unpair");
      setStatus(next);
      setError(null);
      setConfirmingUnpair(false);
      setNow(Date.now());
    } catch {
      setError("Discord could not be unpaired. Try again, or use `bb discord unpair`.");
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
      setError(null);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError("The command could not be copied. Select it and copy it manually.");
    }
  };

  if (!status) {
    return (
      <div className="discord-panel discord-panel--loading" aria-live="polite">
        {error ?? "Loading Discord status…"}
        {error ? <button onClick={() => void refresh()}>Try again</button> : null}
      </div>
    );
  }

  const view = pairingPanelView(status, now);

  return (
    <div className="discord-panel">
      <div className="discord-status-grid">
        <section className="discord-card" aria-label="Discord connection">
          <div className="discord-card__heading">
            <span className={`discord-dot discord-dot--${status.gateway.state}`} />
            <h3>Gateway</h3>
          </div>
          <strong>{view.connectionLabel}</strong>
          <p>{view.connectionDetail}</p>
        </section>

        <section className="discord-card" aria-label="Paired Discord server">
          <div className="discord-card__heading">
            <h3>Server pairing</h3>
            <span className="discord-badge">{status.paired ? "Paired" : "Not paired"}</span>
          </div>
          <dl className="discord-details">
            <div><dt>Server</dt><dd>{view.serverLabel}</dd></div>
            <div><dt>Channel</dt><dd>{view.channelLabel}</dd></div>
            <div><dt>User</dt><dd>{view.userLabel}</dd></div>
          </dl>
        </section>
      </div>

      {status.notice ? <p className="discord-notice">{status.notice}</p> : null}
      {status.legacySettingsRequireCleanup && !status.notice ? (
        <p className="discord-notice">
          This server is authorized by the advanced server and user fields above. Clear both fields to fully unpair it.
        </p>
      ) : null}
      {error ? <p className="discord-error" role="alert">{error}</p> : null}

      {!status.paired ? (
        <section className="discord-setup" aria-labelledby="discord-setup-title">
          <div>
            <p className="discord-eyebrow">Pair without a terminal</p>
            <h3 id="discord-setup-title">Connect this bot to your server</h3>
            <p>{view.setupStep}</p>
          </div>

          <ol className="discord-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Invite the bot</strong>
                {status.inviteUrl ? (
                  <UrlLink className="discord-link" href={status.inviteUrl}>Open Discord invite</UrlLink>
                ) : (
                  <p>Save a valid bot token above to create the invite.</p>
                )}
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Send the pairing command</strong>
                {status.pairingCode?.command ? (
                  <>
                    <div className="discord-code-row">
                      <code>{status.pairingCode.command}</code>
                      <button className="discord-button discord-button--secondary" onClick={() => void copyCommand()}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="discord-expiry">{view.expiryLabel}</p>
                  </>
                ) : (
                  <p>
                    {status.pairingCode
                      ? "The copyable command will appear when the Discord gateway identifies the bot."
                      : "A pairing code will appear after the token is saved."}
                  </p>
                )}
              </div>
            </li>
          </ol>

          <button
            className="discord-button discord-button--secondary"
            disabled={!status.tokenConfigured || busy !== null}
            onClick={() => void generateCode()}
          >
            {busy === "code" ? "Creating code…" : "Create a new code"}
          </button>
        </section>
      ) : (
        <section className="discord-danger" aria-label="Unpair Discord server">
          <div>
            <h3>Disconnect this server</h3>
            <p>Unpairing removes allowed users and every Discord-to-BB conversation link.</p>
          </div>
          {confirmingUnpair ? (
            <div className="discord-actions">
              <button className="discord-button discord-button--secondary" onClick={() => setConfirmingUnpair(false)} disabled={busy !== null}>Cancel</button>
              <button className="discord-button discord-button--danger" onClick={() => void unpair()} disabled={busy !== null}>
                {busy === "unpair" ? "Unpairing…" : "Yes, unpair"}
              </button>
            </div>
          ) : (
            <button className="discord-button discord-button--danger" onClick={() => setConfirmingUnpair(true)}>Unpair server</button>
          )}
        </section>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "pairing",
    title: "Discord connection",
    description: "Invite, pair, and manage your Discord bot without leaving BB.",
    component: DiscordSettingsPanel,
  });
});
