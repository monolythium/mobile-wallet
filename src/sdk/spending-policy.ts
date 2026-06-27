// Spending-policy SDK seam — agent sub-account lifecycle + the §18.8
// claim-signed policy write path (consensus-critical consumer pillar).
//
// The spending policy lives at the precompile resolved by
// `spendingPolicyAddressHex()` (0x…110C, Law §5.4 / WP §18.8). A principal
// grants a *sub-account* a bounded spending authority across all §18.8
// dimensions: per-tx cap, daily/weekly/monthly rolling caps, a destination
// allow/deny Merkle root, a category allow Merkle root, a packed time-of-day
// window, and an explicit policy-expiry.
//
// Sub-account lifecycle (no dedicated SDK creation/funding precompile — the
// sub-account is just a fresh ML-DSA-65 keypair the principal controls):
//
//   create  := generateAgentSubAccount() — fresh ML-DSA-65 keypair.
//   fund    := an ordinary native LYTH transfer (sendLyth) from the principal
//              to the sub-account address.  (Lives in the Agents screen.)
//   register:= the on-chain write below.
//
// The FRESH-claim path is consensus-critical: a never-seen sub-account is
// bound to its policy with `setPolicyClaim` (selector 0x35531f6c), which
// requires the SUB-ACCOUNT'S OWN ML-DSA-65 public key (1952 bytes) and a
// signature (3309 bytes) over `composeClaimBoundMessage(chainId, args)`.
// This is a TWO-KEY DANCE:
//
//   1. unlock the SUB-ACCOUNT'S ML-DSA-65 key, sign the bound message → 3309-byte
//      sig + 1952-byte pubkey  (signClaimBoundMessage below);
//   2. the PRINCIPAL signs + submits the OUTER tx via the SDK PLAINTEXT
//      path (submitSpendingPolicyTx below; mesh_submitTx — the chain's
//      sole inclusion path since the v2 re-genesis dropped the encrypted
//      mempool).
//
// A re-claim of an ALREADY-bound sub-account uses `setPolicy` (0x8da1a765),
// which carries no fresh pubkey/sig. Revoke = `disable` (0xe6c09edf).
//
// The chain may reject the call at the precompile-gate if the spending-policy
// precompile isn't activated yet on the connected network — the wallet
// surfaces the chain's typed error verbatim (never masked).
//
// MVP SCOPE (deviation, see plans/todos): the SDK takes pre-built 32-byte
// counterparty allow/deny + category-allow Merkle roots. This seam ships an
// empty (no-constraint) root and a single-address allow-root helper; a
// multi-entry Merkle-set builder is out of MVP scope.

import {
  type MlDsa65Backend,
  type NativeEvmTxFields,
  submitTransaction,
} from "@monolythium/core-sdk/crypto";
import {
  addressToTypedBech32,
  typedBech32ToAddress,
  encodeSetPolicyClaimCalldata,
  encodeSetPolicyCalldata,
  encodeEnableCalldata,
  encodeDisableCalldata,
  composeClaimBoundMessage,
  packTimeWindow,
  resolveRegistryExecutionFee,
  spendingPolicyAddressHex,
  SET_POLICY_CLAIM_DOMAIN_TAG,
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
  SpendingPolicyError,
  type SpendingPolicyArgs,
  type SpendingPolicyView,
} from "@monolythium/core-sdk";
import {
  generateMnemonic,
  mnemonicToAddress,
} from "@monolythium/core-sdk/crypto";
import { getProvider } from "./client";

/** Spending-policy precompile address (0x…110C), resolved from the SDK so the
 *  wallet never hard-codes a precompile literal. */
export const SPENDING_POLICY_PRECOMPILE = spendingPolicyAddressHex();

/** Re-export the SDK's typed error + the claim domain tag so screens can
 *  branch / display without importing the SDK directly. */
export { SpendingPolicyError, SET_POLICY_CLAIM_DOMAIN_TAG };
export { ML_DSA_65_PUBLIC_KEY_LEN, ML_DSA_65_SIGNATURE_LEN };
export type { SpendingPolicyArgs, SpendingPolicyView };

/** The 32-byte zero Merkle root — the "no constraint" sentinel for the
 *  destination allow/deny + category allow roots (WP §18.8). */
export function emptyMerkleRoot(): string {
  return "0x" + "00".repeat(32);
}

/**
 * MVP single-address allow root. The SDK + chain take a 32-byte Merkle root
 * for the counterparty allow-list; a one-entry "Merkle set" is just the leaf
 * itself, so we right-pad the 20-byte address into a 32-byte word. This is a
 * deliberate MVP shape — a true multi-entry Merkle-set builder is out of
 * scope (see the module header).
 *
 * NOTE: this matches the chain's single-leaf convention only when the policy
 * is registered with exactly one allowed counterparty. For multiple
 * counterparties, pass a caller-supplied root or leave the empty root (no
 * constraint) until the Merkle-set builder lands.
 */
