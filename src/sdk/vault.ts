// ML-DSA-65 vault layer — KDF-derived KEK + on-disk encrypted envelope, with
// a 24-word BIP-39 recovery phrase as the sealed payload. ML-DSA-65 keys are
// derived from the mnemonic on every unlock — the wallet never holds a
// raw signing key on disk.
//
// Storage layout:
//
//   keystore (slot "wallet.unlock"):
//     device-key     — 32 random bytes (hex), biometric-gated by the OS.
//
//   disk (`<app data>/vault.v2.json`):
//     {
//       version: 2,
//       params:  { algo: "argon2id", v: 0x13, t: 2, m: 32768, p: 1, dkLen: 32 },
//       salt:           base64(16 bytes),
//       kekWrapIv:      base64(12 bytes),
//       kekWrap:        base64(AES-GCM(device-key, KEK)),
//       payloadIv:      base64(12 bytes),
//       payload:        base64(AES-GCM(KEK, JSON.stringify(VaultPayload))),
//       address:        hex(20 bytes)  // plaintext header for boot-time UI
//     }
//
// Three onboarded paths (unchanged from the secp256k1 era):
//
//   1. Onboarding (`bootstrap`):
//        device-key  := random(32)
//        salt        := random(16)
//        mnemonic    := SDK generateMnemonic()
//        KEK         := argon2id(password, salt, params)
//        kekWrap     := AES-GCM(device-key, KEK)
//        ciphertext  := AES-GCM(KEK, JSON.stringify({ mnemonic, address }))
//        keystore.set(device-key); disk.write(envelope)
//
//   2. Biometric unlock (`unlockWithDeviceKey`):
//        biometric prompt (in caller) -> keystore.get() -> device-key
//        envelope    := disk.read()
//        KEK         := AES-GCM-decrypt(device-key, envelope.kekWrap)
//        payload     := AES-GCM-decrypt(KEK, envelope.payload)
//
//   3. Password unlock (`unlockWithPassword`):
//        envelope    := disk.read()
//        KEK         := argon2id(password, envelope.salt, envelope.params)
//        payload     := AES-GCM-decrypt(KEK, envelope.payload)  // throws on bad password
//
// Argon2id parameters (mobile-friendly):
//   m = 32 MiB, t = 2, p = 1, dkLen = 32. Lower end of OWASP's
//   recommended range — Tauri webview on older iPhones / mid-tier
//   Android can spike CPU under heavier params. Re-tune in
//   `KDF_PARAMS` if profiling shows headroom.
//
// Recovery phrases are standard 24-word BIP-39. Import paths validate the
// phrase (24 words + BIP-39 checksum) before deriving — an invalid phrase
// is rejected with a typed error so a user pasting a malformed phrase
// doesn't silently produce a different identity.

import { invoke } from "@tauri-apps/api/core";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import {
  MnemonicError,
  generateMnemonic,
  mnemonicToAddress,
  validateMnemonic,
} from "@monolythium/core-sdk/crypto";
import { normalizeAddressHex } from "@monolythium/core-sdk";

/**
 * Argon2id KDF parameters. Bumping any of these is a vault re-encryption —
 * `params` is persisted in the envelope so an old vault can still be opened
 * with its original parameters.
 */
export interface KdfParams {
  algo: "argon2id";
  /** Argon2 algorithm version. RFC 9106 = 0x13. */
  v: number;
  /** Iterations. */
  t: number;
  /** Memory cost in KiB. */
  m: number;
  /** Parallelism. */
  p: number;
  /** Output length in bytes. */
  dkLen: number;
}

/** Default Argon2id params for new vaults. Mobile-friendly. */
export const KDF_PARAMS: KdfParams = {
  algo: "argon2id",
  v: 0x13,
  t: 2,
  m: 32 * 1024, // 32 MiB
  p: 1,
  dkLen: 32,
};

/** Current vault envelope version. v2 = BIP-39 mnemonic payload. */
export const VAULT_VERSION = 2;

