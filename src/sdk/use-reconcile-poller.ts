// App-level tracked-tx reconcile poller — ONE interval for the whole app.
//
// Mounted once (in App.tsx). It is the durable replacement for the
// OperationsDrawer's per-op receipt poll: because the tracked txs live in a
// persisted registry (`pending-tx-store.ts`), this single loop carries each
// to its terminal state regardless of which sheet submitted it or whether
// that sheet is still open — and it resumes after an app restart while txs
// are still in flight.
//
// Lifecycle / gating
// ==================
// - Gated on the experimental-v5 flag. Flag OFF ⇒ the loop never schedules a
//   tick and the app is byte-identical to master.
// - Runs ONLY while the registry is non-empty. With zero tracked txs it is a
//   pure no-op (no timer armed, no RPC), so an idle wallet never polls.
// - Self-stops: each tick reports `remaining`; when it reaches 0 the loop
//   tears down its timer and waits for the next enqueue (a store subscription
//   re-arms it).
// - Back-off: a tick that records/clears nothing lengthens the next delay up
//   to a cap, so a stuck/slow tx doesn't hammer the node; any progress
//   resets to the base cadence.
//
// READ-AND-NOTIFY ONLY: like the browser poll-core, this loop reads public
// receipts for hashes already in plaintext storage and writes only the
// notification store + the registry. It never touches signing / broadcast /
// fee / nonce / encrypted payloads.

import { useEffect, useRef } from "react";
import { reconcilePendingOnce } from "./reconcile";
import {
  hydratePendingTxs,
  pendingTxsSnapshot,
  subscribePendingTxs,
} from "./pending-tx-store";

/** Base poll cadence — anchors settle in ~1s, so a couple of seconds after
 *  submit is the first realistic check. */
export const RECONCILE_BASE_INTERVAL_MS = 3_000;
/** Back-off ceiling for a registry whose txs aren't resolving (slow/stuck). */
export const RECONCILE_MAX_INTERVAL_MS = 15_000;

/** Outcome of a single reconcile tick, as the scheduler sees it. */
export interface ReconcileTickSummary {
  remaining: number;
  recorded: number;
  removed: number;
}

/** Stable module-level default tick so the hook's effect deps stay constant
 *  across renders (a fresh arrow each render would churn the effect). */
function defaultRunTick(): Promise<ReconcileTickSummary> {
  return reconcilePendingOnce();
}

/** Decision the scheduler reaches after a tick. `stop` ⇒ no work left, go
 *  idle (the next enqueue re-arms via the store subscription). Otherwise
 *  `delayMs` is when to run the next tick. PURE — the unit-tested core of the
 *  poller's back-off + self-stop; the hook below is a thin timer shell over
 *  it. */
export function nextReconcileDelay(
  result: ReconcileTickSummary,
  currentMs: number,
  baseMs: number = RECONCILE_BASE_INTERVAL_MS,
  maxMs: number = RECONCILE_MAX_INTERVAL_MS,
): { stop: boolean; delayMs: number } {
  // No outstanding txs ⇒ stop and idle until the next enqueue.
  if (result.remaining <= 0) return { stop: true, delayMs: baseMs };
  // Any progress (a record or a removal) resets to the base cadence; a tick
  // that moved nothing doubles the delay up to the cap so a stuck/slow tx
  // doesn't hammer the node.
  const progressed = result.recorded > 0 || result.removed > 0;
  const delayMs = progressed ? baseMs : Math.min(currentMs * 2, maxMs);
  return { stop: false, delayMs };
}

/** Mount the single app-level reconcile loop. No-op (and no timer) whenever
 *  `enabled` is false or the registry is empty.
 *
 *  `enabled` is the experimental-v5 flag; pass `useExperimentalV5()`. The
 *  optional knobs exist for tests (fast intervals + an injected clock /
 *  tick runner) — production omits them. */
export function useReconcilePoller(
  enabled: boolean,
  opts: {
    baseIntervalMs?: number;
    maxIntervalMs?: number;
    runTick?: () => Promise<ReconcileTickSummary>;
  } = {},
): void {
  const baseIntervalMs = opts.baseIntervalMs ?? RECONCILE_BASE_INTERVAL_MS;
  const maxIntervalMs = opts.maxIntervalMs ?? RECONCILE_MAX_INTERVAL_MS;
  const runTick = opts.runTick ?? defaultRunTick;

  // Hold the knobs in a ref so the effect depends ONLY on `enabled`. The
  // default `runTick`/intervals are stable across renders, but keeping them
  // out of the dep array prevents an App re-render from tearing down and
  // rebuilding the loop (which would reset back-off + drop an in-flight
  // timer). The ref is refreshed each render so a test that varies the knobs
  // still sees the latest on the next (re-)mount.
  const knobs = useRef({ baseIntervalMs, maxIntervalMs, runTick });
  knobs.current = { baseIntervalMs, maxIntervalMs, runTick };

  useEffect(() => {
    if (!enabled) return;

    const { baseIntervalMs, maxIntervalMs, runTick } = knobs.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let intervalMs = baseIntervalMs;
    let running = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // Arm the next tick only when there is work AND none is queued. Reading
    // the synchronous snapshot keeps an empty registry from ever arming a
    // timer (true idle).
    const arm = (delayMs: number) => {
      if (cancelled || timer !== null) return;
      if (pendingTxsSnapshot().length === 0) return;
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled || running) return;
      if (pendingTxsSnapshot().length === 0) return; // nothing to do — idle
      running = true;
      let result: ReconcileTickSummary;
      try {
        result = await runTick();
      } catch {
        // reconcilePendingOnce never throws, but guard the seam anyway.
        result = { remaining: pendingTxsSnapshot().length, recorded: 0, removed: 0 };
      } finally {
        running = false;
      }
      if (cancelled) return;
      const decision = nextReconcileDelay(
        result,
        intervalMs,
        baseIntervalMs,
        maxIntervalMs,
      );
      intervalMs = decision.stop ? baseIntervalMs : decision.delayMs;
      // `stop` ⇒ go idle: leave no timer armed; the store subscription
      // re-arms on the next enqueue.
      if (!decision.stop) arm(intervalMs);
    };

    // A change to the registry (a fresh enqueue, or hydration finding
    // restart-surviving entries) wakes an idle loop. If a tick is mid-flight
    // it re-arms itself; this only matters when the loop is parked.
    const unsub = subscribePendingTxs(() => {
      if (cancelled || running || timer !== null) return;
      intervalMs = baseIntervalMs;
      arm(intervalMs);
    });

    // Hydrate restart-surviving entries, then kick the first tick. Hydration
    // emits on a non-empty registry, which arms via the subscription; the
    // explicit arm covers the already-hydrated (cache-warm) case.
    void hydratePendingTxs().then(() => {
      if (cancelled) return;
      arm(baseIntervalMs);
    });

    return () => {
      cancelled = true;
      clearTimer();
      unsub();
    };
    // Intentionally depends ONLY on `enabled`: the knobs are read from a ref
    // (refreshed each render) so a benign App re-render never rebuilds the
    // loop. Toggling the flag is the one event that should re-create it.
  }, [enabled]);
}
