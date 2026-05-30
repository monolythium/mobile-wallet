// Activity-detail sheet — a bottom-up sheet opened by tapping a row in the
// Activity list when the experimental-v5 surface is enabled. It mirrors the
// browser wallet's ActivityDetail modal content (kind, amount, counterparty,
// status, relative time, truncated tx hash + a "View on Monoscan" action),
// but uses the mobile sheet pattern (mw-sheet + scrim) rather than a centred
// desktop modal, and the mw-kv / mw-card design language.
//
// Honest-absence, same discipline as the browser modal:
//  - The mobile activity entry (`AddressActivityEntry`) carries no canonical
//    tx hash and the mobile SDK seam exposes no on-demand block-tx lookup, so
//    the tx-hash row and the "View on Monoscan" tx button are simply omitted
//    rather than fabricated. The counterparty IS known and bech32m-renderable,
//    so it links to its Monoscan address page (same builder the browser uses).
//  - Amounts / weight / cluster only render when the entry actually carries
//    them.

import { useState } from "react";
import type { ReactNode } from "react";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import type { AddressActivityEntry } from "@monolythium/core-sdk";
import { Icon } from "./Icon";
import { activityAmountLyth, activityTitle } from "../sdk/activity";
import { monoscanAddressUrl } from "../sdk/monoscan";

/** Middle-truncate any string (bech32m address or hash) for compact
 *  display. Pure — never throws. Ported from the browser wallet's
 *  `_detailModalParts.truncMiddle`. */
export function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Relative timestamp ("Ns / Nm / Nh ago"). Bounded — beyond a few hours the
 *  absolute date is more informative. Ported from the browser wallet's
 *  `_detailModalParts.relativeMs`. */
export function relativeMs(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

interface Props {
  entry: AddressActivityEntry | null;
  onClose: () => void;
}

export function ActivityDetailSheet({ entry, onClose }: Props) {
  if (!entry) return null;
  const title = activityTitle(entry);
  return (
    <>
      <div className="mw-sheet-scrim" onClick={onClose} />
      <div className="mw-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mw-sheet__head">
          <button className="mw-iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
          <div className="mw-sheet__title">{title}</div>
          <div style={{ width: 36 }} />
        </div>

        <div className="mw-sheet__body">
          <DetailBody entry={entry} />
        </div>

        <div className="mw-sheet__footer">
          <button className="mw-btn mw-btn--primary mw-btn--block" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

function DetailBody({ entry }: { entry: AddressActivityEntry }) {
  const amount = activityAmountLyth(entry);
  const sign = directionalSign(entry.direction);
  const counterparty = entry.counterparty
    ? displayCounterparty(entry.counterparty)
    : null;
  const counterpartyLabel = counterpartyLabelFor(entry.direction);
  const weightPct =
    entry.weightBps !== null && entry.weightBps > 0
      ? `${(entry.weightBps / 100).toFixed(2)}%`
      : null;

  return (
    <div className="mw-card">
      <KV k="Status" v="Confirmed" />
      {amount !== null && <KV k="Amount" v={`${sign}${amount} LYTH`} mono />}
      {counterparty !== null && (
        <KVNode k={counterpartyLabel}>
          <CopyableAddress addr={counterparty} />
        </KVNode>
      )}
      {entry.cluster !== null && <KV k="Cluster" v={`cluster ${entry.cluster}`} mono />}
      {weightPct !== null && <KV k="Weight" v={weightPct} mono />}
      <KV k="Block" v={entry.blockHeight.toString()} mono />
      <KV k="Tx index" v={entry.txIndex.toString()} mono />
    </div>
  );
}

/** Plain label/value KV row (reuses the operations-drawer mw-kv styling). */
function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="mw-kv">
      <div className="k">{k}</div>
      <div className={`v${mono ? " mono" : ""}`}>{v}</div>
    </div>
  );
}

/** KV row whose value is a node (e.g. the copyable address + Monoscan link). */
function KVNode({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="mw-kv">
      <div className="k">{k}</div>
      <div className="v mono">{children}</div>
    </div>
  );
}

/** Truncated bech32m address → Monoscan address page, with a copy button.
 *  Mirrors the browser wallet's `CopyableAddress`: the address links to its
 *  Monoscan wallet page and the glyph copies the full string. */
function CopyableAddress({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard.writeText(addr).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        justifyContent: "flex-end",
      }}
    >
      <a
        href={monoscanAddressUrl(addr)}
        target="_blank"
        rel="noopener noreferrer"
        title={addr}
        style={{ color: "var(--gold)", textDecoration: "none" }}
      >
        {truncMiddle(addr)}
      </a>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy address"
        className="mw-iconbtn"
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          color: copied ? "var(--ok)" : "var(--fg-400)",
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
    </span>
  );
}

function directionalSign(direction: string | null): string {
  const d = direction?.toLowerCase();
  if (d === "in" || d === "incoming" || d === "receive") return "+";
  if (d === "out" || d === "outgoing" || d === "send") return "−";
  return "";
}

function counterpartyLabelFor(direction: string | null): string {
  const d = direction?.toLowerCase();
  if (d === "in" || d === "incoming" || d === "receive") return "From";
  if (d === "out" || d === "outgoing" || d === "send") return "To";
  return "Counterparty";
}

// Chain returns raw 0x… hex counterparties. Convert to the user-facing mono1…
// bech32m form before display; fall back to the original string if it isn't a
// recognisable hex address (e.g. cluster id, contract). Same logic the list
// row uses in Activity.tsx.
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
