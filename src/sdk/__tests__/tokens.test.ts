/**
 * tokens seam — live MRC token-balance reads + honest display helpers.
 *
 * The Tokens screen lists the native LYTH row (sourced separately via
 * eth_getBalance) plus any indexed MRC balances the connected node serves
 * (`lyth_getTokenBalances` joined with `lyth_mrcMetadata`). These tests pin:
 *   - fetchTokenBalances classifies a served list as `available`, a
 *     method-disabled / method-not-found RPC error as `indexer_disabled`
 *     (an honest "offline", not a hard error), and any other failure as an
 *     `error` — never a fabricated balance.
 *   - formatTokenBalance applies metadata decimals client-side without a lossy
 *     Number round-trip, trimming trailing fractional zeros.
 *   - tokenDisplay / tokenMonogram fall back to a shortened token id when the
 *     indexer carries no name/symbol — never an invented label.
 */

import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "@monolythium/core-sdk";
import type { TokenBalanceWithMetadata } from "@monolythium/core-sdk";
import {
  fetchTokenBalances,
  formatTokenBalance,
  tokenDisplay,
  tokenMonogram,
} from "../tokens";
import { resetProviderForTest, setProviderForTest } from "../client";

const ADDR = "0x1111111111111111111111111111111111111111";
const TOKEN_ID =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

/** Build an RpcClient whose transport returns a per-method JSON-RPC response,
 *  driven by a `{ method: result }` map. A method present with `__error` is
 *  returned as a JSON-RPC error; absent methods 404 (transport error). */
function clientReturning(
  responses: Record<string, unknown>,
  errors: Record<string, { code: number; message: string }> = {},
): RpcClient {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const method: string = body.method;
    if (errors[method]) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: errors[method] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: responses[method] ?? null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return new RpcClient("https://stub.example/rpc", { fetch: fetchImpl });
}

afterEach(() => {
  resetProviderForTest();
});

describe("fetchTokenBalances", () => {
  it("returns the indexed list with coverage=available", async () => {
    setProviderForTest(
      clientReturning({
        lyth_getTokenBalances: [
          {
            tokenId: TOKEN_ID,
            balance: "1500000",
            updatedAtBlock: "0x10",
            mrc: { standard: "mrc20", assetId: TOKEN_ID, tokenId: null },
          },
        ],
        lyth_mrcMetadata: {
          schemaVersion: 1,
          assetId: TOKEN_ID,
          tokenId: null,
          metadata: {
            standard: "mrc20",
            assetId: TOKEN_ID,
            tokenId: null,
            name: "Test Token",
            symbol: "TST",
            decimals: 6,
            uri: null,
            updatedAtBlock: 16,
          },
        },
      }),
    );

    const res = await fetchTokenBalances(ADDR);
    expect(res.coverage).toBe("available");
    expect(res.error).toBeNull();
    expect(res.tokens).toHaveLength(1);
    const [first] = res.tokens;
    expect(first?.tokenId).toBe(TOKEN_ID);
    expect(first?.metadata?.symbol).toBe("TST");
  });

  it("returns coverage=available with an empty list when the wallet holds no MRC tokens", async () => {
    setProviderForTest(clientReturning({ lyth_getTokenBalances: [] }));
    const res = await fetchTokenBalances(ADDR);
    expect(res.coverage).toBe("available");
    expect(res.error).toBeNull();
    expect(res.tokens).toEqual([]);
  });

  it("maps a method-disabled RPC error to coverage=indexer_disabled (not an error)", async () => {
    setProviderForTest(
      clientReturning(
        {},
        { lyth_getTokenBalances: { code: -32045, message: "method disabled" } },
      ),
    );
    const res = await fetchTokenBalances(ADDR);
    expect(res.coverage).toBe("indexer_disabled");
    expect(res.error).toBeNull();
    expect(res.tokens).toEqual([]);
  });

  it("maps method-not-found (-32601) to coverage=indexer_disabled", async () => {
    setProviderForTest(
      clientReturning(
        {},
        { lyth_getTokenBalances: { code: -32601, message: "method not found" } },
      ),
    );
    const res = await fetchTokenBalances(ADDR);
    expect(res.coverage).toBe("indexer_disabled");
    expect(res.error).toBeNull();
  });

  it("surfaces an unrelated RPC error as a real error (coverage stays available)", async () => {
    setProviderForTest(
      clientReturning(
        {},
        { lyth_getTokenBalances: { code: -32000, message: "internal error" } },
      ),
    );
    const res = await fetchTokenBalances(ADDR);
    expect(res.coverage).toBe("available");
    expect(res.error).toContain("internal error");
    expect(res.tokens).toEqual([]);
  });
});

/** Minimal TokenBalanceWithMetadata factory for the pure-helper tests. */
function row(
  partial: Partial<TokenBalanceWithMetadata> & { balance: string },
): TokenBalanceWithMetadata {
  return {
    tokenId: TOKEN_ID,
    updatedAtBlock: 0n,
    metadata: null,
    ...partial,
  } as TokenBalanceWithMetadata;
}

describe("formatTokenBalance", () => {
  it("applies metadata decimals and trims trailing zeros", () => {
    // 1_500_000 atomic units at 6 decimals = 1.5
    expect(
      formatTokenBalance(row({ balance: "1500000", metadata: meta({ decimals: 6 }) })),
    ).toBe("1.5");
    // exact whole token renders with no fractional part
    expect(
      formatTokenBalance(row({ balance: "2000000", metadata: meta({ decimals: 6 }) })),
    ).toBe("2");
    // sub-unit balance keeps significant digits
    expect(
      formatTokenBalance(row({ balance: "1", metadata: meta({ decimals: 6 }) })),
    ).toBe("0.000001");
  });

  it("treats missing / zero decimals as raw atomic units", () => {
    expect(formatTokenBalance(row({ balance: "42", metadata: null }))).toBe("42");
    expect(
      formatTokenBalance(row({ balance: "42", metadata: meta({ decimals: 0 }) })),
    ).toBe("42");
  });

  it("handles a balance of zero and empty strings honestly", () => {
    expect(
      formatTokenBalance(row({ balance: "0", metadata: meta({ decimals: 6 }) })),
    ).toBe("0");
    expect(formatTokenBalance(row({ balance: "" }))).toBe("0");
  });
});

describe("tokenDisplay / tokenMonogram", () => {
  it("uses indexer name + symbol when present", () => {
    const r = row({ balance: "1", metadata: meta({ name: "Test Token", symbol: "TST" }) });
    expect(tokenDisplay(r)).toEqual({ name: "Test Token", symbol: "TST" });
    expect(tokenMonogram(r)).toBe("TST");
  });

  it("falls back to a shortened token id when no metadata name exists", () => {
    const r = row({ balance: "1", metadata: null });
    const { name, symbol } = tokenDisplay(r);
    expect(symbol).toBeNull();
    expect(name).toContain("…");
    // No invented symbol -> monogram falls back to MRC.
    expect(tokenMonogram(r)).toBe("MRC");
  });
});

/** Metadata factory with the required nulls filled in. */
function meta(partial: {
  name?: string;
  symbol?: string;
  decimals?: number;
}): TokenBalanceWithMetadata["metadata"] {
  return {
    standard: "mrc20",
    assetId: TOKEN_ID,
    tokenId: null,
    name: partial.name ?? null,
    symbol: partial.symbol ?? null,
    decimals: partial.decimals ?? null,
    uri: null,
    updatedAtBlock: 0,
  };
}
