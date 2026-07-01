import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MONOLYTHIUM_TESTNET_CHAIN_ID } from "@monolythium/core-sdk";
import { bytesToHex, hexToBytes, MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import {
  acceptsNoEvmCompactReceiptProofSource,
  buildOfflineWalletReadiness,
  buildWalletReadiness,
  describeNoEvmArchiveMaterial,
  noEvmArchiveTrustConfigFromEnv,
} from "../readiness";
import type { ChainStatus } from "../client";

const sdkRegistryMock = vi.hoisted(() => ({
  policy: null as unknown,
}));

vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getNoEvmReceiptTrustPolicy: vi.fn(() => sdkRegistryMock.policy),
  };
});

const TRUST_ENV_KEYS = [
  "VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS",
  "VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD",
] as const;

const STATUS: ChainStatus = {
  chainId: MONOLYTHIUM_TESTNET_CHAIN_ID,
  blockNumber: 123n,
  endpoint: "http://test.invalid",
};

const VALID_ARCHIVE_SIGNATURE =
  `mono.snapshot.sig.v1:0x${"a1".repeat(20)}:0x${"b2".repeat(64)}`;
const VALID_SIGNATURE_DIGEST = `0x${"c3".repeat(32)}`;

const ARCHIVE_PROOF = {
  schema: "mono.no_evm_receipt_archive_binding.v1",
  source: "indexerReceiptArchiveContentDigest",
  manifestHash: `0x${"53".repeat(32)}`,
  contentHash: `0x${"54".repeat(32)}`,
  signatures: [],
};

const COVERING_SNAPSHOT = {
  snapshotHeight: 100,
  manifestHash: `0x${"61".repeat(32)}`,
  signatureDigest: VALID_SIGNATURE_DIGEST,
  contentHash: `0x${"62".repeat(32)}`,
  checkpointContentHash: ARCHIVE_PROOF.contentHash,
  checkpointFrom: 0,
  checkpointTo: 100,
  signatures: [VALID_ARCHIVE_SIGNATURE],
};

function signedArchiveProof(seed: number) {
  const signer = MlDsa65Backend.fromSeed(new Uint8Array(32).fill(seed));
  const signatureDigest = `0x${"66".repeat(32)}`;
  const signature =
    `mono.snapshot.sig.v1:${signer.getAddress()}:` +
    bytesToHex(signer.sign(hexToBytes(signatureDigest)));
  return {
    signer,
    signatureDigest,
    proof: {
      ...ARCHIVE_PROOF,
      signatureDigest,
      signatures: [signature],
    },
    trust: {
      trustedPublicKeys: [signer.publicKey()],
      threshold: 1,
    },
  };
}

function registryPolicyForProof(
  signedArchive: ReturnType<typeof signedArchiveProof>,
) {
  return {
    chainId: MONOLYTHIUM_TESTNET_CHAIN_ID,
    archive: {
      trustedSigners: [
        {
          publicKey: signedArchive.signer.publicKey(),
        },
      ],
      threshold: 1,
    },
  };
}

function mismatchedRegistryPolicy() {
  return registryPolicyForProof(signedArchiveProof(99));
}

const CAPABILITIES = {
  blockNumber: 123n,
  capabilities: {},
  nativeModuleForwarders: {
    market: [
      {
        module: "market",
        requestBytes: 132,
        contractAddress: "monoc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxk4v02",
        artifactProfile: "mono-rv32im-v1",
        status: "available",
        deploymentVerified: true,
      },
    ],
  },
};

