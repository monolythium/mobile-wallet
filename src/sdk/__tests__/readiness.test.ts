import { describe, expect, it } from "vitest";
import { MONOLYTHIUM_TESTNET_CHAIN_ID } from "@monolythium/core-sdk";
import {
  buildOfflineWalletReadiness,
  buildWalletReadiness,
} from "../readiness";
import type { ChainStatus } from "../client";

const STATUS: ChainStatus = {
  chainId: MONOLYTHIUM_TESTNET_CHAIN_ID,
  blockNumber: 123n,
  endpoint: "http://test.invalid",
};

describe("wallet readiness", () => {
  it("marks v4.1 readiness when network, native fee display, receipt proof, and MRV forwarders align", () => {
    const capabilities = {
      blockNumber: 123n,
      capabilities: {},
      nativeModuleForwarders: {
        market: [
          {
            module: "market",
            requestBytes: 132,
            contractAddress: "monoc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxk4v02",
            artifactProfile: "mono-rv32im-v1",
            status: "available",
            deploymentVerified: true,
          },
        ],
      },
    };

    const readiness = buildWalletReadiness(STATUS, capabilities, null);

    expect(readiness.state).toBe("ready");
    expect(readiness.sampledAtBlock).toBe(123n);
    expect(readiness.items.find((item) => item.key === "native-fee")?.value).toBe("0.0001 LYTH");
    expect(readiness.items.find((item) => item.key === "mrv")?.value).toBe("1 verified");
  });

  it("fails closed when native capability data is unavailable", () => {
    const readiness = buildWalletReadiness(STATUS, null, "method not found");

    expect(readiness.state).toBe("blocked");
    expect(readiness.error).toBe("method not found");
    expect(readiness.items.find((item) => item.key === "mrv")?.state).toBe("blocked");
  });

  it("fails closed while offline", () => {
    const readiness = buildOfflineWalletReadiness("rpc unreachable");

    expect(readiness.state).toBe("blocked");
    expect(readiness.items.find((item) => item.key === "network")?.value).toBe("not verified");
  });
});
