// Reconcile poller scheduler — the pure back-off + self-stop decision that
// drives the app-level loop. The hook itself is a thin timer shell over this;
// the scheduling logic (stop-when-idle, reset-on-progress, exponential
// back-off to a cap) lives here so it's deterministic and unit-testable
// without rendering React or arming real timers.

import { describe, expect, it } from "vitest";
import {
  RECONCILE_BASE_INTERVAL_MS,
  RECONCILE_MAX_INTERVAL_MS,
  nextReconcileDelay,
} from "../use-reconcile-poller";

const BASE = 1_000;
const MAX = 8_000;

describe("nextReconcileDelay", () => {
  it("stops (idle) when no txs remain — regardless of progress", () => {
    expect(
      nextReconcileDelay({ remaining: 0, recorded: 1, removed: 1 }, 2_000, BASE, MAX),
    ).toEqual({ stop: true, delayMs: BASE });
    expect(
      nextReconcileDelay({ remaining: 0, recorded: 0, removed: 0 }, 2_000, BASE, MAX),
    ).toEqual({ stop: true, delayMs: BASE });
  });

  it("resets to base cadence after a tick that recorded something", () => {
    const d = nextReconcileDelay(
      { remaining: 2, recorded: 1, removed: 1 },
      4_000, // was backed off
      BASE,
      MAX,
    );
    expect(d).toEqual({ stop: false, delayMs: BASE });
  });

  it("resets to base when a tick removed something even without recording", () => {
    // e.g. an expired-only sweep (honest absence) is still progress.
    const d = nextReconcileDelay(
      { remaining: 1, recorded: 0, removed: 1 },
      4_000,
      BASE,
      MAX,
    );
    expect(d.delayMs).toBe(BASE);
  });

  it("doubles the delay when a tick made no progress (still pending)", () => {
    const d = nextReconcileDelay(
      { remaining: 1, recorded: 0, removed: 0 },
      BASE,
      BASE,
      MAX,
    );
    expect(d).toEqual({ stop: false, delayMs: BASE * 2 });
  });

  it("caps the back-off at maxMs", () => {
    const stuck = { remaining: 1, recorded: 0, removed: 0 };
    // Walk the back-off up from base; it must never exceed MAX.
    let cur = BASE;
    for (let i = 0; i < 10; i++) {
      cur = nextReconcileDelay(stuck, cur, BASE, MAX).delayMs;
      expect(cur).toBeLessThanOrEqual(MAX);
    }
    expect(cur).toBe(MAX);
  });

  it("exposes sane production defaults (base < max)", () => {
    expect(RECONCILE_BASE_INTERVAL_MS).toBeLessThan(RECONCILE_MAX_INTERVAL_MS);
    // Default-arg path (no explicit base/max).
    const d = nextReconcileDelay({ remaining: 1, recorded: 0, removed: 0 }, RECONCILE_BASE_INTERVAL_MS);
    expect(d.delayMs).toBe(
      Math.min(RECONCILE_BASE_INTERVAL_MS * 2, RECONCILE_MAX_INTERVAL_MS),
    );
  });
});
