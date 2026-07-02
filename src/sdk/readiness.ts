import * as monolythiumCoreSdk from "@monolythium/core-sdk";
import {
  LYTHOSHI_PER_LYTH,
  ML_DSA_65_PUBLIC_KEY_LEN,
  MONOLYTHIUM_TESTNET_CHAIN_ID,
  MONOLYTHIUM_TESTNET_NETWORK_NAME,
  NATIVE_LYTH_DECIMALS,
  verifyNoEvmArchiveProofSignatures,
  type NoEvmArchiveProof as SdkNoEvmArchiveProof,
  type NoEvmArchiveSignatureVerification,
  type NoEvmArchiveTrustedSigner,
} from "@monolythium/core-sdk";
import { getProvider, type ChainStatus } from "./client";

export type ReadinessState = "ready" | "blocked";

export interface ReadinessItem {
  key: "network" | "native-fee" | "receipt-proof" | "mrv";
  label: string;
  value: string;
  state: ReadinessState;
  detail: string;
}

export interface WalletReadiness {
  state: ReadinessState;
  sampledAtBlock: bigint | null;
  items: ReadinessItem[];
  error: string | null;
}

interface NativeModuleForwarderDescriptor {
  module: string;
  requestBytes: number;
  contractAddress: string;
  artifactProfile: string;
  status: string;
  deploymentVerified: boolean;
}

interface NativeCapabilitiesResponse {
  blockNumber: bigint;
  nativeModuleForwarders?: Record<string, NativeModuleForwarderDescriptor[] | undefined>;
}

const MRV_PROFILE_MONO_RV32IM_V1 = "mono_rv32im_v1";
const MRV_TX_EXTENSION_KIND = 0x30;
const NO_EVM_RECEIPT_PROOF_SCHEMA = "mono.no_evm_receipt_proof.v1";
const NO_EVM_COMPACT_INCLUSION_PROOF_SCHEMA =
  "mono.no_evm_receipt_compact_inclusion.v1";
const NO_EVM_ARCHIVE_PROOF_SCHEMA = "mono.no_evm_receipt_archive_binding.v1";
const NO_EVM_ARCHIVE_PROOF_SOURCE = "indexerReceiptArchiveContentDigest";
const NO_EVM_RECEIPT_CODEC = "bincode(protocore_evm::Receipt)";
const NO_EVM_RECEIPT_ROOT_DOMAIN = "monolythium/v4.1/receipts_root_empty/1";
const MIN_NATIVE_FEE_LYTHOSHI = LYTHOSHI_PER_LYTH / 10_000n;
// The registry helper is keyed by the chain-registry slug, not the ethers network name.
const NO_EVM_RECEIPT_TRUST_REGISTRY_NETWORK = "testnet-69420";

export interface NoEvmArchiveProofMaterial {
  schema: unknown;
  source: unknown;
  manifestHash: unknown;
  contentHash: unknown;
  signatureDigest?: unknown;
  signatures: unknown;
  coveringSnapshot?: unknown;
}

export interface NoEvmArchiveCoveringSnapshotMaterial {
  snapshotHeight: unknown;
  manifestHash: unknown;
  signatureDigest: unknown;
  contentHash: unknown;
  checkpointContentHash: unknown;
  checkpointFrom: unknown;
  checkpointTo: unknown;
  signatures: unknown;
}

interface SupportedNoEvmArchiveCoveringSnapshot {
  snapshotHeight: number;
  manifestHash: string;
  signatureDigest: string;
  contentHash: string;
  checkpointContentHash: string;
  checkpointFrom: number;
  checkpointTo: number;
  signatures: string[];
}

type SupportedNoEvmArchiveProof = SdkNoEvmArchiveProof & {
  schema: typeof NO_EVM_ARCHIVE_PROOF_SCHEMA;
  source: typeof NO_EVM_ARCHIVE_PROOF_SOURCE;
  manifestHash: string;
  contentHash: string;
  signatureDigest?: string | null;
  signatures: string[];
  coveringSnapshot?: SupportedNoEvmArchiveCoveringSnapshot | null;
};

