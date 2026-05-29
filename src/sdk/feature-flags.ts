// Feature flags — a single persisted boolean for experimental v5 features.
//
// Stored locally via @tauri-apps/plugin-store (the same plaintext,
// app-private primitive `contacts.ts` and `agents-store.ts` use). The flag
// is NOT secret — it only governs which UI surfaces are mounted.
//
// Schema (file `flags.v1.json`):
//
//   { "experimentalV5": boolean }   // absent => OFF
//
// Default is OFF: a missing or non-boolean value reads as `false`, so a
// fresh install — and any install that never opens the toggle — behaves
// exactly like a build without these surfaces.
//
// Render paths need a synchronous answer (a hook can't await mid-render), so
// this module keeps a small in-memory cache seeded to the default-OFF value
// and exposes a subscribe API. `useExperimentalV5()` (see ./use-feature-flags)
// hydrates the cache from disk on mount and re-renders subscribers when the
// toggle flips. Until hydration completes the cache reports the OFF default,
// so the first paint is identical to a build without the experimental
// surfaces.

import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "flags.v1.json";

/** Persisted flag keys. One today; add more here as the surface grows. */
export const EXPERIMENTAL_V5_KEY = "experimentalV5" as const;

/** Default state for every flag: OFF. */
const DEFAULTS = {
  [EXPERIMENTAL_V5_KEY]: false,
} as const;

type FlagKey = typeof EXPERIMENTAL_V5_KEY;

// In-memory cache seeded to the OFF defaults. Synchronous reads (render
// paths) consult this; `hydrateFeatureFlags()` refreshes it from disk.
const cache: Record<FlagKey, boolean> = { ...DEFAULTS };

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to flag changes. Returns an unsubscribe fn. */
export function subscribeFeatureFlags(listener: Listener): () => void {
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

function coerce(raw: unknown, key: FlagKey): boolean {
  return typeof raw === "boolean" ? raw : DEFAULTS[key];
}

/**
 * Synchronous, render-safe read of the experimental-v5 flag. Reflects the
 * last hydrated/written value, or the OFF default before hydration.
 */
export function experimentalV5Enabled(): boolean {
  return cache[EXPERIMENTAL_V5_KEY];
}

/**
 * Load the persisted flag value into the cache (call once on app mount).
 * Falls back to the OFF default if the store is unreadable (e.g. desktop dev
 * hosts without a store surface) so the app degrades to master behaviour.
 */
export async function hydrateFeatureFlags(): Promise<void> {
  let next: boolean = DEFAULTS[EXPERIMENTAL_V5_KEY];
  try {
    const store = await getStore();
    next = coerce(await store.get<unknown>(EXPERIMENTAL_V5_KEY), EXPERIMENTAL_V5_KEY);
  } catch {
    // Keep the OFF default.
  }
  if (cache[EXPERIMENTAL_V5_KEY] !== next) {
    cache[EXPERIMENTAL_V5_KEY] = next;
    emit();
  }
}

/** Persist + cache the experimental-v5 flag, notifying subscribers. */
export async function setExperimentalV5(enabled: boolean): Promise<void> {
  const store = await getStore();
  await store.set(EXPERIMENTAL_V5_KEY, enabled);
  await store.save();
  if (cache[EXPERIMENTAL_V5_KEY] !== enabled) {
    cache[EXPERIMENTAL_V5_KEY] = enabled;
    emit();
  }
}
