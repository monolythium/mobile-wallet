// Local pending-nonce tracker.
//
// Monolythium Testnet has NO pending-nonce surface: `eth_getTransactionCount`
// returns the COMMITTED nonce and the runtime ignores the block tag (so passing
// "pending" is a no-op). A 2nd tx submitted before the 1st commits would reuse
// the same nonce — the operator mempool then drops or "replace underpriced"-
// rejects one of them.
//
// Fix: remember the highest nonce THIS app successfully submitted per
// (address, chainId) and sign `max(committed, lastSubmitted + 1)`. A short TTL
// heals the case where a submitted tx never commits (operator drop): past the
// TTL we fall back to the committed nonce, so the wallet never gets stuck a
// nonce ahead forever.
//
// In-memory only: the mobile app process is long-lived, so a module-level map
// is the right scope. Shared across the send + staking submit paths so a send
// immediately followed by a delegate advances correctly.

interface PendingNonceEntry {
  /** Highest nonce successfully submitted for this (address, chainId). */
  nonce: bigint;
  /** Recorded-at (ms epoch); entries past PENDING_NONCE_TTL_MS are ignored. */
  ts: number;
}

const PENDING_NONCE_TTL_MS = 5 * 60 * 1000;

const pendingNonces = new Map<string, PendingNonceEntry>();

function nonceKey(address: string, chainId: bigint | number): string {
  return `${address.toLowerCase()}:${chainId.toString()}`;
}

/** Nonce to sign: `max(committed, lastSubmitted + 1)`, TTL-healed. Returns the
 *  committed nonce unchanged when there's no fresh local entry — so the common
 *  single-tx case is byte-identical to reading the chain directly. */
export function nextSendNonce(
  address: string,
  chainId: bigint | number,
  committed: bigint,
): bigint {
  const entry = pendingNonces.get(nonceKey(address, chainId));
  if (entry && Date.now() - entry.ts < PENDING_NONCE_TTL_MS) {
    const localNext = entry.nonce + 1n;
    return localNext > committed ? localNext : committed;
  }
  return committed;
}

/** Record a SUCCESSFULLY-submitted nonce so the next tx advances past it. MUST
 *  be called only on the submit success path — a rejected submit must NOT
 *  advance the nonce (the slot is still free on-chain). */
export function recordSubmittedNonce(
  address: string,
  chainId: bigint | number,
  nonce: bigint,
): void {
  pendingNonces.set(nonceKey(address, chainId), { nonce, ts: Date.now() });
}

/** Test hook — clears all tracked nonces. */
export function _resetPendingNonces(): void {
  pendingNonces.clear();
}
