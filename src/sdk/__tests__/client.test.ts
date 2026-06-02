import { describe, expect, it } from "vitest";
import { lythoshiHexToLyth } from "../client";

describe("lythoshiHexToLyth", () => {
  it("uses 18-decimal native lythoshi units", () => {
    // 1 LYTH = 1e18 lythoshi (0xde0b6b3a7640000).
    expect(lythoshiHexToLyth("0xde0b6b3a7640000")).toBe(1);
    // 1 lythoshi = 1e-18 LYTH.
    expect(lythoshiHexToLyth("0x1")).toBe(1e-18);
    // 0.01 LYTH = 1e16 lythoshi (0x2386f26fc10000).
    expect(lythoshiHexToLyth("0x2386f26fc10000")).toBe(0.01);
  });

  it("returns zero for missing or malformed quantities", () => {
    expect(lythoshiHexToLyth("")).toBe(0);
    expect(lythoshiHexToLyth("0x")).toBe(0);
    expect(lythoshiHexToLyth("not-hex")).toBe(0);
  });
});
