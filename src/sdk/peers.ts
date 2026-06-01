// Peer (RPC endpoint) catalogue + latency probing for the "Change peer"
// screen.
//
// The wallet talks to exactly one RPC endpoint at a time (see `client.ts`).
// This module owns:
//   - `listPeers()`     — the candidate set: the wallet's gateway constant
//                          plus the 14 official chain-registry endpoints,
//                          de-duped by URL.
//   - `probePeer(url)`  — a timed `eth_chainId` JSON-RPC POST that reports
//                          reachability, latency, and whether the peer is on
//                          the right chain (69420 / 0x10f2c). A peer that
//                          answers but on the WRONG chain is reachable yet
//                          NOT eligible — switching to it would silently move
//                          the wallet to a different network, so we never do.
//   - `pickFastest()`   — pure selection over probe results: lowest latency
//                          among reachable + chain-matching peers, tie-broken
//                          by highest observed block height.
//   - persistence       — the selected endpoint URL, stored in the same
//                          plaintext plugin-store primitive `contacts.ts` and
//                          `feature-flags.ts` use (it's not secret).
//
// HONESTY: nothing here invents a latency or a block height. An unreachable
// or wrong-chain peer is reported as such; the UI renders those states
// explicitly rather than masking them behind a plausible number.

import { Store } from "@tauri-apps/plugin-store";
import { getRpcEndpoints } from "@monolythium/core-sdk";

/** Testnet chain id the wallet is pinned to (69420 = 0x10f2c). A probed
 *  peer MUST report this exact id to be eligible for selection. */
export const EXPECTED_CHAIN_ID = 69420n;

/** Default probe timeout. Kept short so a screen-load probe of ~15 peers
 *  doesn't hang on one dead host. */
export const PROBE_TIMEOUT_MS = 4000;

/** Network slug the SDK registry indexes the endpoints under. */
const NETWORK_SLUG = "testnet-69420";

/**
 * The wallet's built-in gateway endpoint. Mirrors `client.ts`'s default:
 * the first SDK-registry endpoint is the canonical gateway the wallet ships
 * pointed at. Kept as a named constant so the peer list always contains the
 * shipped default even if the registry order changes.
 */
export function gatewayEndpoint(): string {
  return getRpcEndpoints(NETWORK_SLUG)[0]?.url ?? "http://localhost:8548";
}

/** A selectable peer, flattened from the SDK registry shape into the fields
 *  the UI renders. */
export interface Peer {
  url: string;
  /** Human label — provider name, or the host when no provider is known. */
  label: string;
  /** Region tag (`fsn1`/`nbg1`/`hel1`/`ash`/`sin`/…) when the registry
   *  carries one, else null. */
  region: string | null;
  /** `official` (registry-listed) or `community`/`gateway`. */
  tier: string;
}

/**
 * The candidate peer set: the shipped gateway plus every official SDK
 * registry endpoint, de-duped by URL (the gateway is usually also the first
 * registry entry, so it would otherwise appear twice). Order is stable:
 * gateway first, then registry order.
 */
export function listPeers(): Peer[] {
  const peers: Peer[] = [];
  const seen = new Set<string>();

  const push = (peer: Peer): void => {
    if (seen.has(peer.url)) return;
    seen.add(peer.url);
    peers.push(peer);
  };

  const gateway = gatewayEndpoint();
  push({ url: gateway, label: hostOf(gateway), region: null, tier: "gateway" });

  for (const ep of getRpcEndpoints(NETWORK_SLUG)) {
    push({
      url: ep.url,
      label: ep.provider || hostOf(ep.url),
      region: ep.region ?? null,
      tier: ep.tier,
    });
  }

  return peers;
}

/** Outcome of probing a single peer. */
export interface ProbeResult {
  url: string;
  /** True iff the peer answered a well-formed `eth_chainId` within timeout. */
  reachable: boolean;
  /** Round-trip latency in ms when reachable, else null. */
  latencyMs: number | null;
  /** True iff the peer answered AND its chain id equals `EXPECTED_CHAIN_ID`.
   *  A reachable peer on the wrong chain has `reachable: true` but
   *  `chainIdOk: false` — it is never eligible for selection. */
  chainIdOk: boolean;
  /** Block height parsed from `eth_blockNumber`, when the probe could read
   *  it. Used only as a selection tie-breaker; null when unavailable. */
  blockHeight: bigint | null;
  /** Short reason a probe failed / was rejected, for the UI's honest state.
   *  null on a fully-successful, chain-matching probe. */
  reason: string | null;
}

interface RpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Probe one peer with a timed `eth_chainId` (and a best-effort
 * `eth_blockNumber`) JSON-RPC POST. Resolves with a `ProbeResult`; never
 * throws — a transport failure, timeout, malformed body, or RPC error all
 * map to a `reachable: false` / honest-`reason` result.
 *
 * `fetchImpl` is injectable so tests can drive the parser without a network;
 * production passes nothing and the global `fetch` is used.
 */
