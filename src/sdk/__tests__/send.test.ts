/**
 * sendLyth — native PLAINTEXT submit (SDK 0.3.11 default) wire-shape tests.
 *
 * The signing + serialization is exercised at the SDK layer
 * (`buildPlaintextSubmission` / `submitTransactionWithPrivacy`); these
 * tests cover the wallet's wrapping responsibilities:
 *   - typed-address validation (no 0x, mono1 only)
 *   - DEFAULT submit path is PLAINTEXT: nonce + chainId reads, then the
 *     live `lyth_executionUnitPrice` fee quote, then a single
 *     `mesh_submitTx` (NOT `lyth_submitEncrypted`)
 *   - the node-echoed canonical tx hash is validated by the SDK, so the
 *     mock echoes the locally computed hash (reconstructed in-test the
 *     same way the wallet builds it)
 *   - decimal-LYTH parsing + fee preview math
 *
 * The SDK backend is a real `MlDsa65Backend` from a generated PQM-1
 * mnemonic; the tx fields the wallet derives from the mock RPC are
 * deterministic, so the expected canonical hash is reproducible.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ADDRESS_KIND_HRPS,
  RpcClient,
  TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT,
  addressToTypedBech32,
  parseLythToLythoshi,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import { previewMaxFeeLyth, sendLyth } from "../send";
import {
  type MlDsa65Backend,
  type NativeEvmTxFields,
  buildPlaintextSubmission,
  pqm1MnemonicToMlDsa65Backend,
  generatePqm1Mnemonic,
} from "@monolythium/core-sdk/crypto";
import { resetProviderForTest, setProviderForTest } from "../client";

const SELF_HEX = "0x1111111111111111111111111111111111111111";
const DEAD_HEX = "0x000000000000000000000000000000000000dead";
const SELF_TYPED = addressToTypedBech32("user", SELF_HEX);
const DEAD_TYPED = addressToTypedBech32("user", DEAD_HEX);

// Mock RPC constants the wallet reads to build the tx. Kept here so the
// test can reconstruct the identical NativeEvmTxFields.
const MOCK_CHAIN_ID = 0x10f2cn; // 69420
const MOCK_NONCE = 0x7n;
const MOCK_UNIT_PRICE = 2_000n; // lyth_executionUnitPrice quote
// resolveExecutionFee: quote × 3 safety multiplier = 6000 per-unit cap;
// the default tip equals the cap.
const MOCK_MAX_FEE = 6_000n;

interface CapturedCall {
  method: string;
  params: unknown[];
}

/** Build the identical NativeEvmTxFields the wallet derives for a send. */
function expectedTxFields(toBech32m: string, amountLyth: string): NativeEvmTxFields {
  const toHex = typedBech32ToAddress(toBech32m, "user").hex;
  const toHexNum = (n: bigint) => "0x" + n.toString(16);
  return {
    chainId: toHexNum(MOCK_CHAIN_ID),
    nonce: toHexNum(MOCK_NONCE),
    gasLimit: toHexNum(TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT),
    maxFeePerGas: toHexNum(MOCK_MAX_FEE),
    maxPriorityFeePerGas: toHexNum(MOCK_MAX_FEE),
    to: toHex,
    value: toHexNum(parseLythToLythoshi(amountLyth)),
    input: "0x",
  };
}

/** Canonical tx hash the node must echo for a plaintext submit to pass. */
function expectedTxHash(
  backend: MlDsa65Backend,
  toBech32m: string,
  amountLyth: string,
): string {
  return buildPlaintextSubmission({
    backend,
    tx: expectedTxFields(toBech32m, amountLyth),
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
        // Echo the locally computed canonical hash so the SDK's
        // validation passes (mismatch throws).
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

describe("sendLyth — input validation", () => {
  it("rejects raw 0x addresses in `from`", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed, "0x" + "00".repeat(32));
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    await expect(
      sendLyth(
        { unlockBackend: async () => backend },
        { from: SELF_HEX, to: DEAD_TYPED, amountLyth: "1" },
      ),
    ).rejects.toThrow(/raw 0x addresses are retired/);
    expect(observed).toEqual([]);
  });

  it("rejects raw 0x addresses in `to`", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed, "0x" + "00".repeat(32));
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    await expect(
      sendLyth(
        { unlockBackend: async () => backend },
        { from: SELF_TYPED, to: DEAD_HEX, amountLyth: "1" },
      ),
    ).rejects.toThrow(/raw 0x addresses are retired/);
  });
});

