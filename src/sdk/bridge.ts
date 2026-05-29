// Bridge seam — READ + RISK-DISCLOSURE only (whitepaper §20 / §25.2).
//
// 0.3.10 exposes NO live bridge quote/submit primitive
// (`BRIDGE_QUOTE_API_BLOCKED_REASON` / `BRIDGE_SUBMIT_API_BLOCKED_REASON`):
// the chain does not yet ship the live quote+submit API/runtime, so this
// seam surfaces the route disclosure + risk assessment ONLY. It never
// claims an executable bridge transfer — the Bridge screen renders the
// blocked reason as a typed not-yet-live state.
//
// What this seam provides:
//   - fetchBridgeHealth   -> the global bridge-health page (circuit-breaker
//                            posture per route) via lyth_bridgeHealth.
//   - fetchBridgeDrainStatus -> the live per-route drain bucket via
//                            lyth_bridgeDrainStatus.
//   - assessRoute         -> SDK risk assessment (riskTier / score /
//                            blockedReasons / warnings) for a disclosure.
//   - rankRoutes          -> SDK ranking across disclosures.
//   - computeDrainRemaining -> SDK `cap - drained` floored at 0 (null if
//                            the cap is disabled).
//   - toRiskRows          -> flattens a disclosure (+ optional drain status
//                            + breaker record) into OperationKeyValue[] for
//                            the OperationsDrawer §25.2 disclosure rows.

import {
  assessBridgeRoute,
  rankBridgeRoutes,
  bridgeDrainRemaining,
  bridgeAddressHex,
  V1_BRIDGE_ALLOWED_FEE_TOKEN,
  type BridgeRouteDisclosure,
  type BridgeRouteAssessment,
  type BridgeHealthResponse,
  type BridgeHealthRecord,
  type BridgeDrainStatus,
  type BridgeCircuitBreakerFields,
  type BridgeRiskTier,
  type RankedBridgeRoute,
} from "@monolythium/core-sdk";
import { getProvider } from "./client";
import type { OperationKeyValue } from "../components/OperationsDrawer";

/** Bridge precompile address (0x…1008), resolved from the SDK. */
export const BRIDGE_PRECOMPILE = bridgeAddressHex();

/** Re-export the LINK fee-token constant so screens render the honest copy. */
export { V1_BRIDGE_ALLOWED_FEE_TOKEN };

/**
 * Page the global bridge-health set (circuit-breaker posture per route).
 * `lyth_bridgeHealth` is paged by cursor + limit; there is no single-bridge
 * form. Each record's `circuitBreaker` answers "is this route paused /
 * rate-limited" in one round-trip.
 */
export async function fetchBridgeHealth(
  cursor?: string | null,
  limit?: number,
): Promise<BridgeHealthResponse> {
  return getProvider().rpcClient.lythBridgeHealth(cursor, limit);
}

/**
 * Fetch the live per-route drain bucket for one `(bridgeId, wrappedAsset)`
 * route. `remaining` is `capPerWindow - drainedThisBucket` clamped at 0
 * (0x0 when no per-asset cap is configured).
 */
export async function fetchBridgeDrainStatus(
  bridgeId: string,
  wrappedAssetBech32m: string,
): Promise<BridgeDrainStatus> {
  return getProvider().rpcClient.lythBridgeDrainStatus(
    bridgeId,
    wrappedAssetBech32m,
  );
}

/** Risk-assess a single route disclosure (riskTier / score / blocked / warn). */
export function assessRoute(
  disclosure: BridgeRouteDisclosure,
): BridgeRouteAssessment {
  return assessBridgeRoute(disclosure);
}

/** Rank a set of route disclosures best-first by their assessment. */
export function rankRoutes(
  disclosures: readonly BridgeRouteDisclosure[],
): RankedBridgeRoute[] {
  return rankBridgeRoutes(disclosures);
}

/**
 * SDK `cap - drained` floored at 0; `null` when the cap is disabled
 * (`capPerWindow === "0"`). Both args are decimal strings.
 */
export function computeDrainRemaining(
  capPerWindow: string,
  drained: string,
): string | null {
  return bridgeDrainRemaining(capPerWindow, drained);
}

/** Find the bridge-health record matching a bridgeId in a health page. */
export function findBreakerRecord(
  health: BridgeHealthResponse,
  bridgeId: string,
): BridgeHealthRecord | null {
  const want = bridgeId.toLowerCase();
  return (
    health.records.find((r) => r.bridgeId.toLowerCase() === want) ?? null
  );
}

