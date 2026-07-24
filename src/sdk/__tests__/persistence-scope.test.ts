import { beforeEach, describe, expect, it, vi } from "vitest";

const liveState = vi.hoisted(() => ({
  info: null as {
    network: string;
    chain_id: number;
    genesis_hash: string;
  } | null,
}));

vi.mock("../live-registry", () => ({
  fetchLiveTestnetRegistry: async () => liveState.info,
}));

vi.mock("@monolythium/core-sdk", () => ({
  getChainInfo: () => ({
    network: "testnet-69420",
    chain_id: 69420,
    genesis_hash: "0xBundled",
  }),
}));

import {
  parsePersistenceScopeEnvelope,
  resolvePersistenceScope,
  selectPersistenceScopeId,
} from "../persistence-scope";

beforeEach(() => {
  liveState.info = null;
});

describe("persistence scope", () => {
  it("prefers and normalizes the live canonical genesis", async () => {
    liveState.info = {
      network: "testnet-69420",
      chain_id: 69420,
      genesis_hash: "  0xLIVE  ",
    };
    await expect(resolvePersistenceScope()).resolves.toEqual({
      id: "testnet-69420:69420:0xlive",
      source: "live",
    });
  });

  it("falls back to the bundled registry pin when live registry is unavailable", async () => {
    await expect(resolvePersistenceScope()).resolves.toEqual({
      id: "testnet-69420:69420:0xbundled",
      source: "bundled",
    });
  });

  it("preserves an existing stamp during fallback but accepts a live change", () => {
    const persisted = {
      schemaVersion: 0 as const,
      id: "testnet-69420:69420:0xcurrent",
    };
    expect(
      selectPersistenceScopeId(
        { id: "testnet-69420:69420:0xstale", source: "bundled" },
        persisted,
      ),
    ).toBe(persisted.id);
    expect(
      selectPersistenceScopeId(
        { id: "testnet-69420:69420:0xnew", source: "live" },
        persisted,
      ),
    ).toBe("testnet-69420:69420:0xnew");
  });

  it("treats missing, malformed, and future metadata as legacy", () => {
    expect(parsePersistenceScopeEnvelope(undefined)).toBeNull();
    expect(
      parsePersistenceScopeEnvelope({ schemaVersion: 1, id: "future" }),
    ).toBeNull();
    expect(
      parsePersistenceScopeEnvelope({ schemaVersion: 0, id: "" }),
    ).toBeNull();
    expect(
      parsePersistenceScopeEnvelope({ schemaVersion: 0, id: "current" }),
    ).toEqual({ schemaVersion: 0, id: "current" });
  });
});
