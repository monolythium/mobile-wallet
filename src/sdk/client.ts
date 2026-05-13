// Chain-IO seam for the mobile wallet.
//
// We construct a single `MonolythiumProvider` (the ethers v6 shim that
// `@monolythium/core-sdk` ships as of Stage 3 of the SDK roadmap) so every
// chain read AND every signed broadcast share one transport, one network
// registration, and one error-shape contract. Ethers callers
// (`provider.getBlockNumber`, `provider.broadcastTransaction`) flow
// straight through; native callers can still reach `lyth_*` methods via
// `provider.rpcClient.call(...)`.
//
// `mono-core-sdk` is the single seam — screens never construct an
// `RpcClient` directly (per workspace CLAUDE §6).

import { MonolythiumProvider, SdkError } from "@monolythium/core-sdk";
import type { MonolythiumProviderOptions } from "@monolythium/core-sdk";

/**
 * Default RPC endpoint. Honors `VITE_MONO_RPC_URL` at build time so a
 * release bundle can pin to a specific endpoint without a code change.
 *
 * The fallback points at the live LythiumDAG-BFT testnet (chain id 69420).
 */
function defaultEndpoint(): string {
  const fromEnv = import.meta.env.VITE_MONO_RPC_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return "https://testnet-rpc.monolythium.io";
}

let _provider: MonolythiumProvider | null = null;

/**
 * Lazily-constructed singleton ethers `MonolythiumProvider`. The shim
 * registers the `monolythium-testnet` network with ethers' global
 * registry on first use; subsequent calls reuse the same instance and
 * the same underlying `RpcClient` transport.
 */
export function getProvider(
  options: MonolythiumProviderOptions = {},
): MonolythiumProvider {
  if (_provider === null) {
    _provider = new MonolythiumProvider(defaultEndpoint(), {
      headers: {
        "x-mono-client": "monolythium-wallet-mobile/0.0.1",
      },
      ...options,
    });
  }
  return _provider;
}

/**
 * Reset the singleton — used by tests so each case can stand up its own
 * provider with a stub `fetch`. Production code never calls this.
 */
export function resetProviderForTest(): void {
  _provider = null;
}

/**
 * Inject a fully-constructed `MonolythiumProvider` as the singleton.
 * Test-only; production code goes through `getProvider()` and lets the
 * lazy initializer pick up `VITE_MONO_RPC_URL`.
 */
export function setProviderForTest(provider: MonolythiumProvider): void {
  _provider = provider;
}

/**
 * Lightweight chain status used by the Home screen halo. The shape
 * preserves the previous `fetchChainStatus()` contract; only the types
 * widened — `chainId` and `blockNumber` are now `bigint` to match the
 * SDK 0.1.0 ethers shim (which exposes `Network.chainId: bigint` and
 * `getBlockNumber(): Promise<number>` — wrapped to bigint here so the
 * UI never sees a mixed numeric type).
 */
export interface ChainStatus {
  chainId: bigint;
  blockNumber: bigint;
  endpoint: string;
}

/**
 * Happy-path probe used on app mount. Returns a small status object the
 * UI can render; throws on transport / RPC failure so the caller can
 * render a degraded state without guessing.
 */
export async function fetchChainStatus(): Promise<ChainStatus> {
  const provider = getProvider();
  const [network, blockNumber] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
  ]);
  return {
    chainId: network.chainId,
    blockNumber: BigInt(blockNumber),
    endpoint: provider.rpcClient.endpoint,
  };
}

/**
 * Bound-address chain snapshot. Layered on top of `fetchChainStatus` —
 * adds `eth_getBalance` for the supplied address. Returns a discriminated
 * value rather than throwing so the caller can render an offline state
 * without unwinding.
 */
export interface ChainSnapshot {
  endpoint: string;
  chainId: bigint;
  blockHeight: bigint | null;
  /** Decimal LYTH as a JS number; for display only (1 LYTH = 1e18 wei). */
  balanceLyth: number;
  /** Raw wei as a `0x`-quantity string straight off the wire. */
  balanceWei: string;
  /** Stringified for UI consumption; original SdkError preserved if applicable. */
  error: { kind: string; message: string } | null;
}

export async function loadChainSnapshot(address: string): Promise<ChainSnapshot> {
  const provider = getProvider();
  const endpoint = provider.rpcClient.endpoint;
  try {
    const [network, blockHeight, balanceWei] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
      provider.getBalance(address),
    ]);
    const wei = `0x${balanceWei.toString(16)}`;
    return {
      endpoint,
      chainId: network.chainId,
      blockHeight: BigInt(blockHeight),
      balanceWei: wei,
      balanceLyth: weiToLyth(wei),
      error: null,
    };
  } catch (cause) {
    return {
      endpoint,
      chainId: 0n,
      blockHeight: null,
      balanceWei: "0x0",
      balanceLyth: 0,
      error: unwrapError(cause),
    };
  }
}

/**
 * Normalize whatever the ethers/SDK transport surfaced into a plain
 * `{ kind, message }` pair the UI can render. Ethers wraps SDK errors in
 * its own envelope, so we unwrap one level; we don't try to be smarter.
 */
function unwrapError(cause: unknown): { kind: string; message: string } {
  if (cause instanceof SdkError) {
    return { kind: cause.kind, message: cause.message };
  }
  if (cause && typeof cause === "object" && "error" in cause) {
    const inner = (cause as { error?: unknown }).error;
    if (inner instanceof SdkError) {
      return { kind: inner.kind, message: inner.message };
    }
  }
  const message = (cause as Error)?.message ?? String(cause);
  return { kind: "unknown", message };
}

/** Convert a `0x`-quantity wei string to a LYTH JS number (1 LYTH = 1e18 wei). */
export function weiToLyth(hex: string): number {
  if (!hex || !hex.startsWith("0x")) return 0;
  const trimmed = hex === "0x" ? "0x0" : hex;
  try {
    const wei = BigInt(trimmed);
    if (wei === 0n) return 0;
    const lythWhole = wei / 1_000_000_000_000_000_000n;
    const lythFrac = wei % 1_000_000_000_000_000_000n;
    return Number(lythWhole) + Number(lythFrac) / 1e18;
  } catch {
    return 0;
  }
}

export { SdkError };
