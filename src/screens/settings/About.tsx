// About — build + chain info. Static; no biometric prompts.

import { MONOLYTHIUM_TESTNET_CHAIN_ID, MONOLYTHIUM_TESTNET_NETWORK_NAME } from "@monolythium/core-sdk";

interface Props {
  onClose: () => void;
}

const APP_VERSION = "0.0.1";

export function About({ onClose }: Props) {
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
