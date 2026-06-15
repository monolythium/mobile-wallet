// React binding for the Public/Private display gate.
//
// `useSyncExternalStore` subscribes a component to the privacy cache so a flip
// in Settings (or a tap on the Home toggle) re-renders every denom-aware
// surface immediately. The snapshots start at the public/OFF defaults and are
// refreshed by `hydratePrivacy()` (called once on app mount), so a component's
// first paint matches a build without the privacy surface.

import { useEffect, useSyncExternalStore } from "react";
import {
  denomValue,
  hydratePrivacy,
  privacyEnabledValue,
  subscribePrivacy,
  type Denom,
} from "./privacy";

/**
 * Subscribe to the privacy-toggle gate. Triggers a one-time disk hydration on
 * first mount; returns `false` until hydration resolves (and whenever the gate
 * is OFF), so the Public / Private toggle stays hidden by default.
 */
export function usePrivacyEnabled(): boolean {
  useEffect(() => {
    void hydratePrivacy();
  }, []);
  return useSyncExternalStore(
    subscribePrivacy,
    privacyEnabledValue,
    privacyEnabledValue,
  );
}

/**
 * Subscribe to the active display denomination. Always "public" until the user
 * flips the Home toggle (which itself requires the privacy gate to be on), so
 * by default every denom-aware surface renders its public state.
 */
export function useDenom(): Denom {
  return useSyncExternalStore(subscribePrivacy, denomValue, denomValue);
}
