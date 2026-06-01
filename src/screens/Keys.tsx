// Keys — the wallet's signing key(s), for the "More → Security" flow.
//
// This wallet has exactly ONE signing key: the ML-DSA-65 (PQM-1 v1) key
// derived from the device's sealed mnemonic on every unlock (see
// sdk/vault.ts + sdk/signer.ts). It never holds a raw key on disk and there
// is no hardware-pairing / passkey / multi-key surface on mobile. So this
// screen renders a single honest card for this device's signer — its real
// derived address and the correct algorithm — and nothing it can't read.

import { useEffect, useState } from "react";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import { Icon } from "../components/Icon";
import { vaultBoundAddress } from "../sdk/vault";

/** Resolution of the bound signer address. */
type KeyState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ok"; bech32m: string };

export function Keys() {
  const [state, setState] = useState<KeyState>({ kind: "loading" });

  // Read the vault's plaintext address header (no biometric prompt) and
  // convert it to the typed mono1… identity for display. This is the only
  // key metadata the wallet exposes without unlocking.
  useEffect(() => {
    let cancelled = false;
    void vaultBoundAddress().then((addr) => {
      if (cancelled) return;
      if (addr === null) {
        setState({ kind: "none" });
        return;
      }
      try {
        setState({ kind: "ok", bech32m: addressToTypedBech32("user", addr) });
      } catch {
        setState({ kind: "none" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Signing key</h3>
          <div className="spacer" />
          <span className="more">{state.kind === "ok" ? "1 active" : "—"}</span>
        </div>

        {state.kind === "loading" && (
          <div className="row-help" style={{ marginTop: 8 }}>
            Resolving this device&apos;s signer…
          </div>
        )}

        {state.kind === "none" && (
          <div className="row-help" style={{ marginTop: 8 }}>
            No signing key on this device yet.
          </div>
        )}

        {state.kind === "ok" && (
          <div className="mw-row">
            <div className="mw-row__icon">
              <Icon name="key" size={16} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="mw-row__name">
                This device
                <span className="ticker">ML-DSA-65</span>
              </div>
              <div
                className="mw-row__sub mono"
                style={{ wordBreak: "break-all" }}
              >
                {state.bech32m}
              </div>
            </div>
            <div className="mw-row__right">
              <span className="mw-halo">active</span>
            </div>
          </div>
        )}
      </div>

      <p
        style={{
          fontSize: 11.5,
          color: "var(--fg-400)",
          textAlign: "center",
          padding: "0 8px",
          lineHeight: 1.55,
        }}
      >
        The signing key is derived from your recovery phrase on every unlock
        (post-quantum ML-DSA-65, PQM-1 v1). The raw key is never stored on
        disk.
      </p>
    </div>
  );
}
