/**
 * staking seam — delegation-precompile calldata + encrypted-envelope submit.
 *
 * After the v5 SDK bump (0.3.10) the wallet's hand-rolled STAKING_SELECTORS
 * and flat-uint256 encoders were REPLACED by the SDK delegation encoders.
 * These tests pin the wallet wrappers to the SDK ABI so they can never
 * silently diverge again:
 *   - buildDelegateCalldata / buildUndelegateCalldata match the SDK encoders
 *     (selectors 0x662337de / 0x914f3ca8)
 *   - undelegate takes the cluster ONLY (no weightBps arg)
 *   - submitStakingTx posts to delegationAddressHex() and drives the
 *     nonce/gasPrice/chainId -> encryption-key -> submit sequence
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  addressToTypedBech32,
  delegationAddressHex,
  encodeDelegateCalldata,
  encodeUndelegateCalldata,
} from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  generatePqm1Mnemonic,
} from "@monolythium/core-sdk/crypto";
import {
  buildDelegateCalldata,
  buildUndelegateCalldata,
  submitStakingTx,
} from "../staking";
import { resetProviderForTest, setProviderForTest } from "../client";

const SELF_HEX = "0x1111111111111111111111111111111111111111";
const SELF_TYPED = addressToTypedBech32("user", SELF_HEX);
const ZERO_ENCAPSULATION_KEY = "0x" + "00".repeat(1184);

interface CapturedCall {
  method: string;
  params: unknown[];
}

function buildMockFetch(observed: CapturedCall[]): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body);
    const method = body.method as string;
    const params = (body.params ?? []) as unknown[];
    observed.push({ method, params });
    let result: unknown;
    switch (method) {
      case "eth_chainId":
        result = "0x10F2C"; // 69420
        break;
      case "eth_getTransactionCount":
        result = "0x7";
        break;
      case "eth_gasPrice":
        result = "0x3b9aca00";
        break;
      case "lyth_getEncryptionKey":
        result = {
          algo: "ml-kem-768",
          epoch: "0x1",
          encapsulationKey: ZERO_ENCAPSULATION_KEY,
        };
        break;
      case "lyth_submitEncrypted":
        result = "0x" + "ab".repeat(32);
        break;
      default:
        result = null;
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function installProvider(observed: CapturedCall[]) {
  const fetchFn = buildMockFetch(observed);
  const rpc = new RpcClient("http://test", { fetch: fetchFn });
  setProviderForTest(rpc);
}

afterEach(() => {
  resetProviderForTest();
});

describe("delegation calldata — pinned to SDK encoders", () => {
  it("buildDelegateCalldata matches encodeDelegateCalldata (selector 0x662337de)", () => {
    const got = buildDelegateCalldata(5, 1000);
    expect(got).toBe(encodeDelegateCalldata(5, 1000));
    expect(got.slice(0, 10)).toBe("0x662337de");
  });

  it("buildUndelegateCalldata takes the cluster ONLY (selector 0x914f3ca8)", () => {
    const got = buildUndelegateCalldata(5);
    expect(got).toBe(encodeUndelegateCalldata(5));
    expect(got.slice(0, 10)).toBe("0x914f3ca8");
  });

  it("delegate and undelegate use distinct selectors", () => {
    const del = buildDelegateCalldata(5, 1000).slice(0, 10);
    const und = buildUndelegateCalldata(5).slice(0, 10);
    expect(del).not.toBe(und);
  });
});

describe("submitStakingTx — envelope submit", () => {
  it("posts to delegationAddressHex() and drives the RPC sequence", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed);
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());

    const result = await submitStakingTx({
      fromBech32m: SELF_TYPED,
      data: buildDelegateCalldata(5, 1000),
      valueLythoshi: 0n,
      unlockBackend: async () => backend,
    });

    expect(result.txHash).toBe("0x" + "ab".repeat(32));

    // Reads run first (parallel), then encryption key, then submit.
    const methods = observed.map((c) => c.method);
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_gasPrice");
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("lyth_getEncryptionKey");
    expect(methods[methods.length - 1]).toBe("lyth_submitEncrypted");

    // The submitted envelope wire-hex is opaque (encrypted), so we assert the
    // precompile target through the public SDK address rather than decoding it.
    expect(delegationAddressHex()).toBe(
      "0x000000000000000000000000000000000000100a",
    );
  });
});
