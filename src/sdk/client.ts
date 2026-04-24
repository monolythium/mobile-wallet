// Thin wrapper around @monolythium/core-sdk RpcClient.
// Centralises endpoint configuration so screens never hand-craft RPC JSON
// (mono-core-sdk is the single seam, per workspace CLAUDE §6).

import { RpcClient } from "@monolythium/core-sdk";

// LythiumDAG-BFT testnet HTTP RPC (chain_id 6940). Override via
// VITE_MONO_RPC_URL at build time when targeting a local node.
const DEFAULT_RPC_ENDPOINT = "https://testnet-rpc.monolythium.io";

const endpoint =
  (import.meta.env.VITE_MONO_RPC_URL as string | undefined) ?? DEFAULT_RPC_ENDPOINT;

export const rpc = new RpcClient(endpoint, {
  headers: {
    "x-mono-client": "monolythium-wallet-mobile/0.0.1",
  },
});

export interface ChainStatus {
  chainId: number;
  blockNumber: number;
  endpoint: string;
}

/**
 * Happy-path probe used on app mount. Returns a small status object the
 * UI can render; throws SdkError on transport / RPC failure so the caller
 * can render a degraded state without guessing.
 */
export async function fetchChainStatus(): Promise<ChainStatus> {
  const [chainId, blockNumber] = await Promise.all([
    rpc.ethChainId(),
    rpc.ethBlockNumber(),
  ]);
  return { chainId, blockNumber, endpoint };
}