describe("sendLyth — DEFAULT path is PLAINTEXT", () => {
  it("submits via mesh_submitTx (NOT lyth_submitEncrypted) by default", async () => {
    const observed: CapturedCall[] = [];
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    const amountLyth = "1.5";
    const hash = expectedTxHash(backend, DEAD_TYPED, amountLyth);
    installProvider(observed, hash);

    const result = await sendLyth(
      { unlockBackend: async () => backend },
      { from: SELF_TYPED, to: DEAD_TYPED, amountLyth },
    );

    expect(result.txHash).toBe(hash);
    expect(result.encrypted).toBe(false);

    const methods = observed.map((c) => c.method);
    // Reads first (nonce + chainId), then the live fee quote, then the
    // single plaintext submit. NO encryption key fetch, NO encrypted submit.
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("lyth_executionUnitPrice");
    expect(methods).not.toContain("lyth_getEncryptionKey");
    expect(methods).not.toContain("lyth_submitEncrypted");
    expect(methods[methods.length - 1]).toBe("mesh_submitTx");

    // The submitted wire is the 0x-prefixed bincode SignedTransaction.
    const submitCall = observed.find((c) => c.method === "mesh_submitTx");
    expect(submitCall).toBeDefined();
    const wire = (submitCall!.params as string[])[0] ?? "";
    expect(typeof wire).toBe("string");
    expect(wire.startsWith("0x")).toBe(true);
  });

  it("uses the SDK sane transfer limit (100k), not the old 21k floor", async () => {
    const observed: CapturedCall[] = [];
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    const amountLyth = "2";
    const hash = expectedTxHash(backend, DEAD_TYPED, amountLyth);
    installProvider(observed, hash);

    // The reconstruction above pins gasLimit to the SDK default; if the
    // wallet had used 21k the hash would not match and submit would throw.
    await expect(
      sendLyth(
        { unlockBackend: async () => backend },
        { from: SELF_TYPED, to: DEAD_TYPED, amountLyth },
      ),
    ).resolves.toMatchObject({ txHash: hash });

    expect(TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT).toBe(100_000n);
  });
});

describe("previewMaxFeeLyth", () => {
  it("formats whole LYTH with no decimal when exact", () => {
    // 1e18 lythoshi per LYTH × 21_000 = 2.1e22 lythoshi total. Dividing
    // by LYTHOSHI_PER_LYTH (1e18) gives 21_000 LYTH whole-cell math.
    const oneLythPerUnit = 1_000_000_000_000_000_000n; // 1 LYTH in lythoshi
    expect(previewMaxFeeLyth(oneLythPerUnit, 21_000n)).toBe("21000");
  });

  it("formats fractional LYTH and trims trailing zeros", () => {
    // 1 lythoshi × 21_000 = 21_000 lythoshi → 0.000000000000021 LYTH
    // at native 18-decimal precision.
    expect(previewMaxFeeLyth(1n, 21_000n)).toBe("0.000000000000021");
  });

  it("returns 0 when fee × limit = 0", () => {
    expect(previewMaxFeeLyth(0n, 21_000n)).toBe("0");
    expect(previewMaxFeeLyth(100n, 0n)).toBe("0");
  });
});

describe("HRP constant", () => {
  it("user HRP is `mono` per ADR-0038", () => {
    expect(ADDRESS_KIND_HRPS.user).toBe("mono");
  });
});
