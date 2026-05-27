// Chain-IO seam for the mobile wallet (post-ethers).
//
// Mono-core-sdk 0.3.1 dropped the `MonolythiumProvider` ethers shim
// alongside the no-EVM chain retirement (mono-core b2f0c498). The
// wallet now talks to a plain SDK `RpcClient` instance; ethers-shaped
// callers (block/balance/network) go through native `eth_*` /
// `lyth_*` reads on the RpcClient directly.
//
// `mono-core-sdk` is still the single seam — screens never construct
// an `RpcClient` of their own.

import {
  LYTHOSHI_PER_LYTH,
  RpcClient,
  SdkError,
  getRpcEndpoints,
  type RpcClientOptions,
} from "@monolythium/core-sdk";

/**
 * Default RPC endpoint. Honors `VITE_MONO_RPC_URL` at build time so a
 * release bundle can pin to a specific endpoint without a code change.
 *
 * The fallback points at the SDK-bundled chain-registry testnet endpoint
 * (chain id 69420), not a stale DNS alias.
 */
function defaultEndpoint(): string {
  const fromEnv = import.meta.env.VITE_MONO_RPC_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  if (import.meta.env.DEV) return "/rpc";
  return getRpcEndpoints("testnet-69420")[0]?.url ?? "http://localhost:8548";
}

let _client: RpcClient | null = null;

/**
 * Lazily-constructed singleton `RpcClient`. First call constructs;
 * subsequent calls reuse the same instance + transport. A thin shim
 * exposes `.rpcClient` self-reference so existing consumers that wrote
 * `getProvider().rpcClient.<method>` keep compiling unchanged after
 * the ethers-shim removal — the property points at the client itself.
 */
export interface ProviderHandle {
  rpcClient: RpcClient;
}

export function getProvider(options: RpcClientOptions = {}): ProviderHandle {
  if (_client === null) {
    _client = new RpcClient(defaultEndpoint(), {
      headers: {
        "x-mono-client": "monolythium-wallet-mobile/0.1.2",
      },
      ...options,
    });
  }
  return { rpcClient: _client };
}

/**
 * Reset the singleton — used by tests so each case can stand up its own
 * client with a stub `fetch`. Production code never calls this.
 */
export function resetProviderForTest(): void {
  _client = null;
}

/**
 * Inject a fully-constructed `RpcClient` as the singleton.
 * Test-only; production code goes through `getProvider()` and lets the
 * lazy initializer pick up `VITE_MONO_RPC_URL`.
 */
export function setProviderForTest(client: RpcClient): void {
  _client = client;
}

/**
 * Lightweight chain status used by the Home screen halo.
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
  const rpc = getProvider().rpcClient;
  const [chainId, blockNumber] = await Promise.all([
    rpc.ethChainId(),
    rpc.ethBlockNumber(),
  ]);
  return {
    chainId,
    blockNumber,
    endpoint: rpc.endpoint,
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
  /** Decimal LYTH as a JS number; for display only (1 LYTH = 1e8 lythoshi). */
  balanceLyth: number;
  /** Raw lythoshi as a `0x`-quantity string straight off the wire. */
  balanceLythoshiHex: string;
  /** Stringified for UI consumption; original SdkError preserved if applicable. */
  error: { kind: string; message: string } | null;
}

export async function loadChainSnapshot(address: string): Promise<ChainSnapshot> {
  const rpc = getProvider().rpcClient;
  const endpoint = rpc.endpoint;
  try {
    const [chainId, blockHeight, balanceProof] = await Promise.all([
      rpc.ethChainId(),
      rpc.ethBlockNumber(),
      rpc.ethGetBalance(address),
    ]);
    // ethGetBalance returns an AccountProofResponse { blockNumber, proof,
    // stateRoot, value } where `value` is the lythoshi hex quantity.
    const lythoshiHex = balanceProof.value ?? "0x0";
    return {
      endpoint,
      chainId,
      blockHeight,
      balanceLythoshiHex: lythoshiHex,
      balanceLyth: lythoshiHexToLyth(lythoshiHex),
      error: null,
    };
  } catch (cause) {
    return {
      endpoint,
      chainId: 0n,
      blockHeight: null,
      balanceLythoshiHex: "0x0",
      balanceLyth: 0,
      error: unwrapError(cause),
    };
  }
}

/**
 * Normalize whatever the SDK transport surfaced into a plain
 * `{ kind, message }` pair the UI can render.
 */
function unwrapError(cause: unknown): { kind: string; message: string } {
  if (cause instanceof SdkError) {
    return { kind: cause.kind, message: cause.message };
  }
  const message = (cause as Error)?.message ?? String(cause);
  return { kind: "unknown", message };
}

/** Convert a `0x`-quantity lythoshi string to a LYTH JS number. */
export function lythoshiHexToLyth(hex: string): number {
  if (!hex || !hex.startsWith("0x")) return 0;
  const trimmed = hex === "0x" ? "0x0" : hex;
  try {
    const lythoshi = BigInt(trimmed);
    if (lythoshi === 0n) return 0;
    const lythWhole = lythoshi / LYTHOSHI_PER_LYTH;
    const lythFraction = lythoshi % LYTHOSHI_PER_LYTH;
    return Number(lythWhole) + Number(lythFraction) / Number(LYTHOSHI_PER_LYTH);
  } catch {
    return 0;
  }
}

export { SdkError };