type NoEvmArchiveTrustedPublicKey = string | Uint8Array | readonly number[];

export interface NoEvmArchiveTrustConfig {
  trustedPublicKeys: string | readonly NoEvmArchiveTrustedPublicKey[];
  threshold: number | string;
}

interface RegistryNoEvmArchiveTrustedSigner {
  publicKey: string | Uint8Array | readonly number[];
  signerId?: string;
  validFromHeight?: number | bigint;
  validToHeight?: number | bigint;
}

interface RegistryNoEvmReceiptTrustPolicy {
  chainId?: number | bigint;
  archive?: {
    trustedSigners: readonly RegistryNoEvmArchiveTrustedSigner[];
    threshold: number;
    validFromHeight?: number | bigint;
    validToHeight?: number | bigint;
  };
}

interface RegistryNoEvmReceiptTrustLookup {
  getNoEvmReceiptTrustPolicy?: (
    network: string,
  ) => RegistryNoEvmReceiptTrustPolicy | null;
}

export type NoEvmArchiveTrustConfigResolution =
  | { state: "unconfigured"; detail: string }
  | {
    state: "configured";
    config: {
      trustedSigners: NoEvmArchiveTrustedSigner[];
      threshold: number;
    };
  }
  | { state: "blocked"; detail: string };

export interface WalletReadinessOptions {
  archiveProof?: unknown;
  archiveTrust?: NoEvmArchiveTrustConfig | NoEvmArchiveTrustConfigResolution | null;
}

const SUPPORTED_INDEXER_ARCHIVE_PROOF: NoEvmArchiveProofMaterial = {
  schema: NO_EVM_ARCHIVE_PROOF_SCHEMA,
  source: NO_EVM_ARCHIVE_PROOF_SOURCE,
  manifestHash: `0x${"00".repeat(32)}`,
  contentHash: `0x${"00".repeat(32)}`,
  signatures: [],
};

export async function loadWalletReadiness(
  status: ChainStatus,
  options: WalletReadinessOptions = {},
): Promise<WalletReadiness> {
  const readinessOptions = withDefaultTrustConfig(options);
  try {
    const capabilities = await getProvider().rpcClient.lythCapabilities(
      "latest",
    ) as unknown as NativeCapabilitiesResponse;
    return buildWalletReadiness(status, capabilities, null, readinessOptions);
  } catch (cause) {
    return buildWalletReadiness(
      status,
      null,
      (cause as Error)?.message ?? "native capability probe failed",
      readinessOptions,
    );
  }
}

export function buildOfflineWalletReadiness(message: string): WalletReadiness {
  const readinessOptions = withDefaultTrustConfig({});
  return {
    state: "blocked",
    sampledAtBlock: null,
    error: message,
    items: [
      networkItem(null),
      nativeFeeItem(),
      receiptProofItem(readinessOptions),
      mrvItem(null),
    ],
  };
}

export function buildWalletReadiness(
  status: ChainStatus,
  capabilities: NativeCapabilitiesResponse | null,
  error: string | null,
  options: WalletReadinessOptions = {},
): WalletReadiness {
  const readinessOptions = withDefaultTrustConfig(options);
  const items = [
    networkItem(status.chainId),
    nativeFeeItem(),
    receiptProofItem(readinessOptions),
    mrvItem(capabilities),
  ];
  const state = error === null && items.every((item) => item.state === "ready")
    ? "ready"
    : "blocked";
  return {
    state,
    sampledAtBlock: capabilities?.blockNumber ?? null,
    items,
    error,
  };
}

export function noEvmArchiveTrustConfigFromEnv(
  env: Record<string, unknown> = import.meta.env,
): NoEvmArchiveTrustConfigResolution {
  const raw = {
    trustedPublicKeys: env.VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS,
    threshold: env.VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD,
  };
  const values = Object.values(raw).map(readEnvString);
  const configuredCount = values.filter((value) => value !== undefined).length;
  if (configuredCount === 0) {
    return {
      state: "unconfigured",
      detail: "trusted archive signer config absent",
    };
  }
  if (configuredCount !== values.length) {
    return {
      state: "blocked",
      detail:
        "incomplete archive signer trust config; set VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS " +
        "and VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD",
    };
  }
  return resolveNoEvmArchiveTrustConfig({
    trustedPublicKeys: values[0]!,
    threshold: values[1]!,
  });
}

