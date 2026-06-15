import { beforeEach, describe, expect, it } from "vitest";
import {
  nextSendNonce,
  recordSubmittedNonce,
  _resetPendingNonces,
} from "./pending-nonce";

const A = "0xAbC0000000000000000000000000000000000001";
const CHAIN = 69420;

describe("pending-nonce tracker", () => {
  beforeEach(() => _resetPendingNonces());

  it("returns the committed nonce unchanged when nothing is pending", () => {
    expect(nextSendNonce(A, CHAIN, 5n)).toBe(5n);
  });

  it("advances past a just-submitted nonce (2nd tx before the 1st commits)", () => {
    expect(nextSendNonce(A, CHAIN, 5n)).toBe(5n);
    recordSubmittedNonce(A, CHAIN, 5n); // 1st tx succeeded at nonce 5
    // committed is still 5 (1st not yet committed) → next must be 6, not 5.
    expect(nextSendNonce(A, CHAIN, 5n)).toBe(6n);
  });

  it("uses the committed nonce once the chain advances past the pending one", () => {
    recordSubmittedNonce(A, CHAIN, 5n);
    expect(nextSendNonce(A, CHAIN, 6n)).toBe(6n);
    expect(nextSendNonce(A, CHAIN, 9n)).toBe(9n);
  });

  it("shares ordering across send + staking (same address/chain)", () => {
    // sendLyth submits nonce 5 ...
    recordSubmittedNonce(A, CHAIN, 5n);
    // ... a delegate fired immediately after must take 6, not the committed 5.
    expect(nextSendNonce(A, CHAIN, 5n)).toBe(6n);
  });

  it("is keyed per (address, chainId) and address-case-insensitive", () => {
    recordSubmittedNonce(A.toLowerCase(), CHAIN, 7n);
    expect(nextSendNonce(A.toUpperCase(), CHAIN, 7n)).toBe(8n);
    expect(nextSendNonce("0xdeadbeef00000000000000000000000000000002", CHAIN, 7n)).toBe(7n);
    expect(nextSendNonce(A, 1, 7n)).toBe(7n);
  });
});
