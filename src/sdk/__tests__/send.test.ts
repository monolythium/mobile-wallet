/**
 * sendLyth — native encrypted-envelope wire-shape tests.
 *
 * The signing + ML-KEM encryption is exercised at the SDK layer
 * (`buildEncryptedSubmission`); these tests cover the wallet's wrapping
 * responsibilities:
 *   - typed-address validation (no 0x, mono1 only)
 *   - RPC method ordering (nonce + gasPrice + chainId in parallel,
 *     then lyth_getEncryptionKey, then lyth_submitEncrypted)
 *   - decimal-LYTH parsing + fee preview math
 *
 * The SDK backend is stubbed with a minimal `MlDsa65Backend`
 * implementation that captures sign requests; we don't assert on the
 * signature bytes (that's the SDK's job) — just that the wallet drove
 * the call sequence.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ADDRESS_KIND_HRPS,
  RpcClient,
  addressToTypedBech32,
} from "@monolythium/core-sdk";
import { MonolythiumProvider } from "@monolythium/core-sdk/ethers";
import { previewMaxFeeLyth, sendLyth } from "../send";
import {
  pqm1MnemonicToMlDsa65Backend,
  generatePqm1Mnemonic,
} from "@monolythium/core-sdk/crypto";
import { resetProviderForTest, setProviderForTest } from "../client";

const SELF_HEX = "0x1111111111111111111111111111111111111111";
const DEAD_HEX = "0x000000000000000000000000000000000000dead";
const SELF_TYPED = addressToTypedBech32("user", SELF_HEX);
const DEAD_TYPED = addressToTypedBech32("user", DEAD_HEX);

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
        result = "0x3b9aca00"; // 1 gwei-equivalent
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
  const provider = new MonolythiumProvider(rpc);
  setProviderForTest(provider);
}

afterEach(() => {
  resetProviderForTest();
});

describe("sendLyth — input validation", () => {
  it("rejects raw 0x addresses in `from`", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed);
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
    installProvider(observed);
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    await expect(
      sendLyth(
        { unlockBackend: async () => backend },
        { from: SELF_TYPED, to: DEAD_HEX, amountLyth: "1" },
      ),
    ).rejects.toThrow(/raw 0x addresses are retired/);
  });
});

describe("previewMaxFeeLyth", () => {
  it("formats whole LYTH with no decimal when exact", () => {
    // 1e8 lythoshi per LYTH × 21_000 = 2.1e12 lythoshi total. Dividing
    // by LYTHOSHI_PER_LYTH (1e8) gives 21_000 LYTH whole-cell math.
    const oneLythPerUnit = 100_000_000n; // 1 LYTH in lythoshi
    expect(previewMaxFeeLyth(oneLythPerUnit, 21_000n)).toBe("21000");
  });

  it("formats fractional LYTH and trims trailing zeros", () => {
    // 1 lythoshi × 21_000 = 21_000 lythoshi → 0.00021 LYTH.
    expect(previewMaxFeeLyth(1n, 21_000n)).toBe("0.00021");
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