function noEvmArchiveTrustConfigFromRegistry(
  policy: RegistryNoEvmReceiptTrustPolicy | null = bundledNoEvmReceiptTrustPolicy(),
): NoEvmArchiveTrustConfigResolution {
  const archive = policy?.archive;
  if (archive == null) {
    return {
      state: "unconfigured",
      detail: "registry archive signer policy absent",
    };
  }
  const threshold = parsePositiveSafeInteger(archive.threshold, "registry archive threshold");
  if (threshold.state === "blocked") return threshold;
  const archiveValidFrom = parseOptionalRegistryBound(
    archive.validFromHeight,
    "registry archive validFromHeight",
  );
  if (archiveValidFrom.state === "blocked") return archiveValidFrom;
  const archiveValidTo = parseOptionalRegistryBound(
    archive.validToHeight,
    "registry archive validToHeight",
  );
  if (archiveValidTo.state === "blocked") return archiveValidTo;
  if (archiveValidFrom.value !== undefined || archiveValidTo.value !== undefined) {
    return {
      state: "blocked",
      detail:
        "registry archive signer policy has height bounds, but mobile readiness " +
        "has no receipt block-height context",
    };
  }
  if (archive.trustedSigners.length === 0) {
    return {
      state: "blocked",
      detail: "registry archive signer policy must include at least one signer",
    };
  }
  if (threshold.value > archive.trustedSigners.length) {
    return {
      state: "blocked",
      detail:
        `registry archive threshold ${threshold.value.toString()} exceeds signer count ` +
        archive.trustedSigners.length.toString(),
    };
  }

  const trustedSigners: NoEvmArchiveTrustedSigner[] = [];
  for (const [index, signer] of archive.trustedSigners.entries()) {
    const publicKey = parseArchivePublicKey(
      signer.publicKey,
      `registry archive trustedSigners[${index.toString()}].publicKey`,
    );
    if (publicKey.state === "blocked") return publicKey;
    const signerValidFrom = parseOptionalRegistryBound(
      signer.validFromHeight,
      `registry archive trustedSigners[${index.toString()}].validFromHeight`,
    );
    if (signerValidFrom.state === "blocked") return signerValidFrom;
    const signerValidTo = parseOptionalRegistryBound(
      signer.validToHeight,
      `registry archive trustedSigners[${index.toString()}].validToHeight`,
    );
    if (signerValidTo.state === "blocked") return signerValidTo;
    if (signerValidFrom.value !== undefined || signerValidTo.value !== undefined) {
      return {
        state: "blocked",
        detail:
          `registry archive trustedSigners[${index.toString()}] has height bounds, ` +
          "but mobile readiness has no receipt block-height context",
      };
    }
    trustedSigners.push({
      ...signer,
      publicKey: publicKey.value,
    });
  }

  return {
    state: "configured",
    config: {
      trustedSigners,
      threshold: threshold.value,
    },
  };
}

export function resolveNoEvmArchiveTrustConfig(
  archiveTrust: NoEvmArchiveTrustConfig | NoEvmArchiveTrustConfigResolution | null | undefined,
): NoEvmArchiveTrustConfigResolution {
  if (archiveTrust == null) {
    return {
      state: "unconfigured",
      detail: "trusted archive signer config absent",
    };
  }
  if (isArchiveTrustConfigResolution(archiveTrust)) return archiveTrust;

  const trustedSigners = parseArchiveTrustedPublicKeys(
    archiveTrust.trustedPublicKeys,
    "trustedPublicKeys",
  );
  if (trustedSigners.state === "blocked") return trustedSigners;
  const threshold = parsePositiveSafeInteger(archiveTrust.threshold, "threshold");
  if (threshold.state === "blocked") return threshold;
  if (threshold.value > trustedSigners.value.length) {
    return {
      state: "blocked",
      detail:
        `threshold ${threshold.value.toString()} exceeds trusted archive signer count ` +
        trustedSigners.value.length.toString(),
    };
  }

  return {
    state: "configured",
    config: {
      trustedSigners: trustedSigners.value,
      threshold: threshold.value,
    },
  };
}

