// Durable tracked-tx store — enqueue/dedupe, remove, snapshot, subscribe, and
// restart survival.
//
// @tauri-apps/plugin-store has no runtime in jsdom, so we mock it with an
// in-memory key/value store that mirrors Store.load / get / set / save (same
// pattern as feature-flags.test.ts). A "restart" = fresh module instance over
// the same backing map.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backing = vi.hoisted(() => new Map<string, Map<string, unknown>>());
const scopeState = vi.hoisted(() => ({
  resolved: {
    id: "testnet-69420:69420:0xgenesis-a",
    source: "live" as "live" | "bundled",
  },
}));

vi.mock("../persistence-scope", () => ({
  resolvePersistenceScope: async () => scopeState.resolved,
  parsePersistenceScopeEnvelope: (input: unknown) => {
    if (typeof input !== "object" || input === null) return null;
    const value = input as Record<string, unknown>;
    if (value.schemaVersion !== 0 || typeof value.id !== "string") return null;
    return { schemaVersion: 0, id: value.id };
  },
  selectPersistenceScopeId: (
    resolved: { id: string; source: "live" | "bundled" },
    persisted: { id: string } | null,
  ) =>
    resolved.source === "bundled" && persisted
      ? persisted.id
      : resolved.id,
}));

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

async function loadModule() {
  return import("../pending-tx-store");
}

const CHAIN = "0x10f2c";

function entry(n: number, over: Record<string, unknown> = {}) {
  return {
    txHash: "0x" + n.toString(16).padStart(64, "0"),
    chainIdHex: CHAIN,
    opKind: "send" as const,
    amountDecimal: "1.5",
    counterparty: "0x" + "11".repeat(20),
    submittedAtMs: 1_000 + n,
    ...over,
  };
}

beforeEach(() => {
  backing.clear();
  scopeState.resolved = {
    id: "testnet-69420:69420:0xgenesis-a",
    source: "live",
  };
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pending-tx store", () => {
  it("starts empty (synchronous snapshot)", async () => {
    const m = await loadModule();
    expect(m.pendingTxsSnapshot()).toEqual([]);
  });

  it("enqueues and reflects in the snapshot + list", async () => {
    const m = await loadModule();
    const res = await m.enqueuePendingTx(entry(1));
    expect(res.added).toBe(true);
    expect(m.pendingTxsSnapshot().map((e) => e.txHash)).toEqual([entry(1).txHash]);
    expect((await m.listPendingTxs())).toHaveLength(1);
  });

  it("dedupes a re-enqueue of the same (chain, hash) — no second entry", async () => {
    const m = await loadModule();
    await m.enqueuePendingTx(entry(1));
    const res = await m.enqueuePendingTx(entry(1, { submittedAtMs: 999_999 }));
    expect(res.added).toBe(false);
    const snap = m.pendingTxsSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.submittedAtMs).toBe(entry(1).submittedAtMs); // original kept
  });

  it("removes by key and writes back only the survivors", async () => {
    const m = await loadModule();
    await m.enqueuePendingTx(entry(1));
    await m.enqueuePendingTx(entry(2));
    const { pendingTxKey } = await import("../pending-tx");
    const res = await m.removePendingTxs(
      new Set([pendingTxKey(CHAIN, entry(1).txHash)]),
    );
    expect(res.removed).toBe(1);
    expect(m.pendingTxsSnapshot().map((e) => e.txHash)).toEqual([entry(2).txHash]);
  });

  it("remove is a no-op (removed:0) when nothing matches", async () => {
    const m = await loadModule();
    await m.enqueuePendingTx(entry(1));
    const res = await m.removePendingTxs(new Set(["no-such-key"]));
    expect(res.removed).toBe(0);
    expect(m.pendingTxsSnapshot()).toHaveLength(1);
  });

  it("survives an app restart (fresh module, same backing store)", async () => {
    const m = await loadModule();
    await m.enqueuePendingTx(entry(1));

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.pendingTxsSnapshot()).toEqual([]); // cold cache pre-hydrate
    await m2.hydratePendingTxs();
    expect(m2.pendingTxsSnapshot().map((e) => e.txHash)).toEqual([entry(1).txHash]);
  });

  it("clears a legacy unscoped registry once instead of polling old hashes", async () => {
    backing.set(
      "pending-tx.v1.json",
      new Map([["pending", { schemaVersion: 0, entries: [entry(1)] }]]),
    );

    const m = await loadModule();
    await m.hydratePendingTxs();

    expect(m.pendingTxsSnapshot()).toEqual([]);
    expect(backing.get("pending-tx.v1.json")?.get("networkScope")).toEqual({
      schemaVersion: 0,
      id: scopeState.resolved.id,
    });
    expect(backing.get("pending-tx.v1.json")?.get("pending")).toEqual({
      schemaVersion: 0,
      entries: [],
    });
  });

  it("drops tracked txs when the canonical genesis changes", async () => {
    const m = await loadModule();
    await m.enqueuePendingTx(entry(1));
    expect(m.pendingTxsSnapshot()).toHaveLength(1);

    scopeState.resolved = {
      id: "testnet-69420:69420:0xgenesis-b",
      source: "live",
    };
    expect(await m.listPendingTxs()).toEqual([]);
    expect(backing.get("pending-tx.v1.json")?.get("networkScope")).toEqual({
      schemaVersion: 0,
      id: scopeState.resolved.id,
    });
  });

  it("notifies subscribers on enqueue and on remove", async () => {
    const m = await loadModule();
    const listener = vi.fn();
    const unsub = m.subscribePendingTxs(listener);

    await m.enqueuePendingTx(entry(1));
    expect(listener).toHaveBeenCalledTimes(1);

    const { pendingTxKey } = await import("../pending-tx");
    await m.removePendingTxs(new Set([pendingTxKey(CHAIN, entry(1).txHash)]));
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    await m.enqueuePendingTx(entry(2));
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it("does not clobber on-disk entries when enqueuing from a cold cache", async () => {
    // Seed disk directly, then a fresh module enqueues a DIFFERENT tx without
    // an explicit hydrate first — the read-through hydrate in enqueue must
    // merge, not overwrite.
    backing.set(
      "pending-tx.v1.json",
      new Map([
        [
          "networkScope",
          {
            schemaVersion: 0,
            id: scopeState.resolved.id,
          },
        ],
        ["pending", { schemaVersion: 0, entries: [entry(1)] }],
      ]),
    );
    const m = await loadModule();
    await m.enqueuePendingTx(entry(2));
    const hashes = m.pendingTxsSnapshot().map((e) => e.txHash).sort();
    expect(hashes).toEqual([entry(1).txHash, entry(2).txHash].sort());
  });
});
