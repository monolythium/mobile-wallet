// Native Send-LYTH composer (post-EVM, encrypted-envelope wire shape).
//
// Stages of a real send:
//   1. read sender nonce + native fee + chain id from the RpcClient
//      (no key access yet);
//   2. fetch the cluster's ML-KEM-768 encapsulation key via
//      `lyth_getEncryptionKey`;
//   3. unlock the vault via the supplied backend factory (biometric or
//      password) and produce a fresh `MlDsa65Backend`;
//   4. ask the SDK's `buildEncryptedSubmission` to sign the inner
//      native tx with ML-DSA-65 and ML-KEM-encrypt the envelope;
//   5. submit via `lyth_submitEncrypted` through the RpcClient.
//
// The ethers shim is no longer the canonical wire format — the chain
// settled on a native encrypted-envelope tx (whitepaper §22, post-EVM
// posture per the 2026-05-23 session decision). Wallets ship native
// signing and submission only.

import {
  LYTHOSHI_PER_LYTH,
  parseLythToLythoshi,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import {
  buildEncryptedSubmission,
  type EncryptionKey,
  type MempoolClass,
  type MlDsa65Backend,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { getProvider } from "./client";

export interface SendLythArgs {
  /** Typed ADR-0038 user address to debit. Must match the signer's address. */
  from: string;
  /** Typed ADR-0038 user recipient. */
  to: string;
  /** Decimal LYTH string, e.g. "12.5"; parsed as 8-decimal native lythoshi. */
  amountLyth: string;
  /** Execution-unit limit. Defaults to 21_000 for a plain transfer. */
  executionUnitLimit?: bigint;
  /**
   * Optional explicit chain id override. When omitted we use whatever
   * the RpcClient's `eth_chainId` returns.
   */
  chainId?: bigint;
  /** Optional hex data payload; most plain transfers leave this empty. */
  data?: string;
  /**
   * Mempool class override. The chain defaults to encrypted; use
   * `MempoolClass.PUBLIC` for protocol-owned action plans that explicitly
   * opt out (e.g. emergency operator broadcasts). User sends never want
   * this; leave undefined.
   */
  mempoolClass?: MempoolClass;
}

export interface SendLythResult {
  /** Canonical native tx hash the cluster acknowledged. */
  txHash: string;
  /** Wire-bytes count of the inner unencrypted tx (for fee preview UI). */
  innerWireBytes: number;
  /** Inner native-tx sighash (hex) — useful for the Done pane diff. */
  innerSighashHex: string;
  /** Chain id observed at broadcast time. */
  chainId: bigint;
  /** Effective amount sent (lythoshi). */
  amountLythoshi: bigint;
}

export interface SendLythBackends {
  /** Materialise a fresh ML-DSA-65 backend for this signing op. */
  unlockBackend: () => Promise<MlDsa65Backend>;
}

/** Convert a `bigint` to a `0x`-prefixed minimal-width quantity. */
function bigintToHex(n: bigint): string {
  return "0x" + n.toString(16);
}

/**
 * Compose a real Send LYTH against the live testnet via the SDK
 * RpcClient + native encrypted-envelope path. Throws on any wire-level
 * failure so the OperationsDrawer can promote the drawer to its `done`
 * stage with an error.
 */
export async function sendLyth(
  backends: SendLythBackends,
  args: SendLythArgs,
): Promise<SendLythResult> {
  const fromHex = requireTypedUserAddressHex(args.from, "from");
  const toHex = requireTypedUserAddressHex(args.to, "to");
  const rpc = getProvider().rpcClient;

  // 1. Sender nonce + execution-unit price + chain id, in parallel.
  const [nonce, executionUnitPrice, chainIdFromChain] = await Promise.all([
    rpc.ethGetTransactionCount(fromHex, "pending"),
    rpc.ethGasPrice(),
    rpc.ethChainId(),
  ]);

  const chainId = args.chainId ?? chainIdFromChain;
  const executionUnitLimit = args.executionUnitLimit ?? 21_000n;
  const amountLythoshi = parseLythToLythoshi(args.amountLyth);

  // 2. Cluster encryption key (ML-KEM-768). Cached briefly inside the
  //    RpcClient transport in production deployments; safe to call per-send.
  const encryptionKeyRes = await rpc.lythGetEncryptionKey();
  const encryptionKey: EncryptionKey = {
    algo: encryptionKeyRes.algo,
    epoch:
      typeof encryptionKeyRes.epoch === "bigint"
        ? encryptionKeyRes.epoch
        : BigInt(encryptionKeyRes.epoch as unknown as string | number),
    encapsulationKey: hexStringToBytes(encryptionKeyRes.encapsulationKey),
  };

  // 3. Unlock the vault for one signing op. The backend drops out of
  //    scope when the function returns.
  const backend = await backends.unlockBackend();

  // 4. Build the inner native tx + ML-DSA-65 sign + ML-KEM-encrypt
  //    envelope, all inside the SDK.
  const tx: NativeEvmTxFields = {
    chainId: bigintToHex(chainId),
    nonce: bigintToHex(nonce),
    gasLimit: bigintToHex(executionUnitLimit),
    maxFeePerGas: bigintToHex(executionUnitPrice),
    maxPriorityFeePerGas: bigintToHex(executionUnitPrice),
    to: toHex,
    value: bigintToHex(amountLythoshi),
    input: args.data ?? "0x",
  };

  const wrapped = await buildEncryptedSubmission({
    backend,
    tx,
    encryptionKey,
    ...(args.mempoolClass !== undefined ? { class: args.mempoolClass } : {}),
  });

  // 5. Submit via lyth_submitEncrypted and return the cluster's tx hash.
  const txHash = await rpc.lythSubmitEncrypted(wrapped.envelopeWireHex);

  return {
    txHash,
    innerWireBytes: wrapped.innerWireBytes,
    innerSighashHex: wrapped.innerSighashHex,
    chainId,
    amountLythoshi,
  };
}

/**
 * Decimal-LYTH preview helper for fee math. `feePerUnit` is the chain's
 * `eth_gasPrice` quantity (lythoshi per execution unit); multiplying by
 * the limit gives the maximum possible fee in lythoshi, which we then
 * format back to LYTH for display.
 */
export function previewMaxFeeLyth(
  feePerUnit: bigint,
  executionUnitLimit: bigint,
): string {
  const lythoshi = feePerUnit * executionUnitLimit;
  if (lythoshi === 0n) return "0";
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const fraction = lythoshi % LYTHOSHI_PER_LYTH;
  if (fraction === 0n) return whole.toString();
  const fracStr = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  return fracStr.length === 0 ? whole.toString() : `${whole}.${fracStr}`;
}

function requireTypedUserAddressHex(address: string, label: string): string {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    throw new Error(
      `${label} raw 0x addresses are retired; use a typed mono1 address`,
    );
  }
  try {
    return typedBech32ToAddress(address, "user").hex;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} must be a typed mono1 address: ${message}`);
  }
}

function hexStringToBytes(s: string): Uint8Array {
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex byte");
    out[i] = b;
  }
  return out;
}