function networkItem(chainId: bigint | null): ReadinessItem {
  const ready = chainId === MONOLYTHIUM_TESTNET_CHAIN_ID;
  return {
    key: "network",
    label: "Network",
    value: ready
      ? `${MONOLYTHIUM_TESTNET_NETWORK_NAME} (${chainId.toString()})`
      : "not verified",
    state: ready ? "ready" : "blocked",
    detail: `Expected chain ${MONOLYTHIUM_TESTNET_CHAIN_ID.toString()}.`,
  };
}

function nativeFeeItem(): ReadinessItem {
  return {
    key: "native-fee",
    label: "Native fee",
    value: formatNativeLyth(MIN_NATIVE_FEE_LYTHOSHI),
    state: "ready",
    detail: `${NATIVE_LYTH_DECIMALS} decimal LYTH display backed by native precision.`,
  };
}

function receiptProofItem(options: WalletReadinessOptions): ReadinessItem {
  const archiveProofSupplied = "archiveProof" in options;
  const archiveProof = archiveProofSupplied
    ? options.archiveProof
    : SUPPORTED_INDEXER_ARCHIVE_PROOF;
  const archive = assessNoEvmArchiveMaterial(
    archiveProof,
    archiveProofSupplied ? options.archiveTrust : null,
  );
  const ready =
    NO_EVM_RECEIPT_PROOF_SCHEMA === "mono.no_evm_receipt_proof.v1" &&
    NO_EVM_COMPACT_INCLUSION_PROOF_SCHEMA ===
      "mono.no_evm_receipt_compact_inclusion.v1" &&
    NO_EVM_RECEIPT_CODEC.length > 0 &&
    NO_EVM_RECEIPT_ROOT_DOMAIN.includes("monolythium/v4.1") &&
    acceptsNoEvmCompactReceiptProofSource("liveBlockCache", null) &&
    acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      archiveProof,
      archiveProofSupplied ? options.archiveTrust : null,
    ) &&
    archive.accepted;
  return {
    key: "receipt-proof",
    label: "Receipt proofs",
    value: receiptProofValue(ready, archive.walletVerified),
    state: ready ? "ready" : "blocked",
    detail: [
      "Compact inclusion from live cache or indexer archive",
      archive.detail,
    ].join("; "),
  };
}

export function acceptsNoEvmCompactReceiptProofSource(
  historySource: unknown,
  archiveProof: unknown,
  archiveTrust?: NoEvmArchiveTrustConfig | NoEvmArchiveTrustConfigResolution | null,
): boolean {
  if (historySource === "liveBlockCache") return archiveProof == null;
  if (historySource !== "indexerReceiptArchive") return false;
  return assessNoEvmArchiveMaterial(archiveProof, archiveTrust).accepted;
}

export function describeNoEvmArchiveMaterial(
  archiveProof: unknown,
  archiveTrust?: NoEvmArchiveTrustConfig | NoEvmArchiveTrustConfigResolution | null,
): string {
  return assessNoEvmArchiveMaterial(archiveProof, archiveTrust).detail;
}

