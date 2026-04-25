// Stage 4 — Active WalletConnect v2 sessions screen.
//
// Lives behind the More tab. Lists what's persisted in `wcStore` and lets
// the user disconnect any one session, or wipe them all. The on-disk
// store is the source of truth for the row list (cheap read on screen
// open); the `wc.disconnect` call below boots the SignClient to send the
// disconnect notice to the relay before removing the row.

import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import {
  clearAllSessions,
  listSessions,
  removeSession,
  type PersistedWcSession,
} from "../sdk/wcStore";
import { disconnect as wcDisconnect, isConfigured } from "../sdk/wc";

interface Props {
  /** Tap "Add session" affordance — opens the QR scanner. */
  onAddSession: () => void;
}

export function Sessions({ onAddSession }: Props) {
  const [sessions, setSessions] = useState<PersistedWcSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listSessions().then((list) => {
      if (!cancelled) setSessions(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = async () => {
    const list = await listSessions();
    setSessions(list);
  };

  const onDisconnect = async (topic: string) => {
    setBusy(topic);
    setError(null);
    try {
      // Best-effort relay notice — even if the relay throws (network down,
      // session already expired), we still wipe the local row.
      try {
        await wcDisconnect(topic);
      } catch (cause) {
        console.warn("wc disconnect relay failure", cause);
      }
      await removeSession(topic);
      await refresh();
    } catch (cause) {
      setError((cause as Error)?.message ?? "disconnect failed");
    } finally {
      setBusy(null);
    }
  };

  const onForgetAll = async () => {
    setBusy("__all__");
    setError(null);
    try {
      // Notify each session, but don't fail the wipe if any single relay
      // call throws.
      for (const s of sessions ?? []) {
        try {
          await wcDisconnect(s.topic);
        } catch (cause) {
          console.warn("wc disconnect relay failure", cause);
        }
      }
      await clearAllSessions();
      await refresh();
    } catch (cause) {
      setError((cause as Error)?.message ?? "wipe failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Connected apps</h3>
          <div className="spacer" />
          <span className="more">
            {sessions?.length ?? 0} session
            {(sessions?.length ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        {!isConfigured() && (
          <p style={{ margin: "0 0 12px 0", fontSize: 12, color: "var(--warn)" }}>
            WalletConnect not configured for this build (set
            <code style={{ marginLeft: 4 }}>VITE_WC_PROJECT_ID</code>).
            Existing sessions can still be disconnected, but new pairings
            will fail until the project ID is set.
          </p>
        )}
        {sessions === null && (
          <div className="mw-row">
            <div className="mw-row__icon">
              <span className="mw-spin" />
            </div>
            <div>
              <div className="mw-row__name">Loading…</div>
            </div>
          </div>
        )}
        {sessions && sessions.length === 0 && (
          <p style={{ margin: 0, fontSize: 13, color: "var(--fg-300)", lineHeight: 1.55 }}>
            No active WalletConnect sessions. Scan a QR code from a dapp or
            paste its <span className="mono">wc:</span> URI to pair.
          </p>
        )}
        {sessions?.map((s) => (
          <div key={s.topic} className="mw-row">
            <div className="mw-row__icon">
              {s.peerIcon ? (
                <img
                  src={s.peerIcon}
                  alt=""
                  width={26}
                  height={26}
                  style={{ borderRadius: 6 }}
                />
              ) : (
                s.peerName.slice(0, 2).toUpperCase()
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="mw-row__name">{s.peerName}</div>
              <div className="mw-row__sub">
                {short(s.peerUrl)} · {s.chains.join(", ") || "no chains"}
              </div>
            </div>
            <div className="mw-row__right">
              <button
                className="mw-btn"
                onClick={() => onDisconnect(s.topic)}
                disabled={busy === s.topic}
                style={{ minHeight: 32, padding: "6px 12px", fontSize: 12 }}
              >
                {busy === s.topic ? "…" : "Disconnect"}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Add session</h3>
        </div>
        <button
          className="mw-btn mw-btn--primary mw-btn--block"
          onClick={onAddSession}
        >
          <Icon name="qr" size={16} />
          Scan QR code
        </button>
        {sessions && sessions.length > 0 && (
          <button
            className="mw-btn mw-btn--block"
            onClick={onForgetAll}
            disabled={busy === "__all__"}
            style={{ marginTop: 8 }}
          >
            {busy === "__all__" ? "Disconnecting…" : "Disconnect all"}
          </button>
        )}
      </div>

      {error && (
        <div className="mw-toast" style={{ position: "static", margin: "8px auto" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function short(s: string): string {
  try {
    const u = new URL(s);
    return u.host || s;
  } catch {
    return s;
  }
}
