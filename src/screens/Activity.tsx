// Activity — recent on-chain activity for the bound wallet address.
// Polls `lyth_getAddressActivity` once on mount; the user pulls to
// refresh (the chrome's existing scroll container does the heavy
// lifting). Pending txs that the indexer hasn't picked up yet do not
// appear here; a separate Pending screen handles those.

import { useEffect, useState } from "react";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import type { AddressActivityEntry } from "@monolythium/core-sdk";
import {
  activityAmountLyth,
  activityTitle,
  fetchAddressActivity,
} from "../sdk/activity";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. */
  selfAddress: string | null;
}

export function Activity({ selfAddress }: Props) {
  const [entries, setEntries] = useState<AddressActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<string | null>(null);

  const refresh = async (addr: string) => {
    setLoading(true);
    const bech32m = addressToTypedBech32("user", addr);
    const res = await fetchAddressActivity(bech32m);
    setEntries(res.entries);
    setError(res.error);
    setCoverage(res.coverage?.kind ?? null);
    setLoading(false);
  };

  useEffect(() => {
    if (selfAddress === null) return;
    void refresh(selfAddress);
  }, [selfAddress]);

  if (selfAddress === null) {
    return (
      <div className="mw-scroll">
        <div className="mw-card">
          <p style={{ margin: 0, color: "var(--fg-300)", fontSize: 13 }}>
            Resolving wallet identity…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Activity</h3>
          <div className="spacer" />
          <button
            type="button"
            className="mw-btn"
            onClick={() => void refresh(selfAddress)}
            disabled={loading}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="row-help" style={{ color: "var(--err)", marginTop: 8 }}>
            {error}
          </div>
        )}

        {!error && coverage === "indexer_disabled" && (
          <div className="row-help" style={{ color: "var(--warn)", marginTop: 8 }}>
            Activity indexer is offline on the connected node. Recent
            transactions you submit will still confirm on-chain.
          </div>
        )}
        {!error && coverage === "private" && (
          <div className="row-help" style={{ color: "var(--fg-400)", marginTop: 8 }}>
            This address is marked private. Activity is hidden from the
            indexer by design.
          </div>
        )}

        {!loading && entries.length === 0 && !error && (
          <div className="row-help" style={{ marginTop: 8 }}>
            No on-chain activity yet for this wallet.
          </div>
        )}

        {entries.map((entry, i) => (
          <ActivityRow key={`${entry.blockHeight}-${entry.txIndex}-${entry.logIndex}-${i}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ entry }: { entry: AddressActivityEntry }) {
  const title = activityTitle(entry);
  const amount = activityAmountLyth(entry);
  const directionalSign = (() => {
    const d = entry.direction?.toLowerCase();
    if (d === "in" || d === "incoming" || d === "receive") return "+";
    if (d === "out" || d === "outgoing" || d === "send") return "−";
    return "";
  })();

  return (
    <div className="mw-row" style={{ alignItems: "center" }}>
      <div className="mw-row__icon">
        {title === "Received" ? "↓" : title === "Sent" ? "↑" : "·"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mw-row__name">{title}</div>
        <div className="mw-row__sub">
          Block {entry.blockHeight.toString()} ·{" "}
          {entry.counterparty
            ? shortAddr(displayCounterparty(entry.counterparty))
            : entry.cluster !== null
              ? `cluster ${entry.cluster}`
              : "—"}
        </div>
      </div>
      <div className="mw-row__right">
        {amount !== null ? (
          <div
            className="primary"
            style={{ fontFamily: "var(--f-mono)", fontSize: 13 }}
          >
            {directionalSign}
            {amount} LYTH
          </div>
        ) : entry.weightBps !== null && entry.weightBps > 0 ? (
          <div className="usd" style={{ fontFamily: "var(--f-mono)", fontSize: 12 }}>
            {(entry.weightBps / 100).toFixed(2)}%
          </div>
        ) : null}
      </div>
    </div>
  );
}

function shortAddr(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

// Chain returns raw 0x… hex counterparties. Convert to the user-facing
// mono1… bech32m form before display; fall back to the original string
// if it isn't a recognisable hex address (e.g. cluster id, contract).
function displayCounterparty(s: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    try {
      return addressToTypedBech32("user", s);
    } catch {
      return s;
    }
  }
  return s;
}
