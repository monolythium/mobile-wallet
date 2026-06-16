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
// network. Default (set in beforeEach) is a rejection → the fail-soft path
// keeps the shipped default.
const selectSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ endpoint: string }>>(),
);
vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk")>();
  return {
    ...actual,
    selectTrustedOperatorForNetwork: selectSpy,
  };
});

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
