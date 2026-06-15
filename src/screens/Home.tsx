// Home — primary mobile screen.
// Hero balance + quick actions + tokens card + readiness + chain conn.
//
// The hero + tokens card render the LIVE native LYTH balance for the bound
// wallet address, read through `loadChainSnapshot` (eth_getBalance) the same
// way Activity/Stake read live RPC. There is no on-chain price oracle and no
// token-list index, so USD is rendered as an honest em-dash — never a
// fabricated "$0.00" dressed up as a real fiat value.

import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { DenomToggle } from "../components/DenomToggle";
import { loadChainSnapshot, type ChainSnapshot, type ChainStatus } from "../sdk/client";
import type { WalletReadiness } from "../sdk/readiness";
import type { Denom } from "../sdk/privacy";

interface Props {
  status: ChainStatus | null;
  statusError: string | null;
  readiness: WalletReadiness | null;
  /** Internal 0x address bound to the unlocked vault. `null` until
   *  the bound address has been resolved; public UI renders typed mono1. */
  selfAddress: string | null;
  /** Active display denomination. `private` hides amounts on this device;
   *  the chain serves public-only balances, so private mode is a display gate. */
  denom: Denom;
  /** Whether the Public / Private toggle is offered (privacy gate, OFF by
   *  default). When off the toggle is not rendered and `denom` is always
   *  `public`. */
  privacyEnabled: boolean;
  /** Switch the active denomination. */
  setDenom: (next: Denom) => void;
  openSend: () => void;
  /** Opens the Receive QR overlay. */
  openReceive: () => void;
  /** Opens the dedicated Tokens screen (full token list). */
  openTokens: () => void;
  /** Opens the full-screen QR scanner. */
  onScan: () => void;
  /** Navigate to the Stake tab (the real delegation flow). */
  goStake: () => void;
}

const fmt = (n: number, f = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: f, maximumFractionDigits: f });

/** Local load state for the bound-address balance read. */
type BalanceState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: ChainSnapshot }
  | { kind: "error"; message: string };

