/**
 * bridge seam — risk-DISCLOSURE + read tests.
 *
 * 0.3.10 ships no live bridge quote/submit primitive; this seam is
 * disclosure + assessment + the two health/drain reads. These tests pin:
 *   - assessRoute against a known-good CCIP disclosure (accepted, low) and a
 *     1-of-1 verifier (blocked, "verifier set must not be 1-of-1");
 *   - computeDrainRemaining math (750, and null when disabled);
 *   - the fetch wrappers parse the lyth_bridgeHealth / lyth_bridgeDrainStatus
 *     envelopes via the shared send.test RPC-mock harness.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  addressToTypedBech32,
  type BridgeRouteDisclosure,
} from "@monolythium/core-sdk";
import {
  assessRoute,
  computeDrainRemaining,
  fetchBridgeDrainStatus,
  fetchBridgeHealth,
} from "../bridge";
import { resetProviderForTest, setProviderForTest } from "../client";

/** A valid typed `mono` bech32m wrapped-asset address for the drain read. */
const WRAPPED_ASSET = addressToTypedBech32(
  "user",
  "0x000000000000000000000000000000000000dead",
);

const GOOD_ROUTE: BridgeRouteDisclosure = {
  routeId: "ccip-eth-mono",
  bridge: "chainlink",
  protocol: "chainlink-ccip",
  asset: "USDC",
  feeToken: "LINK",
  sourceChain: "ethereum",
  destinationChain: "monolythium",
  verifier: { model: "chainlink-don", participantCount: 7, threshold: 5 },
  drainCapAtomic: "1000000000",
  finalityBlocks: 20,
  cooldownSeconds: 3600,
  adminControl: "consensusOnly",
  circuitBreaker: "armed",
  insuranceAtomic: "500000000",
  lastIncidentDate: null,
};

interface CapturedCall {
  method: string;
  params: unknown[];
}

function buildMockFetch(observed: CapturedCall[]): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body);
    const method = body.method as string;
    const params = (body.params ?? []) as unknown[];
    observed.push({ method, params });
    let result: unknown;
    switch (method) {
      case "lyth_bridgeHealth":
        result = {
          schemaVersion: 1,
          source: "native_state_storage",
          precompile: "0x0000000000000000000000000000000000001008",
          records: [
            {
              bridgeId: "0x" + "11".repeat(32),
              status: "active",
              statusCode: 1,
              latestAnchor: {
                headerRoot: "0x" + "22".repeat(32),
                headerBlock: 100,
                updatedAtProtocoreBlock: 200,
              },
              circuitBreaker: {
                defaultDrainCapPerWindow: "0x3b9aca00",
                defaultDrainWindowBlocks: 600,
                paused: false,
                pausedAtBlock: null,
                resumeCooldownBlocks: 100,
              },
            },
          ],
          nextCursor: null,
        };
        break;
      case "lyth_bridgeDrainStatus":
        result = {
          schemaVersion: 1,
          source: "native_state_storage",
          precompile: "0x0000000000000000000000000000000000001008",
          bridgeId: "0x" + "11".repeat(32),
          wrappedAsset: WRAPPED_ASSET,
          capPerWindow: "0x3e8",
          windowBlocks: 600,
          currentBucket: 3,
          drainedThisBucket: "0xfa",
          remaining: "0x2ee",
          bridgeDefault: {
            drainCapPerWindow: "0x3e8",
            drainWindowBlocks: 600,
          },
        };
        break;
      default:
        result = null;
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function installProvider(observed: CapturedCall[]) {
  const fetchFn = buildMockFetch(observed);
  const rpc = new RpcClient("http://test", { fetch: fetchFn });
  setProviderForTest(rpc);
}

afterEach(() => {
  resetProviderForTest();
});

describe("assessRoute", () => {
  it("accepts a known-good CCIP route as low risk", () => {
    const a = assessRoute(GOOD_ROUTE);
    expect(a.accepted).toBe(true);
    expect(a.riskTier).toBe("low");
    expect(a.blockedReasons).toEqual([]);
  });

  it("blocks a 1-of-1 verifier set", () => {
    const oneOfOne: BridgeRouteDisclosure = {
      ...GOOD_ROUTE,
      verifier: { model: "single", participantCount: 1, threshold: 1 },
    };
    const a = assessRoute(oneOfOne);
    expect(a.accepted).toBe(false);
    expect(a.riskTier).toBe("blocked");
    expect(a.blockedReasons).toContain("verifier set must not be 1-of-1");
  });

  it("blocks a non-CCIP protocol", () => {
    const wrongProto: BridgeRouteDisclosure = {
      ...GOOD_ROUTE,
      protocol: "wormhole",
      feeToken: "WETH",
    };
    const a = assessRoute(wrongProto);
    expect(a.accepted).toBe(false);
    expect(a.riskTier).toBe("blocked");
  });
});

describe("computeDrainRemaining", () => {
  it("computes cap - drained floored at zero", () => {
    expect(computeDrainRemaining("1000", "250")).toBe("750");
  });

  it("returns null when the cap is disabled", () => {
    expect(computeDrainRemaining("0", "0")).toBeNull();
  });
});

describe("bridge read wrappers", () => {
  it("fetchBridgeHealth parses the health envelope", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed);
    const health = await fetchBridgeHealth(null, 20);
    expect(observed.map((c) => c.method)).toContain("lyth_bridgeHealth");
    expect(health.records).toHaveLength(1);
    expect(health.records[0]?.circuitBreaker.paused).toBe(false);
    expect(health.nextCursor).toBeNull();
  });

  it("fetchBridgeDrainStatus parses the drain envelope", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed);
    const drain = await fetchBridgeDrainStatus(
      "0x" + "11".repeat(32),
      WRAPPED_ASSET,
    );
    expect(observed.map((c) => c.method)).toContain("lyth_bridgeDrainStatus");
    expect(drain.windowBlocks).toBe(600);
    expect(drain.bridgeDefault.drainWindowBlocks).toBe(600);
  });
});