function assessNoEvmArchiveMaterial(
  archiveProof: unknown,
  archiveTrust?: NoEvmArchiveTrustConfig | NoEvmArchiveTrustConfigResolution | null,
): {
  accepted: boolean;
  walletVerified: boolean;
  detail: string;
} {
  const trust = resolveNoEvmArchiveTrustConfig(archiveTrust);
  if (archiveProof == null) {
    return {
      accepted: trust.state !== "blocked",
      walletVerified: false,
      detail: trust.state === "blocked"
        ? `archive binding absent; wallet verification blocked: ${trust.detail}`
        : "archive binding absent",
    };
  }
  if (!isSupportedArchiveProofMaterial(archiveProof)) {
    return {
      accepted: false,
      walletVerified: false,
      detail: "unsupported archive binding; not wallet-verified; not validator finality",
    };
  }

  const parsed = describeParsedNoEvmArchiveMaterial(archiveProof);
  if (trust.state === "unconfigured") {
    return {
      accepted: true,
      walletVerified: false,
      detail:
        `${parsed}; archive proof parsed; not wallet-verified (${trust.detail}); ` +
        "not validator finality",
    };
  }
  if (trust.state === "blocked") {
    return {
      accepted: false,
      walletVerified: false,
      detail: `${parsed}; wallet verification blocked: ${trust.detail}; not validator finality`,
    };
  }

  let verification: NoEvmArchiveSignatureVerification;
  try {
    verification = verifyNoEvmArchiveProofSignatures(
      archiveProofForSdkVerification(archiveProof),
      trust.config.trustedSigners,
      trust.config.threshold,
    );
  } catch (cause) {
    return {
      accepted: false,
      walletVerified: false,
      detail:
        `${parsed}; wallet verification blocked: ` +
        `${formatArchiveVerificationErrorMessage(cause)}; not validator finality`,
    };
  }

  const material = archiveSignatureMaterialLabel(archiveProof);
  if (verification.verified) {
    return {
      accepted: true,
      walletVerified: true,
      detail:
        `${parsed}; wallet-verified ML-DSA archive threshold ` +
        `${verification.validSigners.length.toString()}/${verification.threshold.toString()} ` +
        `via ${material}; not validator finality`,
    };
  }

  return {
    accepted: false,
    walletVerified: false,
    detail:
      `${parsed}; wallet verification mismatch: ` +
      `${describeArchiveSignatureMismatch(verification)}; not validator finality`,
  };
}

function describeParsedNoEvmArchiveMaterial(
  archiveProof: SupportedNoEvmArchiveProof,
): string {
  const signatureCount = archiveProof.signatures.length;
  const signatureDetail = signatureCount === 0
    ? "signature records absent"
    : `${signatureCount} exact-height archive signature ` +
      `record${signatureCount === 1 ? "" : "s"} parsed`;
  const coveringSnapshotDetail = archiveProof.coveringSnapshot == null
    ? null
    : `${archiveProof.coveringSnapshot.signatures.length.toString()} covering snapshot signature ` +
      `record${archiveProof.coveringSnapshot.signatures.length === 1 ? "" : "s"} parsed`;
  return [
    `archive binding ${NO_EVM_ARCHIVE_PROOF_SCHEMA}`,
    `content digest ${NO_EVM_ARCHIVE_PROOF_SOURCE}`,
    signatureDetail,
    coveringSnapshotDetail,
  ].filter((detail): detail is string => detail !== null).join("; ");
}

function isSupportedArchiveProofMaterial(
  archiveProof: unknown,
): archiveProof is SupportedNoEvmArchiveProof {
  if (!isRecord(archiveProof)) return false;
  return (
    archiveProof.schema === NO_EVM_ARCHIVE_PROOF_SCHEMA &&
    archiveProof.source === NO_EVM_ARCHIVE_PROOF_SOURCE &&
    isHexHash(archiveProof.manifestHash) &&
    isHexHash(archiveProof.contentHash) &&
    (archiveProof.signatureDigest == null || isHexHash(archiveProof.signatureDigest)) &&
    Array.isArray(archiveProof.signatures) &&
    archiveProof.signatures.every(isSnapshotSignature) &&
    isSupportedArchiveCoveringSnapshot(
      archiveProof.coveringSnapshot,
      archiveProof.contentHash,
    )
  );
}

