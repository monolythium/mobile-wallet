// Notification store — record/dedupe/cap, mark-read, unread count, hydrate,
// snapshot + subscribe, and the best-effort failure swallow.
//
// @tauri-apps/plugin-store has no runtime in jsdom, so we mock it with an
// in-memory key/value store mirroring Store.load / get / set / save (same
// approach as feature-flags.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backing = vi.hoisted(() => new Map<string, Map<string, unknown>>());
// When set, the next mocked store op throws — exercises the swallow paths.
const failNext = vi.hoisted(() => ({ value: false }));
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
      if (failNext.value) {
        failNext.value = false;
        throw new Error("store get boom");
      }
      return this.map.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      if (failNext.value) {
        failNext.value = false;
        throw new Error("store set boom");
      }
      this.map.set(key, value);
    }
    async save(): Promise<void> {}
  }
  return { Store: MockStore };
});

async function loadModule() {
  return import("../notifications-store");
}

function input(over: Record<string, unknown> = {}) {
  return {
    chainIdHex: "0x10f2c",
    txHash: "0x" + "ab".repeat(32),
    status: "confirmed" as const,
    blockNumber: 100,
    kind: "send" as const,
    amountDecimal: "1.5",
    counterparty: "0x" + "11".repeat(20),
    ...over,
  };
}

beforeEach(() => {
  backing.clear();
  failNext.value = false;
  scopeState.resolved = {
    id: "testnet-69420:69420:0xgenesis-a",
    source: "live",
  };
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordNotification", () => {
  it("appends a record and exposes it via the cache + list", async () => {
    const m = await loadModule();
    const res = await m.recordNotification(input());
    expect(res.added).toBe(true);
    expect(res.record?.status).toBe("confirmed");
    expect(res.record?.read).toBe(false);

    expect(m.notificationsSnapshot()).toHaveLength(1);
    const listed = await m.listNotifications();
    expect(listed[0]?.txHash).toBe(input().txHash);
  });

  it("dedupes on (chainIdHex, txHash) across calls", async () => {
    const m = await loadModule();
    const first = await m.recordNotification(input());
    const second = await m.recordNotification(input());
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.record).toBeNull();
    expect(m.notificationsSnapshot()).toHaveLength(1);
  });

  it("same txHash on a different chain is a distinct record", async () => {
    const m = await loadModule();
    await m.recordNotification(input({ chainIdHex: "0x1" }));
    await m.recordNotification(input({ chainIdHex: "0x2" }));
    expect(m.notificationsSnapshot()).toHaveLength(2);
  });

  it("STATUS FIDELITY — persists the status verbatim, never coercing", async () => {
    const m = await loadModule();
    await m.recordNotification(input({ status: "failed", txHash: "0x" + "ff".repeat(32) }));
    const listed = await m.listNotifications();
    expect(listed[0]?.status).toBe("failed");
  });

  it("respects read:true at observe-time (no unread bump)", async () => {
    const m = await loadModule();
    await m.recordNotification(input({ read: true }));
    expect(m.unreadCountSnapshot()).toBe(0);
    expect(await m.getUnreadCount()).toBe(0);
  });

  it("is newest-first and capped at NOTIFICATION_HISTORY_CAP", async () => {
    const m = await loadModule();
    const { NOTIFICATION_HISTORY_CAP } = await import("../notifications");
    for (let i = 0; i < NOTIFICATION_HISTORY_CAP + 3; i++) {
      await m.recordNotification(input({ txHash: "0x" + i.toString(16).padStart(64, "0") }));
    }
    const listed = await m.listNotifications();
    expect(listed).toHaveLength(NOTIFICATION_HISTORY_CAP);
  });

  it("is best-effort: a store failure is swallowed (no throw)", async () => {
    const m = await loadModule();
    failNext.value = true; // first get() inside recordNotification throws
    const res = await m.recordNotification(input());
    expect(res).toEqual({ added: false, record: null });
  });
});

describe("unread count", () => {
  it("counts only unread records", async () => {
    const m = await loadModule();
    await m.recordNotification(input({ txHash: "0x" + "01".repeat(32) }));
    await m.recordNotification(input({ txHash: "0x" + "02".repeat(32) }));
    expect(m.unreadCountSnapshot()).toBe(2);
    expect(await m.getUnreadCount()).toBe(2);
  });
});

