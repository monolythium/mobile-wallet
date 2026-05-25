/**
 * sendLyth — wire-shape test against a stubbed mono-core node.
 *
 * The purpose isn't to re-test ethers; it's to verify that
 * `MonolythiumProvider` (the live SDK shim, NOT a mock) faithfully
 * pipes the four calls a Send LYTH needs through to the node:
 *
 *   1. eth_chainId         — from getNetwork()
 *   2. eth_getTransactionCount  (block tag "pending")
 *   3. eth_gasPrice / eth_maxPriorityFeePerGas (or eth_feeHistory)
 *   4. eth_sendRawTransaction
 *
 * The signer is a plain `MonolythiumSigner.fromEthersWallet(...)` so the
 * test doesn't need a real biometric/keystore round trip. The biometric
 * backend is exercised by the existing `signer.ts` shape — covered by
 * typecheck — and the device-only paths run on simulator/emulator in
 * Stage 5+.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { Wallet, keccak256 } from "ethers";
import {
  MONOLYTHIUM_TESTNET_CHAIN_ID,
  MonolythiumProvider,
  MonolythiumSigner,
  RpcClient,
  parseLythToLythoshi,
} from "@monolythium/core-sdk";
import { sendLyth } from "../send";
import { resetProviderForTest, setProviderForTest } from "../client";

/**
 * Deterministic private key — keeps tests reproducible across runs and
 * sidesteps `Wallet.createRandom()`'s Node-Buffer interplay under jsdom.
 * The address is `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (Anvil's
 * default account #0).
 */
const TEST_PRIVKEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface CapturedCall {
  method: string;
  params: unknown[];
}

interface MockState {
  chainId: bigint;
  blockNumber: bigint;
  baseFee: bigint;
  nonce: bigint;
  acceptedRawTxs: string[];
  observed: CapturedCall[];
}

function buildMockFetch(state: MockState): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body);
    const id = body.id ?? 0;
    const method = body.method as string;
    const params = (body.params ?? []) as unknown[];
    state.observed.push({ method, params });
    let result: unknown;
    switch (method) {
      case "eth_chainId":
        result = `0x${state.chainId.toString(16)}`;
        break;
      case "eth_blockNumber":
        result = `0x${state.blockNumber.toString(16)}`;
        break;
      case "eth_getTransactionCount":
        result = `0x${state.nonce.toString(16)}`;
        break;
      case "eth_gasPrice":
        result = `0x${state.baseFee.toString(16)}`;
        break;
      case "eth_maxPriorityFeePerGas":
        result = `0x${(state.baseFee / 2n).toString(16)}`;
        break;
      case "eth_feeHistory": {
        // ethers' getFeeData calls feeHistory + base+priority. We return a
        // shape that lets ethers compute (baseFeePerGas, priorityFee).
        result = {
          oldestBlock: `0x${state.blockNumber.toString(16)}`,
          baseFeePerGas: [
            `0x${state.baseFee.toString(16)}`,
            `0x${state.baseFee.toString(16)}`,
          ],
          gasUsedRatio: [0.5],
          reward: [[`0x${(state.baseFee / 2n).toString(16)}`]],
        };
        break;
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as string;
        state.acceptedRawTxs.push(raw);
        // Echo the canonical tx hash: ethers cross-checks
        // `keccak(rawTx)` against the node's reply and rejects on
        // mismatch (defense-in-depth against MITM hash swaps).
        result = keccak256(raw);
        break;
      }
      case "eth_getBlockByNumber":
        result = {
          number: `0x${state.blockNumber.toString(16)}`,
          baseFeePerGas: `0x${state.baseFee.toString(16)}`,
          hash: `0x${"b".repeat(64)}`,
          parentHash: `0x${"c".repeat(64)}`,
          timestamp: "0x0",
          // ethers v6 needs these to construct a Block — empty defaults.
          transactions: [],
          extraData: "0x",
          stateRoot: `0x${"0".repeat(64)}`,
          transactionsRoot: `0x${"0".repeat(64)}`,
          receiptsRoot: `0x${"0".repeat(64)}`,
          logsBloom: `0x${"0".repeat(512)}`,
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          miner: `0x${"0".repeat(40)}`,
          nonce: "0x0000000000000000",
          mixHash: `0x${"0".repeat(64)}`,
          sha3Uncles: `0x${"0".repeat(64)}`,
          size: "0x0",
        };
        break;
      default:
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `unhandled: ${method}` },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