function isSupportedArchiveCoveringSnapshot(
  coveringSnapshot: unknown,
  archiveContentHash: string,
): coveringSnapshot is {
  snapshotHeight: number;
  manifestHash: string;
  signatureDigest: string;
  contentHash: string;
  checkpointContentHash: string;
  checkpointFrom: number;
  checkpointTo: number;
  signatures: string[];
} | null | undefined {
  if (coveringSnapshot == null) return true;
  if (!isRecord(coveringSnapshot)) return false;
  return (
    isNonNegativeSafeInteger(coveringSnapshot.snapshotHeight) &&
    isNonNegativeSafeInteger(coveringSnapshot.checkpointFrom) &&
    isNonNegativeSafeInteger(coveringSnapshot.checkpointTo) &&
    coveringSnapshot.checkpointFrom === 0 &&
    coveringSnapshot.checkpointTo <= coveringSnapshot.snapshotHeight &&
    isHexHash(coveringSnapshot.manifestHash) &&
    isHexHash(coveringSnapshot.signatureDigest) &&
    isHexHash(coveringSnapshot.contentHash) &&
    isHexHash(coveringSnapshot.checkpointContentHash) &&
    normalizeHex(coveringSnapshot.checkpointContentHash) === normalizeHex(archiveContentHash) &&
    Array.isArray(coveringSnapshot.signatures) &&
    coveringSnapshot.signatures.length > 0 &&
    coveringSnapshot.signatures.every(isSnapshotSignature)
  );
}

function withDefaultTrustConfig(
  options: WalletReadinessOptions,
): WalletReadinessOptions {
  let registryTrustLoaded = false;
  let registryTrust: RegistryNoEvmReceiptTrustPolicy | null = null;
  const registryTrustPolicy = () => {
    if (!registryTrustLoaded) {
      registryTrust = bundledNoEvmReceiptTrustPolicy();
      registryTrustLoaded = true;
    }
    return registryTrust;
  };

  return "archiveTrust" in options
    ? options
    : {
      ...options,
      archiveTrust: envTrustOrRegistryTrust(
        noEvmArchiveTrustConfigFromEnv(),
        () => noEvmArchiveTrustConfigFromRegistry(registryTrustPolicy()),
      ),
    };
}

function envTrustOrRegistryTrust<T extends { state: "unconfigured" | "configured" | "blocked" }>(
  envTrust: T,
  registryTrust: () => T,
): T {
  if (envTrust.state !== "unconfigured") return envTrust;
  const fallback = registryTrust();
  return fallback.state === "unconfigured" ? envTrust : fallback;
}

function bundledNoEvmReceiptTrustPolicy(): RegistryNoEvmReceiptTrustPolicy | null {
  const sdk = monolythiumCoreSdk as typeof monolythiumCoreSdk & RegistryNoEvmReceiptTrustLookup;
  return sdk.getNoEvmReceiptTrustPolicy?.(NO_EVM_RECEIPT_TRUST_REGISTRY_NETWORK) ?? null;
}

function isArchiveTrustConfigResolution(
  value: NoEvmArchiveTrustConfig | NoEvmArchiveTrustConfigResolution,
): value is NoEvmArchiveTrustConfigResolution {
  return (
    isRecord(value) &&
    (value.state === "unconfigured" ||
      value.state === "configured" ||
      value.state === "blocked")
  );
}

function readEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseTrustedChainId(
  value: unknown,
  field: string,
): { state: "ok"; value: bigint } | { state: "blocked"; detail: string } {
  const parsed = parseIntegerLike(value, field);
  if (parsed.state === "blocked") return parsed;
  if (parsed.value < 0n) {
    return { state: "blocked", detail: `${field} must be non-negative` };
  }
  if (parsed.value > 0xffff_ffff_ffff_ffffn) {
    return { state: "blocked", detail: `${field} must fit u64` };
  }
  return { state: "ok", value: parsed.value };
}

function parsePositiveSafeInteger(
  value: unknown,
  field: string,
): { state: "ok"; value: number } | { state: "blocked"; detail: string } {
  const parsed = parseIntegerLike(value, field);
  if (parsed.state === "blocked") return parsed;
  if (parsed.value < 1n || parsed.value > 0xffffn) {
    return { state: "blocked", detail: `${field} must be in 1..=65535` };
  }
  return { state: "ok", value: Number(parsed.value) };
}