export interface VaultEnvelope {
  version: 2;
  params: KdfParams;
  salt: string; // base64
  kekWrapIv: string; // base64
  kekWrap: string; // base64
  payloadIv: string; // base64
  payload: string; // base64
  /**
   * Internal 20-byte address derived from the recovery phrase, hex-encoded
   * with `0x` prefix. Surfaced in plaintext so the UI can render the
   * typed `mono1…` identity without triggering a biometric prompt at app
   * boot. The address bytes are public information; the mnemonic stays
   * inside `payload`.
   */
  address: string;
}

/**
 * Decrypted vault payload. The 24-word recovery phrase sits inside the
 * AES-GCM-sealed payload, never in the clear and never in the keystore —
 * only an unlock flow that derives the right KEK can reveal it. The
 * ML-DSA-65 backend is materialised on demand from the mnemonic and
 * never persisted.
 */
export interface VaultPayload {
  version: 2;
  createdAt: number; // unix seconds
  /** 24-word BIP-39 recovery phrase (ML-DSA-65 seed source). */
  mnemonic: string;
  /** Internal 20-byte address (hex with `0x` prefix). */
  address: string;
}

// -----------------------------------------------------------------------------
// Tauri command bindings
// -----------------------------------------------------------------------------

interface VaultErrorPayload {
  kind: "Path" | "Io";
  message: string;
}

export class VaultIoError extends Error {
  readonly kind: "Path" | "Io";
  constructor(payload: VaultErrorPayload) {
    super(payload.message);
    this.name = "VaultIoError";
    this.kind = payload.kind;
  }
}

/**
 * Mnemonic rejection at the vault layer. Surfaces a clear "this is not a
 * valid recovery phrase" error so a user pasting a malformed or truncated
 * phrase doesn't silently produce a different identity. Maps onto the
 * SDK's `MnemonicError` causes.
 */
export class VaultMnemonicError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "VaultMnemonicError";
    if (cause !== undefined) this.cause = cause;
  }
}

function asVaultIoError(cause: unknown): VaultIoError {
  if (cause && typeof cause === "object" && "kind" in cause) {
    const c = cause as { kind?: string; message?: string };
    return new VaultIoError({
      kind: (c.kind as "Path" | "Io") ?? "Io",
      message: c.message ?? String(cause),
    });
  }
  return new VaultIoError({
    kind: "Io",
    message: (cause as Error)?.message ?? String(cause),
  });
}

async function vaultExistsCmd(): Promise<boolean> {
  try {
    return await invoke<boolean>("vault_exists");
  } catch (cause) {
    throw asVaultIoError(cause);
  }
}

async function vaultReadCmd(): Promise<string | null> {
  try {
    return await invoke<string | null>("vault_read");
  } catch (cause) {
    throw asVaultIoError(cause);
  }
}

async function vaultWriteCmd(contents: string): Promise<void> {
  try {
    await invoke("vault_write", { contents });
  } catch (cause) {
    throw asVaultIoError(cause);
  }
}

async function vaultDeleteCmd(): Promise<void> {
  try {
    await invoke("vault_delete");
  } catch (cause) {
    throw asVaultIoError(cause);
  }
}

// -----------------------------------------------------------------------------
// Helpers — base64 (binary-safe), random bytes, AES-GCM via Web Crypto.
// Web Crypto is available in the Tauri 2 webview on every target.
// -----------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let h = "";
  for (let i = 0; i < bytes.length; i++) h += bytes[i]!.toString(16).padStart(2, "0");
  return h;
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.substr(i * 2, 2), 16);
  }
  return out;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  const buf = new Uint8Array(raw.byteLength);
  buf.set(raw);
  return crypto.subtle.importKey("raw", buf, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes);
  const ivBuf = new Uint8Array(iv.byteLength);
  ivBuf.set(iv);
  const ptBuf = new Uint8Array(plaintext.byteLength);
  ptBuf.set(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, key, ptBuf);
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes);
  const ivBuf = new Uint8Array(iv.byteLength);
  ivBuf.set(iv);
  const ctBuf = new Uint8Array(ciphertext.byteLength);
  ctBuf.set(ciphertext);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key, ctBuf);
  return new Uint8Array(pt);
}