export function Home({
  status,
  statusError,
  readiness,
  selfAddress,
  denom,
  privacyEnabled,
  setDenom,
  openSend,
  openReceive,
  openTokens,
  onScan,
  goStake,
}: Props) {
  const isPrivate = denom === "private";
  const [balance, setBalance] = useState<BalanceState>({ kind: "loading" });

  // Read the live native balance for the bound address. Mirrors Activity:
  // one read on mount / when the address resolves; the snapshot carries its
  // own RPC-error state so an offline node renders honestly rather than 0.
  // Skipped in private mode — the hero hides the amount by design, so there's
  // nothing to read.
  useEffect(() => {
    if (selfAddress === null || isPrivate) return;
    let cancelled = false;
    setBalance({ kind: "loading" });
    void (async () => {
      try {
        const snapshot = await loadChainSnapshot(selfAddress);
        if (cancelled) return;
        if (snapshot.error) {
          setBalance({ kind: "error", message: snapshot.error.message });
        } else {
          setBalance({ kind: "ok", snapshot });
        }
      } catch (cause) {
        if (!cancelled) {
          setBalance({
            kind: "error",
            message: (cause as Error)?.message ?? "balance unavailable",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selfAddress, isPrivate]);

  const canSend = selfAddress !== null;
  const canReceive = selfAddress !== null;

  return (
    <div className="mw-scroll">
      {/* Public / Private toggle — only offered when the privacy gate is on.
          Switching drives data-denom on the root and flips every denom-aware
          screen into its private state. */}
      {privacyEnabled && <DenomToggle denom={denom} setDenom={setDenom} />}

      <div className="mw-card mw-hero">
        <div className="mw-hero__label">
          {isPrivate ? "Private balance" : "Total balance"}
        </div>
        {isPrivate ? (
          <div className="mw-hero__amount hidden">amount hidden by design</div>
        ) : (
          <div className="mw-hero__amount">
            {/* No on-chain price oracle: USD is honestly unavailable. */}
            —<span className="tok">USD</span>
          </div>
        )}
        <div className="mw-hero__meta">
          {isPrivate ? (
            <span>Only you and your recipients can read the amount.</span>
          ) : (
            <HeroBalanceMeta selfAddress={selfAddress} balance={balance} />
          )}
        </div>
        <div className="mw-actions">
          <button
            className="mw-act"
            onClick={openSend}
            disabled={!canSend}
            style={canSend ? undefined : { opacity: 0.4 }}
          >
            <span className="ico">
              <Icon name="send" size={18} />
            </span>
            <span>Send</span>
          </button>
          <button
            className="mw-act"
            onClick={openReceive}
            disabled={!canReceive}
            style={canReceive ? undefined : { opacity: 0.4 }}
          >
            <span className="ico">
              <Icon name="receive" size={18} />
            </span>
            <span>Receive</span>
          </button>
          <button className="mw-act" onClick={goStake}>
            <span className="ico">
              <Icon name="stake" size={18} />
            </span>
            <span>Stake</span>
          </button>
          <button
            className="mw-act"
            onClick={onScan}
            aria-label="Scan QR code"
          >
            <span className="ico">
              <Icon name="qr" size={18} />
            </span>
            <span>Scan</span>
          </button>
        </div>
      </div>

      {/* Tokens live on the public side (the chain serves public-only
          balances) — hidden in private mode, matching the design shell. */}
      {!isPrivate && (
        <TokensCard
          selfAddress={selfAddress}
          balance={balance}
          openTokens={openTokens}
        />
      )}

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Wallet readiness</h3>
          <div className="spacer" />
          <span className={`mw-readiness__state ${readiness?.state ?? "blocked"}`}>
            {readiness === null ? "checking" : readiness.state}
          </span>
        </div>
        {readiness === null ? (
          <div className="mw-readiness__empty">
            Checking native wallet posture…
          </div>
        ) : (
          <>
            {readiness.items.map((item) => (
              <div key={item.key} className="mw-readiness">
                <div className={`mw-readiness__dot ${item.state}`} />
                <div className="mw-readiness__body">
                  <div className="mw-readiness__label">{item.label}</div>
                  <div className="mw-readiness__detail">{item.detail}</div>
                </div>
                <div className="mw-readiness__value">{item.value}</div>
              </div>
            ))}
            <div className="mw-readiness__foot">
              {readiness.sampledAtBlock === null
                ? readiness.error ?? "Native capability data unavailable."
                : `Capabilities sampled at height ${readiness.sampledAtBlock.toLocaleString()}.`}
            </div>
          </>
        )}
      </div>

      <ChainConnection status={status} error={statusError} />
    </div>
  );
}

/** Hero "Available …" line. Honest about every state: resolving identity,
 *  loading the balance, an RPC error, or the real native LYTH amount. */
function HeroBalanceMeta({
  selfAddress,
  balance,
}: {
  selfAddress: string | null;
  balance: BalanceState;
}) {
  if (selfAddress === null) {
    return <span>Resolving wallet identity…</span>;
  }
  if (balance.kind === "loading") {
    return (
      <span>
        Available <b>… LYTH</b>
      </span>
    );
  }
  if (balance.kind === "error") {
    return (
      <span>
        Available <b>— LYTH</b> · balance unavailable
      </span>
    );
  }
  return (
    <span>
      Available <b>{fmt(balance.snapshot.balanceLyth)} LYTH</b>
    </span>
  );
}

/** Tokens card. Shows the honest native LYTH row (read via eth_getBalance) and
 *  links to the dedicated Tokens screen, where any indexed MRC token balances
 *  the connected node serves are listed alongside it. USD stays an em-dash for
 *  want of a price oracle. */
function TokensCard({
  selfAddress,
  balance,
  openTokens,
}: {
  selfAddress: string | null;
  balance: BalanceState;
  openTokens: () => void;
}) {
  return (
    <div className="mw-card">
      <div className="mw-card__head">
        <h3>Tokens</h3>
        <div className="spacer" />
        <button
          type="button"
          className="mw-btn"
          onClick={openTokens}
          style={{ padding: "5px 10px", fontSize: 12 }}
        >
          View all
        </button>
      </div>

      {selfAddress === null ? (
        <div className="row-help" style={{ marginTop: 8 }}>
          Resolving wallet identity…
        </div>
      ) : balance.kind === "error" ? (
        <div className="row-help" style={{ color: "var(--err)", marginTop: 8 }}>
          Couldn&apos;t read your balance from the connected node. Recent
          transactions you submit will still confirm on-chain.
        </div>
      ) : (
        <div className="mw-row">
          <div className="mw-row__icon native">LYT</div>
          <div>
            <div className="mw-row__name">
              Monolythium
              <span className="ticker">LYTH</span>
            </div>
            <div className="mw-row__sub">
              {balance.kind === "loading"
                ? "… LYTH"
                : `${fmt(balance.snapshot.balanceLyth)} LYTH`}
            </div>
          </div>
          <div className="mw-row__right">
            {/* No price oracle on chain — USD is honestly unavailable. */}
            <div className="primary">—</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChainConnection({
  status,
  error,
}: {
  status: ChainStatus | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="mw-conn">
        <span className="mw-halo err">RPC unreachable</span>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="mw-conn">
        <span className="mw-halo warn live">Connecting…</span>
      </div>
    );
  }
  return (
    <div className="mw-conn">
      <span className="mw-halo">Chain {status.chainId.toString()}</span>
      <span>·</span>
      <span>height {Number(status.blockNumber).toLocaleString()}</span>
    </div>
  );
}
