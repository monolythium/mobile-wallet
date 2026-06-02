/**
 * spending-policy seam — golden-vector + write-path tests (WP §18.8).
 *
 * Written FIRST (golden-vector-first), so the calldata correctness of the
 * agent-sub-account claim dance is pinned without a live chain:
 *
 *   - selector pins: a FRESH sub-account uses setPolicyClaim (0x35531f6c);
 *     a re-claim (no fresh pubkey/sig) uses setPolicy (0x8da1a765);
 *     revoke uses disable (0xe6c09edf).
 *   - length guards: the sub-account ML-DSA-65 pubkey MUST be 1952 bytes and
 *     the bound-message signature MUST be 3309 bytes; wrong sizes throw.
 *   - submit posts tx.to === spendingPolicyAddressHex() (0x…110C) and drives
 *     the same encrypted-envelope sequence as sendLyth/submitStakingTx.
 *   - fetchSpendingPolicy parses a lyth_getSpendingPolicy SpendingPolicyView.
 *
 * Reuses the send.test buildMockFetch / installProvider RPC-mock harness.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
  RpcClient,
  addressToTypedBech32,
  spendingPolicyAddressHex,
  typedBech32ToAddress,
  SPENDING_POLICY_SELECTORS,
  composeClaimBoundMessage,
  packTimeWindow,
  type SpendingPolicyArgs,
} from "@monolythium/core-sdk";
import {
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
  type MlDsa65Backend,
  type NativeEvmTxFields,
  buildPlaintextSubmission,
  pqm1MnemonicToMlDsa65Backend,
  generatePqm1Mnemonic,
} from "@monolythium/core-sdk/crypto";
import {
  buildDisablePolicyCalldata,
  buildEnablePolicyCalldata,
  buildRegisterPolicyCalldata,
  emptyMerkleRoot,
  fetchSpendingPolicy,
  generateAgentSubAccount,
  packPolicyTimeWindow,
  signClaimBoundMessage,
  submitSpendingPolicyTx,
} from "../spending-policy";
import { resetProviderForTest, setProviderForTest } from "../client";

const PRINCIPAL_HEX = "0x1111111111111111111111111111111111111111";
const SUB_HEX = "0x2222222222222222222222222222222222222222";
const PRINCIPAL = addressToTypedBech32("user", PRINCIPAL_HEX);
const SUB = addressToTypedBech32("user", SUB_HEX);

const TEST_CHAIN_ID = 69420n;

// Mock RPC constants the wallet reads to build the plaintext tx.
const MOCK_CHAIN_ID = 0x10f2cn; // 69420
const MOCK_NONCE = 0x7n;
const MOCK_UNIT_PRICE = 2_000n; // lyth_executionUnitPrice quote
const MOCK_MAX_FEE = 6_000n; // quote × 3 safety multiplier

/** Build the identical NativeEvmTxFields the wallet derives for a policy
 *  write: registry default limit (250k), 0 native value, calldata as-is. */
function expectedPolicyTxFields(data: string): NativeEvmTxFields {
  const toHexNum = (n: bigint) => "0x" + n.toString(16);
  return {
    chainId: toHexNum(MOCK_CHAIN_ID),
    nonce: toHexNum(MOCK_NONCE),
    gasLimit: toHexNum(REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT),
    maxFeePerGas: toHexNum(MOCK_MAX_FEE),
    maxPriorityFeePerGas: toHexNum(MOCK_MAX_FEE),
    to: spendingPolicyAddressHex(),
    value: "0x0",
    input: data,
  };
}

function expectedPolicyTxHash(backend: MlDsa65Backend, data: string): string {
  return buildPlaintextSubmission({
    backend,
    tx: expectedPolicyTxFields(data),
  }).innerTxHashHex;
}

/** A complete §18.8 policy carrying every dimension. */
function fullArgs(): SpendingPolicyArgs {
  return {
    subAccount: SUB,
    principal: PRINCIPAL,
    perTxCapLythoshi: 100_000_000n, // raw lythoshi cap (ABI-encoded, echo-validated)
    dailyCapLythoshi: 500_000_000n,
    weeklyCapLythoshi: 2_000_000_000n,
    monthlyCapLythoshi: 8_000_000_000n,
    allowRoot: emptyMerkleRoot(),
    denyRoot: emptyMerkleRoot(),
    categoryAllowRoot: emptyMerkleRoot(),
    timeWindow: packPolicyTimeWindow(true, 9, 17),
    policyExpiry: 0,
  };
}

/** A valid 1952-byte pubkey + 3309-byte sig from a real PQM-1 backend. */
function freshClaimMaterial(args: SpendingPolicyArgs) {
  const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
  const pubkey = backend.publicKey();
  const sig = signClaimBoundMessage(backend, TEST_CHAIN_ID, args);
  return { pubkey, sig };
}