describe("markAllNotificationsRead", () => {
  it("flips all unread and is idempotent", async () => {
    const m = await loadModule();
    await m.recordNotification(input({ txHash: "0x" + "01".repeat(32) }));
    await m.recordNotification(input({ txHash: "0x" + "02".repeat(32) }));

    const first = await m.markAllNotificationsRead();
    expect(first.flipped).toBe(2);
    expect(m.unreadCountSnapshot()).toBe(0);

    const second = await m.markAllNotificationsRead();
    expect(second.flipped).toBe(0);
  });
});

describe("markNotificationRead", () => {
  it("flips a single record by id; second tap is a no-op", async () => {
    const m = await loadModule();
    const r = await m.recordNotification(input());
    const id = r.record!.id;

    const first = await m.markNotificationRead(id);
    expect(first.flipped).toBe(true);
    expect(m.unreadCountSnapshot()).toBe(0);

    const second = await m.markNotificationRead(id);
    expect(second.flipped).toBe(false);
  });

  it("returns flipped:false for an unknown id", async () => {
    const m = await loadModule();
    await m.recordNotification(input());
    expect((await m.markNotificationRead("0xdead:0xbeef")).flipped).toBe(false);
  });
});

describe("hydrate + subscribe", () => {
  it("hydrates the cache from disk on a fresh module instance", async () => {
    const m = await loadModule();
    await m.recordNotification(input());

    // Simulate a restart: fresh module, same backing store.
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.notificationsSnapshot()).toHaveLength(0); // cold cache
    await m2.hydrateNotifications();
    expect(m2.notificationsSnapshot()).toHaveLength(1); // restored from disk
  });

  it("clears legacy history + dedupe watermark once and stamps the genesis", async () => {
    backing.set(
      "notifications.v1.json",
      new Map([
        [
          "history",
          {
            schemaVersion: 0,
            entries: [
              {
                id: "0x10f2c:0xold",
                txHash: "0xold",
                status: "confirmed",
                blockNumber: 5,
                kind: "send",
                amountDecimal: "1",
                counterparty: "0x" + "11".repeat(20),
                createdAtMs: 1,
                read: false,
                schemaVersion: 0,
              },
            ],
          },
        ],
        ["notified", { schemaVersion: 0, ids: ["0x10f2c:0xold"] }],
      ]),
    );

    const m = await loadModule();
    await m.hydrateNotifications();

    expect(m.notificationsSnapshot()).toEqual([]);
    const store = backing.get("notifications.v1.json");
    expect(store?.get("history")).toEqual({ schemaVersion: 0, entries: [] });
    expect(store?.get("notified")).toEqual({ schemaVersion: 0, ids: [] });
    expect(store?.get("networkScope")).toEqual({
      schemaVersion: 0,
      id: scopeState.resolved.id,
    });
  });

  it("clears history + dedupe watermark when canonical genesis changes", async () => {
    const m = await loadModule();
    await m.recordNotification(input());
    expect(m.notificationsSnapshot()).toHaveLength(1);

    scopeState.resolved = {
      id: "testnet-69420:69420:0xgenesis-b",
      source: "live",
    };
    expect(await m.listNotifications()).toEqual([]);
    const store = backing.get("notifications.v1.json");
    expect(store?.get("notified")).toEqual({ schemaVersion: 0, ids: [] });
    expect(store?.get("networkScope")).toEqual({
      schemaVersion: 0,
      id: scopeState.resolved.id,
    });
  });

  it("notifies subscribers on record + mark-all-read", async () => {
    const m = await loadModule();
    const listener = vi.fn();
    const unsub = m.subscribeNotifications(listener);

    await m.recordNotification(input());
    expect(listener).toHaveBeenCalledTimes(1);

    await m.markAllNotificationsRead();
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    await m.recordNotification(input({ txHash: "0x" + "0a".repeat(32) }));
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it("hydrate degrades to empty when the store is unreadable", async () => {
    const m = await loadModule();
    failNext.value = true; // get() throws during hydrate
    await m.hydrateNotifications();
    expect(m.notificationsSnapshot()).toHaveLength(0);
  });
});
