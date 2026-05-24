import {
  MONOLYTHIUM_TESTNET_CHAIN_ID,
  MONOLYTHIUM_TESTNET_NETWORK_NAME,
  verifyNoEvmFinalityEvidenceThreshold,
  type NoEvmBlsFinalityVerification,
  type NoEvmFinalityEvidence as SdkNoEvmFinalityEvidence,
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

const NATIVE_LYTH_DECIMALS = 8;
const LYTHOSHI_PER_LYTH = 100_000_000n;
const MRV_PROFILE_MONO_RV32IM_V1 = "mono_rv32im_v1";
const MRV_TX_EXTENSION_KIND = 0x30;
const NO_EVM_RECEIPT_PROOF_SCHEMA = "mono.no_evm_receipt_proof.v1";
const NO_EVM_COMPACT_INCLUSION_PROOF_SCHEMA =
  "mono.no_evm_receipt_compact_inclusion.v1";
const NO_EVM_ARCHIVE_PROOF_SCHEMA = "mono.no_evm_receipt_archive_binding.v1";
const NO_EVM_ARCHIVE_PROOF_SOURCE = "indexerReceiptArchiveContentDigest";
const NO_EVM_FINALITY_EVIDENCE_SCHEMA = "mono.no_evm_receipt_finality.v1";
const NO_EVM_FINALITY_EVIDENCE_SOURCE = "blsRoundCertificate";
const NO_EVM_RECEIPT_CODEC = "bincode(protocore_evm::Receipt)";
const NO_EVM_RECEIPT_ROOT_DOMAIN = "monolythium/v4.1/receipts_root_empty/1";
const MIN_NATIVE_FEE_LYTHOSHI = LYTHOSHI_PER_LYTH / 10_000n;

export interface NoEvmArchiveProofMaterial {
  schema: unknown;
  source: unknown;
  manifestHash: unknown;
  contentHash: unknown;
  signatureDigest?: unknown;
  signatures: unknown;
}

export interface NoEvmFinalityEvidence {
  schema: unknown;
  source: unknown;
  round: unknown;
  certificate: unknown;
}

export interface NoEvmFinalityTrustConfig {
  chainId: number | bigint | string;
  clusterPublicKey: string | Uint8Array | readonly number[];
  committeeSize: number | string;
  threshold: number | string;
}

export type NoEvmFinalityTrustConfigResolution =
  | { state: "unconfigured"; detail: string }
  | {
    state: "configured";
    config: {
      chainId: number | bigint;
      clusterPublicKey: Uint8Array;
      committeeSize: number;
      threshold: number;
    };
  }
  | { state: "blocked"; detail: string };

export interface WalletReadinessOptions {
  finalityEvidence?: unknown;
  finalityTrust?: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution | null;
}

const SUPPORTED_INDEXER_ARCHIVE_PROOF: NoEvmArchiveProofMaterial = {
  schema: NO_EVM_ARCHIVE_PROOF_SCHEMA,
  source: NO_EVM_ARCHIVE_PROOF_SOURCE,
  manifestHash: `0x${"00".repeat(32)}`,
  contentHash: `0x${"00".repeat(32)}`,
  signatures: [],
};

const SUPPORTED_BLS_ROUND_CERT_FINALITY_EVIDENCE: NoEvmFinalityEvidence = {
  schema: NO_EVM_FINALITY_EVIDENCE_SCHEMA,
  source: NO_EVM_FINALITY_EVIDENCE_SOURCE,
  round: 42,
  certificate: {
    round: 42,
    signature: `0x${"11".repeat(96)}`,
    signersBitmap: "0x03",
    signerIndices: [0, 1],
    signerCount: 2,
  },
};

export async function loadWalletReadiness(
  status: ChainStatus,
  options: WalletReadinessOptions = {},
): Promise<WalletReadiness> {
  const readinessOptions = withDefaultFinalityTrustConfig(options);
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
  return {
    state: "blocked",
    sampledAtBlock: null,
    error: message,
    items: [
      networkItem(null),
      nativeFeeItem(),
      receiptProofItem({}),
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
  const items = [
    networkItem(status.chainId),
    nativeFeeItem(),
    receiptProofItem(options),
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

export function noEvmFinalityTrustConfigFromEnv(
  env: Record<string, unknown> = import.meta.env,
): NoEvmFinalityTrustConfigResolution {
  const raw = {
    chainId: env.VITE_MONO_BLS_FINALITY_CHAIN_ID,
    clusterPublicKey: env.VITE_MONO_BLS_FINALITY_CLUSTER_PUBLIC_KEY,
    committeeSize: env.VITE_MONO_BLS_FINALITY_COMMITTEE_SIZE,
    threshold: env.VITE_MONO_BLS_FINALITY_THRESHOLD,
  };
  const values = Object.values(raw).map(readEnvString);
  const configuredCount = values.filter((value) => value !== undefined).length;
  if (configuredCount === 0) {
    return {
      state: "unconfigured",
      detail: "trusted BLS finality config absent",
    };
  }
  if (configuredCount !== values.length) {
    return {
      state: "blocked",
      detail:
        "incomplete BLS finality trust config; set VITE_MONO_BLS_FINALITY_CHAIN_ID, " +
        "VITE_MONO_BLS_FINALITY_CLUSTER_PUBLIC_KEY, VITE_MONO_BLS_FINALITY_COMMITTEE_SIZE, " +
        "and VITE_MONO_BLS_FINALITY_THRESHOLD",
    };
  }
  return resolveNoEvmFinalityTrustConfig({
    chainId: values[0]!,
    clusterPublicKey: values[1]!,
    committeeSize: values[2]!,
    threshold: values[3]!,
  });
}

export function resolveNoEvmFinalityTrustConfig(
  finalityTrust: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution | null | undefined,
): NoEvmFinalityTrustConfigResolution {
  if (finalityTrust == null) {
    return {
      state: "unconfigured",
      detail: "trusted BLS finality config absent",
    };
  }
  if (isFinalityTrustConfigResolution(finalityTrust)) return finalityTrust;

  const chainId = parseTrustedChainId(finalityTrust.chainId, "chainId");
  if (chainId.state === "blocked") return chainId;
  const clusterPublicKey = parseBlsPublicKey(
    finalityTrust.clusterPublicKey,
    "clusterPublicKey",
  );
  if (clusterPublicKey.state === "blocked") return clusterPublicKey;
  const committeeSize = parsePositiveSafeInteger(
    finalityTrust.committeeSize,
    "committeeSize",
  );
  if (committeeSize.state === "blocked") return committeeSize;
  const threshold = parsePositiveSafeInteger(finalityTrust.threshold, "threshold");
  if (threshold.state === "blocked") return threshold;
  if (threshold.value > committeeSize.value) {
    return {
      state: "blocked",
      detail: `threshold ${threshold.value.toString()} exceeds committeeSize ${committeeSize.value.toString()}`,
    };
  }

  return {
    state: "configured",
    config: {
      chainId: chainId.value,
      clusterPublicKey: clusterPublicKey.value,
      committeeSize: committeeSize.value,
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
  const finalityEvidence = options.finalityEvidence === undefined
    ? SUPPORTED_BLS_ROUND_CERT_FINALITY_EVIDENCE
    : options.finalityEvidence;
  const finality = assessNoEvmFinalityEvidence(
    finalityEvidence,
    options.finalityTrust,
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
      SUPPORTED_INDEXER_ARCHIVE_PROOF,
      finalityEvidence,
      options.finalityTrust,
    ) &&
    finality.accepted;
  return {
    key: "receipt-proof",
    label: "Receipt proofs",
    value: ready
      ? finality.walletVerified
        ? "compact + BLS verified"
        : "compact + archive digest"
      : "not verified",
    state: ready ? "ready" : "blocked",
    detail: [
      "Compact inclusion from live cache or indexer archive",
      describeNoEvmArchiveMaterial(SUPPORTED_INDEXER_ARCHIVE_PROOF),
      finality.detail,
    ].join("; "),
  };
}

export function acceptsNoEvmCompactReceiptProofSource(
  historySource: unknown,
  archiveProof: unknown,
  finalityEvidence: unknown = null,
  finalityTrust?: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution | null,
): boolean {
  if (!acceptsNoEvmFinalityEvidence(finalityEvidence, finalityTrust)) return false;
  if (historySource === "liveBlockCache") return archiveProof == null;
  if (historySource !== "indexerReceiptArchive") return false;
  return archiveProof == null || isSupportedArchiveProofMaterial(archiveProof);
}

export function acceptsNoEvmFinalityEvidence(
  finalityEvidence: unknown,
  finalityTrust?: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution | null,
): boolean {
  return assessNoEvmFinalityEvidence(finalityEvidence, finalityTrust).accepted;
}

export function describeNoEvmArchiveMaterial(archiveProof: unknown): string {
  if (archiveProof == null) return "archive binding absent";
  if (!isSupportedArchiveProofMaterial(archiveProof)) {
    return "unsupported archive binding";
  }

  const signatureCount = archiveProof.signatures.length;
  const signatureDetail = signatureCount === 0
    ? "signature records absent"
    : `${signatureCount} archive signature record${signatureCount === 1 ? "" : "s"} parsed`;
  return [
    `archive binding ${NO_EVM_ARCHIVE_PROOF_SCHEMA}`,
    `content digest ${NO_EVM_ARCHIVE_PROOF_SOURCE}`,
    signatureDetail,
    "not cryptographically verified",
    "not validator finality",
  ].join("; ");
}

export function describeNoEvmFinalityEvidence(
  finalityEvidence: unknown,
  finalityTrust?: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution | null,
): string {
  return assessNoEvmFinalityEvidence(finalityEvidence, finalityTrust).detail;
}

function assessNoEvmFinalityEvidence(
  finalityEvidence: unknown,
  finalityTrust?: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution | null,
): {
  accepted: boolean;
  walletVerified: boolean;
  detail: string;
} {
  const trust = resolveNoEvmFinalityTrustConfig(finalityTrust);
  if (finalityEvidence == null) {
    return {
      accepted: trust.state !== "blocked",
      walletVerified: false,
      detail: trust.state === "blocked"
        ? `BLS round certificate absent; wallet verification blocked: ${trust.detail}`
        : "BLS round certificate absent; no live finality evidence",
    };
  }
  if (!isSupportedBlsRoundCertificateFinalityEvidence(finalityEvidence)) {
    return {
      accepted: false,
      walletVerified: false,
      detail: "unsupported finality evidence",
    };
  }

  const { round, certificate } = finalityEvidence;
  const signerLabel = certificate.signerCount === 1 ? "signer" : "signers";
  const parsed = [
    `BLS round certificate ${NO_EVM_FINALITY_EVIDENCE_SCHEMA}`,
    `source ${NO_EVM_FINALITY_EVIDENCE_SOURCE}`,
    `round ${round.toString()}`,
    `${certificate.signerCount.toString()} ${signerLabel}`,
  ].join("; ");

  if (trust.state === "unconfigured") {
    return {
      accepted: true,
      walletVerified: false,
      detail: `${parsed}; certificate parsed; not wallet-verified (${trust.detail})`,
    };
  }
  if (trust.state === "blocked") {
    return {
      accepted: false,
      walletVerified: false,
      detail: `${parsed}; wallet verification blocked: ${trust.detail}`,
    };
  }

  let verification: NoEvmBlsFinalityVerification;
  try {
    verification = verifyNoEvmFinalityEvidenceThreshold(finalityEvidence, trust.config);
  } catch (cause) {
    return {
      accepted: false,
      walletVerified: false,
      detail: `${parsed}; wallet verification blocked: ${formatErrorMessage(cause)}`,
    };
  }

  if (verification.verified) {
    return {
      accepted: true,
      walletVerified: true,
      detail:
        `${parsed}; wallet-verified BLS threshold ` +
        `${verification.acceptedSignatureCount.toString()}/${verification.requiredSignatureCount.toString()}`,
    };
  }

  return {
    accepted: false,
    walletVerified: false,
    detail: `${parsed}; wallet verification mismatch: ${describeBlsFinalityMismatch(verification)}`,
  };
}

function isSupportedArchiveProofMaterial(
  archiveProof: unknown,
): archiveProof is {
  schema: typeof NO_EVM_ARCHIVE_PROOF_SCHEMA;
  source: typeof NO_EVM_ARCHIVE_PROOF_SOURCE;
  manifestHash: string;
  contentHash: string;
  signatureDigest?: string | null;
  signatures: string[];
} {
  if (!isRecord(archiveProof)) return false;
  return (
    archiveProof.schema === NO_EVM_ARCHIVE_PROOF_SCHEMA &&
    archiveProof.source === NO_EVM_ARCHIVE_PROOF_SOURCE &&
    isHexHash(archiveProof.manifestHash) &&
    isHexHash(archiveProof.contentHash) &&
    (archiveProof.signatureDigest == null || isHexHash(archiveProof.signatureDigest)) &&
    Array.isArray(archiveProof.signatures) &&
    archiveProof.signatures.every(isSnapshotSignature)
  );
}

function isSupportedBlsRoundCertificateFinalityEvidence(
  finalityEvidence: unknown,
): finalityEvidence is SdkNoEvmFinalityEvidence & {
  schema: typeof NO_EVM_FINALITY_EVIDENCE_SCHEMA;
  source: typeof NO_EVM_FINALITY_EVIDENCE_SOURCE;
  round: number;
  certificate: {
    round: number;
    signature: string;
    signersBitmap: string;
    signerIndices: number[];
    signerCount: number;
  };
} {
  if (!isRecord(finalityEvidence) || !isRecord(finalityEvidence.certificate)) {
    return false;
  }

  const { certificate } = finalityEvidence;
  return (
    finalityEvidence.schema === NO_EVM_FINALITY_EVIDENCE_SCHEMA &&
    finalityEvidence.source === NO_EVM_FINALITY_EVIDENCE_SOURCE &&
    isNonNegativeSafeInteger(finalityEvidence.round) &&
    certificate.round === finalityEvidence.round &&
    isHexBytesOfLength(certificate.signature, 96) &&
    isHexBytes(certificate.signersBitmap) &&
    Array.isArray(certificate.signerIndices) &&
    certificate.signerIndices.every(isNonNegativeSafeInteger) &&
    isPositiveSafeInteger(certificate.signerCount) &&
    certificate.signerCount === certificate.signerIndices.length
  );
}

function withDefaultFinalityTrustConfig(
  options: WalletReadinessOptions,
): WalletReadinessOptions {
  return "finalityTrust" in options
    ? options
    : { ...options, finalityTrust: noEvmFinalityTrustConfigFromEnv() };
}

function isFinalityTrustConfigResolution(
  value: NoEvmFinalityTrustConfig | NoEvmFinalityTrustConfigResolution,
): value is NoEvmFinalityTrustConfigResolution {
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

function parseBlsPublicKey(
  value: unknown,
  field: string,
): { state: "ok"; value: Uint8Array } | { state: "blocked"; detail: string } {
  if (typeof value === "string") {
    if (!isHexBytesOfLength(value, 48)) {
      return {
        state: "blocked",
        detail: `${field} must be a 0x-prefixed 48-byte BLS public key`,
      };
    }
    return { state: "ok", value: hexToBytes(value) };
  }
  if (value instanceof Uint8Array) {
    if (value.length !== 48) {
      return { state: "blocked", detail: `${field} must be 48 bytes` };
    }
    return { state: "ok", value: value.slice() };
  }
  if (Array.isArray(value)) {
    if (value.length !== 48 || !value.every(isByte)) {
      return { state: "blocked", detail: `${field} must be 48 bytes` };
    }
    return { state: "ok", value: new Uint8Array(value) };
  }
  return {
    state: "blocked",
    detail: `${field} must be a 0x-prefixed 48-byte BLS public key`,
  };
}

function describeBlsFinalityMismatch(
  verification: NoEvmBlsFinalityVerification,
): string {
  const reasons: string[] = [];
  if (!verification.signerCountMatches) reasons.push("signer count mismatch");
  if (!verification.signerBitmapMatchesIndices) reasons.push("signer bitmap mismatch");
  if (!verification.signerIndicesInRange) reasons.push("signer index outside committee");
  if (!verification.allSignersTrusted) reasons.push("untrusted signer");
  if (!verification.thresholdMet) {
    reasons.push(
      `threshold ${verification.acceptedSignatureCount.toString()}/${verification.requiredSignatureCount.toString()} not met`,
    );
  }
  if (!verification.signatureValid) reasons.push("signature invalid");
  return reasons.join(", ") || "certificate not verified";
}

function formatErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "BLS finality verification failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHexHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function isHexBytes(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/u.test(value);
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
    /^mono\.snapshot\.sig\.v1:0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]+$/u.test(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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