function parseOptionalRegistryBound(
  value: unknown,
  field: string,
): { state: "ok"; value: bigint | undefined } | { state: "blocked"; detail: string } {
  if (value === undefined) return { state: "ok", value: undefined };
  const parsed = parseTrustedChainId(value, field);
  if (parsed.state === "blocked") return parsed;
  return { state: "ok", value: parsed.value };
}

function parseIntegerLike(
  value: unknown,
  field: string,
): { state: "ok"; value: bigint } | { state: "blocked"; detail: string } {
  if (typeof value === "bigint") return { state: "ok", value };
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return { state: "ok", value: BigInt(value) };
    return { state: "blocked", detail: `${field} must be a safe integer` };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const pattern = trimmed.startsWith("0x") ? /^0x[0-9a-fA-F]+$/u : /^[0-9]+$/u;
    if (!pattern.test(trimmed)) {
      return { state: "blocked", detail: `${field} must be an integer` };
    }
    return { state: "ok", value: BigInt(trimmed) };
  }
  return { state: "blocked", detail: `${field} must be an integer` };
}

function parseArchiveTrustedPublicKeys(
  value: unknown,
  field: string,
): { state: "ok"; value: NoEvmArchiveTrustedSigner[] } | { state: "blocked"; detail: string } {
  const entries = typeof value === "string"
    ? value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : Array.isArray(value)
      ? value
      : null;
  if (entries == null) {
    return {
      state: "blocked",
      detail: `${field} must be a comma-separated string or array`,
    };
  }
  if (entries.length === 0) {
    return { state: "blocked", detail: `${field} must include at least one public key` };
  }

  const trustedSigners: NoEvmArchiveTrustedSigner[] = [];
  for (const [index, entry] of entries.entries()) {
    const publicKey = parseArchivePublicKey(entry, `${field}[${index.toString()}]`);
    if (publicKey.state === "blocked") return publicKey;
    trustedSigners.push({ publicKey: publicKey.value });
  }
  return { state: "ok", value: trustedSigners };
}

function parseArchivePublicKey(
  value: unknown,
  field: string,
): { state: "ok"; value: Uint8Array } | { state: "blocked"; detail: string } {
  const hexDetail =
    `${field} must be a 0x-prefixed ${ML_DSA_65_PUBLIC_KEY_LEN.toString()}-byte ` +
    "ML-DSA-65 public key";
  if (typeof value === "string") {
    if (!isHexBytesOfLength(value, ML_DSA_65_PUBLIC_KEY_LEN)) {
      return { state: "blocked", detail: hexDetail };
    }
    return { state: "ok", value: hexToBytes(value) };
  }
  if (value instanceof Uint8Array) {
    if (value.length !== ML_DSA_65_PUBLIC_KEY_LEN) {
      return {
        state: "blocked",
        detail: `${field} must be ${ML_DSA_65_PUBLIC_KEY_LEN.toString()} bytes`,
      };
    }
    return { state: "ok", value: value.slice() };
  }
  if (Array.isArray(value)) {
    if (value.length !== ML_DSA_65_PUBLIC_KEY_LEN || !value.every(isByte)) {
      return {
        state: "blocked",
        detail: `${field} must be ${ML_DSA_65_PUBLIC_KEY_LEN.toString()} bytes`,
      };
    }
    return { state: "ok", value: new Uint8Array(value) };
  }
  return { state: "blocked", detail: hexDetail };
}

function receiptProofValue(
  ready: boolean,
  archiveWalletVerified: boolean,
): string {
  if (!ready) return "not verified";
  if (archiveWalletVerified) return "compact + archive signatures verified";
  return "compact + archive digest";
}

function archiveSignatureMaterialLabel(
  archiveProof: SupportedNoEvmArchiveProof,
): string {
  if (archiveProof.signatureDigest != null || archiveProof.signatures.length > 0) {
    return "exact-height archive signatures";
  }
  if (archiveProof.coveringSnapshot != null) return "covering snapshot signatures";
  return "archive signatures";
}

