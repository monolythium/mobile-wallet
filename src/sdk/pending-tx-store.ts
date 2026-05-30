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
//   { "pending": { "schemaVersion": 0, "entries": PendingTx[] } }
//
// The mobile wallet binds a single vault address at a time, so — like the
// notifications store — the registry lives in one global file. The entry's
// dedupe key still embeds `chainIdHex` (`pendingTxKey`), so the same tx hash
// on two chains is two distinct tracked txs.
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

const STORE_FILE = "pending-tx.v1.json";
const PENDING_KEY = "pending" as const;

// In-memory cache of the registry, newest-first. Synchronous reads (the
// poller's gate, render paths) consult this; `hydratePendingTxs()` refreshes
// it from disk.
let pendingCache: PendingTx[] = [];
let hydrated = false;

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

/** Synchronous, render-safe read of the cached registry (newest-first).
 *  Empty before hydration. The poller's "≥1 pending" gate reads this. */
export function pendingTxsSnapshot(): PendingTx[] {
  return pendingCache;
}

/** Load the persisted registry into the cache (call once on mount, and the
 *  store reconciles it after every write). Falls back to an empty registry
 *  if the store is unreadable (e.g. desktop dev hosts without a store
 *  surface) so the app degrades to master behaviour. Idempotent emit: only
 *  notifies when the cache actually changed. */
export async function hydratePendingTxs(): Promise<void> {
  let next: PendingTx[] = [];
  try {
    const store = await getStore();
    const env = parsePendingTxEnvelope(await store.get<unknown>(PENDING_KEY));
    next = env?.entries ?? [];
  } catch {
    // Keep the empty default.
  }
  hydrated = true;
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
  // Read-through hydrate so we never clobber on-disk entries with a stale
  // (empty) cache on the first enqueue of a session.
  if (!hydrated) await hydratePendingTxs();
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
  if (!hydrated) await hydratePendingTxs();
  const next = removePendingByKeys(pendingCache, keys);
  if (next === pendingCache) return { removed: 0 };
  const removed = pendingCache.length - next.length;
  await writePending(next);
  return { removed };
}

/** Read of the tracked-tx registry, newest-first. Hydrates the cache on
 *  first call so the synchronous snapshot is warm. */
export async function listPendingTxs(): Promise<PendingTx[]> {
  if (!hydrated) await hydratePendingTxs();
  return pendingCache;
}

/** Reset module state — test-only so each case starts from a cold cache.
 *  Production code never calls this. */
export function resetPendingTxsForTest(): void {
  pendingCache = [];
  hydrated = false;
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
