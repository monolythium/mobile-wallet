// Home — primary mobile screen.
// Hero balance + quick actions + tokens preview + readiness + chain conn.

import { Icon } from "../components/Icon";
import type { OperationRequest } from "../components/OperationsDrawer";
import type { ChainStatus } from "../sdk/client";
import type { WalletReadiness } from "../sdk/readiness";

interface Props {
  status: ChainStatus | null;
  statusError: string | null;
  readiness: WalletReadiness | null;
  /** Internal 0x address bound to the unlocked vault. `null` until
   *  the bound address has been resolved; public UI renders typed mono1. */
  selfAddress: string | null;
  openOperation: (req: OperationRequest) => void;
  /** Opens the Send compose overlay. */
  openSend: () => void;
  /** Opens the Receive QR overlay. */
  openReceive: () => void;
  /** Opens the full-screen QR scanner. */
  onScan: () => void;
}

// TODO(monolythium-vision): replace with live MRC balances + a price
// feed once the indexer surfaces a token list for the user address.
const DEMO_TOKENS = [
  { sym: "LYTH", name: "Monolythium", amount: 0, priceUsd: 0, chg24h: 0, primary: true },
] as const;

const fmt = (n: number, f = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: f, maximumFractionDigits: f });

export function Home({
  status,
  statusError,
  readiness,
  selfAddress,
  openOperation,
  openSend,
  openReceive,
  onScan,
}: Props) {
  const totalUsd = DEMO_TOKENS.reduce((a, t) => a + t.amount * t.priceUsd, 0);
  const canSend = selfAddress !== null;
  const canReceive = selfAddress !== null;

  return (
    <div className="mw-scroll">
      <div className="mw-card mw-hero">
        <div className="mw-hero__label">Total balance</div>
        <div className="mw-hero__amount">
          ${fmt(totalUsd)}
          <span className="tok">USD</span>
        </div>
        <div className="mw-hero__meta">
          <span>
            Available <b>{fmt(DEMO_TOKENS[0].amount, 0)} LYTH</b>
          </span>
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
          <button
            className="mw-act"
            onClick={() =>
              openOperation({
                kind: "stake",
                title: "Stake with cluster",
                summary:
                  "Delegate LYTH to a DVT cluster. Liquid stake — exit any time, no lockup.",
                details: [
                  { k: "Cluster", v: "(picker coming soon)" },
                  { k: "Exit", v: "Instant" },
                ],
                confirmLabel: "Coming soon",
              })
            }
          >
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

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Tokens</h3>
          <div className="spacer" />
          <span className="more">{DEMO_TOKENS.length} held</span>
        </div>
        {DEMO_TOKENS.map((t) => (
          <div key={t.sym} className="mw-row">
            <div className={`mw-row__icon${t.primary ? " native" : ""}`}>
              {t.sym.slice(0, 3)}
            </div>
            <div>
              <div className="mw-row__name">
                {t.name}
                <span className="ticker">{t.sym}</span>
              </div>
              <div className="mw-row__sub">
                {fmt(t.amount, 2)} {t.sym}
              </div>
            </div>
            <div className="mw-row__right">
              <div className="primary">${fmt(t.amount * t.priceUsd)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>v4.1 readiness</h3>
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