async function deriveKek(password: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
  if (params.algo !== "argon2id") {
    throw new Error(`unsupported KDF algo: ${params.algo}`);
  }
  return argon2idAsync(password, salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    version: params.v,
    dkLen: params.dkLen,
  });
}

// -----------------------------------------------------------------------------
// Mnemonic → address
// -----------------------------------------------------------------------------

/**
 * Derive the internal 20-byte address (hex with `0x` prefix) from a
 * 24-word BIP-39 recovery phrase. Throws `VaultMnemonicError` if the
 * phrase is not a valid 24-word BIP-39 mnemonic — wallets MUST refuse to
 * silently accept a malformed or truncated seed.
 */
export function addressHexFromMnemonic(mnemonic: string): string {
  // validateMnemonic enforces 24 words + the BIP-39 checksum; reject
  // before deriving so the UI gets a typed "this isn't a valid recovery
  // phrase" surface rather than a silent different identity.
  if (!validateMnemonic(mnemonic)) {
    throw new VaultMnemonicError(
      "recovery phrase is not a valid 24-word BIP-39 phrase",
    );
  }
  // mnemonicToAddress returns an already-normalized `0x...` 20-byte hex
  // string (MlDsa65Backend.getAddress() → bytesToHex). Run it through
  // normalizeAddressHex to lower-case + length-check it.
  try {
    return normalizeAddressHex(mnemonicToAddress(mnemonic));
  } catch (cause) {
    if (cause instanceof MnemonicError) {
      throw new VaultMnemonicError(
        `recovery phrase is not valid: ${cause.message}`,
        cause,
      );
    }
    throw cause;
  }
}

// -----------------------------------------------------------------------------
// Public API consumed by Onboarding + auth.ts.
// -----------------------------------------------------------------------------

/** True iff a vault envelope is on disk. */
export async function vaultExists(): Promise<boolean> {
  return vaultExistsCmd();
}

/**
 * Internal 20-byte address bound to the vault (hex `0x...`), read from
 * the envelope's plaintext header. Returns `null` if the vault hasn't
 * been bootstrapped. No biometric prompt, no decryption — public UI
 * converts this to typed `mono1…` via `addressToTypedBech32("user", …)`.
 */
export async function vaultBoundAddress(): Promise<string | null> {
  const env = await readEnvelope();
  if (!env) return null;
  return typeof env.address === "string" ? env.address : null;
}

async function readEnvelope(): Promise<VaultEnvelope | null> {
  const raw = await vaultReadCmd();
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as VaultEnvelope;
  if (parsed.version !== VAULT_VERSION) {
    throw new VaultIoError({
      kind: "Io",
      message: `unsupported vault version: ${parsed.version} (expected ${VAULT_VERSION})`,
    });
  }
  return parsed;
}

async function writeEnvelope(env: VaultEnvelope): Promise<void> {
  await vaultWriteCmd(JSON.stringify(env));
}

/**
 * Fresh-install bootstrap. Generates the device-key + salt, derives the
 * KEK, mints a brand-new BIP-39 recovery phrase, seals it under the KEK,
 * and persists everything.
 *
 * Returns the mnemonic so onboarding can show + verify it before the user
 * lands on the wallet. The caller must `setUnlockSecret(deviceKeyHex)` so
 * the biometric unlock path can recover the KEK.
 */
export interface BootstrapResult {
  /** 32-byte device-key, hex-encoded. Caller pushes to keystore. */
  deviceKeyHex: string;
  /** The KEK in plain bytes — kept by the caller in memory only, for this session. */
  kek: Uint8Array;
  /** The freshly-generated 24-word recovery phrase to be shown + verified. */
  mnemonic: string;
  /** Internal 20-byte address (hex `0x…`) derived from the mnemonic. */
  address: string;
}