export function buildSingleAddressAllowRoot(counterpartyBech32m: string): string {
  const { hex } = typedBech32ToAddress(counterpartyBech32m, "user");
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  // 20-byte address, left-aligned into a 32-byte word.
  return "0x" + stripped.padEnd(64, "0");
}

/** Re-export of the SDK time-window packer (32-byte word, WP §18.8). */
export function packPolicyTimeWindow(
  enabled: boolean,
  startHour: number,
  endHour: number,
): Uint8Array {
  return packTimeWindow(enabled, startHour, endHour);
}

// -----------------------------------------------------------------------------
// Sub-account creation (local key-gen — no dedicated SDK/chain primitive).
// -----------------------------------------------------------------------------

export interface AgentSubAccount {
  /** 24-word BIP-39 recovery phrase (ML-DSA-65). The principal controls this. */
  mnemonic: string;
  /** Typed `mono` bech32m address derived from the mnemonic. */
  addressBech32m: string;
  /** Internal 20-byte address (hex `0x…`) — storage-key form. */
  addressHex: string;
}

/**
 * Mint a fresh agent sub-account: a brand-new ML-DSA-65 keypair the
 * principal will fund + bind to a spending policy. The caller is responsible
 * for sealing the returned mnemonic (the Agents screen stores it in the OS
 * keychain, biometric-gated) and for zeroizing any transient copy.
 */
export function generateAgentSubAccount(): AgentSubAccount {
  const mnemonic = generateMnemonic();
  const addressHex = mnemonicToAddress(mnemonic);
  return {
    mnemonic,
    addressHex,
    addressBech32m: addressToTypedBech32("user", addressHex),
  };
}

// -----------------------------------------------------------------------------
// Claim-bound message signing (sub-account's OWN key signs the bound message).
// -----------------------------------------------------------------------------

/**
 * Sign `composeClaimBoundMessage(chainId, args)` with the SUB-ACCOUNT'S
 * ML-DSA-65 key. Returns the 3309-byte signature the FRESH-claim path
 * (`setPolicyClaim`) requires. The caller pairs this with the sub-account's
 * 1952-byte public key (`subAccountBackend.publicKey()`).
 *
 * The transient sub-account backend / seed material should be zeroized after
 * this call returns (the Agents screen drops it out of scope immediately).
 */
export function signClaimBoundMessage(
  subAccountBackend: MlDsa65Backend,
  chainId: bigint | number | string,
  args: SpendingPolicyArgs,
): Uint8Array {
  const message = composeClaimBoundMessage(chainId, args);
  return subAccountBackend.sign(message);
}

// -----------------------------------------------------------------------------
// Calldata builders.
// -----------------------------------------------------------------------------

export interface BuildRegisterPolicyArgs {
  args: SpendingPolicyArgs;
  /**
   * The sub-account's ML-DSA-65 public key (1952 bytes). REQUIRED for a FRESH
   * claim (`setPolicyClaim`). Omit (with `subAccountSig`) for a re-claim of an
   * already-bound sub-account (`setPolicy`).
   */
  subAccountPubkey?: Uint8Array | readonly number[] | string;
  /**
   * The sub-account's signature (3309 bytes) over
   * `composeClaimBoundMessage(chainId, args)`. REQUIRED for a FRESH claim.
   * Produce it with {@link signClaimBoundMessage}.
   */
  subAccountSig?: Uint8Array | readonly number[] | string;
}

/**
 * Build the register-policy calldata.
 *
 *   - FRESH sub-account (both `subAccountPubkey` + `subAccountSig` present):
 *     `setPolicyClaim` (selector 0x35531f6c). Length-guards the pubkey to
 *     1952 bytes and the signature to 3309 bytes BEFORE handing them to the
 *     SDK so a wrong-size buffer fails loudly at the wallet boundary.
 *
 *   - RE-CLAIM (no fresh material): `setPolicy` (selector 0x8da1a765) — the
 *     chain already holds the sub-account's bound key.
 */
export function buildRegisterPolicyCalldata(
  input: BuildRegisterPolicyArgs,
): string {
  const { args, subAccountPubkey, subAccountSig } = input;
  const hasFreshMaterial =
    subAccountPubkey !== undefined || subAccountSig !== undefined;

  if (!hasFreshMaterial) {
    // Re-claim of an already-bound sub-account.
    return encodeSetPolicyCalldata(args);
  }

  if (subAccountPubkey === undefined || subAccountSig === undefined) {
    throw new SpendingPolicyError(
      "fresh claim requires BOTH the sub-account public key and the bound-message signature",
    );
  }

  const pubkeyLen = byteLength(subAccountPubkey);
  if (pubkeyLen !== ML_DSA_65_PUBLIC_KEY_LEN) {
    throw new SpendingPolicyError(
      `sub-account ML-DSA-65 public key must be ${ML_DSA_65_PUBLIC_KEY_LEN} bytes, got ${pubkeyLen}`,
    );
  }
  const sigLen = byteLength(subAccountSig);
  if (sigLen !== ML_DSA_65_SIGNATURE_LEN) {
    throw new SpendingPolicyError(
      `sub-account ML-DSA-65 signature must be ${ML_DSA_65_SIGNATURE_LEN} bytes, got ${sigLen}`,
    );
  }

  return encodeSetPolicyClaimCalldata(args, subAccountPubkey, subAccountSig);
}

