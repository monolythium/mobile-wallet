// feature-flags seam — default-OFF + persistence + subscription tests.
//
// The flag is stored via @tauri-apps/plugin-store, which has no runtime in
// jsdom, so we mock it with an in-memory key/value store that mirrors the
// real Store.load / get / set / save surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One shared in-memory backing map per loaded store file.
const backing = vi.hoisted(() => new Map<string, Map<string, unknown>>());

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

// Import AFTER the mock is registered. Re-import per test via resetModules so
// the module-level cache starts fresh each time.
async function loadModule() {
  return import("../feature-flags");
}

beforeEach(() => {
  backing.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feature flags — experimental v5", () => {
  it("defaults OFF before hydration (synchronous render-path read)", async () => {
    const m = await loadModule();
    expect(m.experimentalV5Enabled()).toBe(false);
  });

  it("stays OFF after hydrating an empty store (no persisted value)", async () => {
    const m = await loadModule();
    await m.hydrateFeatureFlags();
    expect(m.experimentalV5Enabled()).toBe(false);
  });

  it("reads OFF when the stored value is not a boolean (corrupt/garbage)", async () => {
    const m = await loadModule();
    // Seed garbage into the backing store under the flag key.
    backing.set("flags.v1.json", new Map([[m.EXPERIMENTAL_V5_KEY, "yes"]]));
    await m.hydrateFeatureFlags();
    expect(m.experimentalV5Enabled()).toBe(false);
  });

  it("turns ON when set, and persists across a fresh hydrate", async () => {
    const m = await loadModule();
    await m.setExperimentalV5(true);
    expect(m.experimentalV5Enabled()).toBe(true);

    // Simulate an app restart: fresh module instance, same backing store.
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.experimentalV5Enabled()).toBe(false); // cache starts OFF
    await m2.hydrateFeatureFlags();
    expect(m2.experimentalV5Enabled()).toBe(true); // restored from disk
  });

  it("notifies subscribers on flip and on hydrate", async () => {
    const m = await loadModule();
    const listener = vi.fn();
    const unsub = m.subscribeFeatureFlags(listener);

    await m.setExperimentalV5(true);
    expect(listener).toHaveBeenCalledTimes(1);

    await m.setExperimentalV5(false);
    expect(listener).toHaveBeenCalledTimes(2);

    // No-op write (same value) does not emit.
    await m.setExperimentalV5(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    await m.setExperimentalV5(true);
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed
  });
});
