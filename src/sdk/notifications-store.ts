// Notification store — @tauri-apps/plugin-store-backed history + dedupe set,
// with an in-memory cache and a subscribe API.
//
// Mirrors how `feature-flags.ts` uses plugin-store (single JSON file, lazy
// `Store.load`, in-memory cache, listener emit) and re-implements the
// browser wallet's `notifications-store.ts` semantics (record / list /
// markAllRead / unreadCount) on that primitive.
//
// Schema (file `notifications.v1.json`):
//
//   {
//     "networkScope": {
//       "schemaVersion": 0,
//       "id": "testnet-69420:69420:<genesis hash>"
//     },
//     "history":  { "schemaVersion": 0, "entries": NotificationRecord[] },
//     "notified": { "schemaVersion": 0, "ids": string[] }
//   }
//
// The mobile wallet binds a single vault address at a time, so — unlike the
// browser wallet's per-(address, chain) keys — history + dedupe live in one
// global file. The dedupe id still embeds `chainIdHex` (`notificationId`),
// while the store-level scope embeds the canonical genesis. History and the
// notified-id watermark are cleared together on a re-genesis. A legacy file
// without a scope is cleared once and stamped.
//
// Recording is the ONLY write path that creates a record, and it is called
// from exactly one chokepoint (the OperationsDrawer terminal transition).
// The notifications center is read-only against this store apart from the
// "mark all read" CTA. Render paths read the synchronous cache; a hook
// (`use-notifications.ts`) hydrates it once on mount and re-renders
// subscribers when the feed or unread count changes.

import { Store } from "@tauri-apps/plugin-store";
import {
  NOTIFICATION_HISTORY_CAP,
  appendCapped,
  notificationId,
  parseHistoryEnvelope,
  parseNotifiedSetEnvelope,
  type NotificationRecord,
  type TxOpKind,
} from "./notifications";
import {
  parsePersistenceScopeEnvelope,
  resolvePersistenceScope,
  selectPersistenceScopeId,
} from "./persistence-scope";

const STORE_FILE = "notifications.v1.json";
const HISTORY_KEY = "history" as const;
const NOTIFIED_KEY = "notified" as const;
const NETWORK_SCOPE_KEY = "networkScope" as const;

// In-memory cache of the history, newest-first. Synchronous reads (render
// paths) consult this; `hydrateNotifications()` refreshes it from disk.
let historyCache: NotificationRecord[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to feed changes. Returns an unsubscribe fn. */
export function subscribeNotifications(listener: Listener): () => void {
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

/** Ensure history + dedupe watermark belong to the canonical genesis before
 *  any read/write. Missing/mismatched scopes are cleared and stamped
 *  fail-closed. An existing live-derived stamp wins during a transient
 *  registry outage instead of being overwritten by a stale bundled pin. */
async function ensureNetworkScope(store: Store): Promise<void> {
  const persisted = parsePersistenceScopeEnvelope(
    await store.get<unknown>(NETWORK_SCOPE_KEY),
  );
  const resolved = await resolvePersistenceScope();
  const targetId = selectPersistenceScopeId(resolved, persisted);
  if (persisted?.id === targetId) return;

  await store.set(HISTORY_KEY, { schemaVersion: 0, entries: [] });
  await store.set(NOTIFIED_KEY, { schemaVersion: 0, ids: [] });
  await store.set(NETWORK_SCOPE_KEY, { schemaVersion: 0, id: targetId });
  await store.save();

  const changed = historyCache.length !== 0;
  historyCache = [];
  if (changed) emit();
}

/** Synchronous, render-safe read of the cached feed (newest-first). Empty
 *  before hydration. */
export function notificationsSnapshot(): NotificationRecord[] {
  return historyCache;
}

/** Synchronous, render-safe unread count derived from the cache. */
export function unreadCountSnapshot(): number {
  let n = 0;
  for (const r of historyCache) if (!r.read) n++;
  return n;
}

/** Load the persisted history into the cache. Safe to call repeatedly: each
 *  read first checks the canonical genesis scope. Falls back to an empty
 *  feed if the store is unreadable (e.g. desktop dev hosts without a store
 *  surface) so the app degrades to master behaviour. Idempotent emit: only
 *  notifies when the cache actually changed. */
export async function hydrateNotifications(): Promise<void> {
  let next: NotificationRecord[] = [];
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    const env = parseHistoryEnvelope(await store.get<unknown>(HISTORY_KEY));
    next = env?.entries ?? [];
  } catch {
    // Keep the empty default.
  }
  if (!sameFeed(historyCache, next)) {
    historyCache = next;
    emit();
  }
}

/** Input shape for the recording chokepoint — every field is pre-normalized
 *  at the call site (status as the literal "confirmed"/"failed", blockNumber
 *  as a finite number or null, etc.). */
export interface RecordNotificationInput {
  chainIdHex: string;
  txHash: string;
  status: "confirmed" | "failed";
  blockNumber: number | null;
  kind: TxOpKind;
  amountDecimal: string;
  counterparty: string;
  /** Present at observe-time. `true` ⇒ store it already-read (no badge
   *  bump). Omitted/`false` ⇒ unread (the default). */
  read?: boolean;
}

/** Append a notification for a tracked-tx terminal transition.
 *
 *  Idempotent on `(chainIdHex, txHash)`: a second call returns
 *  `{ added: false, record: null }` without re-writing history (the
 *  persisted notified-set survives restarts so a reinit can neither re-fire
 *  nor lose dedupe state).
 *
 *  Best-effort: any store failure is swallowed and reported as
 *  `{ added: false, record: null }` — a notification-write failure must
 *  never break the calling operation flow.
 *
 *  `status` is taken verbatim from the input — this function never coerces
 *  "failed" to "confirmed" or vice versa. */
export async function recordNotification(
  input: RecordNotificationInput,
): Promise<{ added: boolean; record: NotificationRecord | null }> {
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    const id = notificationId(input.chainIdHex, input.txHash);

    const seen = parseNotifiedSetEnvelope(
      await store.get<unknown>(NOTIFIED_KEY),
    ) ?? { schemaVersion: 0 as const, ids: [] };
    if (seen.ids.includes(id)) return { added: false, record: null };

    const record: NotificationRecord = {
      id,
      txHash: input.txHash,
      status: input.status,
      blockNumber: input.blockNumber,
      kind: input.kind,
      amountDecimal: input.amountDecimal,
      counterparty: input.counterparty,
      createdAtMs: Date.now(),
      read: input.read ?? false,
      schemaVersion: 0,
    };

    const history = parseHistoryEnvelope(
      await store.get<unknown>(HISTORY_KEY),
    ) ?? { schemaVersion: 0 as const, entries: [] };
    const nextEntries = appendCapped(
      history.entries,
      record,
      NOTIFICATION_HISTORY_CAP,
    );

    await store.set(HISTORY_KEY, { schemaVersion: 0, entries: nextEntries });
    await store.set(NOTIFIED_KEY, {
      schemaVersion: 0,
      ids: [...seen.ids, id],
    });
    await store.save();

    historyCache = nextEntries;
    emit();
    return { added: true, record };
  } catch {
    return { added: false, record: null };
  }
}

