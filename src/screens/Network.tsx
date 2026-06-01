// Network — RPC peer switcher.
//
// Lists the candidate peers (shipped gateway + the official chain-registry
// endpoints), probes each for reachability + latency + correct chain id, and
// lets the user switch the active endpoint manually or jump to the fastest
// healthy peer. Every state is rendered honestly: a peer that times out reads
// "unreachable", a peer on the wrong chain reads "wrong chain" and can never
// be selected, and latency badges only show a number that was actually
// measured.

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import {
  currentEndpoint,
  setEndpoint,
  subscribeEndpoint,
} from "../sdk/client";
import {
  latencyBand,
  listPeers,
  pickFastest,
  probePeer,
  type Peer,
  type ProbeResult,
} from "../sdk/peers";

/** Per-peer probe status for the UI. */
type ProbeStatus =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "done"; result: ProbeResult };

export function Network() {
  const peers = listPeers();
  const [active, setActive] = useState<string>(() => currentEndpoint());
  const [statuses, setStatuses] = useState<Record<string, ProbeStatus>>({});
  const [probing, setProbing] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Reflect endpoint changes made elsewhere (or by this screen).
  useEffect(() => subscribeEndpoint((ep) => setActive(ep)), []);

  const probeAll = useCallback(async () => {
    setProbing(true);
    setPickError(null);
    setStatuses(() =>
      Object.fromEntries(peers.map((p) => [p.url, { kind: "probing" } as const])),
    );
    const results = await Promise.all(
      peers.map(async (p) => {
        const result = await probePeer(p.url);
        setStatuses((prev) => ({
          ...prev,
          [p.url]: { kind: "done", result },
        }));
        return result;
      }),
    );
    setProbing(false);
    return results;
  }, [peers]);

  // Probe once on mount.
  useEffect(() => {
    void probeAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = useCallback(async (url: string) => {
    setSwitching(url);
    try {
      await setEndpoint(url);
    } finally {
      setSwitching(null);
    }
  }, []);

  const switchToFastest = useCallback(async () => {
    setPickError(null);
    // Use the freshest probe round so the pick reflects current latency.
    const results = await probeAll();
    const best = pickFastest(results);
    if (best === null) {
      setPickError(
        "No reachable peer on chain 69420 right now. Try again, or pick one manually.",
      );
      return;
    }
    await switchTo(best.url);
  }, [probeAll, switchTo]);

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Peers</h3>
          <div className="spacer" />
          <button
            type="button"
            className="mw-btn"
            onClick={() => void probeAll()}
            disabled={probing}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {probing ? "Probing…" : "Re-probe"}
          </button>
        </div>

        {peers.map((peer) => (
          <PeerRow
            key={peer.url}
            peer={peer}
            status={statuses[peer.url] ?? { kind: "idle" }}
            isActive={peer.url === active}
            isSwitching={switching === peer.url}
            onSwitch={() => void switchTo(peer.url)}
          />
        ))}
      </div>

      {pickError && (
        <div className="mw-card">
          <div className="row-help" style={{ color: "var(--warn)" }}>
            {pickError}
          </div>
        </div>
      )}

      <button
        type="button"
        className="mw-btn mw-btn--primary mw-btn--block"
        onClick={() => void switchToFastest()}
        disabled={probing || switching !== null}
        style={{ marginTop: 4 }}
      >
        <Icon name="activity" size={16} />
        Switch to fastest
      </button>

      <p
        style={{
          fontSize: 11.5,
          color: "var(--fg-400)",
          textAlign: "center",
          padding: "0 8px",
          lineHeight: 1.55,
          marginTop: 12,
        }}
      >
        Only peers on chain 69420 can be selected. A peer that answers on a
        different chain is shown but kept unselectable.
      </p>
    </div>
  );
}

function PeerRow({
  peer,
  status,
  isActive,
  isSwitching,
  onSwitch,
}: {
  peer: Peer;
  status: ProbeStatus;
  isActive: boolean;
  isSwitching: boolean;
  onSwitch: () => void;
}) {
  const result = status.kind === "done" ? status.result : null;
  // A peer is selectable only when it is reachable AND on the right chain.
  const selectable =
    result !== null && result.reachable && result.chainIdOk && !isActive;

  return (
    <div className="mw-row" style={{ alignItems: "center" }}>
      <div className="mw-row__icon">
        <Icon name="shield" size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mw-row__name">
          {peer.label}
          {isActive && (
            <span className="ticker" style={{ color: "var(--ok)" }}>
              current
            </span>
          )}
        </div>
        <div className="mw-row__sub mono" style={{ wordBreak: "break-all" }}>
          {peer.region ? `${peer.region} · ` : ""}
          {peer.url}
        </div>
      </div>
      <div className="mw-row__right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PeerBadge status={status} />
        {isActive ? (
          <span aria-label="Active peer" style={{ color: "var(--ok)" }}>
            <Icon name="check" size={16} />
          </span>
        ) : selectable ? (
          <button
            type="button"
            className="mw-btn"
            onClick={onSwitch}
            disabled={isSwitching}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {isSwitching ? "…" : "Switch"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Latency / reachability badge — never invents a number. */
function PeerBadge({ status }: { status: ProbeStatus }) {
  if (status.kind === "idle") {
    return <span className="mw-halo warn">queued</span>;
  }
  if (status.kind === "probing") {
    return <span className="mw-halo warn live">probing</span>;
  }
  const r = status.result;
  if (!r.reachable) {
    return <span className="mw-halo err">{r.reason ?? "unreachable"}</span>;
  }
  if (!r.chainIdOk) {
    return <span className="mw-halo err">wrong chain</span>;
  }
  // Reachable + correct chain: show the measured latency with its band.
  // The halo's default dot is green (ok); warn = amber, slow = red (err).
  const ms = r.latencyMs ?? 0;
  const band = latencyBand(ms);
  const haloClass = band === "ok" ? "" : band === "warn" ? "warn" : "err";
  return <span className={`mw-halo ${haloClass}`.trim()}>{ms} ms</span>;
}
