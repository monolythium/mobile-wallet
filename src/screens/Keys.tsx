// Keys — list of signing keys + algos, with mobile-adapted single-column layout.
// Adapted from designs/src/keys.jsx for the wallet's "More → Security" flow.

import { Icon } from "../components/Icon";
import type { OperationRequest } from "../components/OperationsDrawer";

interface Props {
  openOperation: (req: OperationRequest) => void;
}

const DEMO_KEYS = [
  {
    id: "k1",
    label: "Primary signer",
    algo: "ML-DSA-44",
    color: "#7ec7d8",
    fingerprint: "8b41:7d2c:9a01:42a8",
    used: "active",
  },
  {
    id: "k2",
    label: "Hardware backup",
    algo: "Ed25519",
    color: "#b8aaff",
    fingerprint: "1f08:cd44:0917:e2b6",
    used: "paired",
  },
  {
    id: "k3",
    label: "Mobile passkey",
    algo: "Passkey",
    color: "#7ee3c1",
    fingerprint: "44ae:e103:55b8:0c5e",
    used: "this device",
  },
];

export function Keys({ openOperation }: Props) {
  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Signing keys</h3>
          <div className="spacer" />
          <span className="more">3 trusted</span>
        </div>
        {DEMO_KEYS.map((k) => (
          <div key={k.id} className="mw-row">
            <div
              className="mw-row__icon"
              style={{ background: `${k.color}1f`, borderColor: `${k.color}55`, color: k.color }}
            >
              <Icon name="key" size={16} />
            </div>
            <div>
              <div className="mw-row__name">
                {k.label}
                <span className="ticker" style={{ color: k.color }}>
                  {k.algo}
                </span>
              </div>
              <div className="mw-row__sub">{k.fingerprint}</div>
            </div>
            <div className="mw-row__right">
              <span className="mw-halo">{k.used}</span>
            </div>
          </div>
        ))}
      </div>

      <button
        className="mw-btn mw-btn--primary mw-btn--block"
        onClick={() =>
          openOperation({
            kind: "sign",
            title: "Add signing key",
            summary:
              "Pair a new key from a hardware wallet or another device. Pairing requires biometric authorization on this device.",
            details: [
              { k: "Algorithm", v: "ML-DSA-44 (post-quantum)" },
              { k: "Source", v: "Pair via QR" },
              { k: "Bond", v: "0.10 LYTH", mono: true },
            ],
            confirmLabel: "Begin pairing",
          })
        }
      >
        Pair another key
      </button>
    </div>
  );
}
