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
});

afterEach(() => {
  resetProviderForTest();
});

describe("client endpoint switching", () => {
  it("uses the shipped default when nothing is persisted", async () => {
    const before = currentEndpoint();
    await initEndpoint();
    expect(currentEndpoint()).toBe(before);
    expect(readSpy).toHaveBeenCalledOnce();
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
