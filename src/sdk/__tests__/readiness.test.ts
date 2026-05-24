import { describe, expect, it } from "vitest";
import { MONOLYTHIUM_TESTNET_CHAIN_ID } from "@monolythium/core-sdk";
import {
  acceptsNoEvmFinalityEvidence,
  acceptsNoEvmCompactReceiptProofSource,
  buildOfflineWalletReadiness,
  buildWalletReadiness,
  describeNoEvmFinalityEvidence,
  describeNoEvmArchiveMaterial,
} from "../readiness";
import type { ChainStatus } from "../client";

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

describe("wallet readiness", () => {
  it("marks v4.1 readiness when network, native fee display, receipt proof, and MRV forwarders align", () => {
    const capabilities = {
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

    const readiness = buildWalletReadiness(STATUS, capabilities, null);

    expect(readiness.state).toBe("ready");
    expect(readiness.sampledAtBlock).toBe(123n);
    expect(readiness.items.find((item) => item.key === "native-fee")?.value).toBe("0.0001 LYTH");
    expect(readiness.items.find((item) => item.key === "receipt-proof")).toMatchObject({
      state: "ready",
      value: "compact + archive digest",
      detail: expect.stringContaining("BLS round certificate"),
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

  it("labels archive binding material without presenting it as validator finality", () => {
    expect(describeNoEvmArchiveMaterial(ARCHIVE_PROOF)).toBe(
      "archive binding mono.no_evm_receipt_archive_binding.v1; " +
        "content digest indexerReceiptArchiveContentDigest; " +
        "signature records absent; not cryptographically verified; not validator finality",
    );
    expect(describeNoEvmArchiveMaterial({
      ...ARCHIVE_PROOF,
      signatures: [VALID_ARCHIVE_SIGNATURE, VALID_ARCHIVE_SIGNATURE],
    })).toContain("2 archive signature records parsed");
  });

  it("accepts nullable or BLS round certificate finality evidence without overstating finality", () => {
    expect(acceptsNoEvmFinalityEvidence(null)).toBe(true);
    expect(acceptsNoEvmFinalityEvidence(FINALITY_EVIDENCE)).toBe(true);
    expect(describeNoEvmFinalityEvidence(null)).toBe(
      "BLS round certificate absent; no live finality evidence",
    );
    expect(describeNoEvmFinalityEvidence(FINALITY_EVIDENCE)).toBe(
      "BLS round certificate mono.no_evm_receipt_finality.v1; " +
        "source blsRoundCertificate; round 77; 2 signers; not full live finality",
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
