// Send-LYTH composer.
//
// Ties the chain-IO seam (`MonolythiumProvider`) to the signer factory
// (`MonolythiumSigner`) into a single async function the
// OperationsDrawer's `request.execute()` can call. The drawer owns UI
// state; this module owns "what does Send actually do on the wire."
//
// Stages of a real send:
//   1. read sender nonce + fee data from the provider (no key access yet);
//   2. build an EIP-1559 TransactionRequest with explicit gas limits;
//   3. ask the signer for a fully-signed RLP (biometric flow unlocks the
//      vault, decrypts the secp256k1 key, and signs in-memory);
//   4. broadcastTransaction via the provider; the SDK transport carries it.
//
// We deliberately do NOT swap to legacy txs even when the provider's
// `feeData()` reports a zero `maxFeePerGas` — Monolythium v2 is
// EIP-1559-only at the wire level. If the node doesn't surface fee data
// (sandbox / fresh devnet), we surface that as an error instead of
// falling back to a legacy tx the chain wouldn't accept.

import { parseEther } from "ethers";
import type { TransactionRequest } from "ethers";
import type { MonolythiumSigner } from "@monolythium/core-sdk";
import { getProvider } from "./client";

export interface SendLythArgs {
  /** EIP-55 lowercase address to debit. Must match the signer's address. */
  from: string;
  /** EIP-55 lowercase recipient. */
  to: string;
  /** Decimal LYTH string, e.g. "12.5". 1 LYTH = 1e18 wei. */
  amountLyth: string;
  /** Optional gas limit override (default 21_000 for a plain transfer). */
  gasLimit?: bigint;
  /**
   * Optional explicit chain id. When omitted we use whatever the
   * provider's `getNetwork()` returns — the right answer for the happy
   * path and avoids drift if a future stage wires multi-network support.
   */
  chainId?: bigint;
  /** Optional ETH-style data payload — most plain transfers leave this empty. */
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
  const provider = getProvider();

  // 1. Sender nonce + fee data + chain id, in parallel.
  const [nonce, feeData, network] = await Promise.all([
    provider.getTransactionCount(args.from, "pending"),
    provider.getFeeData(),
    provider.getNetwork(),
  ]);

  if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) {
    throw new Error(
      "node did not surface EIP-1559 fee data (maxFeePerGas / maxPriorityFeePerGas) — check that the node implements eth_feeHistory",
    );
  }

  const chainId = args.chainId ?? network.chainId;

  // 2. Build the EIP-1559 TransactionRequest.
  const request: TransactionRequest = {
    type: 2, // EIP-1559
    chainId,
    nonce,
    from: args.from,
    to: args.to,
    value: parseEther(args.amountLyth),
    data: args.data ?? "0x",
    gasLimit: args.gasLimit ?? 21_000n,
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
