import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the peer-persistence layer so these tests never touch the Tauri
// plugin-store. The persisted endpoint is controlled per-case via the spies.
const readSpy = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const writeSpy = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());

vi.mock("../peers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../peers")>();
  return {
    ...actual,
    readSelectedEndpoint: readSpy,
    writeSelectedEndpoint: writeSpy,
  };
});

// Stub the SDK's genesis-verified operator selection so init never hits the
// network. `selectSpy` backs the bundled-snapshot fallback path
// (selectTrustedOperatorForNetwork); `selectLiveSpy` backs the live-registry
// path (selectTrustedOperator). Default (set in beforeEach) is a rejection →
// the fail-soft path keeps the shipped default.
const selectSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ endpoint: string }>>(),
);
const selectLiveSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ endpoint: string }>>(),
);
vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk")>();
  return {
    ...actual,
    selectTrustedOperatorForNetwork: selectSpy,
    selectTrustedOperator: selectLiveSpy,
  };
});

// Stub the live chain-registry fetch so the boot probe never hits GitHub.
// Default (set in beforeEach) is `null` → offline → the probe degrades to the
// bundled-snapshot path (selectTrustedOperatorForNetwork).
const liveRegistrySpy = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>(),
);
vi.mock("../live-registry", () => ({
  fetchLiveTestnetRegistry: liveRegistrySpy,
}));

import {
  currentEndpoint,
  getProvider,
  initEndpoint,
  resetProviderForTest,
  setEndpoint,
  subscribeEndpoint,
} from "../client";

beforeEach(() => {
  resetProviderForTest();
  readSpy.mockReset().mockResolvedValue(null);
  writeSpy.mockReset().mockResolvedValue(undefined);
  // Default: no trusted operator → fail-soft to the shipped default.
  selectSpy.mockReset().mockRejectedValue(new Error("no trusted operator"));
  selectLiveSpy.mockReset().mockRejectedValue(new Error("no trusted operator"));
  // Default: live registry unreachable → probe degrades to the bundled path.
  liveRegistrySpy.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  resetProviderForTest();
});

describe("client endpoint switching", () => {
  it("keeps the shipped default when nothing is persisted and no operator is trusted", async () => {
    const before = currentEndpoint();
    await initEndpoint();
    expect(currentEndpoint()).toBe(before); // fail-soft
    expect(readSpy).toHaveBeenCalledOnce();
    expect(selectSpy).toHaveBeenCalledOnce();
  });

  it("upgrades to a genesis-verified operator when nothing is persisted", async () => {
    selectSpy.mockResolvedValue({ endpoint: "http://verified.example:8545" });
    await initEndpoint();
    expect(currentEndpoint()).toBe("http://verified.example:8545");
    expect(getProvider().rpcClient.endpoint).toBe(
      "http://verified.example:8545",
    );
  });

  it("verifies against the live registry when it is reachable", async () => {
    // Live registry reachable → the probe must verify against it (not the
    // bundled snapshot), so a stale build still checks the current genesis.
    liveRegistrySpy.mockResolvedValue({ network: "testnet-69420" });
    selectLiveSpy.mockResolvedValue({ endpoint: "http://live-verified.example:8545" });
    await initEndpoint();
    expect(selectLiveSpy).toHaveBeenCalledOnce();
    expect(selectSpy).not.toHaveBeenCalled(); // bundled fallback not used
    expect(currentEndpoint()).toBe("http://live-verified.example:8545");
  });

  it("rejects on a genesis mismatch and logs it instead of silently falling back", async () => {
    const before = currentEndpoint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Live registry reachable, but every operator fails the genesis check.
    liveRegistrySpy.mockResolvedValue({ network: "testnet-69420" });
    selectLiveSpy.mockRejectedValue(new Error("no trusted operator (regenesis)"));

    await initEndpoint();

    expect(selectLiveSpy).toHaveBeenCalledOnce();
    expect(currentEndpoint()).toBe(before); // fail-closed to shipped default
    expect(warn).toHaveBeenCalled(); // the failure is observable, not silent
    warn.mockRestore();
  });

  it("respects a persisted user choice without auto-overriding it", async () => {
    readSpy.mockResolvedValue("https://my-peer.example/rpc");
    await initEndpoint();
    expect(currentEndpoint()).toBe("https://my-peer.example/rpc");
    expect(selectSpy).not.toHaveBeenCalled(); // user choice wins; no probe
  });

  it("adopts a persisted endpoint at init and rebuilds the client", async () => {
    readSpy.mockResolvedValue("https://persisted.example/rpc");
    await initEndpoint();
    expect(currentEndpoint()).toBe("https://persisted.example/rpc");
    expect(getProvider().rpcClient.endpoint).toBe(
      "https://persisted.example/rpc",
    );
  });

  it("setEndpoint switches the active endpoint, persists it, and notifies", async () => {
    const seen: string[] = [];
    const unsub = subscribeEndpoint((ep) => seen.push(ep));

    await setEndpoint("https://chosen.example/rpc");

    expect(currentEndpoint()).toBe("https://chosen.example/rpc");
    expect(getProvider().rpcClient.endpoint).toBe("https://chosen.example/rpc");
    expect(writeSpy).toHaveBeenCalledWith("https://chosen.example/rpc");
    expect(seen).toEqual(["https://chosen.example/rpc"]);

    unsub();
  });

  it("does not notify when setEndpoint is a no-op (same url)", async () => {
    await setEndpoint("https://same.example/rpc");
    const seen: string[] = [];
    const unsub = subscribeEndpoint((ep) => seen.push(ep));

    await setEndpoint("https://same.example/rpc");

    expect(seen).toEqual([]); // already active, no emit
    expect(writeSpy).toHaveBeenCalledTimes(2); // still persisted both times
    unsub();
  });
});
