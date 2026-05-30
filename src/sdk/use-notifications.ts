// React bindings for the notification store.
//
// `useSyncExternalStore` subscribes a component to the store cache so a
// freshly-recorded notification (or a mark-all-read) re-renders the bell
// badge and the notifications center immediately. Mirrors the shape of
// `use-feature-flags.ts`: the snapshot starts empty and is refreshed by
// `hydrateNotifications()` (called once on first mount), so a component's
// first paint matches a build without any persisted notifications.

import { useEffect, useSyncExternalStore } from "react";
import {
  hydrateNotifications,
  notificationsSnapshot,
  subscribeNotifications,
  unreadCountSnapshot,
} from "./notifications-store";
import type { NotificationRecord } from "./notifications";

/** Subscribe to the notification feed (newest-first). Triggers a one-time
 *  disk hydration on first mount; returns an empty array until hydration
 *  resolves. */
export function useNotifications(): NotificationRecord[] {
  useEffect(() => {
    void hydrateNotifications();
  }, []);
  return useSyncExternalStore(
    subscribeNotifications,
    notificationsSnapshot,
    notificationsSnapshot,
  );
}

/** Subscribe to the unread count only. Same hydration + subscription as
 *  {@link useNotifications}; returns `0` until hydration resolves and
 *  whenever every record is read. */
export function useUnreadCount(): number {
  useEffect(() => {
    void hydrateNotifications();
  }, []);
  return useSyncExternalStore(
    subscribeNotifications,
    unreadCountSnapshot,
    unreadCountSnapshot,
  );
}