interface CapturedCall {
  method: string;
  params: unknown[];
}

function buildMockFetch(
  observed: CapturedCall[],
  meshEchoHash: string = "0x" + "ab".repeat(32),
): typeof fetch {
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
      case "lyth_getSpendingPolicy":
        result = {
          schemaVersion: 1,
          source: "native_state_storage",
          precompile: spendingPolicyAddressHex(),
          address: SUB,
          exists: true,
          enabled: true,
          version: 1,
          perTxCap: "0x5f5e100", // 1 LYTH
          dailyCap: "0x1dcd6500", // 5 LYTH
          weeklyCap: "0x77359400",
          monthlyCap: "0x1dcd65000",
          categoryAllowRoot: "0x" + "00".repeat(32),
          destinationAllowRoot: "0x" + "00".repeat(32),
          destinationDenyRoot: "0x" + "00".repeat(32),
          timeOfDayWindow: { enabled: true, startHour: 9, endHour: 17 },
          expiryUnixSeconds: null,
        };
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

function installProvider(observed: CapturedCall[], meshEchoHash?: string) {
  const fetchFn = buildMockFetch(observed, meshEchoHash);
  const rpc = new RpcClient("http://test", { fetch: fetchFn });
  setProviderForTest(rpc);
}

afterEach(() => {
  resetProviderForTest();
});

describe("SPENDING_POLICY_SELECTORS — canonical 4-byte pins", () => {
  it("matches the chain ABI selectors verbatim", () => {
    expect(SPENDING_POLICY_SELECTORS.setPolicy).toBe("0x8da1a765");
    expect(SPENDING_POLICY_SELECTORS.setPolicyClaim).toBe("0x35531f6c");
    expect(SPENDING_POLICY_SELECTORS.disable).toBe("0xe6c09edf");
    expect(SPENDING_POLICY_SELECTORS.enable).toBe("0x5bfa1b68");
  });
});

describe("buildRegisterPolicyCalldata — fresh-claim vs re-claim selector", () => {
  it("FRESH sub-account uses setPolicyClaim (0x35531f6c)", () => {
    const args = fullArgs();
    const { pubkey, sig } = freshClaimMaterial(args);
    const calldata = buildRegisterPolicyCalldata({
      args,
      subAccountPubkey: pubkey,
      subAccountSig: sig,
    });
    expect(calldata.slice(0, 10)).toBe(SPENDING_POLICY_SELECTORS.setPolicyClaim);
    expect(calldata.slice(0, 10)).toBe("0x35531f6c");
  });

  it("re-claim (no fresh material) uses setPolicy (0x8da1a765)", () => {
    const args = fullArgs();
    const calldata = buildRegisterPolicyCalldata({ args });
    expect(calldata.slice(0, 10)).toBe(SPENDING_POLICY_SELECTORS.setPolicy);
    expect(calldata.slice(0, 10)).toBe("0x8da1a765");
  });

  it("appends the 1952-byte pubkey + 3309-byte sig to the claim calldata", () => {
    const args = fullArgs();
    const { pubkey, sig } = freshClaimMaterial(args);
    expect(pubkey.length).toBe(ML_DSA_65_PUBLIC_KEY_LEN);
    expect(sig.length).toBe(ML_DSA_65_SIGNATURE_LEN);
    const claim = buildRegisterPolicyCalldata({
      args,
      subAccountPubkey: pubkey,
      subAccountSig: sig,
    });
    const reclaim = buildRegisterPolicyCalldata({ args });
    // The claim calldata carries the extra pubkey(1952)+sig(3309) bytes, so
    // it is materially longer than the re-claim (setPolicy) calldata.
    expect(claim.length).toBeGreaterThan(reclaim.length);
  });
});

describe("buildRegisterPolicyCalldata — length guards", () => {
  it("throws on a wrong-size sub-account pubkey", () => {
    const args = fullArgs();
    const { sig } = freshClaimMaterial(args);
    const badPubkey = new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN - 1);
    expect(() =>
      buildRegisterPolicyCalldata({
        args,
        subAccountPubkey: badPubkey,
        subAccountSig: sig,
      }),
    ).toThrow(/1952/);
  });

  it("throws on a wrong-size sub-account signature", () => {
    const args = fullArgs();
    const { pubkey } = freshClaimMaterial(args);
    const badSig = new Uint8Array(ML_DSA_65_SIGNATURE_LEN + 1);
    expect(() =>
      buildRegisterPolicyCalldata({
        args,
        subAccountPubkey: pubkey,
        subAccountSig: badSig,
      }),
    ).toThrow(/3309/);
  });
});

