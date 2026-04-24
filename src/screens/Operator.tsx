// Operator — DVT cluster status pane (mobile-adapted from designs/src/operator.jsx).
// Wallet-visible read-only view of the cluster the user delegates to.

import { Icon } from "../components/Icon";

const SLOTS = [
  { i: 1, name: "alpha", state: "nominal" as const },
  { i: 2, name: "beta", state: "nominal" as const },
  { i: 3, name: "gamma", state: "nominal" as const },
  { i: 4, name: "delta", state: "nominal" as const },
  { i: 5, name: "epsilon", state: "nominal" as const },
  { i: 6, name: "zeta", state: "maintenance" as const },
  { i: 7, name: "eta", state: "nominal" as const },
];

const stateColor: Record<string, string> = {
  nominal: "var(--ok)",
  maintenance: "var(--warn)",
  jail: "var(--err)",
};

export function Operator() {
  return (
    <div className="mw-scroll">
      <div className="mw-card mw-hero">
        <div className="mw-hero__label">Avengers cluster</div>
        <div className="mw-hero__amount">
          7
          <span className="tok">of 10 active</span>
        </div>
        <div className="mw-hero__meta">
          <span>
            APR <b className="up">+4.20%</b>
          </span>
          <span>
            Uptime <b>99.97%</b>
          </span>
          <span>
            TVS <b>3.4M LYTH</b>
          </span>
        </div>
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Slots</h3>
          <div className="spacer" />
          <span className="mw-halo live">live</span>
        </div>
        {SLOTS.map((s) => (
          <div key={s.i} className="mw-row">
            <div className="mw-row__icon">{String(s.i).padStart(2, "0")}</div>
            <div>
              <div className="mw-row__name">slot-{s.name}</div>
              <div className="mw-row__sub">
                participation 98.{(80 + s.i).toString().slice(-2)}%
              </div>
            </div>
            <div className="mw-row__right">
              <span
                className="mw-halo"
                style={
                  s.state !== "nominal"
                    ? { color: stateColor[s.state] }
                    : undefined
                }
              >
                {s.state}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Charter</h3>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
          One active cluster, two standby. Service revenue (archive, RPC, GPU) splits per
          operator; base reward pool divides equally across the ten members.
        </p>
        <div className="mw-kv" style={{ marginTop: 12 }}>
          <div className="k">Swap window</div>
          <div className="v">3 epochs notice</div>
        </div>
        <div className="mw-kv">
          <div className="k">Bond cooldown</div>
          <div className="v">14 days + 1 epoch</div>
        </div>
        <div className="mw-kv">
          <div className="k">Region mix</div>
          <div className="v">EU · NA · APAC</div>
        </div>
      </div>

      <p
        style={{
          fontSize: 11.5,
          color: "var(--fg-400)",
          textAlign: "center",
          padding: "0 8px",
        }}
      >
        <Icon name="shield" size={11} /> &nbsp;Read-only on mobile. Operator actions live in Monarch
        Desktop.
      </p>
    </div>
  );
}