/** Human-readable circuit-breaker posture from a health record's breaker. */
export function breakerPostureLabel(
  breaker: BridgeCircuitBreakerFields | null,
): string {
  if (!breaker) return "unknown";
  if (breaker.paused) {
    return breaker.pausedAtBlock !== null
      ? `paused (since block ${breaker.pausedAtBlock})`
      : "paused";
  }
  return "armed";
}

/** A short, honest riskTier badge label. */
export function riskTierLabel(tier: BridgeRiskTier): string {
  switch (tier) {
    case "low":
      return "Low risk";
    case "medium":
      return "Medium risk";
    case "high":
      return "High risk";
    case "blocked":
      return "Blocked";
    default:
      return String(tier);
  }
}

export interface ToRiskRowsArgs {
  disclosure: BridgeRouteDisclosure;
  assessment: BridgeRouteAssessment;
  /** Live per-route drain bucket, if fetched. */
  drainStatus?: BridgeDrainStatus | null;
  /** Bridge-health circuit-breaker record, if fetched. */
  breaker?: BridgeCircuitBreakerFields | null;
}

/**
 * Flatten a route disclosure + assessment (+ optional live drain status +
 * breaker) into the OperationsDrawer's `details[]` rows — the §25.2
 * disclosure surface: route, protocol, asset/fee-token, source→dest chain,
 * verifier model+threshold/participants, drain-cap remaining, circuit-breaker
 * status, insurance, last-incident date, risk tier + warnings.
 */
export function toRiskRows(args: ToRiskRowsArgs): OperationKeyValue[] {
  const { disclosure: d, assessment, drainStatus, breaker } = args;
  const rows: OperationKeyValue[] = [
    { k: "Route", v: d.routeId, mono: true },
    { k: "Protocol", v: d.protocol ?? "—", mono: true },
    { k: "Asset", v: d.asset, mono: true },
    { k: "Fee token", v: d.feeToken, mono: true },
    { k: "Route", v: `${d.sourceChain} → ${d.destinationChain}` },
    {
      k: "Verifier",
      v: `${d.verifier.model} · ${d.verifier.threshold}-of-${d.verifier.participantCount}`,
    },
  ];

  // Drain-cap remaining: prefer the live per-route bucket, else the
  // disclosure's static cap.
  if (drainStatus) {
    const remaining = computeDrainRemaining(
      hexOrDecToDec(drainStatus.capPerWindow),
      hexOrDecToDec(drainStatus.drainedThisBucket),
    );
    rows.push({
      k: "Drain cap remaining",
      v:
        remaining === null
          ? "no per-asset cap"
          : `${remaining} (atomic)`,
      mono: true,
    });
  } else {
    rows.push({
      k: "Drain cap",
      v:
        d.drainCapAtomic === "0"
          ? "disabled"
          : `${d.drainCapAtomic} (atomic)`,
      mono: true,
    });
  }

  rows.push({
    k: "Circuit breaker",
    v: breaker ? breakerPostureLabel(breaker) : disclosureBreakerLabel(d.circuitBreaker),
  });
  rows.push({
    k: "Insurance pool",
    v:
      d.insuranceAtomic === "0"
        ? "none"
        : `${d.insuranceAtomic} (atomic)`,
    mono: true,
  });
  rows.push({
    k: "Last incident",
    v: d.lastIncidentDate ?? "none on record",
  });
  rows.push({ k: "Risk tier", v: riskTierLabel(assessment.riskTier) });
  if (assessment.blockedReasons.length > 0) {
    rows.push({ k: "Blocked", v: assessment.blockedReasons.join("; ") });
  }
  if (assessment.warnings.length > 0) {
    rows.push({ k: "Warnings", v: assessment.warnings.join("; ") });
  }
  return rows;
}

/** Disclosure-side circuit-breaker enum → label (when no live record). */
function disclosureBreakerLabel(state: string): string {
  switch (state) {
    case "armed":
      return "armed";
    case "paused":
      return "paused";
    case "disabled":
      return "disabled";
    default:
      return "unknown";
  }
}

/** Normalize a `0x`-hex or decimal `uint256` string to a decimal string. */
function hexOrDecToDec(s: string): string {
  if (s.startsWith("0x") || s.startsWith("0X")) {
    try {
      return BigInt(s).toString(10);
    } catch {
      return "0";
    }
  }
  return s;
}
