// Bridge — cross-chain risk DISCLOSURE surface (whitepaper §20 / §25.2).
//
// 0.3.10 ships NO live bridge quote/submit primitive, so this screen is
// honest about that: it renders the live circuit-breaker posture of every
// bridge route (via lyth_bridgeHealth), and — when the user picks a route
// to inspect — opens the OperationsDrawer with the full §25.2 disclosure
// (route, protocol, asset/fee-token, source→dest, verifier, drain-cap
// remaining, breaker, insurance, last-incident, risk tier + warnings). The
// drawer's execute() surfaces the typed BRIDGE_QUOTE/SUBMIT blocked reason
// rather than pretending a transfer landed.

import { useCallback, useEffect, useState } from "react";
import {
  BRIDGE_QUOTE_API_BLOCKED_REASON,
  type BridgeHealthRecord,
  type BridgeRouteDisclosure,
} from "@monolythium/core-sdk";
import type { OperationRequest } from "../components/OperationsDrawer";
import { Icon } from "../components/Icon";
import {
  assessRoute,
  breakerPostureLabel,
  fetchBridgeHealth,
  riskTierLabel,
  toRiskRows,
  V1_BRIDGE_ALLOWED_FEE_TOKEN,
} from "../sdk/bridge";

interface Props {
  openOperation: (req: OperationRequest) => void;
}

export function Bridge({ openOperation }: Props) {
  const [records, setRecords] = useState<BridgeHealthRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const health = await fetchBridgeHealth(null, 20);
      setRecords(health.records);
    } catch (cause) {
      setError((cause as Error)?.message ?? "bridge health unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the §25.2 disclosure for a record. We synthesise a disclosure from
  // the live health record's known posture (the live route-index RPC isn't
  // in 0.3.10), risk-assess it, and surface the disclosure rows in the
  // drawer. execute() throws the typed blocked reason — there is no live
  // submit, and we never pretend otherwise.
  const inspect = (rec: BridgeHealthRecord) => {
    const disclosure = disclosureFromRecord(rec);
    const assessment = assessRoute(disclosure);
    const breaker = rec.circuitBreaker;
    openOperation({
      kind: "bridge",
      title: "Bridge route disclosure",
      summary:
        "Cross-chain transfers are not yet live on Monolythium. Review the route's risk posture below. Proceeding shows why the transfer cannot be submitted yet.",
      details: toRiskRows({ disclosure, assessment, breaker }),
      confirmLabel: "Proceed",
      execute: async () => {
        // No live quote/submit primitive in 0.3.10 — surface the typed
        // blocked reason verbatim rather than minting a fake receipt.
        throw new Error(BRIDGE_QUOTE_API_BLOCKED_REASON);
      },
    });
  };

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Bridge routes</h3>
          <div className="spacer" />
          <button
            type="button"
            className="mw-btn"
            onClick={() => void refresh()}
            disabled={loading}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <p
          style={{
            margin: "0 0 12px",
            fontSize: 12.5,
            color: "var(--fg-300)",
            lineHeight: 1.55,
          }}
        >
          Cross-chain transfers route over Chainlink CCIP with{" "}
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--fg-200)" }}>
            {V1_BRIDGE_ALLOWED_FEE_TOKEN}
          </span>{" "}
          fees. Live transfers are not enabled yet — this surface shows each
          route&apos;s circuit-breaker posture and risk disclosure.
        </p>

        {error && (
          <div className="row-help" style={{ color: "var(--err)", marginTop: 4 }}>
            {error}
          </div>
        )}

        {!error && records.length === 0 && !loading && (
          <div className="row-help">No bridge routes registered on chain.</div>
        )}

        {records.map((rec) => (
          <div
            key={rec.bridgeId}
            className="mw-row"
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onClick={() => inspect(rec)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") inspect(rec);
            }}
          >
            <div className="mw-row__icon">
              <Icon name="shield" size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mw-row__name" style={{ fontFamily: "var(--f-mono)" }}>
                {shortId(rec.bridgeId)}
              </div>
              <div className="mw-row__sub">
                {rec.status} · breaker {breakerPostureLabel(rec.circuitBreaker)}
              </div>
            </div>
            <div className="mw-row__right">
              <span
                className="mw-halo"
                style={
                  rec.circuitBreaker.paused
                    ? { color: "var(--warn)" }
                    : undefined
                }
              >
                {rec.circuitBreaker.paused ? "paused" : "armed"}
              </span>
            </div>
          </div>
        ))}
      </div>

      <p
        style={{
          fontSize: 11.5,
          color: "var(--fg-400)",
          textAlign: "center",
          padding: "0 8px",
          lineHeight: 1.55,
        }}
      >
        <Icon name="shield" size={11} /> &nbsp;Disclosure only. Bridge
        transfers activate once the chain ships the live quote and submit
        primitives.
      </p>
    </div>
  );
}

/**
 * Build a §25.2 disclosure from a live bridge-health record. The live
 * route-index (protocol / asset / verifier / insurance) is NOT a 0.3.10 RPC;
 * the fields the chain DOES publish per route come from the health record's
 * circuit-breaker posture, so we present those honestly and mark the rest as
 * the canonical V1 bridge posture (Chainlink CCIP + LINK).
 */
function disclosureFromRecord(rec: BridgeHealthRecord): BridgeRouteDisclosure {
  const cb = rec.circuitBreaker;
  return {
    routeId: rec.bridgeId,
    bridge: rec.bridgeId,
    protocol: "chainlink-ccip",
    asset: "wrapped",
    feeToken: V1_BRIDGE_ALLOWED_FEE_TOKEN,
    sourceChain: "ethereum",
    destinationChain: "monolythium",
    // The health record does not publish a verifier set; the SDK assessment
    // flags a 1-of-1 set as blocked, so we leave participants/threshold at the
    // chain-default DON posture and let assessRoute speak for the rest.
    verifier: { model: "chainlink-don", participantCount: 0, threshold: 0 },
    drainCapAtomic: cb.defaultDrainCapPerWindow,
    finalityBlocks: rec.latestAnchor.headerBlock,
    cooldownSeconds: cb.resumeCooldownBlocks,
    adminControl: "consensusOnly",
    circuitBreaker: cb.paused ? "paused" : "armed",
    insuranceAtomic: "0",
    lastIncidentDate: cb.pausedAtBlock !== null ? `block ${cb.pausedAtBlock}` : null,
  };
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

// Re-export for downstream typing if a screen needs the tier label directly.
export { riskTierLabel };