function archiveProofForSdkVerification(
  archiveProof: SupportedNoEvmArchiveProof,
): SdkNoEvmArchiveProof {
  if (archiveProof.signatureDigest != null || archiveProof.signatures.length > 0) {
    if (archiveProof.signatureDigest !== null) return archiveProof;
    const normalized: SdkNoEvmArchiveProof = { ...archiveProof };
    delete normalized.signatureDigest;
    return normalized;
  }
  if (archiveProof.coveringSnapshot != null) {
    return {
      schema: archiveProof.schema,
      source: archiveProof.source,
      manifestHash: archiveProof.coveringSnapshot.manifestHash,
      contentHash: archiveProof.contentHash,
      signatureDigest: archiveProof.coveringSnapshot.signatureDigest,
      signatures: archiveProof.coveringSnapshot.signatures,
    };
  }
  const normalized: SdkNoEvmArchiveProof = { ...archiveProof };
  delete normalized.signatureDigest;
  return normalized;
}

function describeArchiveSignatureMismatch(
  verification: NoEvmArchiveSignatureVerification,
): string {
  const reasons = new Set<string>();
  for (const issue of verification.issues) {
    switch (issue.code) {
      case "missing_signature_digest":
        reasons.add("missing signature digest");
        break;
      case "threshold_not_met":
        reasons.add(
          `threshold ${verification.validSigners.length.toString()}/` +
            `${verification.threshold.toString()} not met`,
        );
        break;
      case "duplicate_signer":
        reasons.add("duplicate signer");
        break;
      case "untrusted_signer":
        reasons.add("untrusted signer");
        break;
      case "invalid_signature":
        reasons.add("signature invalid");
        break;
      case "invalid_trusted_public_key":
        reasons.add("trusted public key invalid");
        break;
    }
  }
  return Array.from(reasons).join(", ") || "archive signatures not verified";
}

function formatArchiveVerificationErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "archive signature verification failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHexHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function isHexBytesOfLength(value: unknown, byteLength: number): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${(byteLength * 2).toString()}}$`, "u").test(value)
  );
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function isSnapshotSignature(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^mono\.snapshot\.sig\.v1:0x[0-9a-fA-F]{40}:0x(?:[0-9a-fA-F]{2})+$/u.test(value)
  );
}

function normalizeHex(value: string): string {
  return value.toLowerCase();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isByte(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255;
}

function mrvItem(capabilities: NativeCapabilitiesResponse | null): ReadinessItem {
  const forwarders = Object.values(capabilities?.nativeModuleForwarders ?? {})
    .flatMap((rows) => rows ?? [])
    .filter(isReadyMrvForwarder);
  return {
    key: "mrv",
    label: "MRV modules",
    value: forwarders.length > 0 ? `${forwarders.length} verified` : "not verified",
    state: forwarders.length > 0 ? "ready" : "blocked",
    detail: `Extension 0x${MRV_TX_EXTENSION_KIND.toString(16)}; profile ${MRV_PROFILE_MONO_RV32IM_V1}.`,
  };
}

function isReadyMrvForwarder(row: NativeModuleForwarderDescriptor): boolean {
  return (
    row.deploymentVerified === true &&
    row.status === "available" &&
    normaliseMrvProfile(row.artifactProfile) ===
      normaliseMrvProfile(MRV_PROFILE_MONO_RV32IM_V1)
  );
}

function normaliseMrvProfile(profile: string): string {
  return profile.replaceAll("-", "_");
}

function formatNativeLyth(lythoshi: bigint): string {
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const fraction = lythoshi % LYTHOSHI_PER_LYTH;
  const suffix = fraction === 0n
    ? ""
    : `.${fraction.toString().padStart(NATIVE_LYTH_DECIMALS, "0").replace(/0+$/, "")}`;
  return `${whole.toLocaleString()}${suffix} LYTH`;
}
