import {
  MONOLYTHIUM_TESTNET_CHAIN_ID,
  MONOLYTHIUM_TESTNET_NETWORK_NAME,
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
const NO_EVM_RECEIPT_CODEC = "bincode(protocore_evm::Receipt)";
const NO_EVM_RECEIPT_ROOT_DOMAIN = "monolythium/v4.1/receipts_root_empty/1";
const MIN_NATIVE_FEE_LYTHOSHI = LYTHOSHI_PER_LYTH / 10_000n;

export async function loadWalletReadiness(
  status: ChainStatus,
): Promise<WalletReadiness> {
  try {
    const capabilities = await getProvider().rpcClient.lythCapabilities(
      "latest",
    ) as unknown as NativeCapabilitiesResponse;
    return buildWalletReadiness(status, capabilities, null);
  } catch (cause) {
    return buildWalletReadiness(
      status,
      null,
      (cause as Error)?.message ?? "native capability probe failed",
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
      receiptProofItem(),
      mrvItem(null),
    ],
  };
}

export function buildWalletReadiness(
  status: ChainStatus,
  capabilities: NativeCapabilitiesResponse | null,
  error: string | null,
): WalletReadiness {
  const items = [
    networkItem(status.chainId),
    nativeFeeItem(),
    receiptProofItem(),
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

function receiptProofItem(): ReadinessItem {
  const ready =
    NO_EVM_RECEIPT_PROOF_SCHEMA === "mono.no_evm_receipt_proof.v1" &&
    NO_EVM_RECEIPT_CODEC.length > 0 &&
    NO_EVM_RECEIPT_ROOT_DOMAIN.includes("monolythium/v4.1");
  return {
    key: "receipt-proof",
    label: "Receipt proofs",
    value: ready ? "v4.1 canonical" : "not verified",
    state: ready ? "ready" : "blocked",
    detail: NO_EVM_RECEIPT_PROOF_SCHEMA,
  };
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
