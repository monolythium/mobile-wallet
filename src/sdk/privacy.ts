// Privacy denomination — the Public/Private display gate.
//
// Two pieces of state live here, both render-safe via the same in-memory
// cache + subscribe primitive `feature-flags.ts` uses:
//
//   1. `privacyEnabled` (PERSISTED) — whether the Public / Private toggle is
//      offered at all. OFF by default; a fresh install never shows the toggle
//      and only ever displays the public denomination, exactly like a build
//      without this surface. Persisted via @tauri-apps/plugin-store (the same
//      plaintext, app-private primitive `feature-flags.ts`/`contacts.ts` use).
//
//   2. `denom` (EPHEMERAL) — the active denomination, "public" | "private".
//      NOT persisted: it always resets to "public" on launch (matching the
//      design shell, which seeds denom from the live root attribute, never
//      from storage) and is forced back to "public" whenever privacy is
//      turned off. This is a DISPLAY gate, never a chain capability —
//      Monolythium returns public-only balances by construction (see
//      `tokens.ts`), so private mode hides amounts client-side and surfaces
//      the design's empty / disclosure states; it never fabricates a private
//      balance the node didn't serve.
//
// Schema (file `flags.v1.json`, shared with feature-flags):
//
//   { "privacyEnabled": boolean }   // absent => OFF
//
// Neither value is secret. `privacyEnabled` only governs whether the toggle is
// mounted; `denom` only governs which amounts are shown on this device.

import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "flags.v1.json";

/** Persisted key for the privacy-toggle gate. */
export const PRIVACY_ENABLED_KEY = "privacyEnabled" as const;

/** The two display denominations. "private" only reachable when the gate is on. */
export type Denom = "public" | "private";

/** Default gate state: OFF (toggle hidden, public-only). */
const PRIVACY_DEFAULT = false;

/** In-memory state. `privacyEnabled` mirrors disk after hydration; `denom`
 *  is ephemeral and always starts public. Synchronous render paths read these;
 *  `hydratePrivacy()` refreshes `privacyEnabled` from disk. */
let privacyEnabled = PRIVACY_DEFAULT;
let denom: Denom = "public";

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to privacy / denom changes. Returns an unsubscribe fn. */
export function subscribePrivacy(listener: Listener): () => void {
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

function coerce(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : PRIVACY_DEFAULT;
}

/** Synchronous, render-safe read of the privacy-toggle gate. */
export function privacyEnabledValue(): boolean {
  return privacyEnabled;
}

/** Synchronous, render-safe read of the active display denomination. */
export function denomValue(): Denom {
  return denom;
}

/**
 * Load the persisted privacy gate into the cache (call once on app mount).
 * Falls back to the OFF default if the store is unreadable (e.g. desktop dev
 * hosts without a store surface) so the app degrades to public-only behaviour.
 */
export async function hydratePrivacy(): Promise<void> {
  let next = PRIVACY_DEFAULT;
  try {
    const store = await getStore();
    next = coerce(await store.get<unknown>(PRIVACY_ENABLED_KEY));
  } catch {
    // Keep the OFF default.
  }
  let changed = false;
  if (privacyEnabled !== next) {
    privacyEnabled = next;
    changed = true;
  }
  // A hydration that lands on OFF must not leave a stale private denom.
  if (!privacyEnabled && denom !== "public") {
    denom = "public";
    changed = true;
  }
  if (changed) emit();
}

/**
 * Persist + cache the privacy gate, notifying subscribers. Turning the gate
 * OFF also forces the active denomination back to public (the private surface
 * must never linger once the toggle is hidden).
 */
export async function setPrivacyEnabled(enabled: boolean): Promise<void> {
  const store = await getStore();
  await store.set(PRIVACY_ENABLED_KEY, enabled);
  await store.save();
  let changed = false;
  if (privacyEnabled !== enabled) {
    privacyEnabled = enabled;
    changed = true;
  }
  if (!enabled && denom !== "public") {
    denom = "public";
    changed = true;
  }
  if (changed) emit();
}

/**
 * Set the active display denomination (no persistence). A "private" request is
 * ignored while the privacy gate is off, so the only way to reach private mode
 * is with the toggle enabled — matching the design's `setDenom` guard.
 */
export function setDenom(next: Denom): void {
  if (!privacyEnabled && next === "private") return;
  if (denom === next) return;
  denom = next;
  emit();
}
