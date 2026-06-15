// Privacy — the gate that offers the Public / Private balance toggle on Home.
//
// Off by default. While off, the wallet only ever displays the public
// denomination and the Home toggle is hidden — identical to a build without
// this surface. Turning it on reveals the Public / Private toggle on the
// wallet home; switching to Private hides amounts on this device and shows the
// design's empty / disclosure states across Tokens, Stake, and Activity. The
// gate is persisted locally via @tauri-apps/plugin-store (see
// ../../sdk/privacy.ts); the active denomination itself is never persisted and
// resets to Public on launch and whenever this gate is turned off.

import { useState } from "react";
import { setPrivacyEnabled } from "../../sdk/privacy";
import { usePrivacyEnabled } from "../../sdk/use-privacy";

interface Props {
  onClose: () => void;
}

export function Privacy({ onClose }: Props) {
  const enabled = usePrivacyEnabled();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await setPrivacyEnabled(!enabled);
    } catch (cause) {
      setError((cause as Error)?.message ?? "could not save setting");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Privacy</h3>
          <div className="spacer" />
          <span className="more">{enabled ? "ENABLED" : "HIDDEN"}</span>
        </div>

        <div className="mw-kv">
          <div className="k">Private balances</div>
          <div className="v">{enabled ? "On" : "Off"}</div>
        </div>

        <div className="row-help" style={{ lineHeight: 1.5, marginTop: 8 }}>
          Show the Public / Private toggle on your wallet home. When off, the
          wallet only displays your public balance. Private mode is a display
          gate: amounts are hidden on this device — Monolythium serves
          public-denomination balances, so tokens, staking, and activity stay
          on the public side.
        </div>

        <button
          type="button"
          className={`mw-btn mw-btn--block${enabled ? "" : " mw-btn--primary"}`}
          onClick={() => void toggle()}
          disabled={busy}
          style={{ marginTop: 12 }}
        >
          {enabled ? "Turn off" : "Turn on"}
        </button>

        {error && (
          <div className="row-help" style={{ color: "var(--err)", marginTop: 8 }}>
            {error}
          </div>
        )}
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
