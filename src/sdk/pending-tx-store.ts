// Durable tracked-tx store — @tauri-apps/plugin-store-backed registry of txs
// awaiting their terminal receipt, with an in-memory cache and a subscribe
// API.
//
// Mirrors `notifications-store.ts` exactly (single JSON file, lazy
// `Store.load`, in-memory cache, listener emit) so the two stores read the
// same way. The reconcile poller (`reconcile.ts`) is the only consumer that
// removes entries; the enqueue path adds them when an operation that sets a
// `notify` descriptor returns a canonical tx hash.
//
// Schema (file `pending-tx.v1.json`):
//
//   {
//     "networkScope": {
//       "schemaVersion": 0,
//       "id": "testnet-69420:69420:<genesis hash>"
//     },
//     "pending": { "schemaVersion": 0, "entries": PendingTx[] }
//   }
//
// The mobile wallet binds a single vault address at a time, so — like the
// notifications store — the registry lives in one global file. The entry's
// dedupe key still embeds `chainIdHex` (`pendingTxKey`), while the store-level
// network scope embeds the canonical genesis. A testnet re-genesis therefore
// clears old tracked txs before the poller can query their hashes on the new
// chain. A legacy file without a scope is cleared once and stamped.
//
// Persistence is the whole point: an entry written here survives the
// OperationsDrawer being dismissed AND a full app restart, so the app-level
// poller can carry the tx to its real terminal state long after the sheet
// that submitted it is gone.

import { Store } from "@tauri-apps/plugin-store";
import {
  PENDING_TX_CAP,
  appendPendingCapped,
  parsePendingTxEnvelope,
  pendingTxKey,
  removePendingByKeys,
  type PendingTx,
} from "./pending-tx";
import {
  parsePersistenceScopeEnvelope,
  resolvePersistenceScope,
  selectPersistenceScopeId,
} from "./persistence-scope";

const STORE_FILE = "pending-tx.v1.json";
const PENDING_KEY = "pending" as const;
const NETWORK_SCOPE_KEY = "networkScope" as const;

// In-memory cache of the registry, newest-first. Synchronous reads (the
// poller's gate, render paths) consult this; `hydratePendingTxs()` refreshes
// it from disk.
let pendingCache: PendingTx[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to registry changes. Returns an unsubscribe fn. */
export function subscribePendingTxs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_FILE);
  }
  return storePromise;
}

/** Ensure disk + cache belong to the canonical genesis before any read/write.
 *
 * A missing/mismatched scope is fail-closed: discard old pending hashes,
 * stamp the new identity, then save both together. When the live registry is
 * unavailable, an existing stamp wins over the SDK fallback so a transient
 * outage cannot roll the scope backward in a stale build. */
async function ensureNetworkScope(store: Store): Promise<void> {
  const persisted = parsePersistenceScopeEnvelope(
    await store.get<unknown>(NETWORK_SCOPE_KEY),
  );
  const resolved = await resolvePersistenceScope();
  const targetId = selectPersistenceScopeId(resolved, persisted);
  if (persisted?.id === targetId) return;

  await store.set(PENDING_KEY, { schemaVersion: 0, entries: [] });
  await store.set(NETWORK_SCOPE_KEY, { schemaVersion: 0, id: targetId });
  await store.save();

  const changed = pendingCache.length !== 0;
  pendingCache = [];
  if (changed) emit();
}

/** Synchronous, render-safe read of the cached registry (newest-first).
 *  Empty before hydration. The poller's "≥1 pending" gate reads this. */
export function pendingTxsSnapshot(): PendingTx[] {
  return pendingCache;
}

/** Load the persisted registry into the cache. Safe to call repeatedly: each
 *  read first checks the canonical genesis scope. Falls back to an empty
 *  registry if the store is unreadable (e.g. desktop dev hosts without a
 *  store surface) so the app degrades to master behaviour. Idempotent emit:
 *  only notifies when the cache actually changed. */
export async function hydratePendingTxs(): Promise<void> {
  let next: PendingTx[] = [];
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    const env = parsePendingTxEnvelope(await store.get<unknown>(PENDING_KEY));
    next = env?.entries ?? [];
  } catch {
    // Keep the empty default.
  }
  if (!sameRegistry(pendingCache, next)) {
    pendingCache = next;
    emit();
  }
}

/** Persist the entries to disk and reconcile the cache. Best-effort: a store
 *  failure leaves the cache as-is and reports `false` (the caller never lets
 *  a persistence hiccup break the operation flow). */
async function writePending(entries: PendingTx[]): Promise<boolean> {
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    await store.set(PENDING_KEY, { schemaVersion: 0, entries });
    await store.save();
    pendingCache = entries;
    emit();
    return true;
  } catch {
    return false;
  }
}

/** Enqueue a tracked tx. Idempotent on `(chainIdHex, txHash)` via
 *  {@link appendPendingCapped}: a second enqueue of the same tx is a no-op
 *  that preserves the original submit time. Best-effort — any store failure
 *  is swallowed and reported as `{ added: false }` so a failed enqueue never
 *  breaks the calling operation.
 *
 *  NOTE: this does NOT consult the notifications dedupe-set; the reconcile
 *  loop's `recordNotification` call is the single chokepoint that enforces
 *  "notify at most once per (chain, hash)". Re-enqueuing an already-notified
 *  tx is harmless: the poller will probe it, `recordNotification` will return
 *  `added:false`, and the entry is removed. */
export async function enqueuePendingTx(
  entry: PendingTx,
): Promise<{ added: boolean }> {
  // Read-through hydrate every time so we never merge a fresh tx into cache
  // that belongs to the previous genesis.
  await hydratePendingTxs();
  const next = appendPendingCapped(pendingCache, entry, PENDING_TX_CAP);
  if (next === pendingCache) return { added: false };
  const ok = await writePending(next);
  return { added: ok };
}

/** Remove tracked txs by their `(chainIdHex, txHash)` keys. Called by the
 *  reconcile loop once a tx reaches a terminal state OR exceeds its window.
 *  No-op (no write) when nothing matched. Best-effort. */
export async function removePendingTxs(
  keys: ReadonlySet<string>,
): Promise<{ removed: number }> {
  if (keys.size === 0) return { removed: 0 };
  // A re-genesis may have happened since the last poll tick. Refresh before
  // deriving survivors so old entries cannot be resurrected after a scope
  // migration.
  await hydratePendingTxs();
  const next = removePendingByKeys(pendingCache, keys);
  if (next === pendingCache) return { removed: 0 };
  const removed = pendingCache.length - next.length;
  await writePending(next);
  return { removed };
}

/** Read of the tracked-tx registry, newest-first. Refreshes the cache and its
 *  genesis scope so the synchronous snapshot is warm and current. */
export async function listPendingTxs(): Promise<PendingTx[]> {
  // Re-check even after hydration so a canonical registry change observed
  // during a long-running app session clears stale tx hashes before polling.
  await hydratePendingTxs();
  return pendingCache;
}

/** Reset module state — test-only so each case starts from a cold cache.
 *  Production code never calls this. */
export function resetPendingTxsForTest(): void {
  pendingCache = [];
  storePromise = null;
  listeners.clear();
}

/** Shallow registry-equality on the fields that drive a re-render / re-poll
 *  (the dedupe key). Avoids emitting when hydration produced a structurally
 *  identical registry. */
function sameRegistry(a: PendingTx[], b: PendingTx[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (pendingTxKey(x.chainIdHex, x.txHash) !== pendingTxKey(y.chainIdHex, y.txHash)) {
      return false;
    }
  }
  return true;
}
