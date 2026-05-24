import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MONOLYTHIUM_TESTNET_CHAIN_ID } from "@monolythium/core-sdk";
import { bytesToHex, hexToBytes, MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import {
  acceptsNoEvmFinalityEvidence,
  acceptsNoEvmCompactReceiptProofSource,
  buildOfflineWalletReadiness,
  buildWalletReadiness,
  describeNoEvmFinalityEvidence,
  describeNoEvmArchiveMaterial,
  noEvmArchiveTrustConfigFromEnv,
  noEvmFinalityTrustConfigFromEnv,
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
  "VITE_MONO_BLS_FINALITY_CHAIN_ID",
  "VITE_MONO_BLS_FINALITY_CLUSTER_PUBLIC_KEY",
  "VITE_MONO_BLS_FINALITY_COMMITTEE_SIZE",
  "VITE_MONO_BLS_FINALITY_THRESHOLD",
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

const FINALITY_EVIDENCE = {
  schema: "mono.no_evm_receipt_finality.v1",
  source: "blsRoundCertificate",
  round: 77,
  certificate: {
    round: 77,
    signature: `0x${"11".repeat(96)}`,
    signersBitmap: "0x03",
    signerIndices: [0, 1],
    signerCount: 2,
  },
};

const VERIFIED_FINALITY_EVIDENCE = {
  schema: "mono.no_evm_receipt_finality.v1",
  source: "blsRoundCertificate",
  round: 58,
  certificate: {
    round: 58,
    signature:
      "0xb52a7567f736afbda5e09d5af4bd8da36cff89c3e8d09ca4c98f8bffe5fbdca7af2437f1fbf92e4f52df8a54ed1c2de71954d1134637a675734db73acb4c0c545f4b3cd39577b4985e8a26b767a68d825c48f0a90e606d8ccbbd8885ef27fcd7",
    signersBitmap: "0x08",
    signerIndices: [3],
    signerCount: 1,
  },
};

const VERIFIED_FINALITY_TRUST = {
  chainId: 69_420,
  clusterPublicKey: "0xb77f27a88bfe18988cfcf68ba7462d188a0e655bdd68318c706a3b51887a61fa7d7a9c8843e26f91c91446819925db97",
  committeeSize: 7,
  threshold: 1,
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
    finality: {
      mode: "cluster",
      chainId: VERIFIED_FINALITY_TRUST.chainId,
      clusterPublicKey: hexToBytes(VERIFIED_FINALITY_TRUST.clusterPublicKey),
      committeeSize: VERIFIED_FINALITY_TRUST.committeeSize,
      threshold: VERIFIED_FINALITY_TRUST.threshold,
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
      FINALITY_EVIDENCE,
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
    expect(acceptsNoEvmCompactReceiptProofSource("indexerReceiptArchive", ARCHIVE_PROOF, {
      ...FINALITY_EVIDENCE,
      source: "validatorFinality",
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
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + BLS/archive verified",
      detail: expect.stringContaining("wallet-verified BLS threshold 1/1"),
    });
    expect(readiness.items.find((item) => item.key === "receipt-proof")?.detail)
      .toContain("wallet-verified ML-DSA archive threshold 1/1");
  });

  it("preserves unconfigured receipt proof readiness when the bundled registry has no policy", () => {
    const signed = signedArchiveProof(19);
    sdkRegistryMock.policy = null;

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + archive digest",
      detail: expect.stringContaining("not wallet-verified"),
    });
  });

  it("fails closed when the bundled registry finality policy is multisig", () => {
    const signed = signedArchiveProof(21);
    sdkRegistryMock.policy = {
      ...registryPolicyForProof(signed),
      finality: {
        mode: "multisig",
        chainId: VERIFIED_FINALITY_TRUST.chainId,
        trustedSigners: [],
        threshold: 1,
      },
    };

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
    });

    expect(readiness.state).toBe("blocked");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "blocked",
      value: "not verified",
      detail: expect.stringContaining("multisig mode"),
    });
  });

  it("fails closed for bounded bundled registry policies that cannot be satisfied", () => {
    const signed = signedArchiveProof(22);
    sdkRegistryMock.policy = {
      ...registryPolicyForProof(signed),
      finality: {
        ...registryPolicyForProof(signed).finality,
        validToRound: 57,
      },
    };

    const finalityExpired = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
    });

    expect(finalityExpired.state).toBe("blocked");
    expect(finalityExpired.items.find((item) => item.key === "receipt-proof")?.detail)
      .toContain("registry BLS finality policy is not valid at round 58");

    sdkRegistryMock.policy = {
      ...registryPolicyForProof(signed),
      archive: {
        ...registryPolicyForProof(signed).archive,
        validFromHeight: 100,
      },
    };

    const archiveBounded = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
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
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
      finalityTrust: VERIFIED_FINALITY_TRUST,
    });

    expect(explicit.state).toBe("ready");
    expect(explicit.items.find((item) => item.key === "receipt-proof")?.value)
      .toBe("compact + BLS/archive verified");

    vi.stubEnv("VITE_MONO_ARCHIVE_TRUSTED_PUBKEYS", bytesToHex(signed.signer.publicKey()));
    vi.stubEnv("VITE_MONO_ARCHIVE_SIGNATURE_THRESHOLD", "1");
    vi.stubEnv("VITE_MONO_BLS_FINALITY_CHAIN_ID", VERIFIED_FINALITY_TRUST.chainId.toString());
    vi.stubEnv("VITE_MONO_BLS_FINALITY_CLUSTER_PUBLIC_KEY", VERIFIED_FINALITY_TRUST.clusterPublicKey);
    vi.stubEnv(
      "VITE_MONO_BLS_FINALITY_COMMITTEE_SIZE",
      VERIFIED_FINALITY_TRUST.committeeSize.toString(),
    );
    vi.stubEnv("VITE_MONO_BLS_FINALITY_THRESHOLD", VERIFIED_FINALITY_TRUST.threshold.toString());

    const fromEnv = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: signed.proof,
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
    });

    expect(fromEnv.state).toBe("ready");
    expect(fromEnv.items.find((item) => item.key === "receipt-proof")?.value)
      .toBe("compact + BLS/archive verified");
  });

  it("wallet-verifies exact-height archive signatures when trusted signer config is supplied", () => {
    const { proof, trust } = signedArchiveProof(14);

    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      proof,
      null,
      null,
      trust,
    )).toBe(true);
    expect(describeNoEvmArchiveMaterial(proof, trust)).toContain(
      "wallet-verified ML-DSA archive threshold 1/1 via exact-height archive signatures",
    );

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      archiveProof: proof,
      archiveTrust: trust,
      finalityEvidence: null,
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
      null,
      null,
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
      null,
      null,
      trusted.trust,
    )).toBe(false);
    expect(describeNoEvmArchiveMaterial(mismatchedProof, trusted.trust)).toContain(
      "wallet verification mismatch: untrusted signer, threshold 0/1 not met",
    );
    expect(acceptsNoEvmCompactReceiptProofSource(
      "indexerReceiptArchive",
      trusted.proof,
      null,
      null,
      invalidTrust,
    )).toBe(false);
    expect(describeNoEvmArchiveMaterial(trusted.proof, invalidTrust)).toContain(
      "wallet verification blocked: incomplete archive signer trust config",
    );
  });

  it("accepts nullable or BLS round certificate finality evidence without fabricating wallet verification", () => {
    expect(acceptsNoEvmFinalityEvidence(null)).toBe(true);
    expect(acceptsNoEvmFinalityEvidence(FINALITY_EVIDENCE)).toBe(true);
    expect(describeNoEvmFinalityEvidence(null)).toBe(
      "BLS round certificate absent; no live finality evidence",
    );
    expect(describeNoEvmFinalityEvidence(FINALITY_EVIDENCE)).toBe(
      "BLS round certificate mono.no_evm_receipt_finality.v1; " +
        "source blsRoundCertificate; round 77; 2 signers; " +
        "certificate parsed; not wallet-verified (trusted BLS finality config absent)",
    );
    expect(acceptsNoEvmFinalityEvidence({
      ...FINALITY_EVIDENCE,
      certificate: {
        ...FINALITY_EVIDENCE.certificate,
        round: 78,
      },
    })).toBe(false);
    expect(acceptsNoEvmFinalityEvidence({
      ...FINALITY_EVIDENCE,
      certificate: {
        ...FINALITY_EVIDENCE.certificate,
        signerCount: 3,
      },
    })).toBe(false);
  });

  it("wallet-verifies BLS finality evidence when trusted threshold config is supplied", () => {
    expect(acceptsNoEvmFinalityEvidence(
      VERIFIED_FINALITY_EVIDENCE,
      VERIFIED_FINALITY_TRUST,
    )).toBe(true);
    expect(describeNoEvmFinalityEvidence(
      VERIFIED_FINALITY_EVIDENCE,
      VERIFIED_FINALITY_TRUST,
    )).toContain("wallet-verified BLS threshold 1/1");

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
      finalityTrust: VERIFIED_FINALITY_TRUST,
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + BLS verified",
      detail: expect.stringContaining("wallet-verified BLS threshold 1/1"),
    });
  });

  it("fails closed when configured BLS finality trust does not match the evidence", () => {
    const wrongChainTrust = {
      ...VERIFIED_FINALITY_TRUST,
      chainId: 69_421,
    };

    expect(acceptsNoEvmFinalityEvidence(
      VERIFIED_FINALITY_EVIDENCE,
      wrongChainTrust,
    )).toBe(false);
    expect(describeNoEvmFinalityEvidence(
      VERIFIED_FINALITY_EVIDENCE,
      wrongChainTrust,
    )).toContain("wallet verification mismatch: signature invalid");

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      finalityEvidence: VERIFIED_FINALITY_EVIDENCE,
      finalityTrust: wrongChainTrust,
    });

    expect(readiness.state).toBe("blocked");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "blocked",
      value: "not verified",
      detail: expect.stringContaining("wallet verification mismatch"),
    });
  });

  it("fails closed for incomplete or malformed configured BLS finality trust", () => {
    expect(noEvmFinalityTrustConfigFromEnv({})).toMatchObject({
      state: "unconfigured",
    });

    const incomplete = noEvmFinalityTrustConfigFromEnv({
      VITE_MONO_BLS_FINALITY_CHAIN_ID: "69420",
    });
    expect(incomplete).toMatchObject({ state: "blocked" });
    expect(acceptsNoEvmFinalityEvidence(FINALITY_EVIDENCE, incomplete)).toBe(false);
    expect(describeNoEvmFinalityEvidence(FINALITY_EVIDENCE, incomplete)).toContain(
      "wallet verification blocked: incomplete BLS finality trust config",
    );

    const malformed = noEvmFinalityTrustConfigFromEnv({
      VITE_MONO_BLS_FINALITY_CHAIN_ID: "69420",
      VITE_MONO_BLS_FINALITY_CLUSTER_PUBLIC_KEY: "0x12",
      VITE_MONO_BLS_FINALITY_COMMITTEE_SIZE: "7",
      VITE_MONO_BLS_FINALITY_THRESHOLD: "1",
    });
    expect(malformed).toMatchObject({ state: "blocked" });

    const readiness = buildWalletReadiness(STATUS, CAPABILITIES, null, {
      finalityTrust: malformed,
    });

    expect(readiness.state).toBe("blocked");
    expect(readiness.items.find((item) => item.key === "receipt-proof")?.detail)
      .toContain("wallet verification blocked");
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
