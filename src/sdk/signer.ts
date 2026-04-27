// Wallet-side signer factory for the mobile wallet.
//
// `@monolythium/core-sdk` ships an ethers v6 compat shim
// (`MonolythiumSigner` extending `AbstractSigner`). This module wires the
// wallet's biometric+vault auth path into that shim so the
// OperationsDrawer can flow a "send LYTH" through the canonical ethers
// Signer surface (`signTransaction` + `provider.broadcastTransaction`)
// without the page code knowing anything about how the key gets recovered.
//
// Two backends ship today:
//
//   makeBiometricSigner({ unlock, address })
//     → MonolythiumSigner that, on every signing call, re-runs the
//       supplied `unlock()` (canonically: biometric prompt → keystore
//       device-key → AES-GCM-decrypt envelope → payload), reads the
//       secp256k1 private key carried inside the AES-GCM-sealed payload,
//       and uses an ephemeral `ethers.Wallet` to produce the signature.
//       The key never leaves the call frame — `signTransaction`
//       constructs an ephemeral wallet for exactly the duration of one
//       signing op.
//
//   makeReadOnlySigner(address)
//     → MonolythiumSigner that resolves `getAddress()` and throws on
//       every signing path. Used by ethers callers that only need the
//       address (e.g. `provider.getBalance(signer.address)`).
//
// Sibling design: desktop-wallet ships a Ledger backend over the same
// `MonolythiumSignerBackend` interface (`makeLedgerSigner`); mobile has
// no Ledger HID surface so the biometric+vault path is the only signing
// route. The wire shape is identical so the OperationsDrawer / send
// composer code stays portable across surfaces.

import { invoke } from "@tauri-apps/api/core";
import {
  MonolythiumSigner,
  type MonolythiumSignerBackend,
} from "@monolythium/core-sdk";
import {
  Wallet,
  type Provider,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
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

interface BiometricSignerArgs {
  /** Resolves to the decrypted vault payload — see `VaultUnlock`. */
  unlock: VaultUnlock;
  /** EIP-55 lowercase address the vault payload was bootstrapped to. */
  address: string;
  provider?: Provider | null;
}

/**
 * Build an ethers v6 `Signer` backed by the biometric+vault auth path.
 *
 * Each signing call:
 *   1. invokes `unlock()` → returns the decrypted vault payload;
 *   2. builds a transient `ethers.Wallet` from the secp256k1 key in the
 *      payload;
 *   3. delegates the signing op to the wallet;
 *   4. drops the wallet on the next event-loop turn — there is no module
 *      state holding key material between calls.
 */
export function makeBiometricSigner(args: BiometricSignerArgs): MonolythiumSigner {
  const { unlock, address, provider } = args;
  const backend: MonolythiumSignerBackend = {
    getAddress: async () => address,
    signTransaction: async (tx: TransactionRequest) => {
      const wallet = await unlockEphemeralWallet(unlock);
      return wallet.signTransaction(tx);
    },
    signMessage: async (message: string | Uint8Array) => {
      const wallet = await unlockEphemeralWallet(unlock);
      return wallet.signMessage(message);
    },
    signTypedData: async (
      domain: TypedDataDomain,
      types: Record<string, Array<TypedDataField>>,
      value: Record<string, unknown>,
    ) => {
      const wallet = await unlockEphemeralWallet(unlock);
      return wallet.signTypedData(domain, types, value);
    },
  };
  return new MonolythiumSigner(backend, provider ?? null);
}

/**
 * Build a read-only `Signer`. Returns `address` from `getAddress()` and
 * throws on every signing path.
 */
export function makeReadOnlySigner(
  address: string,
  provider?: Provider | null,
): MonolythiumSigner {
  const backend: MonolythiumSignerBackend = {
    getAddress: async () => address,
    signTransaction: async () => {
      throw new Error("read-only signer cannot sign transactions");
    },
    signMessage: async () => {
      throw new Error("read-only signer cannot sign messages");
    },
    signTypedData: async () => {
      throw new Error("read-only signer cannot sign typed data");
    },
  };
  return new MonolythiumSigner(backend, provider ?? null);
}

/**
 * Canonical biometric-path unlock. Pulls the device-key from the OS
 * keystore (the keychain plugin gates this on the prior biometric
 * prompt — see `auth.ts:authorizeOperation`) and decrypts the on-disk
 * vault envelope.
 *
 * Throws if the keystore is empty (vault wasn't bootstrapped, or was
 * wiped) or if AES-GCM authentication fails (envelope was tampered with
 * or device-key drifted from the on-disk wrap).
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

async function unlockEphemeralWallet(unlock: VaultUnlock): Promise<Wallet> {
  const payload = await unlock();
  // The payload's `secp256k1Priv` is the unprefixed hex; ethers' `Wallet`
  // constructor accepts both `0x`-prefixed and bare hex but we normalize
  // for clarity at the call site.
  return new Wallet(`0x${payload.secp256k1Priv}`);
}
