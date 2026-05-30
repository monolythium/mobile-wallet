// Pure notification model — key builder, append/cap, title labels, zero
// detection, and tolerant parsing (incl. the status-fidelity guard).

import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_HISTORY_CAP,
  NOTIFICATION_LABELS,
  appendCapped,
  isTxOpKind,
  isZeroAmount,
  notificationId,
  notificationTitle,
  parseHistoryEnvelope,
  parseNotifiedSetEnvelope,
  type NotificationRecord,
  type TxOpKind,
} from "../notifications";

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "0x10f2c:0xabc",
    txHash: "0xabc",
    status: "confirmed",
    blockNumber: 42,
    kind: "send",
    amountDecimal: "1.5",
    counterparty: "0x" + "11".repeat(20),
    createdAtMs: 1_700_000_000_000,
    read: false,
    schemaVersion: 0,
    ...over,
  };
}

describe("notificationId", () => {
  it("is `${chainIdHex}:${txHash}` and disambiguates by chain", () => {
    expect(notificationId("0x10f2c", "0xabc")).toBe("0x10f2c:0xabc");
    expect(notificationId("0x1", "0xabc")).not.toBe(
      notificationId("0x2", "0xabc"),
    );
  });
});

describe("appendCapped", () => {
  it("inserts newest-first", () => {
    const a = rec({ id: "a" });
    const b = rec({ id: "b" });
    const out = appendCapped([a], b);
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("drops the oldest past the cap", () => {
    let entries: NotificationRecord[] = [];
    for (let i = 0; i < NOTIFICATION_HISTORY_CAP + 5; i++) {
      entries = appendCapped(entries, rec({ id: `r${i}` }));
    }
    expect(entries).toHaveLength(NOTIFICATION_HISTORY_CAP);
    // Newest (highest index) is first; the first 5 inserted fell off.
    expect(entries[0]?.id).toBe(`r${NOTIFICATION_HISTORY_CAP + 4}`);
    expect(entries.find((r) => r.id === "r0")).toBeUndefined();
  });

  it("honours an explicit smaller cap", () => {
    const out = appendCapped([rec({ id: "a" }), rec({ id: "b" })], rec({ id: "c" }), 2);
    expect(out.map((r) => r.id)).toEqual(["c", "a"]);
  });
});

describe("isTxOpKind", () => {
  it("accepts every known kind", () => {
    const kinds: TxOpKind[] = [
      "send",
      "delegate",
      "undelegate",
      "redelegate",
      "claim",
      "emergency-key",
      "agent-policy",
      "contract_call",
    ];
    for (const k of kinds) expect(isTxOpKind(k)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isTxOpKind("nope")).toBe(false);
    expect(isTxOpKind(undefined)).toBe(false);
    expect(isTxOpKind(7)).toBe(false);
  });
});

describe("notificationTitle / NOTIFICATION_LABELS", () => {
  it("renders distinct confirmed/failed wording per kind", () => {
    expect(notificationTitle("send", "confirmed")).toBe("Sent");
    expect(notificationTitle("send", "failed")).toBe("Send failed");
    expect(notificationTitle("delegate", "confirmed")).toBe("Staked");
    expect(notificationTitle("claim", "confirmed")).toBe("Rewards claimed");
    expect(notificationTitle("contract_call", "failed")).toBe("Transaction failed");
  });
  it("covers every kind in the label table", () => {
    for (const kind of Object.keys(NOTIFICATION_LABELS) as TxOpKind[]) {
      expect(notificationTitle(kind, "confirmed").length).toBeGreaterThan(0);
      expect(notificationTitle(kind, "failed").length).toBeGreaterThan(0);
    }
  });
});

describe("isZeroAmount", () => {
  it("treats empty / 0 / 0.000 as zero", () => {
    expect(isZeroAmount("")).toBe(true);
    expect(isZeroAmount("0")).toBe(true);
    expect(isZeroAmount("0.0")).toBe(true);
    expect(isZeroAmount("0.00000000")).toBe(true);
  });
  it("treats any positive amount as non-zero", () => {
    expect(isZeroAmount("0.1")).toBe(false);
    expect(isZeroAmount("1")).toBe(false);
    expect(isZeroAmount("12.5")).toBe(false);
  });
});

describe("parseHistoryEnvelope", () => {
  it("round-trips a valid envelope and keeps only valid records", () => {
    const env = parseHistoryEnvelope({
      schemaVersion: 0,
      entries: [rec({ id: "ok" }), { id: "bad" }, null, 7],
    });
    expect(env).not.toBeNull();
    expect(env!.entries.map((r) => r.id)).toEqual(["ok"]);
  });

  it("rejects a wrong schemaVersion / non-array entries", () => {
    expect(parseHistoryEnvelope({ schemaVersion: 1, entries: [] })).toBeNull();
    expect(parseHistoryEnvelope({ schemaVersion: 0, entries: {} })).toBeNull();
    expect(parseHistoryEnvelope(null)).toBeNull();
    expect(parseHistoryEnvelope("nope")).toBeNull();
  });

  it("STATUS FIDELITY — drops records whose status isn't exactly confirmed/failed", () => {
    const env = parseHistoryEnvelope({
      schemaVersion: 0,
      entries: [
        rec({ id: "c", status: "confirmed" }),
        rec({ id: "f", status: "failed" }),
        // Anything optimistic / pending-ish must NOT survive the parse.
        { ...rec({ id: "p1" }), status: "pending" },
        { ...rec({ id: "p2" }), status: "kept" },
        { ...rec({ id: "p3" }), status: "submitted" },
        { ...rec({ id: "p4" }), status: true },
      ],
    });
    expect(env!.entries.map((r) => r.id).sort()).toEqual(["c", "f"]);
  });

  it("drops records with an unknown kind, but null blockNumber is valid", () => {
    const env = parseHistoryEnvelope({
      schemaVersion: 0,
      entries: [
        { ...rec({ id: "k" }), kind: "frobnicate" },
        rec({ id: "nb", blockNumber: null }),
      ],
    });
    expect(env!.entries.map((r) => r.id)).toEqual(["nb"]);
    expect(env!.entries[0]?.blockNumber).toBeNull();
  });
});

describe("parseNotifiedSetEnvelope", () => {
  it("keeps only string ids", () => {
    const env = parseNotifiedSetEnvelope({
      schemaVersion: 0,
      ids: ["a", 1, "b", null, "c"],
    });
    expect(env).not.toBeNull();
    expect(env!.ids).toEqual(["a", "b", "c"]);
  });
  it("rejects malformed envelopes", () => {
    expect(parseNotifiedSetEnvelope({ schemaVersion: 1, ids: [] })).toBeNull();
    expect(parseNotifiedSetEnvelope({ schemaVersion: 0, ids: "x" })).toBeNull();
    expect(parseNotifiedSetEnvelope(undefined)).toBeNull();
  });
});
