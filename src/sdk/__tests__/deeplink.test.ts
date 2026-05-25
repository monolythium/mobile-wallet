import { describe, expect, it } from "vitest";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import { parseDeepLink, type DeepLinkAction, type UnknownAction } from "../deeplink";

const USER = addressToTypedBech32("user", "0x1111111111111111111111111111111111111111");
const CONTRACT = addressToTypedBech32("contract", "0x2222222222222222222222222222222222222222");

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

  it("parses monolythium send links with typed recipient and token HRPs", () => {
    const raw = `monolythium://send?to=${USER}&value=12.5&token=${CONTRACT}&chainId=69420`;
    const action = parseDeepLink(raw);

    expect(action).toEqual({
      kind: "send",
      to: USER,
      value: "12.5",
      token: CONTRACT,
      chainId: 69420,
      raw,
    });
  });

  it("parses lyth shorthand only when the recipient is a typed mono address", () => {
    const raw = `lyth:${USER}?value=1`;
    const action = parseDeepLink(raw);

    expect(action).toEqual({
      kind: "send",
      to: USER,
      value: "1",
      token: undefined,
      chainId: undefined,
      raw,
    });
  });

  it("rejects raw 0x monolythium send recipients", () => {
    const action = parseDeepLink("monolythium://send?to=0x1111111111111111111111111111111111111111");

    expect(expectUnknown(action).reason).toMatch(/raw 0x addresses are retired/);
  });

  it("rejects wrong-HRP monolythium send recipients", () => {
    const action = parseDeepLink(`monolythium://send?to=${CONTRACT}`);

    expect(expectUnknown(action).reason).toMatch(/expected 'mono'/);
  });

  it("rejects raw 0x token contract parameters", () => {
    const action = parseDeepLink(
      `monolythium://send?to=${USER}&token=0x2222222222222222222222222222222222222222`,
    );

    expect(expectUnknown(action).reason).toMatch(/send.token raw 0x addresses are retired/);
  });

  it("rejects bare raw 0x address scans", () => {
    const action = parseDeepLink("0x1111111111111111111111111111111111111111");

    expect(expectUnknown(action).reason).toMatch(/raw 0x addresses are retired/);
  });

  it("rejects ethereum EIP-681 address scans instead of coercing them", () => {
    const action = parseDeepLink("ethereum:0x1111111111111111111111111111111111111111?value=1");

    expect(expectUnknown(action).reason).toMatch(/typed monolythium send link/);
  });
});

function expectUnknown(action: DeepLinkAction): UnknownAction {
  expect(action.kind).toBe("unknown");
  if (action.kind !== "unknown") {
    throw new Error(`expected unknown action, got ${action.kind}`);
  }
  return action;
}
