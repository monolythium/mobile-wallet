// Durable reconcile state machine — the status-fidelity + honest-absence
// heart of the feature.
//
// `classifyPending` is pure w.r.t. an injected probe + clock, so its three
// disjoint buckets (terminal / expired / kept) are asserted directly. The
// one-tick driver `reconcilePendingOnce` is tested against mocked store +
// notification seams so we assert EXACTLY what gets recorded and removed —
// confirmed and failed both fire, pending neither records nor removes, and an
// expired entry is removed WITHOUT a notification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordSpy = vi.hoisted(() => vi.fn());
const listSpy = vi.hoisted(() => vi.fn());
const removeSpy = vi.hoisted(() => vi.fn());

vi.mock("../notifications-store", () => ({
  recordNotification: recordSpy,
}));

vi.mock("../pending-tx-store", () => ({
  listPendingTxs: listSpy,
  removePendingTxs: removeSpy,
}));

import {
  PENDING_TX_TTL_MS,
  classifyPending,
  reconcilePendingOnce,
  type TerminalProbe,
} from "../reconcile";
import { pendingTxKey, type PendingTx } from "../pending-tx";
import type { TerminalStatus } from "../tx-terminal";

const CHAIN = "0x10f2c";
const NOW = 1_000_000;

function tx(n: number, over: Partial<PendingTx> = {}): PendingTx {
  return {
    txHash: "0x" + n.toString(16).padStart(64, "0"),
    chainIdHex: CHAIN,
    opKind: "send",
    amountDecimal: "1.5",
    counterparty: "0x" + "11".repeat(20),
    submittedAtMs: NOW - 1_000, // fresh by default
    ...over,
  };
}

const confirmed: TerminalStatus = { status: "confirmed", blockNumber: 42 };
const failed: TerminalStatus = { status: "failed", blockNumber: 7 };

beforeEach(() => {
  recordSpy.mockReset().mockResolvedValue({ added: true, record: {} });
  listSpy.mockReset();
  removeSpy.mockReset().mockResolvedValue({ removed: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyPending — pure buckets", () => {
  it("routes confirmed + failed verdicts to `terminal`, pending to `kept`", async () => {
    const probe: TerminalProbe = async (hash) => {
      if (hash === tx(1).txHash) return confirmed;
      if (hash === tx(2).txHash) return failed;
      return null; // tx(3) still pending
    };
    const res = await classifyPending([tx(1), tx(2), tx(3)], probe, NOW);
    expect(res.terminal.map((t) => [t.entry.txHash, t.status])).toEqual([
      [tx(1).txHash, "confirmed"],
      [tx(2).txHash, "failed"],
    ]);
    expect(res.terminal[0]!.blockNumber).toBe(42);
    expect(res.kept.map((e) => e.txHash)).toEqual([tx(3).txHash]);
    expect(res.expired).toHaveLength(0);
  });

  it("drops entries past the TTL into `expired` WITHOUT probing them", async () => {
    const probe = vi.fn<TerminalProbe>(async () => confirmed);
    const old = tx(9, { submittedAtMs: NOW - PENDING_TX_TTL_MS - 1 });
    const res = await classifyPending([old, tx(1)], probe, NOW);
    expect(res.expired.map((e) => e.txHash)).toEqual([old.txHash]);
    // The expired entry was never probed; only the live one was.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(tx(1).txHash);
  });

  it("never synthesizes a verdict — an all-pending registry yields all `kept`", async () => {
    const res = await classifyPending([tx(1), tx(2)], async () => null, NOW);
    expect(res.terminal).toHaveLength(0);
    expect(res.expired).toHaveLength(0);
    expect(res.kept).toHaveLength(2);
  });
});

describe("reconcilePendingOnce — driver", () => {
  it("records confirmed verbatim, then removes the terminal entry", async () => {
    listSpy.mockResolvedValue([tx(1)]);
    removeSpy.mockResolvedValue({ removed: 1 });

    const res = await reconcilePendingOnce(async () => confirmed, NOW);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0]![0]).toMatchObject({
      chainIdHex: CHAIN,
      txHash: tx(1).txHash,
      status: "confirmed",
      blockNumber: 42,
      kind: "send",
      amountDecimal: "1.5",
      counterparty: tx(1).counterparty,
    });
    // Removed by the terminal key.
    const removedKeys = removeSpy.mock.calls[0]![0] as Set<string>;
    expect([...removedKeys]).toEqual([pendingTxKey(CHAIN, tx(1).txHash)]);
    expect(res).toMatchObject({ recorded: 1, removed: 1, remaining: 0 });
  });

  it("records 'failed' (never coerced to confirmed) and removes", async () => {
    listSpy.mockResolvedValue([tx(2)]);
    await reconcilePendingOnce(async () => failed, NOW);
    expect(recordSpy.mock.calls[0]![0].status).toBe("failed");
  });

  it("a pending tx records nothing and removes nothing (stays tracked)", async () => {
    listSpy.mockResolvedValue([tx(3)]);
    const res = await reconcilePendingOnce(async () => null, NOW);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith(new Set()); // empty key set
    expect(res.remaining).toBe(1);
  });

  it("removes an expired tx WITHOUT recording a notification (honest absence)", async () => {
    const old = tx(9, { submittedAtMs: NOW - PENDING_TX_TTL_MS - 1 });
    listSpy.mockResolvedValue([old]);
    removeSpy.mockResolvedValue({ removed: 1 });

    const res = await reconcilePendingOnce(async () => confirmed, NOW);

    expect(recordSpy).not.toHaveBeenCalled();
    const removedKeys = removeSpy.mock.calls[0]![0] as Set<string>;
    expect([...removedKeys]).toEqual([pendingTxKey(CHAIN, old.txHash)]);
    expect(res).toMatchObject({ recorded: 0, removed: 1, remaining: 0 });
  });

  it("counts a dedupe-miss as recorded:0 but still removes the entry", async () => {
    // recordNotification returns added:false when the (chain, hash) was
    // already notified — the entry must still be cleared from the registry.
    listSpy.mockResolvedValue([tx(1)]);
    recordSpy.mockResolvedValue({ added: false, record: null });
    removeSpy.mockResolvedValue({ removed: 1 });

    const res = await reconcilePendingOnce(async () => confirmed, NOW);
    expect(res.recorded).toBe(0);
    expect([...(removeSpy.mock.calls[0]![0] as Set<string>)]).toHaveLength(1);
  });

  it("is a clean no-op on an empty registry (no record, no remove)", async () => {
    listSpy.mockResolvedValue([]);
    const res = await reconcilePendingOnce(async () => confirmed, NOW);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ recorded: 0, removed: 0, remaining: 0 });
  });

  it("never throws when the store read fails — returns a zeroed tick", async () => {
    listSpy.mockRejectedValue(new Error("store down"));
    const res = await reconcilePendingOnce(async () => confirmed, NOW);
    expect(res).toEqual({ recorded: 0, removed: 0, remaining: 0 });
  });

  it("mixes confirmed + pending: records+removes the terminal, keeps the rest", async () => {
    listSpy.mockResolvedValue([tx(1), tx(2)]);
    removeSpy.mockResolvedValue({ removed: 1 });
    const probe: TerminalProbe = async (h) =>
      h === tx(1).txHash ? confirmed : null;

    const res = await reconcilePendingOnce(probe, NOW);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect([...(removeSpy.mock.calls[0]![0] as Set<string>)]).toEqual([
      pendingTxKey(CHAIN, tx(1).txHash),
    ]);
    expect(res.remaining).toBe(1);
  });
});
