// Stake — total-staked / earned hero + current delegations + cluster
// directory + delegate flow + autovote (§25.1).
//
// The hero (per the MStake design) leads with three honest figures read
// live off-chain: TOTAL STAKED (the effective LYTH weight = balance ×
// total delegated bps), EARNED (claimable pending rewards from
// `lyth_pendingRewards` — read straight off the wire, never an APR
// projection), and CLUSTER SLOTS (the count of clusters the wallet
// delegates to). A "Claim rewards" action sits in the hero; per-delegation
// rows expose unstake (undelegate) + restake (redelegate). Staking here is
// non-custodial: there is NO unbonding period — undelegate is instant —
// so the sheet says so rather than inventing a lock-up.
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
  formatLythoshi,
  type ClusterDirectoryEntryResponse,
  type ClusterDiversityView,
  type DelegationsResponse,
  type PendingRewardsResponse,
} from "@monolythium/core-sdk";
import type { OperationRequest } from "../components/OperationsDrawer";
import {
  buildClaimRewardsCalldata,
  buildDelegateCalldata,
  buildRedelegateCalldata,
  buildUndelegateCalldata,
  DELEGATION_PRECOMPILE,
  fetchClusterDirectory,
  fetchDelegations,
  fetchPendingRewards,
  submitStakingTx,
} from "../sdk/staking";
import { loadChainSnapshot, type ChainSnapshot } from "../sdk/client";
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
import type { Denom } from "../sdk/privacy";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. */
  selfAddress: string | null;
  /** Active display denomination. Staking lives on the public chain; in
   *  private mode the screen shows the disclosure state. */
  denom: Denom;
  openOperation: (req: OperationRequest) => void;
}