/** Read of the notification history, newest-first. Refreshes the cache and
 *  its genesis scope. Empty on parse failure / missing key. */
export async function listNotifications(): Promise<NotificationRecord[]> {
  // Re-check even after hydration so a canonical registry change observed
  // during a long-running app session drops stale history/watermarks.
  await hydrateNotifications();
  return historyCache;
}

/** Flip every record's `read` to `true`. Returns the count of records that
 *  changed (already-read records do not count). Idempotent: a second call
 *  on an all-read feed returns `{ flipped: 0 }` and writes nothing. */
export async function markAllNotificationsRead(): Promise<{ flipped: number }> {
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    const env = parseHistoryEnvelope(await store.get<unknown>(HISTORY_KEY));
    if (!env) {
      // Nothing persisted; reconcile the cache to empty if it drifted.
      if (historyCache.length !== 0) {
        historyCache = [];
        emit();
      }
      return { flipped: 0 };
    }
    let flipped = 0;
    const next = env.entries.map((r) => {
      if (r.read) return r;
      flipped++;
      return { ...r, read: true };
    });
    if (flipped > 0) {
      await store.set(HISTORY_KEY, { schemaVersion: 0, entries: next });
      await store.save();
    }
    historyCache = next;
    emit();
    return { flipped };
  } catch {
    return { flipped: 0 };
  }
}

/** Flip ONE record's `read` to `true` by its full id. Returns
 *  `{ flipped: true }` when the record was found and was previously unread;
 *  `{ flipped: false }` when the id is unknown OR the record was already
 *  read (so a second tap is a no-op and writes nothing). Best-effort. */
export async function markNotificationRead(
  id: string,
): Promise<{ flipped: boolean }> {
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    const env = parseHistoryEnvelope(await store.get<unknown>(HISTORY_KEY));
    if (!env) return { flipped: false };
    let flipped = false;
    const next = env.entries.map((r) => {
      if (r.id !== id || r.read) return r;
      flipped = true;
      return { ...r, read: true };
    });
    if (flipped) {
      await store.set(HISTORY_KEY, { schemaVersion: 0, entries: next });
      await store.save();
      historyCache = next;
      emit();
    }
    return { flipped };
  } catch {
    return { flipped: false };
  }
}

/** Derived unread count = `!read` across the persisted history (re-read from
 *  disk so it never trusts a stale cache). */
export async function getUnreadCount(): Promise<number> {
  try {
    const store = await getStore();
    await ensureNetworkScope(store);
    const env = parseHistoryEnvelope(await store.get<unknown>(HISTORY_KEY));
    if (!env) return 0;
    let total = 0;
    for (const r of env.entries) if (!r.read) total++;
    return total;
  } catch {
    return 0;
  }
}

/** Reset module state — test-only so each case starts from a cold cache.
 *  Production code never calls this. */
export function resetNotificationsForTest(): void {
  historyCache = [];
  storePromise = null;
  listeners.clear();
}

/** Shallow feed-equality on the fields that drive a re-render (id + read).
 *  Avoids emitting when hydration produced a structurally identical feed. */
function sameFeed(a: NotificationRecord[], b: NotificationRecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.id !== y.id || x.read !== y.read) return false;
  }
  return true;
}
