// Send-LYTH composer.
//
// Ties the chain-IO seam (`MonolythiumProvider`) to the signer factory
// (`MonolythiumSigner`) into a single async function the
// OperationsDrawer's `request.execute()` can call. The drawer owns UI
// state; this module owns "what does Send actually do on the wire."
//
// Stages of a real send:
//   1. read sender nonce + native fee data from the provider (no key access yet);
//   2. build an ethers TransactionRequest with an explicit execution-unit limit;
//   3. ask the signer for a fully-signed RLP (biometric flow unlocks the
//      vault, decrypts the secp256k1 key, and signs in-memory);
//   4. broadcastTransaction via the provider; the SDK transport carries it.
//
// We keep the ethers-compatible type-2 envelope while the SDK signer expects
// that shape. If the node does not surface native fee data (sandbox / fresh
// devnet), we surface that as an error instead of composing an ambiguous tx.

import type { TransactionRequest } from "ethers";
import {
  parseLythToLythoshi,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import type { MonolythiumSigner } from "@monolythium/core-sdk/ethers";
import { getProvider } from "./client";

export interface SendLythArgs {
  /** Typed ADR-0038 user address to debit. Must match the signer's address. */
  from: string;
  /** Typed ADR-0038 user recipient. */
  to: string;
  /** Decimal LYTH string, e.g. "12.5"; parsed as 8-decimal native lythoshi. */
  amountLyth: string;
  /** Optional execution-unit limit override (default 21_000 for a plain transfer). */
  executionUnitLimit?: bigint;
  /**
   * Optional explicit chain id. When omitted we use whatever the
   * provider's `getNetwork()` returns — the right answer for the happy
   * path and avoids drift if a future stage wires multi-network support.
   */
  chainId?: bigint;
  /** Optional hex data payload; most plain transfers leave this empty. */
  data?: string;
}

export interface SendLythResult {
  txHash: string;
  /** Raw signed tx bytes that were broadcast (`0x`-hex). */
  rawSigned: string;
  /** Final TransactionRequest snapshot — useful for the Done pane diff. */
  request: TransactionRequest;
}

/**
 * Compose a real Send LYTH against the live testnet via
 * `MonolythiumProvider` + `MonolythiumSigner`. Throws on any wire-level
 * failure so the OperationsDrawer can promote the drawer to its `done`
 * stage with an error; the caller is responsible for clearing sensitive
 * UI state.
 */
export async function sendLyth(
  signer: MonolythiumSigner,
  args: SendLythArgs,
): Promise<SendLythResult> {
  const fromHex = requireTypedUserAddressHex(args.from, "from");
  const toHex = requireTypedUserAddressHex(args.to, "to");
  const provider = getProvider();

  // 1. Sender nonce + native fee data + chain id, in parallel.
  const [nonce, feeData, network] = await Promise.all([
    provider.getTransactionCount(fromHex, "pending"),
    provider.getFeeData(),
    provider.getNetwork(),
  ]);

  if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) {
    throw new Error(
      "node did not surface native execution fee data; check that the RPC endpoint implements fee-history support",
    );
  }

  const chainId = args.chainId ?? network.chainId;
  const executionUnitLimit = args.executionUnitLimit ?? 21_000n;

  // 2. Build the ethers-compatible TransactionRequest.
  const request: TransactionRequest = {
    type: 2, // EIP-1559
    chainId,
    nonce,
    from: fromHex,
    to: toHex,
    value: parseLythToLythoshi(args.amountLyth),
    data: args.data ?? "0x",
    gasLimit: executionUnitLimit,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  };

  // 3. Sign — the signer is responsible for routing to whichever backend
  //    the user picked (biometric+vault, future hardware). We don't peek
  //    inside the signer here.
  const rawSigned = await signer.signTransaction(request);

  // 4. Broadcast — provider.broadcastTransaction returns a TransactionResponse
  //    with the canonical hash the node accepted.
  const broadcast = await provider.broadcastTransaction(rawSigned);

  return {
    txHash: broadcast.hash,
    rawSigned,
    request,
  };
}

function requireTypedUserAddressHex(address: string, label: string): string {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    throw new Error(`${label} raw 0x addresses are retired; use a typed mono1 address`);
  }
  try {
    return typedBech32ToAddress(address, "user").hex;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} must be a typed mono1 address: ${message}`);
  }
}
