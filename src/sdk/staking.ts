// Staking SDK seam — wraps `lyth_clusterDirectory`, `lyth_getDelegations`,
// and the delegation-precompile (Law §5.4 / §7.6) calldata encoders.
//
// NON-CUSTODIAL ARK staking: delegation is balance-weighted and never
// escrows tokens. `delegate(cluster, weightBps)` records a `weightBps`
// fraction of the caller's LIVE balance; the contribution to a cluster is
// the effective weight `floor(balance × weightBps / 10000)`. Tokens stay
// fully liquid and spendable. The delegate tx is sent with value = 0; the
// chain reverts (UnexpectedValue, tag 0x020e) if any native value is
// attached. There is no redemption queue: `undelegate` is instant.
//
// Delegation lives at the precompile resolved by `delegationAddressHex()`
// (0x…100A). Calldata is the SDK's canonical 4-byte selector + packed-word
// encoding — NOT a hand-rolled flat-uint256 ABI. The signatures are:
//
//   delegate(uint32 clusterId, uint16 weightBps)   — value = 0, no escrow.
//   undelegate(uint32 clusterId)                    — cluster only; instant
//                                                     removal, no redemption.
//   redelegate(uint32 src, uint32 dst, uint16 weightBps)
//   claim()                                         — selector only.
//
// All encoders + the precompile address come from `@monolythium/core-sdk`
// (delegation.ts) so the wallet never diverges from the chain ABI.
//
// Submission uses the SDK PLAINTEXT path (`submitTransaction` ->
// `mesh_submitTx`) — the chain's sole inclusion path since the v2
// re-genesis dropped the encrypted mempool. Staking (delegate /
// undelegate / redelegate / claim) always goes plaintext.
//
// The chain may reject the call at the precompile-gate if delegation
// isn't activated yet on the connected network — wallets surface the
// chain's typed error verbatim.

import {
  type MlDsa65Backend,
  type NativeEvmTxFields,
  submitTransaction,
} from "@monolythium/core-sdk/crypto";
import type {
  ClusterDirectoryPageResponse,
  DelegationsResponse,
  PendingRewardsResponse,
} from "@monolythium/core-sdk";
import {
  typedBech32ToAddress,
  encodeDelegateCalldata,
  encodeUndelegateCalldata,
  encodeRedelegateCalldata,
  encodeClaimCalldata,
  delegationAddressHex,
  resolveExecutionFee,
  DelegationPrecompileError,
} from "@monolythium/core-sdk";
import { getProvider } from "./client";
import { nextSendNonce, recordSubmittedNonce } from "./pending-nonce";

/** Sane execution-unit limit for a delegation-precompile call. The
 *  delegate / undelegate / redelegate / claim ops fit comfortably under
 *  this; the SDK fee resolver derives the per-unit price + clamps the tip. */
const DELEGATION_DEFAULT_EXECUTION_UNIT_LIMIT = 100_000n;

/** Delegation precompile address (Law §5.4 / §7.6), resolved from the SDK
 *  so the wallet never hard-codes a precompile literal. */
export const DELEGATION_PRECOMPILE = delegationAddressHex();

export type StakingAction = "delegate" | "undelegate" | "redelegate";

export interface StakingTxResult {
  /** Validated canonical native tx hash echoed by `mesh_submitTx`. */
  txHash: string;
}

/** delegate(uint32 clusterId, uint16 weightBps) — thin wrapper over the SDK
 *  encoder. NON-CUSTODIAL: `weightBps` is the fraction of the caller's live
 *  balance to contribute; the tx is sent with value = 0 (no escrow — see
 *  {@link submitStakingTx}). */
export function buildDelegateCalldata(
  clusterId: number,
  weightBps: number,
): string {
  return encodeDelegateCalldata(clusterId, weightBps);
}

/** undelegate(uint32 clusterId) — cluster only. The SDK encoder takes NO
 *  weightBps; the chain INSTANTLY removes the delegation row. There is no
 *  redemption queue or cooldown — nothing was escrowed. */
export function buildUndelegateCalldata(clusterId: number): string {
  return encodeUndelegateCalldata(clusterId);
}

/** redelegate(uint32 src, uint32 dst, uint16 weightBps). */
export function buildRedelegateCalldata(
  srcCluster: number,
  dstCluster: number,
  weightBps: number,
): string {
  return encodeRedelegateCalldata(srcCluster, dstCluster, weightBps);
}

/** claim() — selector only, no args. */
export function buildClaimRewardsCalldata(): string {
  return encodeClaimCalldata();
}

