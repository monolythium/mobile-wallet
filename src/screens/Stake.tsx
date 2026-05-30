// Stake — current delegations + cluster directory + delegate flow +
// autovote (§25.1).
//
// Delegation runs over the precompile at `0x…100A`. The chain may
// reject the call until the precompile is activated; wallets surface
// the chain's typed error verbatim. The Stake screen is informational
// + the delegate compose UI; the OperationsDrawer drives auth + write.
//
// The autovote surface (§25.1) sits above the directory: four modes
// (Max Yield / Max Diversity / Max Decentralization / Custom). The two
// diversity modes consume the live `lyth_getClusterDiversity` reads
// (-> ClusterDiversityView) and the planner in `sdk/autovote.ts`;
// Max Yield uses the aggregate-health proxy (no APR on chain — see the
// planner's TODO); Custom keeps the existing per-cluster manual form.
//
// A read-only per-cluster diversity chip (delegator-facing diversity view)
// is shown once the scores are fetched.

import { useCallback, useEffect, useState } from "react";
import {
  addressToTypedBech32,
  DIVERSITY_SCORE_MAX,
  type ClusterDirectoryEntryResponse,
  type ClusterDiversityView,
  type DelegationsResponse,
} from "@monolythium/core-sdk";
import type { OperationRequest } from "../components/OperationsDrawer";
import {
  buildDelegateCalldata,
  DELEGATION_PRECOMPILE,
  fetchClusterDirectory,
  fetchDelegations,
  submitStakingTx,
} from "../sdk/staking";
import {
  computeAutovotePlan,
  fetchClusterDiversity,
  type AutovoteMode,
  type AutovotePlan,
} from "../sdk/autovote";
import {
  makeBiometricBackendFactory,
  unlockViaBiometric,
} from "../sdk/signer";
import { useExperimentalV5 } from "../sdk/use-feature-flags";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. */
  selfAddress: string | null;
  openOperation: (req: OperationRequest) => void;
}

type DelegateFormState =
  | { kind: "closed" }
  | {
      kind: "open";
      clusterId: number;
      weightBpsDraft: string;
      principalLythDraft: string;
      error: string | null;
    };

/** Default total wallet-weight an autovote plan distributes (50%). */
const DEFAULT_AUTOVOTE_CAP_BPS = 5000;

const AUTOVOTE_MODES: { mode: AutovoteMode; label: string; blurb: string }[] = [
  { mode: "max-yield", label: "Max Yield", blurb: "Highest aggregate health" },
  { mode: "max-diversity", label: "Max Diversity", blurb: "Top diversity score" },
  {
    mode: "max-decentralization",
    label: "Max Decentralization",
    blurb: "Spread ASN / geo / hosting",
  },
  { mode: "custom", label: "Custom", blurb: "Pick clusters manually" },
];

