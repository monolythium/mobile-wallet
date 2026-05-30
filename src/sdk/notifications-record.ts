// Recording chokepoint — turn a just-submitted tx hash into a persisted
// NotificationRecord on its REAL terminal transition, and never before.
//
// Why a receipt poll (status fidelity)
// ====================================
// The mobile send / staking SDK returns the cluster-ack tx hash without
// awaiting a receipt — that hash means "broadcast accepted", NOT "confirmed
// on-chain". Recording a "confirmed" notification off that ack would be
// optimism, which the model forbids. So this helper polls the node for the
// authoritative receipt and records:
//   - "confirmed"  iff the receipt's explicit status bit is 1
//   - "failed"     iff the receipt's explicit status bit is 0
// and records NOTHING while the tx is still pending or if the poll never
// resolves a receipt (honest absence — no optimistic row, no fabricated
// "failed"). The wallet shows the optimistic result in the OperationsDrawer
// "done" pane as it always has; the notification only lands once the chain
// has actually spoken.
//
// This is the mobile analogue of the browser wallet's SW reconcile loop
// (`dropConfirmedPendingByHash` → `recordNotification`), scoped to the one
// tx the user just authorized. It runs as a detached best-effort task: it
// is fire-and-forget from the drawer, swallows every error, and can never
// throw back into the operation flow.

import { getProvider } from "./client";
import { recordNotification } from "./notifications-store";
import type { TxOpKind } from "./notifications";

/** Structured notification metadata a screen attaches to its
 *  `OperationRequest` so the recording hook can build a faithful record
 *  from the user's own intent (kind / amount / counterparty) plus the
 *  chain's explicit receipt status. Amount + 0x counterparty only — never a
 *  contact name. */
export interface NotifyDescriptor {
  kind: TxOpKind;
  /** Decimal LYTH string (e.g. "12.5"); "" / "0" suppresses the amount in
   *  the row + detail. */
  amountDecimal: string;
  /** Lowercase 0x counterparty (recipient, or precompile for a call). */
  counterparty: string;
}

/** Poll cadence: anchors settle in ~1s, so check shortly after submit and
 *  keep checking for a bounded window. Past the window we give up silently
 *  — the next time the user opens the wallet the tx is already in the
 *  Activity feed; we do not synthesize a terminal row we never observed. */
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

/** Normalize a `bigint | number | null | undefined` block number to a finite
 *  number or null. */
function blockToNumber(v: bigint | number | null | undefined): number | null {
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** One probe of the chain for a tx's terminal status. Returns the explicit
 *  terminal outcome, or `null` while still pending / unknown. Best-effort:
 *  any RPC error is treated as "still pending" (returns null) so the caller
 *  keeps polling rather than recording garbage. */
async function probeTerminal(
  txHash: string,
): Promise<{ status: "confirmed" | "failed"; blockNumber: number | null } | null> {
  const rpc = getProvider().rpcClient;
  // The receipt is authoritative: it carries the explicit status bit (1/0).
  // A null receipt means the node has not mined/seen the tx yet (still
  // pending). We intentionally do NOT fall back to `lyth_txStatus="found"`
  // here — "found" tells us a tx landed in a block but not whether it
  // succeeded or reverted, so it cannot satisfy the confirmed/failed
  // fidelity rule on its own.
  try {
    const receipt = await rpc.ethGetTransactionReceipt(txHash);
    if (receipt) {
      const status = receipt.status === 1 ? "confirmed" : "failed";
      return { status, blockNumber: blockToNumber(receipt.block_number) };
    }
  } catch {
    // Transport / RPC hiccup — treat as "still pending" and keep polling.
  }
  return null;
}

/** Fire-and-forget: poll for the tx's real terminal receipt and record a
 *  notification on the explicit status bit only. Resolves (always) once a
 *  terminal status is recorded or the poll window elapses. Never throws.
 *
 *  `chainId` is the chain id observed at broadcast time (drives the dedupe
 *  id); pass the same value the submit returned so the record's id is
 *  stable across wallet sessions. */
export async function recordTerminalNotification(
  txHash: string,
  chainId: bigint,
  notify: NotifyDescriptor,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ added: boolean }> {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const chainIdHex = `0x${chainId.toString(16)}`;
  const deadline = Date.now() + timeoutMs;

  try {
    // First probe immediately, then on the interval until the deadline.
    for (;;) {
      const terminal = await probeTerminal(txHash);
      if (terminal) {
        const { added } = await recordNotification({
          chainIdHex,
          txHash,
          status: terminal.status,
          blockNumber: terminal.blockNumber,
          kind: notify.kind,
          amountDecimal: notify.amountDecimal,
          counterparty: notify.counterparty,
        });
        return { added };
      }
      if (Date.now() >= deadline) return { added: false };
      await sleep(intervalMs);
    }
  } catch {
    return { added: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
