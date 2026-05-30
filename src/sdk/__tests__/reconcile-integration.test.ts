// End-to-end durable reconcile — REAL pending-tx store + REAL notifications
// store + REAL reconcile driver, mocking only the chain (the `../client` RPC
// seam) and @tauri-apps/plugin-store (no jsdom runtime).
//
// This is the test that proves the headline fix: a tx enqueued at submit time
// is carried to its terminal state and produces a faithful notification —
// crucially via the durable registry, so it works regardless of any sheet
// lifetime. It exercises the same wiring App.tsx mounts, minus the timer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backing = vi.hoisted(() => new Map<string, Map<string, unknown>>());
const receiptSpy = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-store", () => {
  class MockStore {
    private map: Map<string, unknown>;
    private constructor(file: string) {
      if (!backing.has(file)) backing.set(file, new Map());
      this.map = backing.get(file)!;
    }
    static async load(file: string): Promise<MockStore> {
      return new MockStore(file);
    }
    async get<T>(key: string): Promise<T | undefined> {
      return this.map.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.map.set(key, value);
    }
    async save(): Promise<void> {}
  }
  return { Store: MockStore };
});

vi.mock("../client", () => ({
  getProvider: () => ({
    rpcClient: {
      ethGetTransactionReceipt: receiptSpy,
      ethChainId: async () => 69420n,
    },
  }),
}));

async function loadModules() {
  const store = await import("../pending-tx-store");
  const notif = await import("../notifications-store");
  const reconcile = await import("../reconcile");
  return { store, notif, reconcile };
}

const CHAIN = "0x10f2c";
const TX = "0x" + "ab".repeat(32);

function entry(over: Record<string, unknown> = {}) {
  return {
    txHash: TX,
    chainIdHex: CHAIN,
    opKind: "send" as const,
    amountDecimal: "2.5",
    counterparty: "0x" + "11".repeat(20),
    submittedAtMs: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  backing.clear();
  receiptSpy.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable reconcile — end to end", () => {
  it("enqueue → confirmed receipt → notification recorded + entry cleared", async () => {
    const { store, notif, reconcile } = await loadModules();
    await store.enqueuePendingTx(entry());
    expect((await store.listPendingTxs())).toHaveLength(1);

    receiptSpy.mockResolvedValue({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: 4242n,
      tx_index: 0,
      status: 1,
      executionUnitsUsed: 21000n,
    });

    const res = await reconcile.reconcilePendingOnce();
    expect(res).toMatchObject({ recorded: 1, removed: 1, remaining: 0 });

    // Notification recorded with the real terminal bit + block number.
    const feed = await notif.listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      txHash: TX,
      status: "confirmed",
      blockNumber: 4242,
      kind: "send",
      amountDecimal: "2.5",
    });
    // Registry cleared so it's never re-polled / re-fired.
    expect((await store.listPendingTxs())).toHaveLength(0);
  });

  it("enqueue → reverted receipt → 'failed' notification (never coerced)", async () => {
    const { store, notif, reconcile } = await loadModules();
    await store.enqueuePendingTx(entry());

    receiptSpy.mockResolvedValue({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: 9n,
      tx_index: 0,
      status: 0, // reverted
      executionUnitsUsed: 21000n,
    });

    await reconcile.reconcilePendingOnce();
    const feed = await notif.listNotifications();
    expect(feed[0]!.status).toBe("failed");
    expect((await store.listPendingTxs())).toHaveLength(0);
  });

  it("pending receipt keeps the entry tracked across ticks, then fires once it confirms", async () => {
    const { store, notif, reconcile } = await loadModules();
    await store.enqueuePendingTx(entry());

    // First tick: receipt not yet available → stays pending, nothing recorded.
    receiptSpy.mockResolvedValueOnce(null);
    const t1 = await reconcile.reconcilePendingOnce();
    expect(t1).toMatchObject({ recorded: 0, removed: 0, remaining: 1 });
    expect((await store.listPendingTxs())).toHaveLength(1);
    expect((await notif.listNotifications())).toHaveLength(0);

    // Second tick: receipt now confirmed → records + clears.
    receiptSpy.mockResolvedValueOnce({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: 50n,
      tx_index: 0,
      status: 1,
      executionUnitsUsed: 21000n,
    });
    const t2 = await reconcile.reconcilePendingOnce();
    expect(t2).toMatchObject({ recorded: 1, removed: 1, remaining: 0 });
    expect((await notif.listNotifications())).toHaveLength(1);
  });

  it("does not re-fire after a restart: a restart-surviving entry whose tx already notified records nothing", async () => {
    // First session: enqueue + confirm.
    {
      const { store, reconcile } = await loadModules();
      await store.enqueuePendingTx(entry());
      receiptSpy.mockResolvedValue({
        tx_hash: TX,
        block_hash: "0x" + "00".repeat(32),
        block_number: 1n,
        tx_index: 0,
        status: 1,
        executionUnitsUsed: 21000n,
      });
      await reconcile.reconcilePendingOnce();
    }

    // Simulate a restart where the entry was somehow re-persisted (defensive:
    // the dedupe-set in the notifications store must still suppress a second
    // notification). Re-seed the registry directly + fresh modules.
    vi.resetModules();
    backing.get("pending-tx.v1.json")!.set("pending", {
      schemaVersion: 0,
      entries: [entry()],
    });
    const { store, notif, reconcile } = await loadModules();
    receiptSpy.mockResolvedValue({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: 1n,
      tx_index: 0,
      status: 1,
      executionUnitsUsed: 21000n,
    });

    const res = await reconcile.reconcilePendingOnce();
    // Terminal again, but recordNotification dedupes on (chain, hash): no new
    // record, yet the stale entry is still removed.
    expect(res.recorded).toBe(0);
    expect(res.removed).toBe(1);
    expect((await notif.listNotifications())).toHaveLength(1); // still just the one
    expect((await store.listPendingTxs())).toHaveLength(0);
  });
});