/** enable(subAccount) — re-arm a previously-disabled policy (0x5bfa1b68). */
export function buildEnablePolicyCalldata(subAccountBech32m: string): string {
  return encodeEnableCalldata(subAccountBech32m);
}

/** disable(subAccount) — REVOKE a sub-account's policy (0xe6c09edf). */
export function buildDisablePolicyCalldata(subAccountBech32m: string): string {
  return encodeDisableCalldata(subAccountBech32m);
}

// -----------------------------------------------------------------------------
// Read.
// -----------------------------------------------------------------------------

/** lyth_getSpendingPolicy(subAccount) -> the §18.8 SpendingPolicyView. */
export async function fetchSpendingPolicy(
  subAccountBech32m: string,
): Promise<SpendingPolicyView> {
  return getProvider().rpcClient.lythGetSpendingPolicy(subAccountBech32m);
}

// -----------------------------------------------------------------------------
// Write (mirrors the staking.ts plaintext submit path).
// -----------------------------------------------------------------------------

export interface SubmitSpendingPolicyTxArgs {
  /** Typed `mono` bech32m PRINCIPAL address (the policy manager). */
  fromBech32m: string;
  /** Calldata from buildRegisterPolicyCalldata / buildEnable/DisablePolicyCalldata. */
  data: string;
  /** Materialise a fresh PRINCIPAL ML-DSA-65 backend for this signing op. */
  unlockBackend: () => Promise<MlDsa65Backend>;
  /**
   * Execution-unit limit. The claim path carries ~5.3 KB of pubkey+sig, so
   * the default is higher than a plain delegate; bump if the chain rejects
   * with out-of-execution.
   */
  executionUnitLimit?: bigint;
}

export interface SpendingPolicyTxResult {
  /** Validated canonical native tx hash echoed by `mesh_submitTx`. */
  txHash: string;
}

function bigintToHex(n: bigint): string {
  return "0x" + n.toString(16);
}

/**
 * Submit a spending-policy precompile call (register / enable / disable). The
 * PRINCIPAL signs + submits the OUTER tx via the SDK PLAINTEXT path
 * (`submitTransaction` -> `mesh_submitTx`, with the node-echoed canonical tx
 * hash validated) — the chain's sole inclusion path since the v2 re-genesis
 * dropped the encrypted mempool. `tx.to` is the spending-policy precompile
 * and `tx.value` is 0 (the policy write carries no native value — funding
 * the sub-account is a separate sendLyth).
 *
 * Fees use the SDK's REGISTRY defaults (`resolveRegistryExecutionFee`): the
 * register/claim path carries ~5.3 KB of pubkey+sig and the register_op
 * verify burns ~151k execution units, so the default limit is the raised
 * 250k registry limit, with the per-unit price derived from the live quote
 * and the priority tip clamped to it.
 */
export async function submitSpendingPolicyTx(
  args: SubmitSpendingPolicyTxArgs,
): Promise<SpendingPolicyTxResult> {
  const rpc = getProvider().rpcClient;
  const fromHex = typedBech32ToAddress(args.fromBech32m, "user").hex;

  const [nonce, chainId] = await Promise.all([
    rpc.ethGetTransactionCount(fromHex, "pending"),
    rpc.ethChainId(),
  ]);

  // Registry/claim fee defaults: raised 250k limit + per-unit price derived
  // from the live quote (with the priority tip clamped to the max), so the
  // BLS-PoP pairing verify does not revert and the plaintext path never hits
  // FeeMismatch.
  const fee = await resolveRegistryExecutionFee(rpc, {
    ...(args.executionUnitLimit !== undefined
      ? { executionUnitLimit: args.executionUnitLimit }
      : {}),
  });

  const tx: NativeEvmTxFields = {
    chainId: bigintToHex(chainId),
    nonce: bigintToHex(nonce),
    gasLimit: bigintToHex(fee.gasLimit),
    maxFeePerGas: bigintToHex(fee.maxFeePerGas),
    maxPriorityFeePerGas: bigintToHex(fee.maxPriorityFeePerGas),
    to: SPENDING_POLICY_PRECOMPILE,
    value: "0x0",
    input: args.data,
  };

  const backend = await args.unlockBackend();
  // Plaintext mesh_submitTx — the chain's sole inclusion path; returns the
  // validated canonical native tx hash.
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  return { txHash };
}

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

function byteLength(input: Uint8Array | readonly number[] | string): number {
  if (typeof input === "string") {
    const stripped =
      input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
    return Math.floor(stripped.length / 2);
  }
  return input.length;
}
