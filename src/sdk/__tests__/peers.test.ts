import { describe, expect, it, vi } from "vitest";
import {
  EXPECTED_CHAIN_ID,
  latencyBand,
  listPeers,
  pickFastest,
  probePeer,
  type ProbeResult,
} from "../peers";

// -----------------------------------------------------------------------------
// Test helpers — a fetch stub that answers eth_chainId / eth_blockNumber based
// on the JSON-RPC method in the request body, so probePeer's two-call flow can
// be driven without a network.
// -----------------------------------------------------------------------------

interface StubOptions {
  chainIdHex?: string | null; // result for eth_chainId; null => no result key
  blockHex?: string | null; // result for eth_blockNumber
  ok?: boolean; // http status ok flag
  status?: number;
  rpcError?: { code: number; message: string };
  /** Throw before responding (transport failure). */
  throwOn?: "all";
  /** Return a body that isn't valid JSON. */
  malformed?: boolean;
}

function methodOf(init: RequestInit | undefined): string {
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    return body.method ?? "";
  } catch {
    return "";
  }
}

function makeFetch(opts: StubOptions): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (opts.throwOn === "all") {
      throw new Error("connection refused");
    }
    const method = methodOf(init);
    const ok = opts.ok ?? true;
    const status = opts.status ?? (ok ? 200 : 502);

    const json = async () => {
      if (opts.malformed) throw new Error("not json");
      if (opts.rpcError) {
        return { jsonrpc: "2.0", id: 1, error: opts.rpcError };
      }
      if (method === "eth_chainId") {
        return opts.chainIdHex === null
          ? { jsonrpc: "2.0", id: 1 }
          : { jsonrpc: "2.0", id: 1, result: opts.chainIdHex };
      }
      if (method === "eth_blockNumber") {
        return opts.blockHex === null
          ? { jsonrpc: "2.0", id: 2 }
          : { jsonrpc: "2.0", id: 2, result: opts.blockHex };
      }
      return { jsonrpc: "2.0", id: 1 };
    };

    return { ok, status, json } as unknown as Response;
  }) as unknown as typeof fetch;
}

const URL_A = "https://a.example/rpc";

// -----------------------------------------------------------------------------
// listPeers
// -----------------------------------------------------------------------------

describe("listPeers", () => {
  it("returns a de-duped, non-empty peer set with the gateway first", () => {
    const peers = listPeers();
    expect(peers.length).toBeGreaterThan(0);
    expect(peers[0]?.tier).toBe("gateway");
    const urls = peers.map((p) => p.url);
    expect(new Set(urls).size).toBe(urls.length); // no duplicate URLs
  });
});

// -----------------------------------------------------------------------------
// probePeer — parsing
// -----------------------------------------------------------------------------

