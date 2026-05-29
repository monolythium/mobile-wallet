/**
 * autovote planner — pure-function + diversity-fetch tests.
 *
 * computeAutovotePlan is pure (the caller supplies the diversity map), so
 * the mode logic is tested without a network stub:
 *   - MaxDiversity spreads to the highest-score clusters, total ≤ cap;
 *   - MaxDecentralization down-weights a cluster with low ASN/geo variance;
 *   - allocations sum within the cap.
 * fetchClusterDiversity is exercised against the shared send.test RPC-mock
 * harness (lyth_getClusterDiversity).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  type ClusterDirectoryEntryResponse,
  type ClusterDiversityView,
} from "@monolythium/core-sdk";
import {
  computeAutovotePlan,
  decentralizationScore,
  diversityScore,
  fetchClusterDiversity,
} from "../autovote";
import { resetProviderForTest, setProviderForTest } from "../client";

function cluster(
  clusterId: number,
  overrides: Partial<ClusterDirectoryEntryResponse> = {},
): ClusterDirectoryEntryResponse {
  return {
    clusterId,
    size: 7,
    threshold: 5,
    aggregateHealth: "healthy",
    regionDiversity: null,
    active: true,
    ...overrides,
  };
}

function diversity(
  clusterId: number,
  score: number,
  asn: number,
  geo: number,
  hosting: number,
): ClusterDiversityView {
  return { clusterId, score, asnVariance: asn, geoVariance: geo, hostingSpread: hosting };
}

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
    if (method === "lyth_getClusterDiversity") {
      result = {
        clusterId: params[0],
        score: 9000,
        asnVariance: 8000,
        geoVariance: 7000,
        hostingSpread: 6000,
      };
    } else {
      result = null;
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function installProvider(observed: CapturedCall[]) {
  const rpc = new RpcClient("http://test", { fetch: buildMockFetch(observed) });
  setProviderForTest(rpc);
}

afterEach(() => {
  resetProviderForTest();
});

describe("computeAutovotePlan — MaxDiversity", () => {
  it("spreads to the highest-score clusters and stays within cap", () => {
    const clusters = [cluster(1), cluster(2), cluster(3), cluster(4)];
    const scores = new Map<number, ClusterDiversityView>([
      [1, diversity(1, 2000, 0, 0, 0)],
      [2, diversity(2, 9000, 0, 0, 0)],
      [3, diversity(3, 7000, 0, 0, 0)],
      [4, diversity(4, 5000, 0, 0, 0)],
    ]);
    const plan = computeAutovotePlan({
      mode: "max-diversity",
      clusters,
      diversity: scores,
      capBps: 6000,
      spread: 3,
    });
    // Top-3 by score: clusters 2 (9000), 3 (7000), 4 (5000). Cluster 1 excluded.
    const picked = plan.allocations.map((a) => a.clusterId).sort();
    expect(picked).toEqual([2, 3, 4]);
    expect(plan.totalBps).toBeLessThanOrEqual(6000);
    expect(plan.totalBps).toBe(plan.allocations.reduce((s, a) => s + a.weightBps, 0));
  });
});

describe("computeAutovotePlan — MaxDecentralization", () => {
  it("down-weights a cluster with low ASN/geo variance", () => {
    const clusters = [cluster(1), cluster(2)];
    const scores = new Map<number, ClusterDiversityView>([
      // Cluster 1: concentrated — low variance everywhere.
      [1, diversity(1, 5000, 500, 500, 500)],
      // Cluster 2: well-spread.
      [2, diversity(2, 5000, 9000, 9000, 9000)],
    ]);
    expect(decentralizationScore(scores, 2)).toBeGreaterThan(
      decentralizationScore(scores, 1),
    );
    const plan = computeAutovotePlan({
      mode: "max-decentralization",
      clusters,
      diversity: scores,
      capBps: 4000,
      spread: 1,
    });
    // With spread 1, only the most-decentralized cluster (2) is picked.
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]?.clusterId).toBe(2);
  });
});

describe("computeAutovotePlan — sums within cap + custom", () => {
  it("allocations sum to exactly the rounded cap (≤ cap)", () => {
    const clusters = [cluster(1), cluster(2), cluster(3)];
    const scores = new Map<number, ClusterDiversityView>([
      [1, diversity(1, 9000, 0, 0, 0)],
      [2, diversity(2, 8000, 0, 0, 0)],
      [3, diversity(3, 7000, 0, 0, 0)],
    ]);
    const plan = computeAutovotePlan({
      mode: "max-diversity",
      clusters,
      diversity: scores,
      capBps: 5001, // odd cap to exercise the remainder absorption
      spread: 3,
    });
    const total = plan.allocations.reduce((s, a) => s + a.weightBps, 0);
    expect(total).toBe(5001);
    expect(plan.totalBps).toBe(5001);
  });

  it("custom mode passes allocations through and flags over-cap", () => {
    const plan = computeAutovotePlan({
      mode: "custom",
      clusters: [],
      diversity: new Map(),
      capBps: 1000,
      customAllocations: [
        { clusterId: 1, weightBps: 700 },
        { clusterId: 2, weightBps: 800 },
      ],
    });
    expect(plan.allocations).toHaveLength(2);
    expect(plan.totalBps).toBe(1500);
    expect(plan.notes.some((n) => /exceeds/.test(n))).toBe(true);
  });

  it("max-yield notes the health-proxy caveat (no APR on chain)", () => {
    const plan = computeAutovotePlan({
      mode: "max-yield",
      clusters: [cluster(1), cluster(2, { aggregateHealth: "degraded" })],
      diversity: new Map(),
      capBps: 4000,
      spread: 2,
    });
    expect(plan.notes.some((n) => /health proxy|aggregate cluster health/i.test(n))).toBe(true);
    // Healthier cluster (1) ranks ahead of the degraded one (2).
    expect(plan.allocations[0]?.clusterId).toBe(1);
  });
});

describe("diversityScore helper", () => {
  it("normalises score against DIVERSITY_SCORE_MAX and reads missing as 0", () => {
    const scores = new Map<number, ClusterDiversityView>([
      [1, diversity(1, 5000, 0, 0, 0)],
    ]);
    expect(diversityScore(scores, 1)).toBeCloseTo(0.5);
    expect(diversityScore(scores, 99)).toBe(0);
  });
});

describe("fetchClusterDiversity", () => {
  it("reads lyth_getClusterDiversity and returns a ClusterDiversityView", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed);
    const view = await fetchClusterDiversity(5);
    expect(observed.map((c) => c.method)).toContain("lyth_getClusterDiversity");
    expect(view.clusterId).toBe(5);
    expect(view.score).toBe(9000);
  });
});
