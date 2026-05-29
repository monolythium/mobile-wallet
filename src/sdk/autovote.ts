// Autovote planner seam — turns a delegator-facing intent (Max Yield /
// Max Diversity / Max Decentralization / Custom) into a set of
// `delegate(uint32,uint16)` allocations the corrected staking seam
// (`submitStakingTx`) can submit one-per-cluster.
//
// This is a READ + PURE-PLANNER surface (whitepaper §25.1). The diversity
// inputs come from the JSON RPC `lyth_getClusterDiversity` method
// (-> ClusterDiversityView), NOT an ABI `eth_call` + decodeClusterDiversity:
// 0.3.10's RpcClient exposes no `ethCall`, and the JSON method already
// carries every basis-point field plus the `clusterId` echo, so no ABI
// decode is needed. This is the idiomatic path.
//
// HONEST-DATA CAVEAT — "Max Yield" has no true APR input:
// `ClusterDirectoryEntryResponse` carries `aggregateHealth` (a string
// label) but NO APR/yield field in 0.3.10. Max Yield therefore ranks by
// the aggregateHealth proxy and is labelled as such; it never fabricates
// an APR. See the TODO below.

// NOTE: the planner is PURE — it produces `{clusterId, weightBps}`
// allocations only. The actual `delegate(uint32,uint16)` calldata is built
// from these allocations by the staking seam (`buildDelegateCalldata`, which
// wraps the SDK's `encodeDelegateCalldata`) at the Stake call site, so this
// module does not import the encoder directly.
import {
  DIVERSITY_SCORE_MAX,
  type ClusterDirectoryEntryResponse,
  type ClusterDiversityView,
} from "@monolythium/core-sdk";
import { getProvider } from "./client";

export type AutovoteMode =
  | "max-yield"
  | "max-diversity"
  | "max-decentralization"
  | "custom";

/** One planned delegation: cluster + the wallet-weight (basis points). */
export interface AutovoteAllocation {
  clusterId: number;
  weightBps: number;
}

export interface AutovotePlan {
  mode: AutovoteMode;
  allocations: AutovoteAllocation[];
  /** Total basis points the plan distributes (≤ capBps). */
  totalBps: number;
  /** Human-readable notes (honest-data caveats, skipped clusters, etc.). */
  notes: string[];
}

export interface ComputeAutovotePlanArgs {
  mode: AutovoteMode;
  clusters: ClusterDirectoryEntryResponse[];
  /** Per-cluster diversity, keyed by clusterId. Required for diversity /
   *  decentralization modes; ignored by max-yield + custom. */
  diversity: Map<number, ClusterDiversityView>;
  /** Total wallet-weight (basis points) to distribute. 1-10000. */
  capBps: number;
  /** How many clusters to spread across (default 3, clamped to active set). */
  spread?: number;
  /** Custom-mode passthrough allocations (used only when mode === "custom"). */
  customAllocations?: AutovoteAllocation[];
}

/**
 * Fetch one cluster's diversity view via the JSON RPC method.
 * Returns a {@link ClusterDiversityView} with the basis-point fields and a
 * `clusterId` echo. Throws on transport / RPC failure so callers can render
 * a degraded state.
 */
export async function fetchClusterDiversity(
  clusterId: number,
): Promise<ClusterDiversityView> {
  return getProvider().rpcClient.lythGetClusterDiversity(clusterId);
}

/**
 * Compute an autovote allocation plan. Pure (no I/O) — the caller fetches
 * the diversity map first (via {@link fetchClusterDiversity}) and passes it
 * in, so this stays unit-testable without a network stub.
 *
 * All modes distribute at most `capBps` basis points; the final cluster
 * absorbs the rounding remainder so the plan sums to exactly the rounded
 * cap (≤ capBps).
 */
