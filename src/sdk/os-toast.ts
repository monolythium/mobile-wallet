// Native OS toast — a thin, best-effort wrapper over
// @tauri-apps/plugin-notification, mirroring how the rest of the SDK wraps a
// Tauri plugin (`feature-flags.ts`/`notifications-store.ts` over plugin-store):
// a single small module that owns the IPC round-trip and degrades silently.
//
// This is purely ADDITIVE to the in-app notifications center. The in-app
// record is still the source of truth (written in `notifications-store.ts`);
// this raises a matching native OS notification (iOS/Android banner, desktop
// host toast) so a confirmed/failed tx is visible even when the app isn't in
// the foreground.
//
// Best-effort contract
// ====================
// Every export here swallows its own errors and never throws — a failed
// permission check or a missing IPC surface (e.g. jsdom under vitest, or a
// desktop host without a notification backend) must never break the reconcile
// tick that calls it. The OS toast is a nicety; its absence is silent UX
// degradation only.
//
// The flag gate lives at the CALL SITE (`reconcile.ts`, behind
// `experimentalV5Enabled()`), so with the experimental surface OFF this module
// is never invoked — no permission prompt, no OS notification.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** Ask for OS-notification permission once, returning whether it is granted.
 *  Checks the current grant first (so we never re-prompt a user who already
 *  granted/denied), and only calls `requestPermission()` on first use. Any
 *  failure (no IPC surface, user dismissal, plugin error) resolves to `false`
 *  — the caller treats a false as "skip the toast" and moves on. */
export async function ensureOsNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    const result = await requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

/** Raise a native OS notification with the given title + body. Best-effort:
 *  requests permission on first use, no-ops if it isn't granted, and swallows
 *  any error so it never throws into the caller.
 *
 *  Body carries NO secrets — the caller passes the same friendly title/body
 *  the in-app record renders (amount + short bech32m only). */
export async function sendOsToast(title: string, body: string): Promise<void> {
  try {
    if (!(await ensureOsNotificationPermission())) return;
    sendNotification({ title, body });
  } catch {
    // Swallow — the in-app record already landed; the OS toast is additive.
  }
}
