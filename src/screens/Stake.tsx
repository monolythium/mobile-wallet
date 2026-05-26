// Stake — current delegations + cluster directory + delegate flow.
//
// Delegation runs over the precompile at `0x…100A`. The chain may
// reject the call until the precompile is activated; wallets surface
// the chain's typed error verbatim. The Stake screen is informational
// + the delegate compose UI; the OperationsDrawer drives auth + write.

import { useCallback, useEffect, useState } from "react";
import {
  addressToTypedBech32,
  type ClusterDirectoryEntryResponse,
  type DelegationsResponse,
} from "@monolythium/core-sdk";
import type { OperationRequest } from "../components/OperationsDrawer";
import {
  buildDelegateCalldata,
  fetchClusterDirectory,
  fetchDelegations,
  submitStakingTx,
} from "../sdk/staking";
import {
  makeBiometricBackendFactory,
  unlockViaBiometric,
} from "../sdk/signer";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. */
  selfAddress: string | null;
  openOperation: (req: OperationRequest) => void;
}

type DelegateFormState =
  | { kind: "closed" }
  | { kind: "open"; clusterId: number; weightBpsDraft: string; error: string | null };

export function Stake({ selfAddress, openOperation }: Props) {
  const [delegations, setDelegations] = useState<DelegationsResponse | null>(null);
  const [clusters, setClusters] = useState<ClusterDirectoryEntryResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<DelegateFormState>({ kind: "closed" });

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

  const openDelegate = (clusterId: number, weightBps: number) => {
    const weightLabel = `${(weightBps / 100).toFixed(2)}%`;
    openOperation({
      kind: "stake",
      title: `Delegate to cluster ${clusterId}`,
      summary: `Stake ${weightLabel} of your wallet weight to cluster ${clusterId}. The chain confirms in ~1 second.`,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        { k: "Cluster", v: String(clusterId), mono: true },
        { k: "Weight", v: weightLabel, mono: true },
        { k: "Precompile", v: "0x…100a", mono: true },
      ],
      confirmLabel: "Sign and stake",
      execute: async () => {
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
            onChangeDraft={(v) =>
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
                setForm({
                  kind: "open",
                  clusterId: c.clusterId,
                  weightBpsDraft: form.weightBpsDraft,
                  error: "Weight must be 1-10000 basis points (0.01% – 100%).",
                });
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
  isFormOpen: boolean;
  form: { weightBpsDraft: string; error: string | null } | null;
  onOpenForm: () => void;
  onCancelForm: () => void;
  onChangeDraft: (v: string) => void;
  onSubmit: () => void;
}

function ClusterRow({
  cluster,
  isFormOpen,
  form,
  onOpenForm,
  onCancelForm,
  onChangeDraft,
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
          </div>
          <div className="mw-row__sub">
            {cluster.size} operators · threshold {cluster.threshold} ·
            health {cluster.aggregateHealth}
          </div>
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
            onChange={(e) => onChangeDraft(e.target.value)}
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
