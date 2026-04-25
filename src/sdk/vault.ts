// Stage 4 vault layer — KDF-derived KEK + on-disk encrypted envelope.
//
// Storage layout (per Stage 4 spec in `../plans/mobile-wallet.md`):
//
//   keystore (slot "wallet.unlock"):
//     device-key     — 32 random bytes (hex), biometric-gated by the OS.
//
//   disk (`<app data>/vault.v1.json`):
//     {
//       version: 1,
//       params:  { algo: "argon2id", v: 0x13, t: 2, m: 32768, p: 1, dkLen: 32 },
//       salt:           base64(16 bytes),
//       kekWrapIv:      base64(12 bytes),  // AES-GCM nonce for kekWrap
//       kekWrap:        base64(ciphertext) // AES-GCM(device-key, KEK)
//       payloadIv:      base64(12 bytes),  // AES-GCM nonce for payload
//       payload:        base64(ciphertext) // AES-GCM(KEK, vault payload JSON)
//     }
//
// Three onboarded paths:
//
//   1. Onboarding (`bootstrap`):
//        device-key  := random(32)
//        salt        := random(16)
//        KEK         := argon2id(password, salt, params)
//        kekWrap     := AES-GCM(device-key, KEK)
//        ciphertext  := AES-GCM(KEK, JSON.stringify(payload))
//        keystore.set(device-key); disk.write(envelope)
//
//   2. Biometric unlock (`unlockWithBiometric`):
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
// Argon2id parameters (mobile-friendly per Stage 4 spec):
//   m = 32 MiB (32 * 1024 = 32768 KiB), t = 2, p = 1, dkLen = 32.
//   These are at the lower end of OWASP's recommended range — Tauri webview
//   on older iPhones / mid-tier Android can spike CPU under heavier params.
//   Re-tune in `KDF_PARAMS` if profiling shows headroom.

import { invoke } from "@tauri-apps/api/core";
import { argon2idAsync } from "@noble/hashes/argon2.js";

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

export interface VaultEnvelope {
  version: 1;
  params: KdfParams;
  salt: string; // base64
  kekWrapIv: string; // base64
  kekWrap: string; // base64
  payloadIv: string; // base64
  payload: string; // base64
}

/**
 * Decrypted vault payload. Stage 4 keeps the payload deliberately empty
 * (just a creation marker) — Stage 5 lands seed material + signing keys.
 */
export interface VaultPayload {
  version: 1;
  createdAt: number; // unix seconds
}

// -----------------------------------------------------------------------------
// Tauri command bindings
// -----------------------------------------------------------------------------

interface VaultErrorPayload {
  kind: "Path" | "Io";
  message: string;
}

class VaultIoError extends Error {
  readonly kind: "Path" | "Io";
  constructor(payload: VaultErrorPayload) {
    super(payload.message);
    this.name = "VaultIoError";
    this.kind = payload.kind;
  }
}

function asVaultError(cause: unknown): VaultIoError {
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
    throw asVaultError(cause);
  }
}

async function vaultReadCmd(): Promise<string | null> {
  try {
    return await invoke<string | null>("vault_read");
  } catch (cause) {
    throw asVaultError(cause);
  }
}

async function vaultWriteCmd(contents: string): Promise<void> {
  try {
    await invoke("vault_write", { contents });
  } catch (cause) {
    throw asVaultError(cause);
  }
}

async function vaultDeleteCmd(): Promise<void> {
  try {
    await invoke("vault_delete");
  } catch (cause) {
    throw asVaultError(cause);
  }
}

// -----------------------------------------------------------------------------
// Helpers — base64 (binary-safe), random bytes, AES-GCM via Web Crypto.
// Web Crypto is available in the Tauri 2 webview on every target (WebKit on
// iOS, WebView2 on Windows, WebKitGTK on Linux, Android System WebView).
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
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  // SubtleCrypto requires an ArrayBuffer-backed view; some TS lib variants
  // type Uint8Array as `Uint8Array<ArrayBufferLike>`, so slice into a fresh
  // Uint8Array<ArrayBuffer> to keep the call site type-tight.
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
// Public API consumed by Onboarding + auth.ts.
// -----------------------------------------------------------------------------

/** True iff a vault envelope is on disk. */
export async function vaultExists(): Promise<boolean> {
  return vaultExistsCmd();
}

async function readEnvelope(): Promise<VaultEnvelope | null> {
  const raw = await vaultReadCmd();
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as VaultEnvelope;
  if (parsed.version !== 1) {
    throw new Error(`unsupported vault version: ${parsed.version}`);
  }
  return parsed;
}

async function writeEnvelope(env: VaultEnvelope): Promise<void> {
  await vaultWriteCmd(JSON.stringify(env));
}

/**
 * Fresh-install bootstrap. Generates the device-key + salt, derives the KEK,
 * encrypts a fresh empty payload, and persists everything.
 *
 * Returns the device-key (hex). Caller pushes it to the keystore.
 */
export interface BootstrapResult {
  /** 32-byte device-key, hex-encoded. Caller must `setUnlockSecret(deviceKeyHex)`. */
  deviceKeyHex: string;
  /** The KEK in plain bytes — kept by the caller in memory only, for this session. */
  kek: Uint8Array;
}

export async function bootstrap(password: string): Promise<BootstrapResult> {
  if (!password) throw new Error("password is empty");
  const params = KDF_PARAMS;
  const salt = randomBytes(16);
  const deviceKey = randomBytes(32);

  // Derive the KEK from password + salt.
  const kek = await deriveKek(password, salt, params);

  // Wrap the KEK under the device-key so the biometric path can recover it
  // without the password.
  const kekWrapIv = randomBytes(12);
  const kekWrap = await aesGcmEncrypt(deviceKey, kekWrapIv, kek);

  // Encrypt a fresh payload under the KEK. Stage 4 leaves payload minimal
  // (creation marker only); Stage 5 will land seed material here.
  const payload: VaultPayload = {
    version: 1,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const payloadIv = randomBytes(12);
  const payloadCt = await aesGcmEncrypt(
    kek,
    payloadIv,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const envelope: VaultEnvelope = {
    version: 1,
    params,
    salt: bytesToBase64(salt),
    kekWrapIv: bytesToBase64(kekWrapIv),
    kekWrap: bytesToBase64(kekWrap),
    payloadIv: bytesToBase64(payloadIv),
    payload: bytesToBase64(payloadCt),
  };

  try {
    await writeEnvelope(envelope);
  } catch (cause) {
    // Re-raise with the host-distinguishing flag so onboarding can surface
    // a "demo mode" badge on desktop hosts where the path resolution may
    // fail (no app data dir bundle yet).
    throw cause;
  }

  return { deviceKeyHex: bytesToHex(deviceKey), kek };
}

/**
 * Biometric path: caller has already passed the OS biometric prompt and
 * retrieved the device-key from the keystore. We unwrap the KEK and verify
 * the payload decrypts.
 *
 * Throws if the envelope is missing or AES-GCM authentication fails.
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
 * then attempt to decrypt the payload. AES-GCM authentication acts as the
 * password verification — wrong password = thrown error (no plaintext
 * compare anywhere).
 *
 * Returns the KEK + payload on success; throws on bad password.
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
 * envelope, without surfacing the KEK to the caller.
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
 * Wipe the vault (used by re-onboarding on hard-reset, or by the "delete
 * wallet" affordance in Settings). Caller is responsible for clearing the
 * keystore device-key separately.
 */
export async function wipe(): Promise<void> {
  await vaultDeleteCmd();
}