export function Stake({ selfAddress, openOperation }: Props) {
  const [delegations, setDelegations] = useState<DelegationsResponse | null>(null);
  const [clusters, setClusters] = useState<ClusterDirectoryEntryResponse[]>([]);
  const [diversity, setDiversity] = useState<Map<number, ClusterDiversityView>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<DelegateFormState>({ kind: "closed" });
  const [mode, setMode] = useState<AutovoteMode>("custom");
  const [plan, setPlan] = useState<AutovotePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // Autovote planner is an experimental v5 surface, OFF by default. When off
  // the card below is not rendered (and its diversity reads never fire), so
  // the Stake screen renders identically to a build without autovote.
  const showAutovote = useExperimentalV5();

  const refresh = useCallback(async (addr: string) => {
    setLoading(true);
    setError(null);
    try {
      const bech32m = addressToTypedBech32("user", addr);
      const [d, dir] = await Promise.all([
        fetchDelegations(bech32m).catch(() => null),
        fetchClusterDirectory(1, 20).catch((cause: unknown) => {
          throw cause;
        }),
      ]);
      setDelegations(d);
      setClusters(dir.clusters);
    } catch (cause) {
      setError((cause as Error)?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selfAddress === null) return;
    void refresh(selfAddress);
  }, [selfAddress, refresh]);

  if (selfAddress === null) {
    return (
      <div className="mw-scroll">
        <div className="mw-card">
          <p style={{ margin: 0, color: "var(--fg-300)", fontSize: 13 }}>
            Resolving wallet identity…
          </p>
        </div>
      </div>
    );
  }

  const selfBech32m = addressToTypedBech32("user", selfAddress);

  // Fetch per-cluster diversity scores for the visible clusters. Best-effort:
  // a cluster with no score reads as zero in the planner. Defined as a plain
  // closure (not a hook) so it stays below the early-return identity guard.
  const loadDiversity = async (): Promise<Map<number, ClusterDiversityView>> => {
    const results = await Promise.all(
      clusters
        .filter((c) => c.active)
        .map(async (c) => {
          try {
            return await fetchClusterDiversity(c.clusterId);
          } catch {
            return null;
          }
        }),
    );
    const next = new Map<number, ClusterDiversityView>();
    for (const v of results) {
      if (v) next.set(v.clusterId, v);
    }
    setDiversity(next);
    return next;
  };

  // Selecting a mode runs the planner. Diversity/decentralization fetch live
  // scores first; max-yield needs no scores; custom clears the plan.
  const selectMode = async (next: AutovoteMode) => {
    setMode(next);
    setPlan(null);
    setPlanError(null);
    if (next === "custom") return;
    setPlanning(true);
    try {
      let scores = diversity;
      if (next === "max-diversity" || next === "max-decentralization") {
        scores = await loadDiversity();
      }
      const computed = computeAutovotePlan({
        mode: next,
        clusters,
        diversity: scores,
        capBps: DEFAULT_AUTOVOTE_CAP_BPS,
        spread: 3,
      });
      setPlan(computed);
    } catch (cause) {
      setPlanError((cause as Error)?.message ?? "could not build plan");
    } finally {
      setPlanning(false);
    }
  };

  const openDelegate = (clusterId: number, weightBps: number, principalLyth: bigint) => {
    const weightLabel = `${(weightBps / 100).toFixed(2)}%`;
    const principalLythoshi = principalLyth * 100_000_000n; // 1 LYTH = 1e8 lythoshi
    openOperation({
      kind: "stake",
      title: `Delegate ${principalLyth} LYTH to cluster ${clusterId}`,
      summary: `Stake ${principalLyth} LYTH principal at ${weightLabel} of your wallet weight to cluster ${clusterId}. The chain confirms in ~1 second.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Cluster", v: String(clusterId), mono: true },
        { k: "Weight", v: weightLabel, mono: true },
        {
          k: "Principal",
          v: `${principalLyth} LYTH (${principalLythoshi.toString()} lythoshi)`,
          mono: true,
        },
        { k: "Precompile", v: "0x…100a", mono: true },
      ],
      confirmLabel: "Sign and stake",
      // Notifications-center metadata (experimental-v5). The principal LYTH
      // staked rides as msg.value; the amount shown is that principal.
      // Counterparty is the delegation precompile, never a contact name.
      notify: {
        kind: "delegate",
        amountDecimal: principalLyth.toString(),
        counterparty: DELEGATION_PRECOMPILE.toLowerCase(),
      },
      execute: async () => {
        // The SDK delegate(uint32,uint16) model sets the wallet-weight via
        // calldata; the principal LYTH staked rides as msg.value.
        const calldata = buildDelegateCalldata(clusterId, weightBps);
        const result = await submitStakingTx({
          fromBech32m: selfBech32m,
          data: calldata,
          valueLythoshi: principalLythoshi,
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        return result.txHash;
      },
    });
    setForm({ kind: "closed" });
  };

  // Apply an autovote plan: the chain has no multi-delegate calldata, so we
  // submit one delegate tx PER allocation, sequentially. Partial failure is
  // surfaced honestly — the drawer reports the first failure and which
  // allocations already landed.
  const applyPlan = (current: AutovotePlan) => {
    const allocations = current.allocations.filter((a) => a.weightBps > 0);
    if (allocations.length === 0) return;
    const summaryLabel = allocations
      .map((a) => `C${a.clusterId} ${(a.weightBps / 100).toFixed(2)}%`)
      .join(" · ");
    openOperation({
      kind: "stake",
      title: `Autovote · ${modeLabel(current.mode)}`,
      summary: `Delegate to ${allocations.length} cluster${allocations.length === 1 ? "" : "s"} (${summaryLabel}). Each delegation is a separate signed transaction submitted in sequence.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Mode", v: modeLabel(current.mode) },
        ...allocations.map((a) => ({
          k: `Cluster ${a.clusterId}`,
          v: `${(a.weightBps / 100).toFixed(2)}%`,
          mono: true,
        })),
        {
          k: "Total weight",
          v: `${(current.totalBps / 100).toFixed(2)}%`,
          mono: true,
        },
        { k: "Precompile", v: "0x…100a", mono: true },
        ...current.notes.map((n, i) => ({ k: i === 0 ? "Note" : " ", v: n })),
      ],
      confirmLabel: `Sign ${allocations.length} delegation${allocations.length === 1 ? "" : "s"}`,
      execute: async () => {
        const unlock = makeBiometricBackendFactory({ unlock: unlockViaBiometric });
        const landed: string[] = [];
        for (const a of allocations) {
          try {
            const result = await submitStakingTx({
              fromBech32m: selfBech32m,
              data: buildDelegateCalldata(a.clusterId, a.weightBps),
              // Autovote (experimental, default-off) plans carry only weight,
              // not a per-allocation principal split — principal escrow for the
              // multi-delegate path is a follow-up (the planner must emit a
              // per-cluster principal first). The single-delegate path above
              // escrows real principal.
              valueLythoshi: 0n,
              unlockBackend: unlock,
            });
            landed.push(result.txHash);
          } catch (cause) {
            const msg = (cause as Error)?.message ?? "delegation failed";
            throw new Error(
              `Delegation to cluster ${a.clusterId} failed (${landed.length}/${allocations.length} landed): ${msg}`,
            );
          }
        }
        // Return the last tx hash for the Done pane; earlier hashes already
        // landed on chain. Refresh delegations after the batch.
        void refresh(selfAddress);
        return landed[landed.length - 1] ?? "";
      },
    });
  };

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Your delegations</h3>
          <div className="spacer" />
          <button
            type="button"
            className="mw-btn"
            onClick={() => void refresh(selfAddress)}
            disabled={loading}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {error && (
          <div className="row-help" style={{ color: "var(--err)", marginTop: 8 }}>
            {error}
          </div>
        )}
        {delegations === null && !error ? (
          <div className="row-help" style={{ marginTop: 8 }}>
            {loading ? "Loading…" : "No delegation data available."}
          </div>
        ) : delegations && delegations.rows.length === 0 ? (
          <div className="row-help" style={{ marginTop: 8 }}>
            You haven&apos;t delegated to any cluster yet. Pick one below
            to stake your wallet&apos;s weight.
          </div>
        ) : null}
        {delegations?.rows.map((row) => (
          <div key={row.cluster} className="mw-row">
            <div className="mw-row__icon">C{row.cluster}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mw-row__name">Cluster {row.cluster}</div>
              <div className="mw-row__sub">
                {(row.weightBps / 100).toFixed(2)}% of your wallet weight
              </div>
            </div>
            <div className="mw-row__right">
              <div
                className="primary"
                style={{ fontFamily: "var(--f-mono)", fontSize: 13 }}
              >
                {(row.weightBps / 100).toFixed(2)}%
              </div>
            </div>
          </div>
        ))}
        {delegations && delegations.totalBps > 0 && (
          <div
            className="row-help"
            style={{
              marginTop: 8,
              fontFamily: "var(--f-mono)",
              color: "var(--fg-400)",
            }}
          >
            Total delegated · {(delegations.totalBps / 100).toFixed(2)}%
          </div>
        )}
      </div>

      {/* Autovote — four-mode planner (§25.1). Experimental, OFF by default. */}
      {showAutovote && (
        <div className="mw-card">
        <div className="mw-card__head">
          <h3>Autovote</h3>
          <div className="spacer" />
          <span className="more">{(DEFAULT_AUTOVOTE_CAP_BPS / 100).toFixed(0)}% cap</span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginBottom: 10,
          }}
        >
          {AUTOVOTE_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              className={`mw-btn${mode === m.mode ? " mw-btn--primary" : ""}`}
              onClick={() => void selectMode(m.mode)}
              disabled={planning}
              style={{
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 2,
                padding: "9px 10px",
                textAlign: "left",
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{m.label}</span>
              <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
                {m.blurb}
              </span>
            </button>
          ))}
        </div>

        {planning && (
          <div className="row-help">Reading on-chain diversity scores…</div>
        )}
        {planError && (
          <div className="row-help" style={{ color: "var(--err)" }}>
            {planError}
          </div>
        )}

        {mode === "custom" && !planning && (
          <div className="row-help">
            Pick a cluster below and set its weight manually.
          </div>
        )}

        {plan && mode !== "custom" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--fg-700)",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-400)",
              }}
            >
              Proposed allocation
            </div>
            {plan.allocations.length === 0 && (
              <div className="row-help">
                No active clusters to allocate against.
              </div>
            )}
            {plan.allocations.map((a) => (
              <div
                key={a.clusterId}
                className="mw-kv"
                style={{ fontFamily: "var(--f-mono)" }}
              >
                <div className="k">Cluster {a.clusterId}</div>
                <div className="v mono">{(a.weightBps / 100).toFixed(2)}%</div>
              </div>
            ))}
            {plan.totalBps > DEFAULT_AUTOVOTE_CAP_BPS && (
              <div className="row-help" style={{ color: "var(--warn)" }}>
                Plan distributes more than the {(DEFAULT_AUTOVOTE_CAP_BPS / 100).toFixed(0)}% cap.
              </div>
            )}
            {plan.notes.map((n) => (
              <div
                key={n}
                className="row-help"
                style={{ color: "var(--fg-400)", lineHeight: 1.5 }}
              >
                {n}
              </div>
            ))}
            <button
              type="button"
              className="mw-btn mw-btn--primary mw-btn--block"
              onClick={() => applyPlan(plan)}
              disabled={plan.allocations.length === 0}
            >
              Review autovote
            </button>
          </div>
        )}
        </div>
      )}

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Cluster directory</h3>
          <div className="spacer" />
          <span className="more">
            {clusters.length === 0 ? "—" : `${clusters.length} active`}
          </span>
        </div>
        {clusters.length === 0 && !loading && (
          <div className="row-help">
            No clusters surfaced by the directory.
          </div>
        )}
        {clusters.map((c) => (
          <ClusterRow
            key={c.clusterId}
            cluster={c}
            diversity={diversity.get(c.clusterId) ?? null}
            isFormOpen={form.kind === "open" && form.clusterId === c.clusterId}
            form={form.kind === "open" && form.clusterId === c.clusterId ? form : null}
            onOpenForm={() =>
              setForm({
                kind: "open",
                clusterId: c.clusterId,
                weightBpsDraft: "1000",
                principalLythDraft: "100",
                error: null,
              })
            }
            onCancelForm={() => setForm({ kind: "closed" })}
            onChangeWeightDraft={(v) =>
              setForm((prev) =>
                prev.kind === "open" && prev.clusterId === c.clusterId
                  ? { ...prev, weightBpsDraft: v, error: null }
                  : prev,
              )
            }
            onChangePrincipalDraft={(v) =>
              setForm((prev) =>
                prev.kind === "open" && prev.clusterId === c.clusterId
                  ? { ...prev, principalLythDraft: v, error: null }
                  : prev,
              )
            }
            onSubmit={() => {
              if (form.kind !== "open" || form.clusterId !== c.clusterId) return;
              const bps = parseInt(form.weightBpsDraft, 10);
              if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) {
                setForm({ ...form, error: "Weight must be 1-10000 basis points (0.01% – 100%)." });
                return;
              }
              let principal: bigint;
              try {
                principal = BigInt(form.principalLythDraft);
              } catch {
                setForm({ ...form, error: "Principal must be a positive integer of whole LYTH." });
                return;
              }
              if (principal <= 0n) {
                setForm({ ...form, error: "Principal must be > 0 whole LYTH." });
                return;
              }
              openDelegate(c.clusterId, bps, principal);
            }}
          />
        ))}
      </div>
    </div>
  );
}