export async function fetchClusterDirectory(
  page: number = 1,
  limit: number = 20,
): Promise<ClusterDirectoryPageResponse> {
  return getProvider().rpcClient.lythClusterDirectory(page, limit);
}

export async function fetchDelegations(
  walletBech32m: string,
): Promise<DelegationsResponse> {
  const rpc = getProvider().rpcClient;
  const hex = typedBech32ToAddress(walletBech32m, "user").hex;
  return rpc.lythGetDelegations(hex);
}

/**
 * Read the wallet's pending (claimable) staking rewards via
 * `lyth_pendingRewards`. `totalAmountLythoshi` is settled + unsettled
 * claimable reward as a hex quantity; `rows` carries the per-cluster
 * unsettled breakdown. The figure is read straight off-chain — there is no
 * APR projection here, so the wallet never fabricates an earnings estimate.
 * The connected node may not serve this method (older operator / disabled
 * indexer); the caller surfaces honest absence rather than a zero.
 */
export async function fetchPendingRewards(
  walletBech32m: string,
): Promise<PendingRewardsResponse> {
  const rpc = getProvider().rpcClient;
  const hex = typedBech32ToAddress(walletBech32m, "user").hex;
  return rpc.lythPendingRewards(hex);
}

/**
 * Submit a delegation-precompile call (delegate / undelegate / redelegate
 * / claim). Drives the SDK PLAINTEXT path (`submitTransaction` ->
 * `mesh_submitTx`, with the node-echoed canonical tx hash validated), with
 * `to` set to the delegation precompile address. This is the chain's sole
 * inclusion path since the v2 re-genesis dropped the encrypted mempool.
 *
 * NON-CUSTODIAL: every staking call (including delegate) is sent with
 * value = 0. The chain reverts (UnexpectedValue, tag 0x020e) if any native
 * value is attached to a delegate — no tokens are ever escrowed.
 */
export interface SubmitStakingTxArgs {
  fromBech32m: string;
  data: string;
  unlockBackend: () => Promise<MlDsa65Backend>;
  /** Execution-unit limit. Defaults to a sane delegation limit; the SDK fee
   *  resolver derives the per-unit price + clamps the tip. */
  executionUnitLimit?: bigint;
}

function bigintToHex(n: bigint): string {
  return "0x" + n.toString(16);
}

export async function submitStakingTx(
  args: SubmitStakingTxArgs,
): Promise<StakingTxResult> {
  const rpc = getProvider().rpcClient;
  const fromHex = typedBech32ToAddress(args.fromBech32m, "user").hex;

  const [committedNonce, chainId] = await Promise.all([
    rpc.ethGetTransactionCount(fromHex, "pending"),
    rpc.ethChainId(),
  ]);
  // Local pending-nonce: chain exposes only the committed nonce, so a stake
  // right after a send (or two stakes) before commit would reuse it. Sign
  // max(committed, lastSubmitted+1); recorded on success below. Shares the
  // tracker with sendLyth so cross-path ordering is correct.
  const nonce = nextSendNonce(fromHex, chainId, committedNonce);

  // Sane per-unit fee defaults from the live quote: max execution-unit
  // price derived (live quote × safety headroom, clamped to a floor) with
  // the priority tip clamped <= that cap, so the plaintext path never
  // reverts with FeeMismatch.
  const fee = await resolveExecutionFee(rpc, {
    executionUnitLimit:
      args.executionUnitLimit ?? DELEGATION_DEFAULT_EXECUTION_UNIT_LIMIT,
  });

  const tx: NativeEvmTxFields = {
    chainId: bigintToHex(chainId),
    nonce: bigintToHex(nonce),
    gasLimit: bigintToHex(fee.gasLimit),
    maxFeePerGas: bigintToHex(fee.maxFeePerGas),
    maxPriorityFeePerGas: bigintToHex(fee.maxPriorityFeePerGas),
    to: DELEGATION_PRECOMPILE,
    // NON-CUSTODIAL: delegation never carries native value.
    value: bigintToHex(0n),
    input: args.data,
  };

  const backend = await args.unlockBackend();
  // Plaintext mesh_submitTx — the chain's sole inclusion path; returns the
  // validated canonical native tx hash.
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  // Success — advance the local pending nonce so the next submit won't reuse it.
  recordSubmittedNonce(fromHex, chainId, nonce);
  return { txHash };
}

/** Re-export the SDK's typed delegation error so screens can branch on it
 *  without importing the SDK directly. */
export { DelegationPrecompileError };