describe("probePeer", () => {
  it("marks a peer reachable + chainIdOk when it answers the expected chain id", async () => {
    const expectedHex = `0x${EXPECTED_CHAIN_ID.toString(16)}`;
    const res = await probePeer(
      URL_A,
      makeFetch({ chainIdHex: expectedHex, blockHex: "0x64" }),
    );
    expect(res.reachable).toBe(true);
    expect(res.chainIdOk).toBe(true);
    expect(res.latencyMs).not.toBeNull();
    expect(res.latencyMs!).toBeGreaterThanOrEqual(0);
    expect(res.blockHeight).toBe(100n);
    expect(res.reason).toBeNull();
  });

  it("flags a reachable peer on the WRONG chain as not eligible", async () => {
    const res = await probePeer(
      URL_A,
      makeFetch({ chainIdHex: "0x1", blockHex: "0x10" }), // chain id 1, not 69420
    );
    expect(res.reachable).toBe(true);
    expect(res.chainIdOk).toBe(false);
    expect(res.reason).toMatch(/wrong chain/i);
  });

  it("treats a transport failure as unreachable", async () => {
    const res = await probePeer(URL_A, makeFetch({ throwOn: "all" }));
    expect(res.reachable).toBe(false);
    expect(res.chainIdOk).toBe(false);
    expect(res.latencyMs).toBeNull();
    expect(res.reason).toBe("unreachable");
  });

  it("treats a non-2xx http response as unreachable", async () => {
    const res = await probePeer(URL_A, makeFetch({ ok: false, status: 503 }));
    expect(res.reachable).toBe(false);
    expect(res.reason).toBe("http 503");
  });

  it("treats a malformed body as unreachable", async () => {
    const res = await probePeer(URL_A, makeFetch({ malformed: true }));
    expect(res.reachable).toBe(false);
    expect(res.reason).toBe("malformed response");
  });

  it("treats a JSON-RPC error envelope as unreachable", async () => {
    const res = await probePeer(
      URL_A,
      makeFetch({ rpcError: { code: -32000, message: "boom" } }),
    );
    expect(res.reachable).toBe(false);
    expect(res.reason).toBe("boom");
  });

  it("treats a missing/non-hex chain id result as unreachable", async () => {
    const res = await probePeer(URL_A, makeFetch({ chainIdHex: null }));
    expect(res.reachable).toBe(false);
    expect(res.reason).toBe("no chain id in response");
  });

  it("stays reachable even when the block-height read fails", async () => {
    const expectedHex = `0x${EXPECTED_CHAIN_ID.toString(16)}`;
    const res = await probePeer(
      URL_A,
      makeFetch({ chainIdHex: expectedHex, blockHex: null }),
    );
    expect(res.reachable).toBe(true);
    expect(res.chainIdOk).toBe(true);
    expect(res.blockHeight).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// pickFastest — pure selection
// -----------------------------------------------------------------------------

function result(partial: Partial<ProbeResult> & { url: string }): ProbeResult {
  return {
    reachable: true,
    latencyMs: 100,
    chainIdOk: true,
    blockHeight: null,
    reason: null,
    ...partial,
  };
}

describe("pickFastest", () => {
  it("returns null when nothing is eligible", () => {
    expect(pickFastest([])).toBeNull();
    expect(
      pickFastest([
        result({ url: "x", reachable: false, latencyMs: null }),
        result({ url: "y", chainIdOk: false }),
      ]),
    ).toBeNull();
  });

  it("never selects a reachable but wrong-chain peer", () => {
    const picked = pickFastest([
      result({ url: "wrong", latencyMs: 5, chainIdOk: false }),
      result({ url: "right", latencyMs: 200, chainIdOk: true }),
    ]);
    expect(picked?.url).toBe("right");
  });

  it("chooses the lowest latency among eligible peers", () => {
    const picked = pickFastest([
      result({ url: "slow", latencyMs: 400 }),
      result({ url: "fast", latencyMs: 50 }),
      result({ url: "mid", latencyMs: 150 }),
    ]);
    expect(picked?.url).toBe("fast");
  });

  it("breaks latency ties by the higher block height", () => {
    const picked = pickFastest([
      result({ url: "behind", latencyMs: 100, blockHeight: 10n }),
      result({ url: "ahead", latencyMs: 100, blockHeight: 99n }),
    ]);
    expect(picked?.url).toBe("ahead");
  });

  it("ignores peers with a null latency", () => {
    const picked = pickFastest([
      result({ url: "no-latency", latencyMs: null }),
      result({ url: "measured", latencyMs: 300 }),
    ]);
    expect(picked?.url).toBe("measured");
  });
});

// -----------------------------------------------------------------------------
// latencyBand
// -----------------------------------------------------------------------------

describe("latencyBand", () => {
  it("bands latency into ok / warn / slow", () => {
    expect(latencyBand(50)).toBe("ok");
    expect(latencyBand(299)).toBe("ok");
    expect(latencyBand(300)).toBe("warn");
    expect(latencyBand(999)).toBe("warn");
    expect(latencyBand(1000)).toBe("slow");
    expect(latencyBand(5000)).toBe("slow");
  });
});
