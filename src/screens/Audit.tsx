// Audit — wallet-side audit trail of the transactions this device actually
// signed and carried to a terminal receipt.
//
// This is the SAME wallet-local terminal-tx feed the notifications center
// (Alerts) consumes — the durable tracked-tx store, recorded only at the
// OperationsDrawer terminal-transition chokepoint. Nothing here is
// fabricated: every row is a real confirmed/failed tx this device submitted.
//
// Gated behind experimental-v5 (the same flag the tracked-tx pipeline runs
// under). When the flag is OFF nothing has ever been recorded, so the screen
// shows a neutral empty state rather than a fake "verified" feed.

import { Icon } from "../components/Icon";
import { relativeMs } from "../components/ActivityDetailSheet";
import { useExperimentalV5 } from "../sdk/use-feature-flags";
import { useNotifications } from "../sdk/use-notifications";
import {
  notificationBody,
  notificationTitle,
  type NotificationRecord,
} from "../sdk/notifications";

export function Audit() {
  const enabled = useExperimentalV5();
  const records = useNotifications();

  if (!enabled) {
    return (
      <div className="mw-scroll">
        <div className="mw-card">
          <p
            style={{
              margin: 0,
              color: "var(--fg-300)",
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            The audit trail records the transactions this device signs. It is
            part of the experimental wallet surface — enable it in Settings to
            keep a local history here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Audit trail</h3>
          <div className="spacer" />
          <span className="more">
            {records.length === 0 ? "—" : `${records.length} signed`}
          </span>
        </div>

        {records.length === 0 ? (
          <div className="row-help" style={{ marginTop: 8 }}>
            No signed transactions yet. Actions you authorize on this device
            appear here once they reach a terminal receipt.
          </div>
        ) : (
          records.map((rec) => <AuditRow key={rec.id} record={rec} />)
        )}
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
        This is the rolling local feed of transactions this device signed.
      </p>
    </div>
  );
}

function AuditRow({ record }: { record: NotificationRecord }) {
  const title = notificationTitle(record.kind, record.status);
  const sub = notificationBody(record.amountDecimal, record.counterparty);
  const failed = record.status === "failed";

  return (
    <div className="mw-tx">
      <div className={`mw-tx__dir ${failed ? "out" : "in"}`}>
        <Icon name="audit" size={14} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="mw-tx__label">{title}</div>
        <div className="mw-tx__when">
          {relativeMs(record.createdAtMs)} · {sub}
        </div>
      </div>
      <div className="mw-row__right">
        <span className={`mw-halo ${failed ? "err" : ""}`}>
          {failed ? "failed" : "ok"}
        </span>
      </div>
    </div>
  );
}