export interface BootstrapOptions {
  /** Inject a known mnemonic (Import wallet flow). Defaults to a fresh one. */
  importMnemonic?: string;
}

export async function bootstrap(
  password: string,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  if (!password) throw new Error("password is empty");

  const mnemonic = options.importMnemonic
    ? options.importMnemonic.trim()
    : generateMnemonic();

  // Address derivation also validates the phrase (24 words + BIP-39
  // checksum). Import paths surface VaultMnemonicError to the UI so a user
  // pasting a malformed phrase gets a precise "not a valid recovery
  // phrase" hint.
  const address = addressHexFromMnemonic(mnemonic);

  const params = KDF_PARAMS;
  const salt = randomBytes(16);
  const deviceKey = randomBytes(32);

  const kek = await deriveKek(password, salt, params);

  const kekWrapIv = randomBytes(12);
  const kekWrap = await aesGcmEncrypt(deviceKey, kekWrapIv, kek);

  const payload: VaultPayload = {
    version: VAULT_VERSION,
    createdAt: Math.floor(Date.now() / 1000),
    mnemonic,
    address,
  };
  const payloadIv = randomBytes(12);
  const payloadCt = await aesGcmEncrypt(
    kek,
    payloadIv,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const envelope: VaultEnvelope = {
    version: VAULT_VERSION,
    params,
    salt: bytesToBase64(salt),
    kekWrapIv: bytesToBase64(kekWrapIv),
    kekWrap: bytesToBase64(kekWrap),
    payloadIv: bytesToBase64(payloadIv),
    payload: bytesToBase64(payloadCt),
    address,
  };

  await writeEnvelope(envelope);

  return {
    deviceKeyHex: bytesToHex(deviceKey),
    kek,
    mnemonic,
    address,
  };
}

/**
 * Biometric path: caller has already passed the OS biometric prompt and
 * retrieved the device-key from the keystore. Unwrap the KEK, decrypt the
 * payload. AES-GCM authentication acts as integrity verification.
 */
export async function unlockWithDeviceKey(deviceKeyHex: string): Promise<{
  kek: Uint8Array;
  payload: VaultPayload;
}> {
  const env = await readEnvelope();
  if (!env) throw new Error("vault not initialized");
  const deviceKey = hexToBytes(deviceKeyHex);
  const kek = await aesGcmDecrypt(
    deviceKey,
    base64ToBytes(env.kekWrapIv),
    base64ToBytes(env.kekWrap),
  );
  const payloadBytes = await aesGcmDecrypt(
    kek,
    base64ToBytes(env.payloadIv),
    base64ToBytes(env.payload),
  );
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as VaultPayload;
  return { kek, payload };
}

/**
 * Password path: derive the KEK from the entered password + on-disk salt,
 * then attempt to decrypt the payload. AES-GCM authentication acts as
 * password verification — wrong password = thrown error (no plaintext
 * compare anywhere).
 */
export async function unlockWithPassword(password: string): Promise<{
  kek: Uint8Array;
  payload: VaultPayload;
}> {
  const env = await readEnvelope();
  if (!env) throw new Error("vault not initialized");
  const salt = base64ToBytes(env.salt);
  const kek = await deriveKek(password, salt, env.params);
  const payloadBytes = await aesGcmDecrypt(
    kek,
    base64ToBytes(env.payloadIv),
    base64ToBytes(env.payload),
  );
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as VaultPayload;
  return { kek, payload };
}

/**
 * Fast password verification — returns true iff the password decrypts the
 * envelope. Does not surface the KEK to the caller.
 */
export async function verifyPasswordAgainstVault(password: string): Promise<boolean> {
  try {
    await unlockWithPassword(password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wipe the vault (re-onboarding hard-reset, "delete wallet" affordance in
 * Settings, "I don't know my phrase" recovery). Caller is responsible
 * for clearing the keystore device-key separately.
 */
export async function wipe(): Promise<void> {
  await vaultDeleteCmd();
}
