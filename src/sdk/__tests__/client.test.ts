import { describe, expect, it } from "vitest";
import { lythoshiHexToLyth } from "../client";

describe("lythoshiHexToLyth", () => {
  it("uses 8-decimal native lythoshi units", () => {
    expect(lythoshiHexToLyth("0x5f5e100")).toBe(1);
    expect(lythoshiHexToLyth("0x1")).toBe(0.00000001);
    expect(lythoshiHexToLyth("0xf4240")).toBe(0.01);
  });

  it("returns zero for missing or malformed quantities", () => {
    expect(lythoshiHexToLyth("")).toBe(0);
    expect(lythoshiHexToLyth("0x")).toBe(0);
    expect(lythoshiHexToLyth("not-hex")).toBe(0);
  });
});