describe("wallet readiness", () => {
  beforeEach(() => {
    sdkRegistryMock.policy = null;
    for (const key of TRUST_ENV_KEYS) vi.stubEnv(key, "");
  });

  afterEach(() => {
    sdkRegistryMock.policy = null;
    vi.unstubAllEnvs();
  });

  it("marks v4.1 readiness when network, native fee display, receipt proof, and MRV forwarders align", () => {
    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null);

    expect(readiness.state).toBe("ready");
    expect(readiness.sampledAtBlock).toBe(123n);
    expect(readiness.items.find((item) => item.key === "native-fee")?.value).toBe("0.0001 LYTH");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + archive digest",
      detail: expect.stringContaining("not wallet-verified"),
    });
    expect(readiness.items.find((item) => item.key === "mrv")?.value).toBe("1 verified");
  });

  it("accepts compact receipt proofs sourced from the indexer archive", () => {
    expect(acceptsNoEvmCompactReceiptProofSource("liveBlockCache", null)).toBe(true);
    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      ARCHIVE_PROOF,
    ))
      .toBe(true);
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatures: [VALID_ARCHIVE_SIGNATURE],
    })).toBe(true);
    expect(acceptsNoEvmCompactReceiptProofSource("validatorFinality", ARCHIVE_PROOF))
      .toBe(false);
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatures: null,
    })).toBe(false);
  });

  it("requires archive signatures to use the exact snapshot signature envelope", () => {
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatures: [VALID_ARCHIVE_SIGNATURE],
    })).toBe(true);
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatures: [],
    })).toBe(true);

    for (const signature of [
      `mono.snapshot.sig.v2:0x${"a1".repeat(20)}:0x${"b2".repeat(64)}`,
      `mono.snapshot.sig.v1:0x${"a1".repeat(20)}:0x${"b2".repeat(64)}:extra`,
      `mono.snapshot.sig.v1:0x${"a1".repeat(19)}:0x${"b2".repeat(64)}`,
      `mono.snapshot.sig.v1:0x${"a1".repeat(20)}:0x`,
      `mono.snapshot.sig.v1:0x${"a1".repeat(20)}:0xnothex`,
      `mono.snapshot.sig.v1:0x${"a1".repeat(20)}:0xabc`,
    ]) {
      expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
        ...ARCHIVE_PROOF,
        signatures: [signature],
      })).toBe(false);
    }
  });

  it("accepts only nullable or 32-byte archive signature digests", () => {
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatureDigest: VALID_SIGNATURE_DIGEST,
    })).toBe(true);
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatureDigest: null,
    })).toBe(true);
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatureDigest: `0x${"c3".repeat(31)}`,
    })).toBe(false);
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
      ...ARCHIVE_PROOF,
      signatureDigest: `0x${"c3".repeat(31)}zz`,
    })).toBe(false);
  });

  it("accepts archive proofs with a signed covering snapshot checkpoint", () => {
    const proof = {
      ...ARCHIVE_PROOF,
      signatureDigest: null,
      signatures: [],
      coveringSnapshot: COVERING_SNAPSHOT,
    };

    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", proof)).toBe(true);
    expect(describeNoEvmArchiveMaterial(proof)).toContain(
      "1 covering snapshot signature record parsed",
    );
    expect(describeNoEvmArchiveMaterial(proof)).toContain(
      "not wallet-verified (trusted archive signer config absent)",
    );
  });

  it("fails closed for malformed archive covering snapshots", () => {
    const invalidSnapshots = [
      { checkpointFrom: 1 },
      { checkpointTo: 101 },
      { checkpointContentHash: `0x${"55".repeat(32)}` },
      { signatureDigest: null },
      { signatures: [] },
      { signatures: [`mono.snapshot.sig.v1:0x${"a1".repeat(19)}:0x${"b2".repeat(64)}`] },
      { manifestHash: `0x${"61".repeat(31)}` },
      { snapshotHeight: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const patch of invalidSnapshots) {
      expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", {
        ...ARCHIVE_PROOF,
        signatureDigest: null,
        signatures: [],
        coveringSnapshot: {
          ...COVERING_SNAPSHOT,
          ...patch,
        },
      })).toBe(false);
    }
  });

  it("labels archive binding material without presenting it as validator finality", () => {
    expect(describeNoEvmArchiveMaterial(ARCHIVE_PROOF)).toBe(
      "archive binding mono.no_evm_receipt_archive_binding.v1; " +
        "content digest indexerReceiptArchiveContentDigest; " +
        "signature records absent; archive proof parsed; " +
        "not wallet-verified (trusted archive signer config absent); not validator finality",
    );
    expect(describeNoEvmArchiveMaterial({
      ...ARCHIVE_PROOF,
      signatures: [VALID_ARCHIVE_SIGNATURE, VALID_ARCHIVE_SIGNATURE],
    })).toContain("2 exact-height archive signature records parsed");
  });

  it("parses trusted archive signer config from env", () => {
    const { signer } = signedArchiveProof(13);
    const configured = noEvmArchiveTrustConfigFromEnv({
      VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS: bytesToHex(signer.publicKey()),
      VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD: "1",
    });

    expect(noEvmArchiveTrustConfigFromEnv({})).toMatchObject({
      state: "unconfigured",
    });
    expect(configured).toMatchObject({
      state: "configured",
      config: {
        threshold: 1,
      },
    });
    expect(noEvmArchiveTrustConfigFromEnv({
      VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS: bytesToHex(signer.publicKey()),
    })).toMatchObject({ state: "blocked" });
    expect(noEvmArchiveTrustConfigFromEnv({
      VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS: "0x12",
      VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD: "1",
    })).toMatchObject({ state: "blocked" });
    expect(noEvmArchiveTrustConfigFromEnv({
      VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS: bytesToHex(signer.publicKey()),
      VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD: "2",
    })).toMatchObject({ state: "blocked" });
  });

  it("uses the bundled registry receipt trust policy when env and trust options are absent", () => {
    const signed = signedArchiveProof(18);
    sdkRegistryMock.policy = registryPolicyForProof(signed);

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + archive signatures verified",
      detail: expect.stringContaining("wallet-verified ML-DSA archive threshold 1/1"),
    });
  });

  it("preserves unconfigured receipt proof readiness when the bundled registry has no policy", () => {
    const signed = signedArchiveProof(19);
    sdkRegistryMock.policy = null;

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + archive digest",
      detail: expect.stringContaining("not wallet-verified"),
    });
  });

  it("fails closed for bounded bundled registry archive policies that cannot be satisfied", () => {
    const signed = signedArchiveProof(22);
    sdkRegistryMock.policy = {
      ...registryPolicyForProof(signed),
      archive: {
        ...registryPolicyForProof(signed).archive,
        validFromHeight: 100,
      },
    };

    const archiveBounded = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
    });

    expect(archiveBounded.state).toBe("blocked");
    expect(archiveBounded.items.find((item) => item.key === "receipt-proof")?.detail)
      .toContain("mobile readiness has no receipt block-height context");
  });

  it("lets explicit trust options and env config override bundled registry trust", () => {
    const signed = signedArchiveProof(20);
    sdkRegistryMock.policy = mismatchedRegistryPolicy();

    const explicit = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
      archiveTrust: signed.trust,
    });

    expect(explicit.state).toBe("ready");
    expect(explicit.items.find((item) => item.key === "receipt-proof")?.value)
      .toBe("compact + archive signatures verified");

    vi.stubEnv("VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS", bytesToHex(signed.signer.publicKey()));
    vi.stubEnv("VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD", "1");

    const fromEnv = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
    });

    expect(fromEnv.state).toBe("ready");
    expect(fromEnv.items.find((item) => item.key === "receipt-proof")?.value)
      .toBe("compact + archive signatures verified");
  });

  it("wallet-verifies exact-height archive signatures when trusted signer config is supplied", () => {
    const { proof, trust } = signedArchiveProof(14);

    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      proof,
      trust,
    )).toBe(true);
    expect(describeNoEvmArchiveMaterial(proof, trust)).toContain(
      "wallet-verified ML-DSA archive threshold 1/1 via exact-height archive signatures",
    );

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: proof,
      archiveTrust: trust,
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + archive signatures verified",
      detail: expect.stringContaining("wallet-verified ML-DSA archive threshold 1/1"),
    });
  });

  it("uses covering snapshot archive signatures when exact-height signatures are absent", () => {
    const { signer, trust } = signedArchiveProof(15);
    const signature =
      `mono.snapshot.sig.v1:${signer.getAddress()}:` +
      bytesToHex(signer.sign(hexToBytes(COVERING_SNAPSHOT.signatureDigest)));
    const proof = {
      ...ARCHIVE_PROOF,
      signatureDigest: null,
      signatures: [],
      coveringSnapshot: {
        ...COVERING_SNAPSHOT,
        signatures: [signature],
      },
    };

    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      proof,
      trust,
    )).toBe(true);
    expect(describeNoEvmArchiveMaterial(proof, trust)).toContain(
      "wallet-verified ML-DSA archive threshold 1/1 via covering snapshot signatures",
    );
  });

  it("fails closed for archive signer mismatches or invalid archive trust config", () => {
    const trusted = signedArchiveProof(16);
    const untrusted = signedArchiveProof(17);
    const mismatchedProof = {
      ...ARCHIVE_PROOF,
      signatureDigest: untrusted.signatureDigest,
      signatures: untrusted.proof.signatures,
    };
    const invalidTrust = noEvmArchiveTrustConfigFromEnv({
      VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS: bytesToHex(trusted.signer.publicKey()),
    });

    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      mismatchedProof,
      trusted.trust,
    )).toBe(false);
    expect(describeNoEvmArchiveMaterial(mismatchedProof, trusted.trust)).toContain(
      "wallet verification mismatch: untrusted signer, threshold 0/1 not met",
    );
    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      trusted.proof,
      invalidTrust,
    )).toBe(false);
    expect(describeNoEvmArchiveMaterial(trusted.proof, invalidTrust)).toContain(
      "wallet verification blocked: incomplete archive signer trust config",
    );
  });

  it("fails closed when native capability data is unavailable", () => {
    const readiness = buildWalletReadiness(STATUS, null, "method not found");

    expect(readiness.state).toBe("blocked");
    expect(readiness.error).toBe("method not found");
    expect(readiness.items.find((item) => item.key === "mrv")?.state).toBe("blocked");
  });

  it("fails closed while offline", () => {
    const readiness = buildOfflineWalletReadiness("rpc unreachable");

    expect(readiness.state).toBe("blocked");
    expect(readiness.items.find((item) => item.key === "network")?.value).toBe("not verified");
  });
});