export function computeAutovotePlan(args: ComputeAutovotePlanArgs): AutovotePlan {
  const { mode, clusters, diversity, capBps } = args;
  const notes: string[] = [];

  if (mode === "custom") {
    const allocations = (args.customAllocations ?? []).filter(
      (a) => a.weightBps > 0,
    );
    const totalBps = allocations.reduce((s, a) => s + a.weightBps, 0);
    if (totalBps > capBps) {
      notes.push(
        `Custom allocation totals ${(totalBps / 100).toFixed(2)}% — exceeds the ${(capBps / 100).toFixed(2)}% cap.`,
      );
    }
    return { mode, allocations, totalBps, notes };
  }

  const active = clusters.filter((c) => c.active);
  if (active.length === 0) {
    notes.push("No active clusters available to plan against.");
    return { mode, allocations: [], totalBps: 0, notes };
  }

  const spread = Math.max(1, Math.min(args.spread ?? 3, active.length));

  let ranked: ClusterDirectoryEntryResponse[];
  switch (mode) {
    case "max-yield": {
      // No true APR field on ClusterDirectoryEntryResponse in 0.3.10 — rank
      // by the aggregateHealth proxy. NEVER fabricate an APR.
      // TODO(monolythium-vision): lyth_clusterDirectory lacks an APR/yield
      // field; Max Yield approximates yield by aggregateHealth. Replace with
      // a real APR rank when the directory exposes one.
      notes.push(
        "Max Yield ranks by aggregate cluster health — the chain does not yet publish a per-cluster APR, so this is a health proxy, not a yield figure.",
      );
      ranked = [...active].sort(
        (a, b) =>
          aggregateHealthScore(b.aggregateHealth) -
          aggregateHealthScore(a.aggregateHealth),
      );
      break;
    }
    case "max-diversity": {
      // Highest headline diversity score first.
      ranked = [...active].sort(
        (a, b) =>
          diversityScore(diversity, b.clusterId) -
          diversityScore(diversity, a.clusterId),
      );
      break;
    }
    case "max-decentralization": {
      // Route stake AWAY from concentrated clusters: rank by the combined
      // network-spread axes (asnVariance + geoVariance + hostingSpread) so
      // concentrated (low-variance) clusters sink to the bottom.
      ranked = [...active].sort(
        (a, b) =>
          decentralizationScore(diversity, b.clusterId) -
          decentralizationScore(diversity, a.clusterId),
      );
      break;
    }
    default: {
      // Exhaustiveness guard.
      const _never: never = mode;
      throw new Error(`unknown autovote mode: ${String(_never)}`);
    }
  }

  const picked = ranked.slice(0, spread);
  if (
    (mode === "max-diversity" || mode === "max-decentralization") &&
    picked.some((c) => !diversity.has(c.clusterId))
  ) {
    notes.push(
      "Some selected clusters had no diversity score on chain; they are weighted as zero.",
    );
  }

  // Even split across `spread` clusters; last cluster absorbs the remainder
  // so the plan sums to exactly `perCluster * (spread-1) + remainder` ≤ cap.
  const perCluster = Math.floor(capBps / picked.length);
  const allocations: AutovoteAllocation[] = picked.map((c, i) => ({
    clusterId: c.clusterId,
    weightBps:
      i === picked.length - 1
        ? capBps - perCluster * (picked.length - 1)
        : perCluster,
  }));
  const totalBps = allocations.reduce((s, a) => s + a.weightBps, 0);

  return { mode, allocations, totalBps, notes };
}

/**
 * Headline diversity score for a cluster, normalised to `0..=1` against
 * {@link DIVERSITY_SCORE_MAX}. Missing scores read as 0.
 */
export function diversityScore(
  diversity: Map<number, ClusterDiversityView>,
  clusterId: number,
): number {
  const v = diversity.get(clusterId);
  if (!v) return 0;
  return v.score / DIVERSITY_SCORE_MAX;
}

/**
 * Decentralization score = mean of the three network-spread axes
 * (ASN / geo / hosting), normalised to `0..=1`. Concentrated clusters
 * (low variance on any axis) score lower. Missing scores read as 0.
 */
export function decentralizationScore(
  diversity: Map<number, ClusterDiversityView>,
  clusterId: number,
): number {
  const v = diversity.get(clusterId);
  if (!v) return 0;
  return (
    (v.asnVariance + v.geoVariance + v.hostingSpread) /
    (3 * DIVERSITY_SCORE_MAX)
  );
}

/**
 * Coarse ordinal score for the directory's free-text `aggregateHealth`
 * label, used ONLY as the Max-Yield proxy (no APR exists). Unknown labels
 * fall to the bottom. This is a display-order heuristic, not a yield.
 */
function aggregateHealthScore(label: string): number {
  switch (label.trim().toLowerCase()) {
    case "excellent":
    case "healthy":
    case "nominal":
      return 3;
    case "good":
    case "ok":
      return 2;
    case "degraded":
    case "warning":
      return 1;
    default:
      return 0;
  }
}
