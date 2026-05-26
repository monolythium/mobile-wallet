// Staking SDK seam — wraps `lyth_clusterDirectory`, `lyth_getDelegations`,
// and the delegation-precompile (Law §5.4 / §7.6) calldata encoders.
//
// Delegation lives at precompile `0x…100A`. Calldata is standard
// 4-byte selector + 32-byte ABI words:
//
//   delegate(uint256 clusterId, uint256 weightBps)
//   undelegate(uint256 clusterId, uint256 weightBps)
//   redelegate(uint256 srcCluster, uint256 dstCluster, uint256 weightBps)
//
// The chain may reject the call at the precompile-gate if delegation
// isn't activated yet on the connected network — wallets surface the
// chain's typed error verbatim.

import {
  buildEncryptedSubmission,
  type EncryptionKey,
  type MlDsa65Backend,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import type {
  ClusterDirectoryPageResponse,
  DelegationsResponse,
} from "@monolythium/core-sdk";
import { typedBech32ToAddress } from "@monolythium/core-sdk";
import { getProvider } from "./client";

/** Delegation precompile address (Law §5.4 / §7.6). */
export const DELEGATION_PRECOMPILE =
  "0x000000000000000000000000000000000000100a";

/** Function selectors. Hex-pinned constants — first 4 bytes of
 *  keccak256(signature). The SDK exports the canonical signatures
 *  alongside their selectors via `DELEGATION_SELECTORS`. */
export const STAKING_SELECTORS = {
  delegate: "d9a34952",
  undelegate: "634b91e3",
  redelegate: "0e184c84",
  claimRewards: "372500ab",
} as const;

export type StakingAction = "delegate" | "undelegate" | "redelegate";

export interface StakingTxResult {
  txHash: string;
  innerSighashHex: string;
}

function encodeUint256(value: number | bigint): string {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new RangeError(`encodeUint256: not a non-negative integer (${value})`);
    }
    n = BigInt(value);
  }
  if (n < 0n) throw new RangeError("encodeUint256: negative");
  if (n >= 1n << 256n) throw new RangeError("encodeUint256: overflow");
  return n.toString(16).padStart(64, "0");
}

export function buildDelegateCalldata(
  clusterId: number,
  weightBps: number,
): string {
  return (
    "0x" +
    STAKING_SELECTORS.delegate +
    encodeUint256(clusterId) +
    encodeUint256(weightBps)
  );
}

export function buildUndelegateCalldata(
  clusterId: number,
  weightBps: number,
): string {
  return (
    "0x" +
    STAKING_SELECTORS.undelegate +
    encodeUint256(clusterId) +
    encodeUint256(weightBps)
  );
}

export function buildRedelegateCalldata(
  srcCluster: number,
  dstCluster: number,
  weightBps: number,
): string {
  return (
    "0x" +
    STAKING_SELECTORS.redelegate +
    encodeUint256(srcCluster) +
    encodeUint256(dstCluster) +
    encodeUint256(weightBps)
  );
}

export function buildClaimRewardsCalldata(): string {
  return "0x" + STAKING_SELECTORS.claimRewards;
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
 * / claimRewards). Drives the same encrypted-envelope path as `sendLyth`,
 * but `to` is the precompile address and value is 0.
 */
export interface SubmitStakingTxArgs {
  fromBech32m: string;
  data: string;
  unlockBackend: () => Promise<MlDsa65Backend>;
  /** Execution-unit limit. Delegation precompile calls typically need
   *  ~50_000 units; bump if the chain rejects with out-of-execution. */
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

  const [nonce, executionUnitPrice, chainId] = await Promise.all([
    rpc.ethGetTransactionCount(fromHex, "pending"),
    rpc.ethGasPrice(),
    rpc.ethChainId(),
  ]);
  const encryptionKeyRes = await rpc.lythGetEncryptionKey();

  const tx: NativeEvmTxFields = {
    chainId: bigintToHex(chainId),
    nonce: bigintToHex(nonce),
    gasLimit: bigintToHex(args.executionUnitLimit ?? 50_000n),
    maxFeePerGas: bigintToHex(executionUnitPrice),
    maxPriorityFeePerGas: bigintToHex(executionUnitPrice),
    to: DELEGATION_PRECOMPILE,
    value: "0x0",
    input: args.data,
  };

  const encryptionKey: EncryptionKey = {
    algo: encryptionKeyRes.algo,
    epoch:
      typeof encryptionKeyRes.epoch === "bigint"
        ? encryptionKeyRes.epoch
        : BigInt(encryptionKeyRes.epoch as unknown as string | number),
    encapsulationKey: hexToBytes(encryptionKeyRes.encapsulationKey),
  };

  const backend = await args.unlockBackend();
  const wrapped = await buildEncryptedSubmission({
    backend,
    tx,
    encryptionKey,
  });
  const txHash = await rpc.lythSubmitEncrypted(wrapped.envelopeWireHex);
  return { txHash, innerSighashHex: wrapped.innerSighashHex };
}

function hexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