describe("sendLyth", () => {
  let state: MockState;

  beforeEach(() => {
    state = {
      chainId: MONOLYTHIUM_TESTNET_CHAIN_ID,
      blockNumber: 1024n,
      baseFee: 1_000_000_000n, // compatibility base fee sample
      nonce: 7n,
      acceptedRawTxs: [],
      observed: [],
    };
    resetProviderForTest();
  });

  it("round-trips through eth_getTransactionCount + eth_sendRawTransaction", async () => {
    const fetchStub = buildMockFetch(state);
    // We construct a provider directly instead of using getProvider()
    // so the test owns the fetch transport. send.ts pulls its provider
    // from the wallet's client module — `setProviderForTest` swaps in
    // the stub-fetch instance for the duration of this test.
    const provider = new MonolythiumProvider(
      new RpcClient("http://test.invalid", { fetch: fetchStub }),
    );
    setProviderForTest(provider);

    // A throwaway wallet for the test — we only care about the wire,
    // not the keys. ethers' signTransaction produces a real RLP that
    // any node would accept (modulo balance/state).
    const wallet = new Wallet(TEST_PRIVKEY);
    const signer = MonolythiumSigner.fromEthersWallet(wallet, provider);

    const result = await sendLyth(signer, {
      from: wallet.address,
      to: "0x000000000000000000000000000000000000dead",
      amountLyth: "0.001",
    });

    // Hash matches the canonical keccak of the broadcast raw tx (ethers
    // cross-checks; we just verify it round-tripped clean).
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.txHash).toBe(keccak256(state.acceptedRawTxs[0]!));
    // Exactly one raw tx hit the wire.
    expect(state.acceptedRawTxs).toHaveLength(1);
    // The raw tx is a 0x-prefixed EIP-1559 envelope — first byte after
    // 0x is the type (0x02 for EIP-1559).
    expect(state.acceptedRawTxs[0]?.startsWith("0x02")).toBe(true);

    // Round-trip should have observed all four core RPC methods.
    const methods = state.observed.map((c) => c.method);
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_sendRawTransaction");

    // The TransactionRequest snapshot returned to the caller carries
    // EIP-1559 fee fields (the only mode the chain accepts) and the
    // testnet chain id.
    expect(result.request.type).toBe(2);
    expect(result.request.chainId).toBe(MONOLYTHIUM_TESTNET_CHAIN_ID);
    expect(result.request.value).toBe(parseLythToLythoshi("0.001"));
    expect(result.request.gasLimit).toBe(21_000n);
    expect(result.request.maxFeePerGas).toBeDefined();
    expect(result.request.maxPriorityFeePerGas).toBeDefined();
  });

  it("throws when the node has no native execution fee data", async () => {
    // Build a fetch stub that returns null fee fields; ethers' getFeeData
    // surfaces null/null in that case, which our send composer must reject
    // (the chain is EIP-1559-only).
    const localFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const id = body.id ?? 0;
      const method = body.method as string;
      let result: unknown;
      switch (method) {
        case "eth_chainId":
          result = `0x${MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16)}`;
          break;
        case "eth_blockNumber":
          result = "0x1";
          break;
        case "eth_getTransactionCount":
          result = "0x0";
          break;
        case "eth_gasPrice":
          // Sentinel that produces null in feeData by failing the
          // EIP-1559 path inside ethers.
          result = "0x0";
          break;
        case "eth_getBlockByNumber":
          // Pre-1559 block (no baseFeePerGas). Triggers ethers' "no
          // EIP-1559" branch, which sets max{Priority,}FeePerGas to null.
          result = {
            number: "0x1",
            hash: `0x${"d".repeat(64)}`,
            parentHash: `0x${"e".repeat(64)}`,
            timestamp: "0x0",
            transactions: [],
            extraData: "0x",
            stateRoot: `0x${"0".repeat(64)}`,
            transactionsRoot: `0x${"0".repeat(64)}`,
            receiptsRoot: `0x${"0".repeat(64)}`,
            logsBloom: `0x${"0".repeat(512)}`,
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            difficulty: "0x0",
            totalDifficulty: "0x0",
            miner: `0x${"0".repeat(40)}`,
            nonce: "0x0000000000000000",
            mixHash: `0x${"0".repeat(64)}`,
            sha3Uncles: `0x${"0".repeat(64)}`,
            size: "0x0",
          };
          break;
        default:
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `unhandled: ${method}` },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, result }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new MonolythiumProvider(
      new RpcClient("http://test.invalid", { fetch: localFetch }),
    );
    setProviderForTest(provider);
    const wallet = new Wallet(TEST_PRIVKEY);
    const signer = MonolythiumSigner.fromEthersWallet(wallet, provider);
    await expect(
      sendLyth(signer, {
        from: wallet.address,
        to: "0x000000000000000000000000000000000000dead",
        amountLyth: "0.001",
      }),
    ).rejects.toThrow(/native execution fee data/);
  });
});
