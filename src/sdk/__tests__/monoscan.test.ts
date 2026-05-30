// Monoscan URL builders + activity-detail helpers — pure, deterministic
// surfaces pinned so the explorer base / hash-route shape can't drift away
// from the other wallet surfaces, and the truncation/relative-time helpers
// keep their byte-for-byte behaviour.

import { describe, expect, it } from "vitest";
import {
  MONOSCAN_ADDRESS_BASE,
  MONOSCAN_TX_BASE,
  monoscanAddressUrl,
  monoscanTxUrl,
} from "../monoscan";
import { relativeMs, truncMiddle } from "../../components/ActivityDetailSheet";

describe("monoscan URL builders", () => {
  it("uses the shared hash-routed explorer base for tx pages", () => {
    expect(MONOSCAN_TX_BASE).toBe("https://monoscan.xyz/#/tx/");
    expect(monoscanTxUrl("0xabc123")).toBe("https://monoscan.xyz/#/tx/0xabc123");
  });

  it("uses the shared hash-routed explorer base for address pages", () => {
    expect(MONOSCAN_ADDRESS_BASE).toBe("https://monoscan.xyz/#/wallet/");
    expect(monoscanAddressUrl("mono1qy")).toBe(
      "https://monoscan.xyz/#/wallet/mono1qy",
    );
  });
});

describe("truncMiddle", () => {
  it("leaves short strings untouched", () => {
    expect(truncMiddle("mono1abc")).toBe("mono1abc");
  });

  it("middle-truncates long strings with the default head/tail", () => {
    const long = "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46xyz";
    expect(truncMiddle(long)).toBe("mono1qypfs…c46xyz");
  });

  it("honours custom head/tail lengths", () => {
    expect(truncMiddle("0123456789abcdef", 4, 4)).toBe("0123…cdef");
  });
});

describe("relativeMs", () => {
  it("renders seconds under a minute", () => {
    expect(relativeMs(Date.now() - 5_000)).toBe("5s ago");
  });

  it("renders minutes under an hour", () => {
    expect(relativeMs(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("renders hours beyond an hour", () => {
    expect(relativeMs(Date.now() - 3 * 3_600_000)).toBe("3h ago");
  });

  it("clamps future timestamps to 0s", () => {
    expect(relativeMs(Date.now() + 10_000)).toBe("0s ago");
  });
});
