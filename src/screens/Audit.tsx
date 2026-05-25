// Audit — wallet-side audit feed (adapted from designs/src/audit.jsx).
// Read-only mobile view; full export lives in the desktop wallet.

import { Icon } from "../components/Icon";
import { addressToTypedBech32 } from "@monolythium/core-sdk";

const MIRA_ADDRESS = addressToTypedBech32(
  "user",
  "0x1111111111111111111111111111111111111111",
);

const ENTRIES = [
  {
    id: "a1",
    when: "today 14:02",
    actor: "this device",
    action: "send 100.00 LYTH",
    target: MIRA_ADDRESS,
    halo: "ok" as const,
  },
  {
    id: "a2",
    when: "today 13:48",
    actor: "Mira Bell",
    action: "received 240.00 LYTH",
    target: "you",
    halo: "ok" as const,
  },
  {
    id: "a3",
    when: "yesterday 23:11",
    actor: "this device",
    action: "rotated mobile passkey",
    target: "key fingerprint 44ae…0c5e",
    halo: "warn" as const,
  },
  {
    id: "a4",
    when: "2 days ago",
    actor: "hardware backup",
    action: "approved cluster swap",
    target: "Avengers → Avengers (slot-zeta)",
    halo: "ok" as const,
  },
];

export function Audit() {
  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Audit trail</h3>
          <div className="spacer" />
          <span className="mw-halo">verified</span>
        </div>
        {ENTRIES.map((e) => (
          <div key={e.id} className="mw-tx">
            <div className={`mw-tx__dir ${e.halo === "ok" ? "in" : "out"}`}>
              <Icon name="audit" size={14} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="mw-tx__label">{e.action}</div>
              <div className="mw-tx__when">
                {e.when} · {e.actor}
              </div>
            </div>
            <div className="mw-row__right">
              <span className={`mw-halo ${e.halo === "warn" ? "warn" : ""}`}>
                {e.halo === "warn" ? "review" : "ok"}
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
        Tap an entry on desktop to inspect the signed envelope. Mobile shows the rolling
        feed only.
      </p>
    </div>
  );
}
