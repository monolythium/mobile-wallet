// Pure notification model — types, key builders, the history cap + a
// newest-first append helper, friendly title strings, and tolerant parsers.
//
// Ported nearly verbatim from the browser wallet's `shared/notifications.ts`
// so a notification recorded on one Monolythium wallet surface reads
// identically on another. No `@tauri-apps/*`, no DOM, no IPC, no
// module-scope state — every helper here is deterministic and unit-testable
// in vitest without a Tauri runtime. (`addressToTypedBech32` from the core
// SDK is pure bech32m encoding — no DOM/IPC — so the body builder stays
// unit-testable.)
//
// The plugin-store round-trip lives in `notifications-store.ts`; the single
// recording chokepoint (terminal pending→confirmed/failed transition) lives
// in the OperationsDrawer's executing→done path.
//
// Invariants this module helps uphold
// ====================================
// - Status fidelity: `NotificationRecord.status` is the literal
//   "confirmed" | "failed", mirroring the explicit receipt status bit —
//   never optimism from a pending/broadcast-accepted tx.
// - Dedupe by canonical inner tx hash: `notificationId` builds the stable
//   per-record key `${chainIdHex}:${txHash}` used both as the record's `id`
//   and the dedupe-set membership key.
// - No secrets in the body: the record's fields are exactly txHash / status
//   / blockNumber / kind / amountDecimal / counterparty / createdAtMs / read
//   / schemaVersion — amount + short bech32m only, never a contact name.

import { addressToTypedBech32 } from "@monolythium/core-sdk";

/** Max notification records retained — newest-first, capped via
 *  `appendCapped`. 50 covers months of normal use; older records are
 *  dropped silently on append. */
export const NOTIFICATION_HISTORY_CAP = 50;

/** Operation classification attached to a record at recording time. The
 *  notifications center renders it via {@link notificationTitle} to a
 *  friendly title. `contract_call` is the explicit fallback for untagged
 *  paths (legacy records on disk + any caller that omits a kind). */
export type TxOpKind =
  | "send"
  | "delegate"
  | "undelegate"
  | "redelegate"
  | "claim"
  | "emergency-key"
  | "agent-policy"
  | "contract_call";

/** Runtime guard for `TxOpKind`. Coerces unknown / malformed literals to a
 *  safe fallback rather than propagating garbage into a record. */
export function isTxOpKind(v: unknown): v is TxOpKind {
  return (
    v === "send" ||
    v === "delegate" ||
    v === "undelegate" ||
    v === "redelegate" ||
    v === "claim" ||
    v === "emergency-key" ||
    v === "agent-policy" ||
    v === "contract_call"
  );
}

/** One persisted notification — the row the notifications center renders,
 *  and the row the detail sheet derives its fields from. */
export interface NotificationRecord {
  /** `${chainIdHex}:${txHash}` — also the dedupe-set membership key. */
  id: string;
  /** Canonical inner-tx hash. 0x-prefixed. */
  txHash: string;
  /** Real on-chain receipt status — explicit `1` ⇒ "confirmed", explicit
   *  `0` ⇒ "failed". Anything else upstream is treated as "kept" and never
   *  reaches this record (so this string is always one of these two
   *  literals — never silently coerced). */
  status: "confirmed" | "failed";
  /** Block number from the receipt. `null` when the receipt didn't carry a
   *  parseable value (e.g. a `lyth_txStatus="found"` fast-path). */
  blockNumber: number | null;
  /** Operation classification used to render the friendly title via
   *  {@link notificationTitle}. */
  kind: TxOpKind;
  /** Canonical decimal LYTH string (e.g. "12.5"). NEVER a BigInt; the
   *  store serializes JSON only. */
  amountDecimal: string;
  /** Lowercase 0x counterparty — what the user intended to send to, or the
   *  precompile address for contract calls. Converted to bech32m for
   *  display at the row/detail layer (never persisted as a contact name). */
  counterparty: string;
  /** Epoch ms at the moment the terminal transition was observed. */
  createdAtMs: number;
  /** Read state. `false` on insert; `markAllRead` flips it. */
  read: boolean;
  /** Bump on shape change. */
  schemaVersion: 0;
}

/** History blob persisted under the store's `history` key. Newest-first,
 *  capped. */
export interface NotificationsHistoryEnvelope {
  schemaVersion: 0;
  entries: NotificationRecord[];
}

/** Dedupe set persisted under the store's `notified` key. Stored as an
 *  array (not a `Set` — the store is JSON only) of `notificationId`
 *  strings. Kept separate from the history blob so a hypothetical "clear
 *  history" wouldn't lose dedupe state and re-fire for txs already seen. */
export interface NotifiedSetEnvelope {
  schemaVersion: 0;
  ids: string[];
}

/** Stable per-record id = dedupe-set membership key. `chainIdHex`
 *  disambiguates the same txHash across chains. */
export function notificationId(chainIdHex: string, txHash: string): string {
  return `${chainIdHex}:${txHash}`;
}

