// React binding for the durable tracked-tx registry.
//
// `useSyncExternalStore` subscribes a component to the registry cache so a
// freshly-enqueued tx — and its later removal once the reconcile loop carries
// it to terminal — re-render any view that shows outstanding txs (the
// Activity "Pending" section). Mirrors `use-notifications.ts`: the snapshot
// starts empty and is hydrated by `hydratePendingTxs()` on first mount, so the
// first paint matches a build with no in-flight txs.

import { useEffect, useSyncExternalStore } from "react";
import {
  hydratePendingTxs,
  pendingTxsSnapshot,
  subscribePendingTxs,
} from "./pending-tx-store";
import type { PendingTx } from "./pending-tx";

/** Subscribe to the tracked-tx registry (newest-first). Triggers a one-time
 *  disk hydration on first mount; returns an empty array until hydration
 *  resolves and whenever no tx is outstanding. */
export function usePendingTxs(): PendingTx[] {
  useEffect(() => {
    void hydratePendingTxs();
  }, []);
  return useSyncExternalStore(
    subscribePendingTxs,
    pendingTxsSnapshot,
    pendingTxsSnapshot,
  );
}
