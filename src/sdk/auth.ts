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
//
// Stage 4 (this file): the keystore now holds the **device-key** (32 random
// bytes, hex-encoded), NOT the password. The vault layer (`./vault.ts`) owns
// the KDF (Argon2id) and the on-disk encrypted envelope. Password
// verification is no longer a string compare — it's an AES-GCM-authenticated
// decryption attempt against the envelope.

import { invoke } from "@tauri-apps/api/core";
import {
  bootstrap as vaultBootstrap,
  unlockWithDeviceKey,
  unlockWithPassword,
  vaultExists,
  verifyPasswordAgainstVault,
  wipe as vaultWipe,
} from "./vault";

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

/** Keystore slot label. The keystore plugin is single-secret, but we keep a
 * stable label so the next slot abstraction can carry over. */
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

/**
 * True iff onboarding has completed for this device — both the keystore
 * device-key slot AND the on-disk vault envelope are present. Either alone
 * means a half-finished install (a bug or a wipe), and onboarding should
 * re-run.
 */
export async function hasUnlockSecret(): Promise<boolean> {
  const [keystoreOk, vaultOk] = await Promise.all([
    keystoreHas().catch(() => false),
    vaultExists().catch(() => false),
  ]);
  return keystoreOk && vaultOk;
}

async function keystoreHas(): Promise<boolean> {
  try {
    return await invoke<boolean>("keychain_has", { key: KEY_UNLOCK });
  } catch {
    return false;
  }
}

/**
 * Persist the device-key to the platform keystore. On desktop hosts this
 * throws `AuthError { kind: "Unavailable" }`.
 */
async function keystoreSet(value: string): Promise<void> {
  try {
    await invoke("keychain_set", { key: KEY_UNLOCK, value });
  } catch (cause) {
    throw asAuthError(cause);
  }
}

async function keystoreGet(): Promise<string | null> {
  try {
    return await invoke<string | null>("keychain_get", { key: KEY_UNLOCK });
  } catch {
    return null;
  }
}

async function keystoreDelete(): Promise<void> {
  try {
    await invoke("keychain_delete", { key: KEY_UNLOCK });
  } catch (cause) {
    throw asAuthError(cause);
  }
}

/**
 * Stage 4 onboarding: take the user's password, derive a KEK via Argon2id,
 * encrypt a fresh vault envelope, and store the device-key in the keystore.
 *
 * Throws `AuthError` on keystore failure. The vault file write is
 * best-effort — desktop hosts may surface an `Unavailable` error if the
 * app data dir can't be created; callers handle that as "demo mode".
 */
export async function bootstrapVault(password: string): Promise<void> {
  // 1. Generate device-key + salt, derive KEK, encrypt envelope, write file.
  const { deviceKeyHex } = await vaultBootstrap(password);

  // 2. Push the device-key into the OS keystore. If this throws, wipe the
  //    on-disk envelope so we don't leave a half-onboarded install — next
  //    boot will re-show onboarding instead of an inconsistent unlock UI.
  try {
    await keystoreSet(deviceKeyHex);
  } catch (cause) {
    try {
      await vaultWipe();
    } catch {
      // Best-effort cleanup; surface the original error.
    }
    throw cause;
  }
}

/**
 * Best-effort wipe — removes both the keystore device-key and the on-disk
 * envelope. Used by Settings -> "Forget this device" (planned) and by
 * cleanup paths.
 */
export async function clearUnlockSecret(): Promise<void> {
  // Run both wipes; a failure to delete the keystore should not block the
  // file wipe and vice versa.
  const errors: AuthError[] = [];
  try {
    await keystoreDelete();
  } catch (cause) {
    errors.push(asAuthError(cause));
  }
  try {
    await vaultWipe();
  } catch (cause) {
    errors.push(asAuthError(cause));
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * Auth flow used by the OperationsDrawer:
 *   1. Try biometric (`authenticateBiometric`).
 *   2. If biometric succeeds, fetch the device-key from the keystore and
 *      unwrap the KEK from the on-disk envelope. Success here = a real,
 *      key-material-backed authorization, not just a "the sensor said yes"
 *      signal.
 *   3. If biometric is unavailable / failed / cancelled, fall back to the
 *      password challenge. The entered password is run through Argon2id
 *      and used to AES-GCM-decrypt the envelope — wrong password fails
 *      authentication tag verification.
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
      if (ok) {
        // Biometric passed → unwrap the KEK from the on-disk envelope. If
        // unwrap fails (e.g., envelope wiped out-of-band), treat as
        // unavailable and fall through to password.
        const deviceKey = await keystoreGet();
        if (deviceKey) {
          try {
            await unlockWithDeviceKey(deviceKey);
            return true;
          } catch {
            // Vault unwrap failed — fall through to password prompt.
          }
        }
      }
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
 * Verify a password by attempting to derive its KEK and decrypt the on-disk
 * envelope. AES-GCM authentication tag mismatch = wrong password.
 *
 * No plaintext compare anywhere. The keystore slot now holds the device-key
 * (random 32 bytes), not the user's password — wrapping is provided by
 * `bootstrapVault` and the vault module.
 */
export async function verifyPassword(entered: string): Promise<boolean> {
  return verifyPasswordAgainstVault(entered);
}

/**
 * Caller convenience — kept exported because `Onboarding.tsx` and the
 * OperationsDrawer probe biometric availability. The KDF + envelope live
 * in `./vault.ts`; this file is the auth seam only.
 */
export async function unlockKekWithPassword(password: string): Promise<Uint8Array> {
  const { kek } = await unlockWithPassword(password);
  return kek;
}

export async function unlockKekWithBiometric(): Promise<Uint8Array> {
  const deviceKey = await keystoreGet();
  if (!deviceKey) throw asAuthError({ kind: "Keystore", message: "device-key missing" });
  const { kek } = await unlockWithDeviceKey(deviceKey);
  return kek;
}