type DelegateFormState =
  | { kind: "closed" }
  | {
      kind: "open";
      clusterId: number;
      weightBpsDraft: string;
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

export function Stake({ selfAddress, denom, openOperation }: Props) {
  const isPrivate = denom === "private";
  const [delegations, setDelegations] = useState<DelegationsResponse | null>(null);
  const [clusters, setClusters] = useState<ClusterDirectoryEntryResponse[]>([]);
  const [diversity, setDiversity] = useState<Map<number, ClusterDiversityView>>(
    new Map(),
  );
  // Pending rewards (the "earned" figure) + balance (the "Max" / total-staked
  // base) — both read live off-chain. `null` = not yet loaded or unavailable;
  // never substituted with a fabricated value.
  const [rewards, setRewards] = useState<PendingRewardsResponse | null>(null);
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null);
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
      // Delegations + pending rewards + the native balance are all best-effort
      // hero inputs: a node that can't serve them leaves the figure honestly
      // blank (`null`), never a stand-in number. The cluster directory is the
      // one hard dependency (the screen is unusable without it) so its failure
      // surfaces the screen-level error.
      const [d, rew, snap, dir] = await Promise.all([
        fetchDelegations(bech32m).catch(() => null),
        fetchPendingRewards(bech32m).catch(() => null),
        loadChainSnapshot(addr).catch(() => null),
        fetchClusterDirectory(1, 20).catch((cause: unknown) => {
          throw cause;
        }),
      ]);
      setDelegations(d);
      setRewards(rew);
      // loadChainSnapshot returns a carrier with its own `.error`; treat a
      // surfaced RPC error the same as no balance (hero base stays honest).
      setSnapshot(snap && !snap.error ? snap : null);
      setClusters(dir.clusters);
    } catch (cause) {
      setError((cause as Error)?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Skip the live reads in private mode — staking is public-only, so the
    // screen renders the disclosure state without touching the chain.
    if (selfAddress === null || isPrivate) return;
    void refresh(selfAddress);
  }, [selfAddress, isPrivate, refresh]);

  // Private mode — rewards and delegations live on the public chain. Show the
  // design's disclosure state rather than the staking surface.
  if (isPrivate) {
    return (
      <div className="mw-scroll">
        <div className="mw-card" style={{ textAlign: "center", padding: 28 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>
            Staking is public
          </div>
          <div
            className="row-help"
            style={{ color: "var(--fg-400)", lineHeight: 1.55 }}
          >
            Rewards and delegations live on the public chain. Switch to Public
            on Home.
          </div>
        </div>
      </div>
    );
  }

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

  const openDelegate = (clusterId: number, weightBps: number) => {
    const weightLabel = `${(weightBps / 100).toFixed(2)}%`;
    openOperation({
      kind: "stake",
      title: `Delegate ${weightLabel} to cluster ${clusterId}`,
      summary: `Weight ${weightLabel} of your balance to cluster ${clusterId}. Non-custodial — your LYTH stays in your wallet and remains spendable. The chain confirms in ~1 second.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Cluster", v: String(clusterId), mono: true },
        { k: "Weight", v: `${weightLabel} of balance`, mono: true },
        { k: "Value", v: "0 LYTH (non-custodial)", mono: true },
        { k: "Precompile", v: "0x…100a", mono: true },
      ],
      confirmLabel: "Sign and delegate",
      // Notifications-center metadata (experimental-v5). Non-custodial — no
      // value moves; the counterparty is the delegation precompile, never a
      // contact name.
      notify: {
        kind: "delegate",
        amountDecimal: "0",
        counterparty: DELEGATION_PRECOMPILE.toLowerCase(),
      },
      execute: async () => {
        // Non-custodial delegate(uint32,uint16): weightBps only, value = 0.
        // Effective weight = balance × weightBps; nothing is escrowed.
        const calldata = buildDelegateCalldata(clusterId, weightBps);
        const result = await submitStakingTx({
          fromBech32m: selfBech32m,
          data: calldata,
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        return result.txHash;
      },
    });
    setForm({ kind: "closed" });
  };

  // Claim rewards — claim() is a selector-only precompile call (no args). One
  // tx claims across every active delegation. The amount shown is the live
  // pending-rewards total, never a projection.
  const openClaim = (totalLabel: string) => {
    openOperation({
      kind: "stake",
      title: "Claim staking rewards",
      summary: `Claim your accrued staking rewards (${totalLabel}) across every active delegation in a single transaction. Non-custodial — your delegated weight is unchanged. The chain confirms in ~1 second.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Action", v: "claim()" },
        { k: "Rewards", v: totalLabel, mono: true },
        { k: "Precompile", v: "0x…100a", mono: true },
      ],
      confirmLabel: "Sign and claim",
      notify: {
        kind: "claim",
        amountDecimal: "0",
        counterparty: DELEGATION_PRECOMPILE.toLowerCase(),
      },
      execute: async () => {
        const result = await submitStakingTx({
          fromBech32m: selfBech32m,
          data: buildClaimRewardsCalldata(),
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        void refresh(selfAddress);
        return result.txHash;
      },
    });
  };

  // Unstake — undelegate(uint32) removes the cluster's delegation row. The
  // weight is non-custodial, so removal is INSTANT: no unbonding period, no
  // redemption queue. The sheet states that plainly.
  const openUnstake = (clusterId: number, weightBps: number) => {
    const weightLabel = `${(weightBps / 100).toFixed(2)}%`;
    openOperation({
      kind: "stake",
      title: `Unstake from cluster ${clusterId}`,
      summary: `Remove your ${weightLabel} delegation from cluster ${clusterId}. Non-custodial — nothing was escrowed, so removal is instant with no unbonding period. The chain confirms in ~1 second.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Cluster", v: String(clusterId), mono: true },
        { k: "Weight removed", v: `${weightLabel} of balance`, mono: true },
        { k: "Unbonding", v: "None — instant" },
        { k: "Precompile", v: "0x…100a", mono: true },
      ],
      confirmLabel: "Sign and unstake",
      notify: {
        kind: "undelegate",
        amountDecimal: "0",
        counterparty: DELEGATION_PRECOMPILE.toLowerCase(),
      },
      execute: async () => {
        // undelegate(uint32): cluster only, value = 0. Instant removal.
        const result = await submitStakingTx({
          fromBech32m: selfBech32m,
          data: buildUndelegateCalldata(clusterId),
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        void refresh(selfAddress);
        return result.txHash;
      },
    });
  };

  // Restake — redelegate(uint32 src, uint32 dst, uint16 weightBps) moves the
  // existing weight from one cluster to another in a single tx.
  const openRedelegate = (srcCluster: number, dstCluster: number, weightBps: number) => {
    const weightLabel = `${(weightBps / 100).toFixed(2)}%`;
    openOperation({
      kind: "stake",
      title: `Restake to cluster ${dstCluster}`,
      summary: `Move your ${weightLabel} delegation from cluster ${srcCluster} to cluster ${dstCluster} in a single transaction. Non-custodial — no unbonding, no escrow. The chain confirms in ~1 second.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Source", v: `Cluster ${srcCluster}`, mono: true },
        { k: "Destination", v: `Cluster ${dstCluster}`, mono: true },
        { k: "Weight", v: `${weightLabel} of balance`, mono: true },
        { k: "Precompile", v: "0x…100a", mono: true },
      ],
      confirmLabel: "Sign and restake",
      notify: {
        kind: "redelegate",
        amountDecimal: "0",
        counterparty: DELEGATION_PRECOMPILE.toLowerCase(),
      },
      execute: async () => {
        const result = await submitStakingTx({
          fromBech32m: selfBech32m,
          data: buildRedelegateCalldata(srcCluster, dstCluster, weightBps),
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        void refresh(selfAddress);
        return result.txHash;
      },
    });
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
              // Non-custodial: each delegate carries weight only (value = 0).
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

  // ── Hero figures (all read live; never fabricated) ──────────────────────
  // EARNED: settled + unsettled claimable rewards straight off
  // `lyth_pendingRewards`. Hex lythoshi → LYTH via the SDK formatter.
  const earnedLythoshi = (() => {
    if (!rewards) return null;
    try {
      return BigInt(rewards.totalAmountLythoshi);
    } catch {
      return null;
    }
  })();
  const earnedLabel =
    earnedLythoshi === null
      ? "—"
      : `${formatLythoshi(earnedLythoshi, { includeUnit: false })} LYTH`;
  const canClaim = earnedLythoshi !== null && earnedLythoshi > 0n;

  // TOTAL STAKED: effective LYTH weight = balance × (total delegated bps /
  // 10000). Both inputs are live; if either is missing the figure is honestly
  // blank rather than partial.
  const totalBps = delegations?.totalBps ?? 0;
  const stakedLabel = (() => {
    if (snapshot === null || delegations === null) return "—";
    if (totalBps === 0) return "0 LYTH";
    try {
      const balanceLythoshi = BigInt(snapshot.balanceLythoshiHex);
      const effective = (balanceLythoshi * BigInt(totalBps)) / 10_000n;
      return `${formatLythoshi(effective, { includeUnit: false })} LYTH`;
    } catch {
      return "—";
    }
  })();

  // CLUSTER SLOTS: how many clusters this wallet delegates weight to.
  const slotCount = delegations?.rows.length ?? 0;

  return (
    <div className="mw-scroll">
      {/* Hero — total staked / earned / cluster slots (MStake design). */}
      <div className="mw-card mw-hero">
        <div className="mw-hero__label">Total staked</div>
        <div className="mw-hero__amount">
          {stakedLabel === "—" ? (
            <>—<span className="tok">LYTH</span></>
          ) : (
            <>
              {stakedLabel.replace(" LYTH", "")}
              <span className="tok">LYTH</span>
            </>
          )}
        </div>
        <div className="mw-hero__meta">
          <span>
            Earned <b>{earnedLabel}</b>
          </span>
          <span>
            Cluster slots <b>{slotCount}</b>
          </span>
          <span>
            Weight <b>{(totalBps / 100).toFixed(2)}%</b>
          </span>
        </div>
        <button
          type="button"
          className="mw-btn mw-btn--primary mw-btn--block"
          style={{ marginTop: 16 }}
          onClick={() => openClaim(earnedLabel)}
          disabled={!canClaim}
        >
          {earnedLythoshi === null
            ? "Rewards unavailable"
            : canClaim
              ? `Claim ${earnedLabel}`
              : "No rewards yet"}
        </button>
        {/* Honest about the non-custodial model: no lock-up, no projection. */}
        <div
          className="row-help"
          style={{ marginTop: 10, color: "var(--fg-400)", lineHeight: 1.5 }}
        >
          Non-custodial staking — your LYTH stays spendable, there is no
          unbonding period, and rewards settle on-chain (no APR is projected
          here).
        </div>
      </div>

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
          <DelegationRow
            key={row.cluster}
            cluster={row.cluster}
            weightBps={row.weightBps}
            rewardLythoshi={rewardForCluster(rewards, row.cluster)}
            restakeTargets={(delegations?.rows ?? [])
              .map((r) => r.cluster)
              .filter((c) => c !== row.cluster)}
            onUnstake={() => openUnstake(row.cluster, row.weightBps)}
            onRestake={(dst) => openRedelegate(row.cluster, dst, row.weightBps)}
          />
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
            onSubmit={() => {
              if (form.kind !== "open" || form.clusterId !== c.clusterId) return;
              const bps = parseInt(form.weightBpsDraft, 10);
              if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) {
                setForm({ ...form, error: "Weight must be 1-10000 basis points (0.01% – 100%)." });
                return;
              }
              openDelegate(c.clusterId, bps);
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
  form: { weightBpsDraft: string; error: string | null } | null;
  onOpenForm: () => void;
  onCancelForm: () => void;
  onChangeWeightDraft: (v: string) => void;
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
            Weight — % of balance (basis points · 100 = 1%)
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
          <div className="row-help" style={{ lineHeight: 1.5 }}>
            Non-custodial: this delegates a percent of your balance — no tokens
            are escrowed. Your LYTH stays in your wallet and remains spendable;
            effective weight = balance × weightBps.
          </div>
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

/** Per-cluster unsettled reward (lythoshi) for the given cluster, or `null`
 *  when the pending-rewards read is absent or has no row. Read straight off
 *  `lyth_pendingRewards` — no projection. */
function rewardForCluster(
  rewards: PendingRewardsResponse | null,
  cluster: number,
): bigint | null {
  if (!rewards) return null;
  const row = rewards.rows.find((r) => r.cluster === cluster);
  if (!row) return null;
  try {
    return BigInt(row.unsettledAmountLythoshi);
  } catch {
    return null;
  }
}

interface DelegationRowProps {
  cluster: number;
  weightBps: number;
  /** Live unsettled reward for this cluster, or `null` when unavailable. */
  rewardLythoshi: bigint | null;
  /** Other clusters this wallet delegates to — valid restake destinations. */
  restakeTargets: number[];
  onUnstake: () => void;
  onRestake: (dst: number) => void;
}

/** One active delegation row with inline unstake + restake actions. Restake
 *  reveals a destination picker over the wallet's OTHER active clusters (the
 *  redelegate precompile moves weight between clusters the wallet already
 *  holds). When there is no other cluster, only unstake is offered. */
function DelegationRow({
  cluster,
  weightBps,
  rewardLythoshi,
  restakeTargets,
  onUnstake,
  onRestake,
}: DelegationRowProps) {
  const [restakeOpen, setRestakeOpen] = useState(false);
  const weightLabel = `${(weightBps / 100).toFixed(2)}%`;
  const canRestake = restakeTargets.length > 0;

  return (
    <div
      className="mw-row"
      style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: "10px 0" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="mw-row__icon">C{cluster}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mw-row__name">Cluster {cluster}</div>
          <div className="mw-row__sub">
            {weightLabel} of your wallet weight
            {rewardLythoshi !== null && rewardLythoshi > 0n && (
              <span style={{ color: "var(--fg-400)" }}>
                {" · "}earned{" "}
                {formatLythoshi(rewardLythoshi, { includeUnit: false })} LYTH
              </span>
            )}
          </div>
        </div>
        <div className="mw-row__right">
          <div
            className="primary"
            style={{ fontFamily: "var(--f-mono)", fontSize: 13 }}
          >
            {weightLabel}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="mw-btn"
          onClick={onUnstake}
          style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
        >
          Unstake
        </button>
        <button
          type="button"
          className="mw-btn"
          onClick={() => setRestakeOpen((v) => !v)}
          disabled={!canRestake}
          style={{
            flex: 1,
            padding: "6px 10px",
            fontSize: 12,
            opacity: canRestake ? 1 : 0.4,
          }}
        >
          Restake
        </button>
      </div>

      {restakeOpen && canRestake && (
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
            Move {weightLabel} to
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {restakeTargets.map((dst) => (
              <button
                key={dst}
                type="button"
                className="mw-btn"
                onClick={() => {
                  setRestakeOpen(false);
                  onRestake(dst);
                }}
                style={{ padding: "6px 10px", fontSize: 12 }}
              >
                Cluster {dst}
              </button>
            ))}
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
