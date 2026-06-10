/**
 * staking seam — delegation-precompile calldata + PLAINTEXT submit.
 *
 * After the v5 SDK bump the wallet's hand-rolled STAKING_SELECTORS and
 * flat-uint256 encoders were REPLACED by the SDK delegation encoders.
 * After the 0.3.11 bump the submit path is PLAINTEXT (mesh_submitTx). These
 * tests pin the wallet wrappers to the SDK ABI + plaintext path:
 *   - buildDelegateCalldata / buildUndelegateCalldata match the SDK encoders
 *     (selectors 0x662337de / 0x914f3ca8)
 *   - undelegate takes the cluster ONLY (no weightBps arg)
 *   - submitStakingTx posts to delegationAddressHex() via the PLAINTEXT
 *     mesh_submitTx path (NOT lyth_submitEncrypted), driving
 *     nonce/chainId -> live fee quote -> submit
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  addressToTypedBech32,
  delegationAddressHex,
  encodeDelegateCalldata,
  encodeUndelegateCalldata,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import {
  type MlDsa65Backend,
  type NativeEvmTxFields,
  buildPlaintextSubmission,
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

const MOCK_CHAIN_ID = 0x10f2cn; // 69420
const MOCK_NONCE = 0x7n;
const MOCK_UNIT_PRICE = 2_000n;
const MOCK_MAX_FEE = 6_000n; // 2000 quote × 3 safety multiplier
// staking default limit (see DELEGATION_DEFAULT_EXECUTION_UNIT_LIMIT).
const STAKING_LIMIT = 100_000n;

interface CapturedCall {
  method: string;
  params: unknown[];
}

// NON-CUSTODIAL: delegation is always submitted with value = 0.
function expectedTxFields(data: string): NativeEvmTxFields {
  const toHexNum = (n: bigint) => "0x" + n.toString(16);
  return {
    chainId: toHexNum(MOCK_CHAIN_ID),
    nonce: toHexNum(MOCK_NONCE),
    gasLimit: toHexNum(STAKING_LIMIT),
    maxFeePerGas: toHexNum(MOCK_MAX_FEE),
    maxPriorityFeePerGas: toHexNum(MOCK_MAX_FEE),
    to: delegationAddressHex(),
    value: toHexNum(0n),
    input: data,
  };
}

function expectedTxHash(backend: MlDsa65Backend, data: string): string {
  return buildPlaintextSubmission({
    backend,
    tx: expectedTxFields(data),
  }).innerTxHashHex;
}

function buildMockFetch(observed: CapturedCall[], meshEchoHash: string): typeof fetch {
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
      case "lyth_executionUnitPrice":
        result = {
          executionUnitPriceLythoshi: MOCK_UNIT_PRICE.toString(),
          basePricePerExecutionUnitLythoshi: "1000",
          priorityTipLythoshi: "1000",
          source: "latest_block",
        };
        break;
      case "mesh_submitTx":
        result = meshEchoHash;
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

function installProvider(observed: CapturedCall[], meshEchoHash: string) {
  const fetchFn = buildMockFetch(observed, meshEchoHash);
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

describe("submitStakingTx — PLAINTEXT submit", () => {
  it("posts to delegationAddressHex() via mesh_submitTx (not encrypted)", async () => {
    const observed: CapturedCall[] = [];
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    const data = buildDelegateCalldata(5, 1000);
    const hash = expectedTxHash(backend, data);
    installProvider(observed, hash);

    const result = await submitStakingTx({
      fromBech32m: SELF_TYPED,
      data,
      unlockBackend: async () => backend,
    });

    expect(result.txHash).toBe(hash);

    // Reads run first, then the live fee quote, then the plaintext submit.
    const methods = observed.map((c) => c.method);
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("lyth_executionUnitPrice");
    expect(methods).not.toContain("lyth_getEncryptionKey");
    expect(methods).not.toContain("lyth_submitEncrypted");
    expect(methods[methods.length - 1]).toBe("mesh_submitTx");

    expect(delegationAddressHex()).toBe(
      "0x000000000000000000000000000000000000100a",
    );

    // Sanity: the from-address hex is the typed user address (no leak of
    // the encrypted path's encryption-key fetch).
    expect(typedBech32ToAddress(SELF_TYPED, "user").hex).toBe(SELF_HEX);
  });

  it("sends a delegate with value = 0 (non-custodial — no escrow)", async () => {
    const observed: CapturedCall[] = [];
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    const data = buildDelegateCalldata(3, 2500);
    // expectedTxHash pins value = 0; if the wallet attached any native value
    // the reconstructed hash would not match and SDK echo-validation throws.
    const hash = expectedTxHash(backend, data);
    installProvider(observed, hash);

    const result = await submitStakingTx({
      fromBech32m: SELF_TYPED,
      data,
      unlockBackend: async () => backend,
    });
    expect(result.txHash).toBe(hash);
  });
});