interface ClusterRowProps {
  cluster: ClusterDirectoryEntryResponse;
  diversity: ClusterDiversityView | null;
  isFormOpen: boolean;
  form: { weightBpsDraft: string; principalLythDraft: string; error: string | null } | null;
  onOpenForm: () => void;
  onCancelForm: () => void;
  onChangeWeightDraft: (v: string) => void;
  onChangePrincipalDraft: (v: string) => void;
  onSubmit: () => void;
}

function ClusterRow({
  cluster,
  diversity,
  isFormOpen,
  form,
  onOpenForm,
  onCancelForm,
  onChangeWeightDraft,
  onChangePrincipalDraft,
  onSubmit,
}: ClusterRowProps) {
  return (
    <div
      className="mw-row"
      style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: "10px 0" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="mw-row__icon">C{cluster.clusterId}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mw-row__name">
            Cluster {cluster.clusterId}
            {!cluster.active && (
              <span
                style={{
                  fontSize: 10,
                  color: "var(--warn)",
                  marginLeft: 8,
                  letterSpacing: "0.06em",
                }}
              >
                INACTIVE
              </span>
            )}
            {diversity && (
              <span
                className="mw-halo"
                style={{ marginLeft: 8, fontSize: 10 }}
                title="Headline diversity score (0-100%)"
              >
                div {((diversity.score / DIVERSITY_SCORE_MAX) * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="mw-row__sub">
            {cluster.size} operators · threshold {cluster.threshold} ·
            health {cluster.aggregateHealth}
          </div>
          {diversity && (
            <div className="mw-row__sub" style={{ marginTop: 2 }}>
              ASN {pct(diversity.asnVariance)} · Geo {pct(diversity.geoVariance)} ·
              Hosting {pct(diversity.hostingSpread)}
            </div>
          )}
          {cluster.regionDiversity && cluster.regionDiversity.length > 0 && (
            <div className="mw-row__sub" style={{ marginTop: 2 }}>
              Regions · {cluster.regionDiversity.join(", ")}
            </div>
          )}
        </div>
        {!isFormOpen && (
          <button
            type="button"
            className="mw-btn"
            onClick={onOpenForm}
            disabled={!cluster.active}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              opacity: cluster.active ? 1 : 0.4,
            }}
          >
            Delegate
          </button>
        )}
      </div>

      {isFormOpen && form && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--fg-700)",
            borderRadius: 8,
          }}
        >
          <label
            style={{
              fontSize: 11,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--fg-400)",
            }}
          >
            Weight (basis points · 100 = 1%)
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            value={form.weightBpsDraft}
            onChange={(e) => onChangeWeightDraft(e.target.value)}
            style={{
              padding: "8px 10px",
              fontSize: 14,
              fontFamily: "var(--f-mono)",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "var(--fg-100)",
              outline: "none",
            }}
          />
          <label
            style={{
              fontSize: 11,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--fg-400)",
            }}
          >
            Principal (whole LYTH)
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={form.principalLythDraft}
            onChange={(e) => onChangePrincipalDraft(e.target.value)}
            style={{
              padding: "8px 10px",
              fontSize: 14,
              fontFamily: "var(--f-mono)",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "var(--fg-100)",
              outline: "none",
            }}
          />
          {form.error && (
            <div className="row-help" style={{ color: "var(--err)" }}>
              {form.error}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="mw-btn"
              onClick={onCancelForm}
              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="mw-btn mw-btn--primary"
              onClick={onSubmit}
              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
            >
              Review
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function pct(bps: number): string {
  return `${((bps / DIVERSITY_SCORE_MAX) * 100).toFixed(0)}%`;
}

function modeLabel(mode: AutovoteMode): string {
  switch (mode) {
    case "max-yield":
      return "Max Yield";
    case "max-diversity":
      return "Max Diversity";
    case "max-decentralization":
      return "Max Decentralization";
    case "custom":
      return "Custom";
  }
}
