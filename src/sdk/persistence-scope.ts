// Runtime identity for state that must not survive a chain re-genesis.
//
// Chain id 69420 intentionally stays stable across testnet resets, so it is
// not enough to scope pending transactions or notification dedupe state.
// Prefer the live chain-registry genesis and fall back to the SDK snapshot
// only when the registry cannot be reached. Stores preserve an already
// stamped scope while running on that fallback, which prevents a transient
// registry outage in an older wallet build from "downgrading" the scope and
// deleting state a second time.

import { getChainInfo } from "@monolythium/core-sdk";
import { fetchLiveTestnetRegistry } from "./live-registry";

const TESTNET_NETWORK = "testnet-69420";

export interface PersistenceScope {
  id: string;
  source: "live" | "bundled";
}

export interface PersistenceScopeEnvelope {
  schemaVersion: 0;
  id: string;
}

/** Resolve the canonical identity used by re-genesis-sensitive stores. */
export async function resolvePersistenceScope(): Promise<PersistenceScope> {
  const live = await fetchLiveTestnetRegistry();
  const info = live ?? getChainInfo(TESTNET_NETWORK);
  const genesisHash = normalizeGenesisHash(info.genesis_hash);
  return {
    id: `${info.network}:${info.chain_id}:${genesisHash}`,
    source: live ? "live" : "bundled",
  };
}

/** Tolerant persisted-envelope parser. Unknown schemas are treated as legacy. */
export function parsePersistenceScopeEnvelope(
  input: unknown,
): PersistenceScopeEnvelope | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 0) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  return { schemaVersion: 0, id: value.id };
}

/** A fallback SDK pin must not overwrite a previously live-stamped scope. */
export function selectPersistenceScopeId(
  resolved: PersistenceScope,
  persisted: PersistenceScopeEnvelope | null,
): string {
  if (resolved.source === "bundled" && persisted) return persisted.id;
  return resolved.id;
}

function normalizeGenesisHash(input: string): string {
  return input.trim().toLowerCase();
}
