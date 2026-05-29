// React binding for the experimental-v5 feature flag.
//
// `useSyncExternalStore` subscribes a component to the flag cache so a flip
// in Settings re-renders every gated surface immediately. The store's
// snapshot starts at the OFF default and is refreshed by
// `hydrateFeatureFlags()` (called once on app mount), so a component's first
// paint matches a build without the experimental surfaces.

import { useEffect, useSyncExternalStore } from "react";
import {
  experimentalV5Enabled,
  hydrateFeatureFlags,
  subscribeFeatureFlags,
} from "./feature-flags";

/**
 * Subscribe to the experimental-v5 flag. Triggers a one-time disk hydration
 * on first mount; returns `false` until hydration resolves (and whenever the
 * flag is OFF), so gated surfaces stay hidden by default.
 */
export function useExperimentalV5(): boolean {
  useEffect(() => {
    void hydrateFeatureFlags();
  }, []);
  return useSyncExternalStore(
    subscribeFeatureFlags,
    experimentalV5Enabled,
    experimentalV5Enabled,
  );
}