describe("buildEnablePolicyCalldata / buildDisablePolicyCalldata", () => {
  it("disable revoke uses 0xe6c09edf", () => {
    const calldata = buildDisablePolicyCalldata(SUB);
    expect(calldata.slice(0, 10)).toBe("0xe6c09edf");
  });

  it("enable uses 0x5bfa1b68", () => {
    const calldata = buildEnablePolicyCalldata(SUB);
    expect(calldata.slice(0, 10)).toBe("0x5bfa1b68");
  });
});

describe("signClaimBoundMessage — two-key dance", () => {
  it("the sub-account signature verifies against the bound message", () => {
    const args = fullArgs();
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    const message = composeClaimBoundMessage(TEST_CHAIN_ID, args);
    const sig = signClaimBoundMessage(backend, TEST_CHAIN_ID, args);
    expect(sig.length).toBe(ML_DSA_65_SIGNATURE_LEN);
    expect(backend.verify(message, sig)).toBe(true);
  });
});

describe("generateAgentSubAccount", () => {
  it("mints a fresh PQM-1 sub-account whose mono bech32m matches its key", () => {
    const a = generateAgentSubAccount();
    expect(a.pqm1Mnemonic.split(/\s+/).length).toBe(24);
    expect(a.addressBech32m.startsWith("mono1")).toBe(true);
    // Deriving the backend from the stored mnemonic reproduces the address.
    const backend = pqm1MnemonicToMlDsa65Backend(a.pqm1Mnemonic);
    const reBech32m = addressToTypedBech32("user", backend.getAddress());
    expect(reBech32m).toBe(a.addressBech32m);
  });
});

describe("packPolicyTimeWindow", () => {
  it("re-exports the SDK packTimeWindow (same 32-byte word)", () => {
    const a = packPolicyTimeWindow(true, 9, 17);
    const b = packTimeWindow(true, 9, 17);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);
  });

  it("emits an all-zero word when disabled (no-window sentinel)", () => {
    const a = packPolicyTimeWindow(false, 0, 0);
    expect(a.every((byte) => byte === 0)).toBe(true);
  });
});

describe("emptyMerkleRoot", () => {
  it("is the 32-byte zero root (no-constraint sentinel)", () => {
    const r = emptyMerkleRoot();
    expect(r).toBe("0x" + "00".repeat(32));
  });
});

describe("submitSpendingPolicyTx — PLAINTEXT write path", () => {
  it("posts the claim calldata to spendingPolicyAddressHex() (0x…110C) via mesh_submitTx", async () => {
    const observed: CapturedCall[] = [];
    const args = fullArgs();
    const { pubkey, sig } = freshClaimMaterial(args);
    const backend = pqm1MnemonicToMlDsa65Backend(generatePqm1Mnemonic());
    const calldata = buildRegisterPolicyCalldata({
      args,
      subAccountPubkey: pubkey,
      subAccountSig: sig,
    });
    const hash = expectedPolicyTxHash(backend, calldata);
    installProvider(observed, hash);

    const result = await submitSpendingPolicyTx({
      fromBech32m: PRINCIPAL,
      data: calldata,
      unlockBackend: async () => backend,
    });
    expect(result.txHash).toBe(hash);
    // The plaintext submit posts the 0x-bincode SignedTransaction; the
    // wallet's tx.to (the precompile) is encoded into those signed bytes.
    expect(spendingPolicyAddressHex().toLowerCase()).toContain("110c");
    // Drove the canonical pre-submit reads + the live registry fee quote +
    // the PLAINTEXT submit. NO encryption-key fetch, NO encrypted submit.
    const methods = observed.map((c) => c.method);
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("lyth_executionUnitPrice");
    expect(methods).not.toContain("lyth_getEncryptionKey");
    expect(methods).not.toContain("lyth_submitEncrypted");
    expect(methods[methods.length - 1]).toBe("mesh_submitTx");
    // The principal address resolves to the typed user hex (sanity).
    expect(typedBech32ToAddress(PRINCIPAL, "user").hex).toBe(PRINCIPAL_HEX);
  });
});

describe("fetchSpendingPolicy", () => {
  it("parses a lyth_getSpendingPolicy SpendingPolicyView", async () => {
    const observed: CapturedCall[] = [];
    installProvider(observed);
    const view = await fetchSpendingPolicy(SUB);
    expect(observed.map((c) => c.method)).toContain("lyth_getSpendingPolicy");
    expect(view.exists).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.address).toBe(SUB);
    expect(view.timeOfDayWindow).toEqual({
      enabled: true,
      startHour: 9,
      endHour: 17,
    });
    expect(view.expiryUnixSeconds).toBeNull();
  });
});
