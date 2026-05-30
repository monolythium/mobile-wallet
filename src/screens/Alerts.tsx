// Notifications center — the in-app feed of the wallet's own tracked-tx
// terminal transitions (confirmed / failed). Repurposed from the former
// static "Alerts" mock: the hardcoded placeholder list is gone; this screen
// now renders the live notification store.
//
// Read-only: this screen never CREATES a record. Recording happens only at
// the OperationsDrawer terminal-transition chokepoint. Here we list (newest
// first), mark-all-read, mark-one-read on open, and open a per-row detail
// sheet (with a Monoscan tx link).
//
// Gated behind experimental-v5: when the flag is OFF the feed is suppressed
// and a neutral empty state is shown (the bell that routes here is itself
// only mounted when the flag is ON, so this is belt-and-braces).

import { useCallback, useState } from "react";
import { Icon } from "../components/Icon";
import { NotificationDetailSheet } from "../components/NotificationDetailSheet";
import { relativeMs } from "../components/ActivityDetailSheet";
import { useExperimentalV5 } from "../sdk/use-feature-flags";
import { useNotifications } from "../sdk/use-notifications";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "../sdk/notifications-store";
import {
  notificationBody,
  notificationTitle,
  type NotificationRecord,
} from "../sdk/notifications";

export function Alerts() {
  const enabled = useExperimentalV5();
  const records = useNotifications();
  const [selected, setSelected] = useState<NotificationRecord | null>(null);
  const [marking, setMarking] = useState(false);

  const handleMarkAllRead = useCallback(async () => {
    setMarking(true);
    await markAllNotificationsRead();
    setMarking(false);
  }, []);

  // Opening a record's detail also marks just that record read. The store
  // emits on a successful flip, so the row's unread dot + the bell badge
  // update on their own; no local optimistic patch needed.
  const handleOpen = useCallback((rec: NotificationRecord) => {
    setSelected(rec);
    if (!rec.read) void markNotificationRead(rec.id);
  }, []);

  if (!enabled) {
    return (
      <div className="mw-scroll">
        <div className="mw-card">
          <p style={{ margin: 0, color: "var(--fg-300)", fontSize: 13, lineHeight: 1.55 }}>
            Notifications are part of the experimental wallet surface. Enable it
            in Settings to track your transactions here.
          </p>
        </div>
      </div>
    );
  }

  const hasUnread = records.some((r) => !r.read);

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Notifications</h3>
          <div className="spacer" />
          {hasUnread && (
            <button
              type="button"
              className="mw-btn"
              onClick={() => void handleMarkAllRead()}
              disabled={marking}
              style={{ padding: "5px 10px", fontSize: 12 }}
            >
              Mark all as read
            </button>
          )}
        </div>

        {records.length === 0 ? (
          <div className="row-help" style={{ marginTop: 8 }}>
            No notifications yet. Confirmed and failed transactions you submit
            will appear here.
          </div>
        ) : (
          records.map((rec) => (
            <NotificationRow
              key={rec.id}
              record={rec}
              onOpen={() => handleOpen(rec)}
            />
          ))
        )}
      </div>

      <NotificationDetailSheet record={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function NotificationRow({
  record,
  onOpen,
}: {
  record: NotificationRecord;
  onOpen: () => void;
}) {
  const title = notificationTitle(record.kind, record.status);
  const sub = notificationBody(record.amountDecimal, record.counterparty);

  return (
    <div
      className="mw-row"
      style={{ alignItems: "center", cursor: "pointer" }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div
        className="mw-row__icon"
        style={{
          color: record.status === "failed" ? "var(--err)" : "var(--ok)",
        }}
      >
        {record.status === "failed" ? "!" : "✓"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mw-row__name"
          style={{ display: "flex", alignItems: "center", gap: 7 }}
        >
          {title}
          {!record.read && <span className="mw-unread-dot" aria-label="Unread" />}
        </div>
        <div className="mw-row__sub">{sub}</div>
      </div>
      <div className="mw-row__right">
        <span
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--fg-400)",
          }}
        >
          {relativeMs(record.createdAtMs)}
        </span>
        <span aria-hidden style={{ display: "inline-flex", marginLeft: 6, color: "var(--fg-400)" }}>
          <Icon name="chev" size={13} />
        </span>
      </div>
    </div>
  );
}
