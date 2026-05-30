// Durable tracked-tx reconcile — the state machine that carries a broadcast
// tx to its REAL terminal state (confirmed OR failed) and records a faithful
// notification on the explicit receipt status bit.
//
// This replaces the old per-drawer poll (`recordTerminalNotification`), which
// died when the OperationsDrawer sheet was dismissed. The pieces are:
//
//   - the durable registry  (`pending-tx-store.ts`)  — survives sheet-dismiss
//                                                       + app restart
//   - this classifier        (classifyPending, pure) — the unit-tested heart
//   - this one-tick driver    (reconcilePendingOnce)  — probe → record →
//                                                       remove
//   - the app-level poller   (`use-reconcile-poller`) — one interval, gated
//
// It is the mobile analogue of the browser wallet's headless poll-core
// (`dropConfirmedPendingByHash` → `recordNotification`, with a TTL backstop),
// scoped to the txs THIS wallet broadcast.
//
// Status fidelity + honest absence
// ================================
// `classifyPending` only ever resolves an entry as terminal when the probe
// returns an explicit confirmed/failed verdict (the receipt status bit). A
// pending probe leaves the entry `kept`; an entry older than the give-up
// window is `expired` and dropped WITHOUT a notification (we never observed a
// terminal state, so we synthesize nothing). It never coerces failed→confirmed
// or invents a verdict for a tx the chain hasn't resolved.

import { recordNotification } from "./notifications-store";
import { pendingTxKey, type PendingTx } from "./pending-tx";
import {
  listPendingTxs,
  removePendingTxs,
} from "./pending-tx-store";
import { probeTxTerminal, type TerminalStatus } from "./tx-terminal";

/** Per-tx give-up window. Anchors settle in ~1s, so a tracked tx normally
 *  resolves within a couple of poll ticks; past this window we stop tracking
 *  it silently. The next time the user opens Activity the tx is already in
 *  the on-chain feed — we do not synthesize a terminal row we never saw. */
export const PENDING_TX_TTL_MS = 5 * 60 * 1000;

/** A tracked tx the chain resolved this tick, with its explicit verdict. */
export interface TerminalPendingTx {
  entry: PendingTx;
  status: "confirmed" | "failed";
  blockNumber: number | null;
}

/** Outcome of one classification pass over the registry. */
export interface ClassifyResult {
  /** Entries the chain explicitly resolved (record + remove). */
  terminal: TerminalPendingTx[];
  /** Entries past the give-up window (remove, NO notification). */
  expired: PendingTx[];
  /** Entries still pending (keep tracking). */
  kept: PendingTx[];
}

/** Probe seam: maps a tx hash to its terminal status (or null = pending).
 *  Production passes {@link probeTxTerminal}; tests pass a stub. */
export type TerminalProbe = (txHash: string) => Promise<TerminalStatus | null>;

/** Deterministic pending → {terminal, expired, kept} classification.
 *
 *  PURE w.r.t. its inputs apart from the injected async probe: it takes the
 *  registry snapshot, a probe, and a clock reading, and returns the three
 *  disjoint buckets. The caller (the one-tick driver) is responsible for the
 *  side effects (record / remove). This split is what makes the state machine
 *  unit-testable without a store or an RPC client.
 *
 *  TTL is checked FIRST so an expired entry is never probed or notified — it
 *  is dropped on honest absence. For a live entry, the probe's explicit
 *  verdict (confirmed/failed) moves it to `terminal`; a null (pending / RPC
 *  hiccup) keeps it. Bounded: the registry is tiny (a handful of outstanding
 *  txs at most). */
export async function classifyPending(
  pending: readonly PendingTx[],
  probe: TerminalProbe,
  nowMs: number,
  ttlMs: number = PENDING_TX_TTL_MS,
): Promise<ClassifyResult> {
  const terminal: TerminalPendingTx[] = [];
  const expired: PendingTx[] = [];
  const kept: PendingTx[] = [];
  for (const entry of pending) {
    if (nowMs - entry.submittedAtMs >= ttlMs) {
      expired.push(entry);
      continue;
    }
    const verdict = await probe(entry.txHash);
    if (verdict) {
      terminal.push({
        entry,
        status: verdict.status,
        blockNumber: verdict.blockNumber,
      });
    } else {
      kept.push(entry);
    }
  }
  return { terminal, expired, kept };
}

/** Outcome of one reconcile tick (driver). */
export interface ReconcileTickResult {
  /** Notifications actually recorded this tick (a dedupe miss in the
   *  notifications store counts as 0 even though the entry was terminal). */
  recorded: number;
  /** Entries removed (terminal + expired). */
  removed: number;
  /** Entries still pending after this tick. The poller stops once this hits
   *  0 (no work left) and idles. */
  remaining: number;
}

/** Run ONE reconcile pass: read the registry, classify it against the chain,
 *  record a notification for each explicitly-terminal tx (status verbatim
 *  from the receipt bit), and remove every terminal + expired entry from the
 *  durable store.
 *
 *  Best-effort end-to-end: every store/RPC error is swallowed inside the
 *  pieces it calls, and this function never throws — a reconcile failure is
 *  silent UX degradation only, never a thrown error into the React tree.
 *
 *  Returns counts so the poller can drive its back-off + self-stop. */
export async function reconcilePendingOnce(
  probe: TerminalProbe = probeTxTerminal,
  nowMs: number = Date.now(),
): Promise<ReconcileTickResult> {
  let recorded = 0;
  try {
    const pending = await listPendingTxs();
    if (pending.length === 0) {
      return { recorded: 0, removed: 0, remaining: 0 };
    }
    const { terminal, expired, kept } = await classifyPending(
      pending,
      probe,
      nowMs,
    );

    const removeKeys = new Set<string>();
    for (const t of terminal) {
      // Status fidelity: taken verbatim from the receipt bit. recordNotification
      // is itself idempotent on (chainIdHex, txHash) and best-effort, so a
      // re-enqueued/already-notified tx records nothing and is simply removed.
      const { added } = await recordNotification({
        chainIdHex: t.entry.chainIdHex,
        txHash: t.entry.txHash,
        status: t.status,
        blockNumber: t.blockNumber,
        kind: t.entry.opKind,
        amountDecimal: t.entry.amountDecimal,
        counterparty: t.entry.counterparty,
      });
      if (added) recorded++;
      removeKeys.add(pendingTxKey(t.entry.chainIdHex, t.entry.txHash));
    }
    // Expired entries are dropped silently — no notification (honest absence).
    for (const e of expired) {
      removeKeys.add(pendingTxKey(e.chainIdHex, e.txHash));
    }

    const { removed } = await removePendingTxs(removeKeys);
    return { recorded, removed, remaining: kept.length };
  } catch {
    // Never let a reconcile tick throw into the poller / React tree.
    return { recorded, removed: 0, remaining: 0 };
  }
}
