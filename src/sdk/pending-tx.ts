// Pure pending-tx model — the durable tracked-tx registry's types, key
// builder, the cap + a newest-first append helper, and tolerant parsers.
//
// A "pending tx" is a tx the wallet has broadcast (it has a canonical inner
// hash) but has NOT yet observed reaching a terminal receipt status. The
// reconcile poller (`reconcile.ts`) walks this registry, asks the chain for
// each tx's real terminal status, and on the explicit receipt status bit
// records a notification (`notifications-store.ts`) and removes the entry.
//
// Like `notifications.ts`, this module is intentionally inert: no
// `@tauri-apps/*`, no DOM, no IPC, no module-scope state — every helper here
// is deterministic and unit-testable in vitest without a Tauri runtime. The
// plugin-store round-trip lives in `pending-tx-store.ts`; the classify
// state-machine lives in `reconcile.ts`.
//
// Why a durable registry (vs the old per-drawer poll)
// ===================================================
// The earlier reconcile path armed a bounded receipt poll from the
// OperationsDrawer's executing→done effect. That poll died the moment the
// sheet was dismissed, so a tx that confirmed (or reverted) after the user
// closed the drawer never produced a notification. Persisting the tracked
// tx here — surviving sheet-dismiss AND app restart — lets one app-level
// poller carry it to its real terminal state. Mirrors the browser wallet's
// `mono.activity.pending.*` registry + headless poll-core, minus the MV3
// service-worker plumbing.
//
// Invariants this module helps uphold
// ====================================
// - Status fidelity is enforced downstream: an entry here is ONLY a "track
//   this hash" intent — it carries no status. `reconcile.ts` records a
//   notification exclusively on the explicit receipt status bit (1 ⇒
//   confirmed, 0 ⇒ failed), never optimistically from the fact that a tx
//   was broadcast.
// - Dedupe by canonical inner tx hash: `pendingTxKey` builds the same
//   `${chainIdHex}:${txHash}` key the notifications store uses, so a tx that
//   was already notified can never be re-enqueued and re-fire.
// - No secrets: an entry's fields are exactly txHash / chainIdHex / opKind /
//   amountDecimal / counterparty / submittedAtMs — amount + lowercase 0x
//   counterparty only, never a contact name.

import { isTxOpKind, type TxOpKind } from "./notifications";

/** Max tracked-tx entries retained. A wallet rarely has more than a couple
 *  of outstanding sends at once; this cap only guards against a pathological
 *  backlog (e.g. a long offline stretch). Oldest entries drop silently on
 *  append, exactly like the notification history cap. */
export const PENDING_TX_CAP = 32;

/** One tracked tx awaiting its terminal receipt. Carries the user's own
 *  broadcast-time intent (kind / amount / counterparty) so the eventual
 *  notification reads faithfully — plus the chain id + submit time the
 *  reconcile loop needs for the dedupe id and the per-tx give-up window. */
export interface PendingTx {
  /** Canonical inner-tx hash. 0x-prefixed, 32 bytes. */
  txHash: string;
  /** Chain id observed at broadcast time, `0x`-hex. Disambiguates the same
   *  txHash across chains and forms the first half of the dedupe key. */
  chainIdHex: string;
  /** Operation classification, mirrored verbatim into the notification's
   *  `kind` on the terminal transition. */
  opKind: TxOpKind;
  /** Canonical decimal LYTH string (e.g. "12.5"); "" / "0" suppresses the
   *  amount in the eventual row + detail. NEVER a BigInt — JSON only. */
  amountDecimal: string;
  /** Lowercase 0x counterparty (recipient, or precompile for a call).
   *  Converted to bech32m for display at the row layer; never a name. */
  counterparty: string;
  /** Epoch ms at broadcast. Drives the per-tx give-up window in
   *  `reconcile.ts` (a tx never seen terminal within the window is dropped
   *  silently — honest absence, no fabricated row). */
  submittedAtMs: number;
}

/** Registry blob persisted under the store's `pending` key. Newest-first,
 *  capped. */
export interface PendingTxEnvelope {
  schemaVersion: 0;
  entries: PendingTx[];
}

/** Stable per-entry key = the notifications store's dedupe key. Identical
 *  shape to {@link import("./notifications").notificationId} so an entry and
 *  the notification it eventually produces share one identity. */
export function pendingTxKey(chainIdHex: string, txHash: string): string {
  return `${chainIdHex}:${txHash}`;
}

/** Insert an entry newest-first and slice to the cap, de-duplicating on the
 *  `(chainIdHex, txHash)` key (a re-enqueue of a tracked tx is a no-op that
 *  preserves the original submit time). Pure. */
export function appendPendingCapped(
  entries: PendingTx[],
  entry: PendingTx,
  cap: number = PENDING_TX_CAP,
): PendingTx[] {
  const key = pendingTxKey(entry.chainIdHex, entry.txHash);
  if (entries.some((e) => pendingTxKey(e.chainIdHex, e.txHash) === key)) {
    return entries;
  }
  const next = [entry, ...entries];
  return next.length > cap ? next.slice(0, cap) : next;
}

/** Remove the entries whose keys appear in `keys`. Pure; returns a new array
 *  (identity-preserving when nothing matched). */
export function removePendingByKeys(
  entries: PendingTx[],
  keys: ReadonlySet<string>,
): PendingTx[] {
  if (keys.size === 0) return entries;
  const next = entries.filter(
    (e) => !keys.has(pendingTxKey(e.chainIdHex, e.txHash)),
  );
  return next.length === entries.length ? entries : next;
}

/** A real, canonical 32-byte tx hash worth tracking. Filters out the
 *  OperationsDrawer mock hash and the empty-string sentinel the batch path
 *  returns when nothing landed, so neither is ever enqueued. Shared with the
 *  drawer so the enqueue guard and the (former) record guard agree. */
export function isRecordableTxHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

function asPendingTx(raw: unknown): PendingTx | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.txHash !== "string" || !isRecordableTxHash(r.txHash)) return null;
  if (typeof r.chainIdHex !== "string" || r.chainIdHex.length === 0) return null;
  if (!isTxOpKind(r.opKind)) return null;
  if (typeof r.amountDecimal !== "string") return null;
  if (typeof r.counterparty !== "string") return null;
  if (typeof r.submittedAtMs !== "number" || !Number.isFinite(r.submittedAtMs)) {
    return null;
  }
  return {
    txHash: r.txHash,
    chainIdHex: r.chainIdHex,
    opKind: r.opKind,
    amountDecimal: r.amountDecimal,
    counterparty: r.counterparty,
    submittedAtMs: r.submittedAtMs,
  };
}

/** Tolerant parse of the registry envelope. Malformed → null (caller treats
 *  as empty + heals on next write): garbage in, defensive default out. */
export function parsePendingTxEnvelope(
  raw: unknown,
): PendingTxEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 0) return null;
  if (!Array.isArray(r.entries)) return null;
  const entries: PendingTx[] = [];
  for (const e of r.entries) {
    const entry = asPendingTx(e);
    if (entry !== null) entries.push(entry);
  }
  return { schemaVersion: 0, entries };
}
