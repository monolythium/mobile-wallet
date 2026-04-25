// Frontend wrapper for the Rust auth commands defined in
// `src-tauri/src/auth.rs`. Centralises the biometric + keystore plumbing so
// individual screens never call `invoke()` directly — the SDK is the seam.
//
// Behaviour by host:
//   - iOS / Android (Tauri 2 mobile): biometric + native keystore work.
//   - Desktop host (current dev build): biometric returns `unavailable`,
//     keystore reads return `null`, keystore writes throw. The UI must
//     branch on `isBiometricAvailable()` and fall back to the password
//     path. See OperationsDrawer + Onboarding.

import { invoke } from "@tauri-apps/api/core";

export interface BiometricStatus {
  available: boolean;
  /** Sensor identifier reported by the platform (`face`, `touch`, …). */
  kind: string | null;
  /** Human-readable reason `available` is false. */
  reason: string | null;
}

export type AuthErrorKind = "Unavailable" | "Cancelled" | "Failed" | "Keystore";

export interface AuthError {
  kind: AuthErrorKind;
  message: string;
}

const KEY_UNLOCK = "wallet.unlock";

function asAuthError(cause: unknown): AuthError {
  // Rust side serialises with `#[serde(tag = "kind", content = "message")]`,
  // so the value comes back as `{ kind, message? }` — except for
  // `Unavailable`, which has no payload, so `message` may be missing.
  const c = cause as { kind?: string; message?: string } | undefined;
  if (c && typeof c.kind === "string") {
    return {
      kind: (c.kind as AuthErrorKind) ?? "Failed",
      message: c.message ?? c.kind,
    };
  }
  return { kind: "Failed", message: (cause as Error)?.message ?? String(cause) };
}

export async function biometricStatus(): Promise<BiometricStatus> {
  try {
    return await invoke<BiometricStatus>("biometric_is_available");
  } catch (cause) {
    // Treat probe failure as "unavailable" rather than throwing — the UI
    // doesn't need to differentiate here.
    return {
      available: false,
      kind: null,
      reason: asAuthError(cause).message,
    };
  }
}

export async function isBiometricAvailable(): Promise<boolean> {
  return (await biometricStatus()).available;
}

/**
 * Prompt the OS biometric sensor. Resolves `true` on success, throws an
 * `AuthError` on failure. Caller decides whether to fall back to password.
 */
export async function authenticateBiometric(reason: string): Promise<boolean> {
  try {
    return await invoke<boolean>("biometric_authenticate", { reason });
  } catch (cause) {
    throw asAuthError(cause);
  }
}

export async function hasUnlockSecret(): Promise<boolean> {
  try {
    return await invoke<boolean>("keychain_has", { key: KEY_UNLOCK });
  } catch {
    return false;
  }
}

/**
 * Persist the unlock secret to the platform keystore. On desktop hosts
 * this throws `AuthError { kind: "Unavailable" }` and the caller should
 * keep the secret in memory only.
 */
export async function setUnlockSecret(secret: string): Promise<void> {
  try {
    await invoke("keychain_set", { key: KEY_UNLOCK, value: secret });
  } catch (cause) {
    throw asAuthError(cause);
  }
}

export async function getUnlockSecret(): Promise<string | null> {
  try {
    return await invoke<string | null>("keychain_get", { key: KEY_UNLOCK });
  } catch {
    return null;
  }
}

export async function clearUnlockSecret(): Promise<void> {
  try {
    await invoke("keychain_delete", { key: KEY_UNLOCK });
  } catch (cause) {
    throw asAuthError(cause);
  }
}

/**
 * Auth flow used by the OperationsDrawer:
 *   1. Try biometric (`authenticateBiometric`).
 *   2. If unavailable / failed / cancelled, fall back to the keystore
 *      password challenge (`verifyPassword`).
 *
 * Returns `true` on success, throws `AuthError` on hard failure (cancelled
 * by user, no fallback wired). Callers render the failure to the drawer.
 */
export async function authorizeOperation(
  reason: string,
  passwordPrompt?: () => Promise<string | null>,
): Promise<boolean> {
  // Step 1 — biometric.
  const status = await biometricStatus();
  if (status.available) {
    try {
      const ok = await authenticateBiometric(reason);
      if (ok) return true;
    } catch (e) {
      const err = e as AuthError;
      if (err.kind === "Cancelled") throw err;
      // Fall through on Failed / Unavailable — try password next.
    }
  }

  // Step 2 — password fallback. Caller supplies the prompt; if no prompt
  // is wired (e.g. desktop dev), throw Unavailable so the UI shows a
  // diagnostic instead of silently succeeding.
  if (!passwordPrompt) {
    throw {
      kind: "Unavailable" as AuthErrorKind,
      message: "biometric not available and no password prompt configured",
    } satisfies AuthError;
  }

  const entered = await passwordPrompt();
  if (entered === null) {
    throw {
      kind: "Cancelled" as AuthErrorKind,
      message: "password challenge cancelled",
    } satisfies AuthError;
  }
  return await verifyPassword(entered);
}

/**
 * Verify a password by comparing it (constant-time) against the secret
 * stored in the keystore at onboarding time. Returns `true` on match.
 *
 * Stage 3 keeps the comparison plaintext (the keystore is already at-rest
 * encrypted by iOS Keychain / Android Keystore). When `mono-core-sdk`'s
 * `Signer` lands, the keystore slot will hold a derived KEK rather than
 * the password directly — this function will then become "decrypt the KEK
 * with the password and unlock the signer". Tracked at:
 *   TODO(monolythium-vision): swap plaintext password compare for
 *     KDF-derived KEK once mono-core-sdk Signer is available.
 */
export async function verifyPassword(entered: string): Promise<boolean> {
  const stored = await getUnlockSecret();
  if (stored === null) return false;
  return constantTimeEq(stored, entered);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
