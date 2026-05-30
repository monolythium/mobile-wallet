// One-shot recording helper — poll a just-submitted tx to its REAL terminal
// transition and record a NotificationRecord on the explicit receipt status
// bit, never before.
//
// SUPERSEDED for the live flow by the durable reconcile loop
// ==========================================================
// The OperationsDrawer used to arm this directly. It now enqueues the tx into
// the durable registry (`pending-tx-store.ts`) instead, and the app-level
// poller (`use-reconcile-poller.ts` → `reconcile.ts`) carries it to terminal
// even after the sheet is dismissed or the app restarts. This module remains
// as a self-contained, bounded one-shot tracker (used by tests, and available
// to any caller that explicitly wants a fire-and-forget single-tx poll), and
// shares the exact same receipt path via `probeTxTerminal`.
//
// Status fidelity (unchanged): records "confirmed" iff the receipt status bit
// is 1, "failed" iff it is 0, and NOTHING while pending or if the window
// elapses without a receipt (honest absence — no optimistic row, no
// fabricated "failed"). The drawer still shows the broadcast-ack in its
// "done" pane; the notification only lands once the chain has spoken.

import { recordNotification } from "./notifications-store";
import { probeTxTerminal } from "./tx-terminal";
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
      const terminal = await probeTxTerminal(txHash);
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
