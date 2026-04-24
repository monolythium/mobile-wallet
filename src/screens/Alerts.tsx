// Alerts — wallet alert feed (adapted from designs/src/alerts.jsx).
// AI is advisory: the screen surfaces signals, the Operations drawer is the
// only path to a destructive action.

import { Icon } from "../components/Icon";
import type { OperationRequest } from "../components/OperationsDrawer";

interface Props {
  openOperation: (req: OperationRequest) => void;
}

const ALERTS = [
  {
    id: "al1",
    title: "Unusual recipient pattern",
    body: "A draft transfer is going to a fresh address that has no on-chain history. The wallet recommends pausing.",
    severity: "warn" as const,
    actionLabel: "Review draft",
  },
  {
    id: "al2",
    title: "Cluster ratifying swap",
    body: "Avengers cluster will swap slot-zeta in 2 epochs. Your delegation is unaffected.",
    severity: "info" as const,
    actionLabel: "Open operator",
  },
  {
    id: "al3",
    title: "New region available",
    body: "AP-Sydney joined the mesh. Diversity bonus is now eligible.",
    severity: "ok" as const,
    actionLabel: "Browse clusters",
  },
];

export function Alerts({ openOperation }: Props) {
  return (
    <div className="mw-scroll">
      {ALERTS.map((a) => (
        <div key={a.id} className="mw-card">
          <div className="mw-card__head">
            <h3>{a.title}</h3>
            <div className="spacer" />
            <span
              className={`mw-halo${
                a.severity === "warn" ? " warn" : a.severity === "ok" ? "" : ""
              }`}
            >
              {a.severity === "warn"
                ? "attention"
                : a.severity === "ok"
                  ? "ok"
                  : "informational"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--fg-200)", lineHeight: 1.55 }}>
            {a.body}
          </p>
          <button
            className="mw-btn mw-btn--block"
            style={{ marginTop: 14 }}
            onClick={() =>
              openOperation({
                kind: "sign",
                title: a.title,
                summary: `${a.body}\n\nThis review records your decision in the audit trail.`,
                details: [
                  { k: "Severity", v: a.severity },
                  { k: "Source", v: "wallet AI" },
                  { k: "Action", v: a.actionLabel },
                ],
                confirmLabel: "Acknowledge",
              })
            }
          >
            <Icon name="alert" size={14} />
            {a.actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}
