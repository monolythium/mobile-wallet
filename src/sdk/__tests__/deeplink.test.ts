import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../deeplink";

describe("parseDeepLink", () => {
  it("parses a Monoscan staking handoff", () => {
    const action = parseDeepLink("monolythium://stake?cluster=C-003&clusterId=3&chainId=69420");

    expect(action).toEqual({
      kind: "stake",
      cluster: "C-003",
      clusterId: 3,
      chainId: 69420,
      raw: "monolythium://stake?cluster=C-003&clusterId=3&chainId=69420",
    });
  });
});
