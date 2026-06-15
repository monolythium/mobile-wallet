// Native Send-LYTH composer (post-EVM, optional-encryption chain).
//
// DEFAULT submit path is PLAINTEXT — the working inclusion path on the
// live optional-encryption chain (`encrypted_mempool_required = false`).
// Stages of a real plaintext send:
//   1. read sender nonce + chain id from the RpcClient (no key access);
//   2. resolve sane per-unit fee defaults from the live
//      `lyth_executionUnitPrice` quote (SDK `resolveExecutionFee`, which
//      clamps the priority tip <= max execution-unit price so the
//      plaintext path never reverts with FeeMismatch);
//   3. unlock the vault via the supplied backend factory (biometric or
//      password) and produce a fresh `MlDsa65Backend`;
//   4. ask the SDK's `submitTransactionWithPrivacy({ private: false })`
//      to build the chain-side `SignedTransaction`, ML-DSA-65 sign over
//      the canonical sighash, bincode-serialize, and POST it through
//      `mesh_submitTx` (validating the node-echoed canonical tx hash).
//
// The PRIVATE (threshold-encrypted) path is a PREVIEW only. Passing
// `privatePreview: true` routes through `submitTransactionWithPrivacy(
// { private: true })` — the Ferveo encrypt-then-`lyth_submitEncrypted`
// pipeline — but threshold-encrypted INCLUSION is NOT live on the chain
// yet, so an encrypted tx will not confirm. The Send screen keeps the
// "Private" toggle default-OFF and disabled (preview copy) precisely so a
// user can never submit a non-confirming encrypted tx. Plaintext (OFF)
// is the only working path today.

import {
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
  TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT,
  parseLythToLythoshi,
  resolveExecutionFee,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import {
  type EncryptionKey,
  type MempoolClass,
  type MlDsa65Backend,
  type NativeEvmTxFields,
  submitTransactionWithPrivacy,
} from "@monolythium/core-sdk/crypto";
import { getProvider } from "./client";
import { nextSendNonce, recordSubmittedNonce } from "./pending-nonce";

export interface SendLythArgs {
  /** Typed ADR-0038 user address to debit. Must match the signer's address. */
  from: string;
  /** Typed ADR-0038 user recipient. */
  to: string;
  /** Decimal LYTH string, e.g. "12.5"; parsed as 8-decimal native lythoshi. */
  amountLyth: string;
  /**
   * Execution-unit limit. Defaults to the SDK's sane transfer default
   * (`TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT`, 500k — the ML-DSA-65-signed
   * transfer cost with margin), NOT the old 21k intrinsic floor.
   */
  executionUnitLimit?: bigint;
  /**
   * Optional explicit chain id override. When omitted we use whatever
   * the RpcClient's `eth_chainId` returns.
   */
  chainId?: bigint;
  /** Optional hex data payload; most plain transfers leave this empty. */
  data?: string;
  /**
   * Privacy toggle. DEFAULT (false / omitted) = PLAINTEXT via
   * `mesh_submitTx` — the working inclusion path. `true` routes through
   * the threshold-encrypted (Ferveo) path, which is a PREVIEW: encrypted
   * inclusion is not live yet, so an encrypted tx will not confirm. The
   * Send screen gates this OFF + disabled.
   */
  privatePreview?: boolean;
  /**
   * Mempool class override. Only consulted on the encrypted (preview)
   * path. User sends never want this; leave undefined.
   */
  mempoolClass?: MempoolClass;
}

export interface SendLythResult {
  /** Canonical native tx hash the cluster acknowledged. */
  txHash: string;
  /** Chain id observed at broadcast time. */
  chainId: bigint;
  /** Effective amount sent (lythoshi). */
  amountLythoshi: bigint;
  /** True when the encrypted (preview) path was used. */
  encrypted: boolean;
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
 * RpcClient. DEFAULT path is PLAINTEXT (`submitTransactionWithPrivacy`
 * with `private: false`) — what actually confirms on the
 * optional-encryption chain. Throws on any wire-level failure so the
 * OperationsDrawer can promote the drawer to its `done` stage with an
 * error.
 */
export async function sendLyth(
  backends: SendLythBackends,
  args: SendLythArgs,
): Promise<SendLythResult> {
  const fromHex = requireTypedUserAddressHex(args.from, "from");
  const toHex = requireTypedUserAddressHex(args.to, "to");
  const rpc = getProvider().rpcClient;

  // 1. Sender nonce + chain id, in parallel (no key access yet).
  const [committedNonce, chainIdFromChain] = await Promise.all([
    rpc.ethGetTransactionCount(fromHex, "pending"),
    rpc.ethChainId(),
  ]);

  const chainId = args.chainId ?? chainIdFromChain;
  // Local pending-nonce: the chain returns only the committed nonce (the
  // "pending" tag above is a no-op), so a 2nd send before the 1st commits would
  // reuse it. Sign max(committed, lastSubmitted+1); recorded on success below.
  const nonce = nextSendNonce(fromHex, chainId, committedNonce);
  const amountLythoshi = parseLythToLythoshi(args.amountLyth);

  // 2. Sane per-unit fee defaults from the live quote. `resolveExecutionFee`
  //    derives the max execution-unit price (live quote × safety headroom,
  //    clamped to a floor) and clamps the priority tip <= that cap, so the
  //    plaintext path never reverts with FeeMismatch.
  const fee = await resolveExecutionFee(rpc, {
    executionUnitLimit:
      args.executionUnitLimit ?? TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT,
  });

  const isPrivate = args.privatePreview === true;

  // 3. Encryption key — only needed for the encrypted (preview) path.
  let encryptionKey: EncryptionKey | undefined;
  if (isPrivate) {
    const encryptionKeyRes = await rpc.lythGetEncryptionKey();
    encryptionKey = {
      algo: encryptionKeyRes.algo,
      epoch:
        typeof encryptionKeyRes.epoch === "bigint"
          ? encryptionKeyRes.epoch
          : BigInt(encryptionKeyRes.epoch as unknown as string | number),
      encapsulationKey: hexStringToBytes(encryptionKeyRes.encapsulationKey),
    };
  }

  // 4. Unlock the vault for one signing op. The backend drops out of
  //    scope when the function returns.
  const backend = await backends.unlockBackend();

  const tx: NativeEvmTxFields = {
    chainId: bigintToHex(chainId),
    nonce: bigintToHex(nonce),
    gasLimit: bigintToHex(fee.gasLimit),
    maxFeePerGas: bigintToHex(fee.maxFeePerGas),
    maxPriorityFeePerGas: bigintToHex(fee.maxPriorityFeePerGas),
    to: toHex,
    value: bigintToHex(amountLythoshi),
    input: args.data ?? "0x",
  };

  // 5. Submit. DEFAULT private:false -> plaintext mesh_submitTx (validated
  //    node-echoed canonical hash). private:true -> encrypted (preview).
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: isPrivate,
    ...(encryptionKey !== undefined ? { encryptionKey } : {}),
    ...(args.mempoolClass !== undefined ? { class: args.mempoolClass } : {}),
  });
  // Success — advance the local pending nonce so the next submit won't reuse it.
  recordSubmittedNonce(fromHex, chainId, nonce);

  return {
    txHash,
    chainId,
    amountLythoshi,
    encrypted: isPrivate,
  };
}

/**
 * Decimal-LYTH preview helper for fee math. `feePerUnit` is the chain's
 * per-execution-unit price (lythoshi); multiplying by the limit gives the
 * maximum possible fee in lythoshi, which we then format back to LYTH for
 * display.
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
  const fracStr = fraction
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .replace(/0+$/, "");
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
