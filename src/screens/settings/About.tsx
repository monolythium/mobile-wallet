// About — build + chain info. Static fields mixed with one live read
// (testnet chain-registry from GitHub) so the genesis hash + binary
// sha track the latest registry push without needing a new SDK
// publish + wallet bump.

import { useEffect, useState } from "react";
import {
  MONOLYTHIUM_TESTNET_CHAIN_ID,
  MONOLYTHIUM_TESTNET_NETWORK_NAME,
  type ChainInfo,
} from "@monolythium/core-sdk";
import { fetchLiveTestnetRegistry } from "../../sdk/live-registry";

interface Props {
  onClose: () => void;
}

const APP_VERSION = "0.1.2";

function shortHex(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function About({ onClose }: Props) {
  const [registry, setRegistry] = useState<ChainInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await fetchLiveTestnetRegistry();
      if (!cancelled && info !== null) setRegistry(info);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>About</h3>
        </div>
        <div className="mw-kv">
          <div className="k">App</div>
          <div className="v">Monolythium Wallet (mobile)</div>
        </div>
        <div className="mw-kv">
          <div className="k">Version</div>
          <div className="v">{APP_VERSION}</div>
        </div>
        <div className="mw-kv">
          <div className="k">Network</div>
          <div className="v">{MONOLYTHIUM_TESTNET_NETWORK_NAME}</div>
        </div>
        <div className="mw-kv">
          <div className="k">Chain id</div>
          <div className="v">{MONOLYTHIUM_TESTNET_CHAIN_ID.toString()}</div>
        </div>
        <div className="mw-kv">
          <div className="k">Signing</div>
          <div className="v">ML-DSA-65 · PQM-1 v1</div>
        </div>
        <div className="mw-kv">
          <div className="k">Vault</div>
          <div className="v">Argon2id + AES-GCM</div>
        </div>
        <div className="mw-kv">
          <div className="k">Wire format</div>
          <div className="v">ML-KEM-768 encrypted envelope</div>
        </div>
        <div className="mw-kv">
          <div className="k">Registry genesis</div>
          <div
            className="v"
            style={{ fontFamily: "var(--f-mono)", fontSize: 12 }}
            title={registry?.genesis_hash ?? ""}
          >
            {registry ? shortHex(registry.genesis_hash) : "fetching…"}
          </div>
        </div>
        <div className="mw-kv">
          <div className="k">Binary sha</div>
          <div className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 12 }}>
            {registry?.binary_sha ?? "fetching…"}
          </div>
        </div>
      </div>

      <button
        className="mw-btn mw-btn--block"
        onClick={onClose}
        style={{ marginTop: 14 }}
      >
        Close
      </button>
    </div>
  );
}