/** Insert a record newest-first and slice to the cap. Pure. */
export function appendCapped(
  entries: NotificationRecord[],
  record: NotificationRecord,
  cap: number = NOTIFICATION_HISTORY_CAP,
): NotificationRecord[] {
  const next = [record, ...entries];
  return next.length > cap ? next.slice(0, cap) : next;
}

function asNotificationStatus(v: unknown): "confirmed" | "failed" | undefined {
  return v === "confirmed" || v === "failed" ? v : undefined;
}

function asNotificationKind(v: unknown): TxOpKind | undefined {
  return isTxOpKind(v) ? v : undefined;
}

/** Friendly title strings for each operation kind × status. The
 *  notifications center row and the detail sheet both call
 *  {@link notificationTitle} so the wording stays centralized here. */
export const NOTIFICATION_LABELS: Record<
  TxOpKind,
  { confirmed: string; failed: string }
> = {
  send: { confirmed: "Sent", failed: "Send failed" },
  delegate: { confirmed: "Staked", failed: "Stake failed" },
  undelegate: { confirmed: "Unstaked", failed: "Unstake failed" },
  redelegate: { confirmed: "Restaked", failed: "Restake failed" },
  claim: { confirmed: "Rewards claimed", failed: "Claim failed" },
  "emergency-key": {
    confirmed: "Backup key registered",
    failed: "Backup registration failed",
  },
  "agent-policy": {
    confirmed: "Agent policy updated",
    failed: "Agent policy failed",
  },
  contract_call: {
    confirmed: "Transaction confirmed",
    failed: "Transaction failed",
  },
};

/** Render the friendly title for a notification. */
export function notificationTitle(
  kind: TxOpKind,
  status: "confirmed" | "failed",
): string {
  return NOTIFICATION_LABELS[kind][status];
}

/** Records store a raw 0x… hex counterparty. Convert to the user-facing
 *  mono1… bech32m form for display; fall back to the original string if it
 *  isn't a recognisable hex address (e.g. a precompile). Pure — same logic the
 *  notifications-center row uses. */
export function displayCounterparty(s: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    try {
      return addressToTypedBech32("user", s);
    } catch {
      return s;
    }
  }
  return s;
}

/** Middle-truncate a long string (e.g. a bech32m address) for compact
 *  display: `mono1abc…uvwxyz`. Pure; shared by the row and the OS toast. */
export function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Friendly notification body — the SAME secondary line the notifications
 *  center row renders: `"<amount> LYTH · <short bech32m>"`, or just the short
 *  bech32m when the amount is zero/empty. Carries NO secrets (amount + short
 *  address only — never a contact name). Pure, so the in-app row, the OS
 *  toast, and unit tests all derive an identical string. */
export function notificationBody(
  amountDecimal: string,
  counterparty: string,
): string {
  const short = truncMiddle(displayCounterparty(counterparty));
  return isZeroAmount(amountDecimal) ? short : `${amountDecimal} LYTH · ${short}`;
}

/** True for amount strings that mean "zero LYTH". The row/detail omit the
 *  amount in this case so a 0-LYTH claim / agent-policy reads cleanly. */
export function isZeroAmount(amountDecimal: string): boolean {
  if (amountDecimal.length === 0) return true;
  return /^0(\.0+)?$/.test(amountDecimal);
}

function asNotificationRecord(raw: unknown): NotificationRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = asNotificationStatus(r.status);
  const kind = asNotificationKind(r.kind);
  if (status === undefined || kind === undefined) return null;
  if (typeof r.id !== "string") return null;
  if (typeof r.txHash !== "string") return null;
  if (typeof r.amountDecimal !== "string") return null;
  if (typeof r.counterparty !== "string") return null;
  if (typeof r.createdAtMs !== "number" || !Number.isFinite(r.createdAtMs)) {
    return null;
  }
  if (typeof r.read !== "boolean") return null;
  const blockNumber =
    r.blockNumber === null
      ? null
      : typeof r.blockNumber === "number" && Number.isFinite(r.blockNumber)
        ? r.blockNumber
        : undefined;
  if (blockNumber === undefined) return null;
  return {
    id: r.id,
    txHash: r.txHash,
    status,
    blockNumber,
    kind,
    amountDecimal: r.amountDecimal,
    counterparty: r.counterparty,
    createdAtMs: r.createdAtMs,
    read: r.read,
    schemaVersion: 0,
  };
}

/** Tolerant parse of the history envelope. Malformed → null (caller treats
 *  as empty + heals on next write): garbage in, defensive default out. */
export function parseHistoryEnvelope(
  raw: unknown,
): NotificationsHistoryEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 0) return null;
  if (!Array.isArray(r.entries)) return null;
  const entries: NotificationRecord[] = [];
  for (const e of r.entries) {
    const rec = asNotificationRecord(e);
    if (rec !== null) entries.push(rec);
  }
  return { schemaVersion: 0, entries };
}

/** Tolerant parse of the dedupe-set envelope. */
export function parseNotifiedSetEnvelope(
  raw: unknown,
): NotifiedSetEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 0) return null;
  if (!Array.isArray(r.ids)) return null;
  const ids = r.ids.filter((x): x is string => typeof x === "string");
  return { schemaVersion: 0, ids };
}
