// Home — primary mobile screen.
// Adapted from designs/src/wallet-mobile.jsx (single-column, large tap targets).
// Hero balance + quick actions + tokens preview + recent activity.

import { Icon } from "../components/Icon";
import type { OperationRequest } from "../components/OperationsDrawer";
import type { ChainStatus } from "../sdk/client";
import { sendLyth } from "../sdk/send";
import { makeBiometricSigner, unlockViaBiometric } from "../sdk/signer";

interface Props {
  status: ChainStatus | null;
  statusError: string | null;
  /** EIP-55 lowercase address bound to the unlocked vault. `null` until
   *  the bound address has been resolved (the App resolves it once via
   *  the password unlock at onboarding-complete time). */
  selfAddress: string | null;
  openOperation: (req: OperationRequest) => void;
  /** Scan affordance: opens the full-screen QR scanner. The scanned
   *  payload routes through `parseDeepLink` and back into either a Send /
   *  Sign sheet or a WalletConnect pairing. */
  onScan: () => void;
}

/**
 * Demo recipient + amount used by the Send button on Home. The drawer
 * shows these in the diff and feeds them straight to `sendLyth`. When a
 * real "compose tx" surface (recipient picker, amount field, gas chooser)
 * lands these go away.
 */
const SEND_DEMO = {
  to: "0x000000000000000000000000000000000000dead",
  amountLyth: "0.001",
};

const DEMO_TOKENS = [
  { sym: "LYTH", name: "Monolythium", amount: 14_280.41, priceUsd: 8.42, chg24h: 2.4, primary: true },
  { sym: "USDM", name: "USD Mono", amount: 4_120.0, priceUsd: 1.0, chg24h: 0.0, primary: false },
  { sym: "ETH", name: "Ether (bridge)", amount: 0.84, priceUsd: 2_950.0, chg24h: -0.6, primary: false },
] as const;

const DEMO_TXS = [
  { id: "tx1", who: "Mira Bell", when: "2 min ago", amount: 240, dir: "in" as const },
  { id: "tx2", who: "Cypher Co.", when: "1 hr ago", amount: 75, dir: "out" as const },
  { id: "tx3", who: "Cluster Avengers", when: "today", amount: 12.4, dir: "in" as const },
];

const fmt = (n: number, f = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: f, maximumFractionDigits: f });

export function Home({ status, statusError, selfAddress, openOperation, onScan }: Props) {
  const totalUsd = DEMO_TOKENS.reduce((a, t) => a + t.amount * t.priceUsd, 0);

  // Send LYTH — biometric+vault path. The drawer's auth stage already
  // ran (or is about to run) `authorizeOperation`; the `execute()`
  // closure fires after the auth gate succeeds and re-unlocks the vault
  // payload to read the secp256k1 key. The unlocked key never leaves
  // `sendLyth`'s call frame.
  const openSend = () => {
    if (!selfAddress) {
      // The bound address is resolved at app boot via the password
      // path; if we haven't gotten it yet, fall back to a preview-only
      // request so the user sees the UI instead of an error.
      openOperation({
        kind: "send",
        title: "Send LYTH",
        summary: "Wallet identity is still loading — try again in a moment.",
        details: [{ k: "Status", v: "binding address…" }],
        confirmLabel: "Retry",
      });
      return;
    }
    const chainLabel = status ? `chain ${status.chainId.toString()}` : "(querying)";
    openOperation({
      kind: "send",
      title: `Send ${SEND_DEMO.amountLyth} LYTH`,
      summary: `Send ${SEND_DEMO.amountLyth} LYTH to ${shortAddr(SEND_DEMO.to)} on ${chainLabel}. The chain confirms in roughly one second.`,
      details: [
        { k: "From", v: selfAddress, mono: true },
        { k: "To", v: SEND_DEMO.to, mono: true },
        { k: "Asset", v: "LYTH" },
        { k: "Amount", v: SEND_DEMO.amountLyth, mono: true },
        { k: "Network", v: chainLabel },
      ],
      confirmLabel: "Sign and send",
      execute: async () => {
        const signer = makeBiometricSigner({
          unlock: unlockViaBiometric,
          address: selfAddress,
        });
        const result = await sendLyth(signer, {
          from: selfAddress,
          to: SEND_DEMO.to,
          amountLyth: SEND_DEMO.amountLyth,
        });
        return result.txHash;
      },
    });
  };

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
          <span>
            Earning <b className="up">+4.12%</b>
          </span>
        </div>
        <div className="mw-actions">
          <button
            className="mw-act"
            onClick={openSend}
          >
            <span className="ico">
              <Icon name="send" size={18} />
            </span>
            <span>Send</span>
          </button>
          <button
            className="mw-act"
            onClick={() =>
              openOperation({
                kind: "receive",
                title: "Receive LYTH",
                summary: "Share your address or QR code with the sender.",
                details: [
                  { k: "Address", v: "mono1:demo…42a8", mono: true },
                  { k: "Network", v: "Monolythium v4.0 testnet" },
                ],
                confirmLabel: "Show QR",
              })
            }
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
                kind: "buy",
                title: "Buy LYTH",
                summary: "Fund the wallet from a debit card or bank transfer.",
                details: [
                  { k: "Method", v: "Debit card" },
                  { k: "Fee", v: "1.5%" },
                ],
                confirmLabel: "Continue",
              })
            }
          >
            <span className="ico">
              <Icon name="buy" size={18} />
            </span>
            <span>Buy</span>
          </button>
          <button
            className="mw-act"
            onClick={() =>
              openOperation({
                kind: "stake",
                title: "Stake with cluster",
                summary: "Delegate LYTH to a DVT cluster. Unbonding takes 21 days.",
                details: [
                  { k: "Cluster", v: "Avengers · 7-of-10" },
                  { k: "APR", v: "4.20%", mono: true },
                  { k: "Unbond", v: "21 days" },
                ],
                confirmLabel: "Confirm stake",
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
            <div className={`mw-row__icon${t.primary ? " native" : ""}`}>{t.sym.slice(0, 3)}</div>
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
              <div className="usd" style={{ color: t.chg24h >= 0 ? "var(--ok)" : "var(--err)" }}>
                {t.chg24h >= 0 ? "+" : ""}
                {t.chg24h.toFixed(1)}%
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Recent activity</h3>
          <div className="spacer" />
        </div>
        {DEMO_TXS.map((tx) => (
          <div key={tx.id} className="mw-tx">
            <div className={`mw-tx__dir ${tx.dir}`}>
              <Icon name={tx.dir === "in" ? "receive" : "send"} size={14} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="mw-tx__label">{tx.who}</div>
              <div className="mw-tx__when">{tx.when}</div>
            </div>
            <div className={`mw-tx__amt ${tx.dir}`}>
              {tx.dir === "in" ? "+" : "−"}
              {fmt(tx.amount)}
              <span style={{ color: "var(--fg-400)", marginLeft: 4, fontSize: 10.5 }}>LYTH</span>
            </div>
          </div>
        ))}
      </div>

      <ChainConnection status={status} error={statusError} />
    </div>
  );
}

function ChainConnection({ status, error }: { status: ChainStatus | null; error: string | null }) {
  if (error) {
    return (
      <div className="mw-conn">
        <span className="mw-halo err">
          RPC unreachable
        </span>
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

function shortAddr(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}
