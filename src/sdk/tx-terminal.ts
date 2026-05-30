// Shared terminal-status probe — the ONE receipt path both the durable
// reconcile loop and any one-shot caller use to ask the chain whether a tx
// has reached a terminal state.
//
// Status fidelity (the #5117 hazard)
// ==================================
// The send / staking SDK returns the cluster-ack tx hash without awaiting a
// receipt — that hash means "broadcast accepted", NOT "confirmed on-chain".
// This probe consults the AUTHORITATIVE receipt, which carries the explicit
// status bit, and returns:
//   - "confirmed"  iff the receipt's explicit status bit is 1
//   - "failed"     iff the receipt's explicit status bit is 0
//   - null         while the tx is still pending / unknown (no receipt yet,
//                  or any RPC hiccup — treated as "keep waiting")
// It never falls back to `lyth_txStatus="found"`: "found" tells us a tx
// landed in a block but not whether it succeeded or reverted, so it cannot
// satisfy the confirmed/failed fidelity rule on its own. A terminal verdict
// is NEVER synthesized — absence of a receipt is reported as null, full stop.

import { getProvider } from "./client";

/** Explicit terminal outcome of a tx, or `null` while still pending. */
export interface TerminalStatus {
  status: "confirmed" | "failed";
  blockNumber: number | null;
}

/** Normalize a `bigint | number | null | undefined` block number to a finite
 *  number or null. */
export function blockToNumber(
  v: bigint | number | null | undefined,
): number | null {
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
export async function probeTxTerminal(
  txHash: string,
): Promise<TerminalStatus | null> {
  const rpc = getProvider().rpcClient;
  // The receipt is authoritative: it carries the explicit status bit (1/0).
  // A null receipt means the node has not mined/seen the tx yet (still
  // pending).
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
