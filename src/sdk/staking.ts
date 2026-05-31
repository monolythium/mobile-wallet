// Staking SDK seam — wraps `lyth_clusterDirectory`, `lyth_getDelegations`,
// and the delegation-precompile (Law §5.4 / §7.6) calldata encoders.
//
// Delegation lives at the precompile resolved by `delegationAddressHex()`
// (0x…100A). Calldata is the SDK's canonical 4-byte selector + packed-word
// encoding — NOT a hand-rolled flat-uint256 ABI. The signatures are:
//
//   delegate(uint32 clusterId, uint16 weightBps)   — caller sends LYTH as
//                                                     msg.value to set the
//                                                     principal stake.
//   undelegate(uint32 clusterId)                    — cluster only; the chain
//                                                     appends a redemption
//                                                     ticket (no weight arg).
//   redelegate(uint32 src, uint32 dst, uint16 weightBps)
//   claim()                                         — selector only.
//
// All encoders + the precompile address come from `@monolythium/core-sdk`
// (delegation.ts) so the wallet never diverges from the chain ABI.
//
// Submission uses the SDK 0.3.11 PLAINTEXT path by default
// (`submitTransactionWithPrivacy` with `private: false` -> `mesh_submitTx`)
// — the working inclusion path on the optional-encryption chain. Staking
// (delegate / undelegate / redelegate / claim) is never user-toggleable to
// the encrypted preview path; it always goes plaintext.
//
// The chain may reject the call at the precompile-gate if delegation
// isn't activated yet on the connected network — wallets surface the
// chain's typed error verbatim.

import {
  type MlDsa65Backend,
  type NativeEvmTxFields,
  submitTransactionWithPrivacy,
} from "@monolythium/core-sdk/crypto";
import type {
  ClusterDirectoryPageResponse,
  DelegationsResponse,
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
 *  encoder. weightBps sets the wallet-weight; the principal LYTH staked is
 *  carried separately as `tx.value` (see {@link submitStakingTx}). */
export function buildDelegateCalldata(
  clusterId: number,
  weightBps: number,
): string {
  return encodeDelegateCalldata(clusterId, weightBps);
}

/** undelegate(uint32 clusterId) — cluster only. The SDK encoder takes NO
 *  weightBps; the chain appends a redemption ticket for the delegated stake. */
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
 * Submit a delegation-precompile call (delegate / undelegate / redelegate
 * / claim). Drives the SDK 0.3.11 PLAINTEXT path
 * (`submitTransactionWithPrivacy` with `private: false` -> `mesh_submitTx`,
 * with the node-echoed canonical tx hash validated), with `to` set to the
 * delegation precompile address. This is the working inclusion path on the
 * optional-encryption chain.
 *
 * The SDK `delegate(uint32,uint16)` model sets the wallet-weight via
 * calldata but expects the principal LYTH stake to be sent as `msg.value`.
 * Pass `valueLythoshi` for delegate; leave it `0n` (default) for
 * undelegate / redelegate / claim.
 */
export interface SubmitStakingTxArgs {
  fromBech32m: string;
  data: string;
  unlockBackend: () => Promise<MlDsa65Backend>;
  /** Principal stake (lythoshi) sent as `msg.value`. Required for delegate;
   *  0n (default) for undelegate / redelegate / claim. */
  valueLythoshi?: bigint;
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

  const [nonce, chainId] = await Promise.all([
    rpc.ethGetTransactionCount(fromHex, "pending"),
    rpc.ethChainId(),
  ]);

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
    value: bigintToHex(args.valueLythoshi ?? 0n),
    input: args.data,
  };

  const backend = await args.unlockBackend();
  // Plaintext default (private: false) -> mesh_submitTx, the working
  // inclusion path; returns the validated canonical native tx hash.
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });
  return { txHash };
}

/** Re-export the SDK's typed delegation error so screens can branch on it
 *  without importing the SDK directly. */
export { DelegationPrecompileError };
