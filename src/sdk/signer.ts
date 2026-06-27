// Wallet-side signer for the mobile wallet (post-EVM, ML-DSA-65).
//
// The signing primitive is `MlDsa65Backend` from `@monolythium/core-sdk`.
// Native tx submission goes through `buildEncryptedSubmission` (in
// `send.ts`), which takes the backend, builds the inner native tx,
// produces the ML-DSA-65 outer signature, ML-KEM-encrypts the envelope,
// and returns wire-ready hex.
//
// Two backends ship today:
//
//   makeBiometricBackend({ unlock })
//     → MlDsa65Backend that, on every signing call, re-runs the supplied
//       `unlock()` (canonically: biometric prompt → keystore device-key →
//       AES-GCM-decrypt envelope → recovery phrase → ML-DSA-65 backend),
//       and delegates the signing op. The mnemonic and derived seed
//       never escape the call frame — a fresh backend is materialised
//       for exactly the duration of one signing op.
//
//   makeReadOnlyIdentity(address)
//     → IdentityHandle that resolves the bound address for UI display
//       and throws on every signing path. Used by surfaces that only
//       need the wallet's address (e.g. Receive screen, address chips).

import { invoke } from "@tauri-apps/api/core";
import {
  mnemonicToMlDsa65Backend,
  type MlDsa65Backend,
} from "@monolythium/core-sdk/crypto";
import {
  unlockWithDeviceKey,
  unlockWithPassword,
  type VaultPayload,
} from "./vault";

/**
 * Vault-unlock callback. Resolves to the decrypted vault payload on
 * success, throws on biometric cancel / wrong password / missing
 * envelope.
 *
 * Production builds wire this to `unlockViaBiometric` (below); tests
 * inject a function that returns a known payload directly.
 */
export type VaultUnlock = () => Promise<VaultPayload>;

export interface BiometricBackendArgs {
  unlock: VaultUnlock;
}

export interface IdentityHandle {
  /** Internal 20-byte address as hex `0x…`. */
  address: string;
  /** Returns a fresh ML-DSA-65 backend; runs the unlock flow each time. */
  unlockBackend?: () => Promise<MlDsa65Backend>;
}

/**
 * Wrap the vault-unlock flow into a "give me a fresh ML-DSA-65 backend
 * for one signing op" factory. The backend's seed material is sourced
 * from the recovery phrase carried in the decrypted payload; both stay
 * inside this call frame. Callers MUST drop the returned backend after
 * the signing op completes.
 */
export function makeBiometricBackendFactory(
  args: BiometricBackendArgs,
): () => Promise<MlDsa65Backend> {
  return async () => {
    const payload = await args.unlock();
    return mnemonicToMlDsa65Backend(payload.mnemonic);
  };
}

/**
 * Read-only identity handle. The address is the 20-byte hex bound to
 * the unlocked vault; `unlockBackend` is undefined so callers that
 * accidentally try to sign get a typed error rather than a silent fail.
 */
export function makeReadOnlyIdentity(address: string): IdentityHandle {
  return { address };
}

/**
 * Canonical biometric-path unlock. Pulls the device-key from the OS
 * keystore (the keychain plugin gates this on the prior biometric
 * prompt — see `auth.ts:authorizeOperation`) and decrypts the on-disk
 * vault envelope.
 *
 * Throws if the keystore is empty (vault wasn't bootstrapped, or was
 * wiped) or if AES-GCM authentication fails.
 */
export async function unlockViaBiometric(): Promise<VaultPayload> {
  const deviceKeyHex = await invoke<string | null>("keychain_get", {
    key: "wallet.unlock",
  });
  if (!deviceKeyHex) {
    throw new Error("vault device-key missing — re-onboard required");
  }
  const { payload } = await unlockWithDeviceKey(deviceKeyHex);
  return payload;
}

/**
 * Password-path unlock. Mirrors `unlockViaBiometric` for callers that
 * opted out of biometric or are running on a desktop dev host where
 * biometric is unavailable.
 */
export async function unlockViaPassword(password: string): Promise<VaultPayload> {
  const { payload } = await unlockWithPassword(password);
  return payload;
}
