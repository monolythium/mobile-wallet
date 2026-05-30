// Pure pending-tx model — append/dedupe/cap, removal, recordable-hash guard,
// and tolerant envelope parsing. No store, no RPC: deterministic helpers.

import { describe, expect, it } from "vitest";
import {
  PENDING_TX_CAP,
  appendPendingCapped,
  isRecordableTxHash,
  parsePendingTxEnvelope,
  pendingTxKey,
  removePendingByKeys,
  type PendingTx,
} from "../pending-tx";

const CHAIN = "0x10f2c"; // 69420

function tx(n: number, over: Partial<PendingTx> = {}): PendingTx {
  return {
    txHash: "0x" + n.toString(16).padStart(64, "0"),
    chainIdHex: CHAIN,
    opKind: "send",
    amountDecimal: "1.5",
    counterparty: "0x" + "11".repeat(20),
    submittedAtMs: 1_000 + n,
    ...over,
  };
}

describe("pendingTxKey", () => {
  it("matches the notifications dedupe-key shape `${chainIdHex}:${txHash}`", () => {
    expect(pendingTxKey(CHAIN, "0xabc")).toBe(`${CHAIN}:0xabc`);
  });
});

describe("appendPendingCapped", () => {
  it("inserts newest-first", () => {
    const out = appendPendingCapped([tx(1)], tx(2));
    expect(out.map((e) => e.txHash)).toEqual([tx(2).txHash, tx(1).txHash]);
  });

  it("is a no-op (identity) on a duplicate (chainIdHex, txHash)", () => {
    const start = [tx(1)];
    // Same tx hash + chain, different submit time — must NOT be re-added, and
    // must preserve the original (no clobber of submittedAtMs).
    const out = appendPendingCapped(start, tx(1, { submittedAtMs: 999_999 }));
    expect(out).toBe(start);
    expect(out).toHaveLength(1);
    expect(out[0]!.submittedAtMs).toBe(tx(1).submittedAtMs);
  });

  it("treats the same hash on a different chain as distinct", () => {
    const out = appendPendingCapped([tx(1)], tx(1, { chainIdHex: "0x1" }));
    expect(out).toHaveLength(2);
  });

  it("drops the oldest beyond the cap (newest-first slice)", () => {
    let acc: PendingTx[] = [];
    for (let i = 0; i < PENDING_TX_CAP + 5; i++) acc = appendPendingCapped(acc, tx(i));
    expect(acc).toHaveLength(PENDING_TX_CAP);
    // Newest (highest n) retained at head; oldest (n=0..4) dropped.
    expect(acc[0]!.txHash).toBe(tx(PENDING_TX_CAP + 4).txHash);
    expect(acc.some((e) => e.txHash === tx(0).txHash)).toBe(false);
  });
});

describe("removePendingByKeys", () => {
  it("removes only the matching keys and returns a new array", () => {
    const start = [tx(1), tx(2), tx(3)];
    const out = removePendingByKeys(
      start,
      new Set([pendingTxKey(CHAIN, tx(2).txHash)]),
    );
    expect(out.map((e) => e.txHash)).toEqual([tx(1).txHash, tx(3).txHash]);
    expect(out).not.toBe(start);
  });

  it("is identity when nothing matches", () => {
    const start = [tx(1)];
    expect(removePendingByKeys(start, new Set(["nope"]))).toBe(start);
  });

  it("is identity on an empty key set", () => {
    const start = [tx(1)];
    expect(removePendingByKeys(start, new Set())).toBe(start);
  });
});

describe("isRecordableTxHash", () => {
  it("accepts a canonical 32-byte 0x hash", () => {
    expect(isRecordableTxHash("0x" + "ab".repeat(32))).toBe(true);
  });
  it("rejects the mock-execute hash, the empty sentinel, and short hashes", () => {
    expect(isRecordableTxHash("0x" + "0".repeat(60) + "demo")).toBe(false);
    expect(isRecordableTxHash("")).toBe(false);
    expect(isRecordableTxHash("0xabc")).toBe(false);
  });
});

describe("parsePendingTxEnvelope", () => {
  it("round-trips a valid envelope", () => {
    const env = { schemaVersion: 0 as const, entries: [tx(1), tx(2)] };
    expect(parsePendingTxEnvelope(env)).toEqual(env);
  });

  it("rejects a non-0 schemaVersion / non-object / non-array entries", () => {
    expect(parsePendingTxEnvelope(null)).toBeNull();
    expect(parsePendingTxEnvelope({ schemaVersion: 1, entries: [] })).toBeNull();
    expect(parsePendingTxEnvelope({ schemaVersion: 0, entries: "no" })).toBeNull();
  });

  it("drops malformed entries (bad hash, bad kind, missing fields) and keeps good ones", () => {
    const env = {
      schemaVersion: 0,
      entries: [
        tx(1),
        { ...tx(2), txHash: "0xshort" }, // bad hash
        { ...tx(3), opKind: "not-a-kind" }, // bad kind
        { ...tx(4), submittedAtMs: "soon" }, // bad time
        { ...tx(5), chainIdHex: "" }, // empty chain
        tx(6),
      ],
    };
    const parsed = parsePendingTxEnvelope(env);
    expect(parsed?.entries.map((e) => e.txHash)).toEqual([tx(1).txHash, tx(6).txHash]);
  });
});
