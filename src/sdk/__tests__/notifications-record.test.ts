// Recording chokepoint — the status-fidelity heart of the feature.
//
// `recordTerminalNotification` must record a notification ONLY on an explicit
// receipt status bit (1 ⇒ confirmed, 0 ⇒ failed), record NOTHING while the tx
// is still pending, and record nothing if the poll window elapses without a
// receipt. We mock the RPC seam (`./client`) and the persistence seam
// (`./notifications-store`) so the test asserts exactly what gets recorded.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordSpy = vi.hoisted(() => vi.fn());
const receiptSpy = vi.hoisted(() => vi.fn());

vi.mock("../notifications-store", () => ({
  recordNotification: recordSpy,
}));

vi.mock("../client", () => ({
  getProvider: () => ({
    rpcClient: {
      ethGetTransactionReceipt: receiptSpy,
      ethChainId: async () => 69420n,
    },
  }),
}));

import { recordTerminalNotification } from "../notifications-record";

const TX = "0x" + "ab".repeat(32);
const NOTIFY = {
  kind: "send" as const,
  amountDecimal: "1.5",
  counterparty: "0x" + "11".repeat(20),
};

beforeEach(() => {
  recordSpy.mockReset();
  recordSpy.mockResolvedValue({ added: true, record: {} });
  receiptSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordTerminalNotification — status fidelity", () => {
  it("records 'confirmed' when the receipt status bit is 1", async () => {
    receiptSpy.mockResolvedValue({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: 4242n,
      tx_index: 0,
      status: 1,
      executionUnitsUsed: 21000n,
    });

    const res = await recordTerminalNotification(TX, 69420n, NOTIFY, {
      intervalMs: 1,
      timeoutMs: 50,
    });

    expect(res.added).toBe(true);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const arg = recordSpy.mock.calls[0]![0];
    expect(arg).toMatchObject({
      chainIdHex: "0x10f2c", // 69420
      txHash: TX,
      status: "confirmed",
      blockNumber: 4242,
      kind: "send",
      amountDecimal: "1.5",
      counterparty: NOTIFY.counterparty,
    });
  });

  it("records 'failed' when the receipt status bit is 0 (never coerced)", async () => {
    receiptSpy.mockResolvedValue({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: 7n,
      tx_index: 0,
      status: 0,
      executionUnitsUsed: 21000n,
    });

    await recordTerminalNotification(TX, 69420n, NOTIFY, {
      intervalMs: 1,
      timeoutMs: 50,
    });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0]![0].status).toBe("failed");
  });

  it("records NOTHING while the tx stays pending until the deadline", async () => {
    receiptSpy.mockResolvedValue(null); // never mined within the window

    const res = await recordTerminalNotification(TX, 69420n, NOTIFY, {
      intervalMs: 1,
      timeoutMs: 10,
    });

    expect(res.added).toBe(false);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("keeps polling through a null receipt, then records on the real bit", async () => {
    receiptSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        tx_hash: TX,
        block_hash: "0x" + "00".repeat(32),
        block_number: 9n,
        tx_index: 1,
        status: 1,
        executionUnitsUsed: 21000n,
      });

    await recordTerminalNotification(TX, 69420n, NOTIFY, {
      intervalMs: 1,
      timeoutMs: 200,
    });

    expect(receiptSpy).toHaveBeenCalledTimes(3);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0]![0].status).toBe("confirmed");
  });

  it("treats an RPC error as 'still pending' and never throws", async () => {
    receiptSpy.mockRejectedValue(new Error("rpc down"));

    const res = await recordTerminalNotification(TX, 69420n, NOTIFY, {
      intervalMs: 1,
      timeoutMs: 10,
    });

    expect(res.added).toBe(false);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("tolerates a null block number on the receipt (records blockNumber:null)", async () => {
    receiptSpy.mockResolvedValue({
      tx_hash: TX,
      block_hash: "0x" + "00".repeat(32),
      block_number: null,
      tx_index: 0,
      status: 1,
      executionUnitsUsed: 21000n,
    });

    await recordTerminalNotification(TX, 69420n, NOTIFY, {
      intervalMs: 1,
      timeoutMs: 50,
    });

    expect(recordSpy.mock.calls[0]![0].blockNumber).toBeNull();
  });
});
