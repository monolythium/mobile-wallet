// Live chain-registry fetcher — pulls testnet-69420 metadata from
// https://raw.githubusercontent.com/monolythium/chain-registry/master/chains/
// so the About page surfaces the canonical "what the registry says
// today" genesis_hash + binary_sha without waiting for the next SDK
// publish + wallet bump.
//
// 5-minute in-memory TTL; falls back to the SDK-bundled snapshot when
// the GitHub fetch fails. Same shape as browser-wallet's
// shared/live-registry.ts so the two wallets stay aligned.

import {
  fetchChainInfoLatest,
  type ChainInfo,
} from "@monolythium/core-sdk";

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  info: ChainInfo;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<ChainInfo | null> | null = null;

export async function fetchLiveTestnetRegistry(): Promise<ChainInfo | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.info;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const info = await fetchChainInfoLatest("testnet-69420");
      cache = { fetchedAt: Date.now(), info };
      return info;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function getCachedLiveTestnetRegistry(): ChainInfo | null {
  if (!cache) return null;
  if (Date.now() - cache.fetchedAt >= TTL_MS) return null;
  return cache.info;
}

export function resetLiveRegistryCacheForTest(): void {
  cache = null;
  inFlight = null;
}