export async function probePeer(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = now();

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Math.round(now() - started));

    if (!res.ok) {
      return unreachable(url, `http ${res.status}`);
    }

    let body: RpcResponse;
    try {
      body = (await res.json()) as RpcResponse;
    } catch {
      return unreachable(url, "malformed response");
    }

    if (body.error) {
      return unreachable(url, body.error.message ?? "rpc error");
    }

    const chainId = parseHexBigInt(body.result);
    if (chainId === null) {
      return unreachable(url, "no chain id in response");
    }

    const chainIdOk = chainId === EXPECTED_CHAIN_ID;
    // Best-effort height read; failure here doesn't make the peer
    // unreachable — height is only a tie-breaker.
    const blockHeight = await readBlockHeight(url, fetchImpl, controller.signal);

    return {
      url,
      reachable: true,
      latencyMs,
      chainIdOk,
      blockHeight,
      reason: chainIdOk
        ? null
        : `wrong chain (${chainId.toString()} ≠ ${EXPECTED_CHAIN_ID.toString()})`,
    };
  } catch (cause) {
    const aborted =
      controller.signal.aborted || (cause as Error)?.name === "AbortError";
    return unreachable(url, aborted ? "timed out" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort `eth_blockNumber` read. Returns null on any failure — height
 *  is only a tie-breaker, never a reachability signal. */
async function readBlockHeight(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<bigint | null> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_blockNumber",
        params: [],
      }),
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as RpcResponse;
    if (body.error) return null;
    return parseHexBigInt(body.result);
  } catch {
    return null;
  }
}

/**
 * Pure selection: of the probe results, choose the fastest peer that is BOTH
 * reachable AND on the expected chain. Lowest `latencyMs` wins; ties break to
 * the highest observed `blockHeight`. Returns null when nothing is eligible
 * (all unreachable / all wrong-chain) — the caller surfaces an honest "no
 * healthy peer" state rather than picking a bad one.
 */
export function pickFastest(results: readonly ProbeResult[]): ProbeResult | null {
  let best: ProbeResult | null = null;
  for (const r of results) {
    if (!r.reachable || !r.chainIdOk || r.latencyMs === null) continue;
    if (best === null) {
      best = r;
      continue;
    }
    if (r.latencyMs < best.latencyMs!) {
      best = r;
    } else if (r.latencyMs === best.latencyMs!) {
      // Tie-break: prefer the higher block height (more caught-up peer).
      const a = r.blockHeight ?? -1n;
      const b = best.blockHeight ?? -1n;
      if (a > b) best = r;
    }
  }
  return best;
}

/** Latency band for the UI badge. Pure so it can be reasoned about + tested. */
export type LatencyBand = "ok" | "warn" | "slow";

export function latencyBand(latencyMs: number): LatencyBand {
  if (latencyMs < 300) return "ok";
  if (latencyMs < 1000) return "warn";
  return "slow";
}

// -----------------------------------------------------------------------------
// Persistence — selected endpoint URL, plaintext plugin-store (not secret).
// -----------------------------------------------------------------------------

const STORE_FILE = "peer.v1.json";
const SELECTED_KEY = "selectedEndpoint";

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_FILE);
  }
  return storePromise;
}

/** Read the persisted endpoint URL, or null when none has been chosen / the
 *  store is unreadable (desktop dev host). Never throws. */
export async function readSelectedEndpoint(): Promise<string | null> {
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(SELECTED_KEY);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the selected endpoint URL. Best-effort: a store-write failure
 *  (desktop dev host without a store surface) is swallowed so an in-session
 *  switch still works. */
export async function writeSelectedEndpoint(url: string): Promise<void> {
  try {
    const store = await getStore();
    await store.set(SELECTED_KEY, url);
    await store.save();
  } catch {
    // Best-effort; the in-memory client override still applies this session.
  }
}

/** Clear any persisted endpoint (revert to the shipped default on next
 *  boot). Best-effort. */
export async function clearSelectedEndpoint(): Promise<void> {
  try {
    const store = await getStore();
    await store.delete(SELECTED_KEY);
    await store.save();
  } catch {
    // Best-effort.
  }
}

/** Reset module state — test-only so each case starts cold. */
export function resetPeersForTest(): void {
  storePromise = null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function unreachable(url: string, reason: string): ProbeResult {
  return {
    url,
    reachable: false,
    latencyMs: null,
    chainIdOk: false,
    blockHeight: null,
    reason,
  };
}

/** Parse a `0x`-prefixed quantity into a bigint. Returns null for anything
 *  that isn't a non-empty hex quantity (so a missing / malformed `result`
 *  can never masquerade as chain id 0). */
function parseHexBigInt(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Short host label for a URL; falls back to the raw string when it isn't a
 *  parseable URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Monotonic-ish clock; `performance.now()` when available, else `Date.now`. */
function now(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
