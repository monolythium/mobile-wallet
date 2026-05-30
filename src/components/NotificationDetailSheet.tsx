// Notification-detail sheet — a bottom-up sheet opened by tapping a row in
// the notifications center. Mirrors the browser wallet's NotificationDetail
// modal content (status, amount, counterparty, block, date + a "View on
// Monoscan" tx link) using the mobile sheet pattern (mw-sheet + scrim) and
// the mw-kv / mw-card design language.
//
// Unlike the Activity sheet, a NotificationRecord DOES carry a canonical tx
// hash (the wallet's own submitted tx), so the Monoscan TX link is shown —
// it lands on the same page the extension's link would.
//
// Honest-absence, same discipline as the browser modal: rows for fields with
// nothing to show (amount on a 0-LYTH delegate/claim; block on a receipt
// that didn't surface one) are omitted — no "—" / "N/A" placeholders.

import { useState } from "react";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import { Icon } from "./Icon";
import { truncMiddle, relativeMs } from "./ActivityDetailSheet";
import { monoscanAddressUrl, monoscanTxUrl } from "../sdk/monoscan";
import {
  isZeroAmount,
  notificationTitle,
  type NotificationRecord,
} from "../sdk/notifications";

interface Props {
  record: NotificationRecord | null;
  onClose: () => void;
}

function statusLabel(status: "confirmed" | "failed"): string {
  return status === "confirmed" ? "Confirmed" : "Failed";
}

export function NotificationDetailSheet({ record, onClose }: Props) {
  if (!record) return null;
  const title = notificationTitle(record.kind, record.status);
  const showAmount = !isZeroAmount(record.amountDecimal);
  const showBlock = record.blockNumber !== null;
  const counterparty = displayCounterparty(record.counterparty);

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
          <div className="mw-card">
            <KV
              k="Status"
              v={statusLabel(record.status)}
              tone={record.status === "failed" ? "err" : "ok"}
            />
            {showAmount && (
              <KV k="Amount" v={`${record.amountDecimal} LYTH`} mono />
            )}
            <KVNode k="To">
              <CopyableAddress addr={counterparty} />
            </KVNode>
            {showBlock && (
              <KV
                k="Block"
                v={`#${record.blockNumber!.toLocaleString("en-US")}`}
                mono
              />
            )}
            <KV k="Date" v={relativeMs(record.createdAtMs)} />
          </div>

          <a
            href={monoscanTxUrl(record.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mw-btn mw-btn--block"
            style={{ marginTop: 14, textDecoration: "none" }}
          >
            <Icon name="search" size={14} />
            View on Monoscan
          </a>
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

/** Plain label/value KV row (reuses the operations-drawer mw-kv styling). A
 *  status tone tints the value green/red so the row is scannable. */
function KV({
  k,
  v,
  mono = false,
  tone,
}: {
  k: string;
  v: string;
  mono?: boolean;
  tone?: "ok" | "err";
}) {
  const color =
    tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err)" : undefined;
  return (
    <div className="mw-kv">
      <div className="k">{k}</div>
      <div className={`v${mono ? " mono" : ""}`} style={color ? { color } : undefined}>
        {v}
      </div>
    </div>
  );
}

/** KV row whose value is a node (the copyable address + Monoscan link). */
function KVNode({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="mw-kv">
      <div className="k">{k}</div>
      <div className="v mono">{children}</div>
    </div>
  );
}

/** Truncated bech32m address → Monoscan address page, with a copy button.
 *  Mirrors `ActivityDetailSheet`'s `CopyableAddress`. */
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

// Records store a raw 0x… hex counterparty. Convert to the user-facing
// mono1… bech32m form before display; fall back to the original string if it
// isn't a recognisable hex address (e.g. a precompile rendered as-is). Same
// logic the Activity sheet uses.
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
