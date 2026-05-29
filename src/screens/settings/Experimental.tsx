// Experimental — opt-in toggle for in-development v5 surfaces.
//
// Off by default. While off, the wallet behaves exactly like a build without
// these surfaces: the Agents + Bridge entries are hidden from the More menu
// and their screens are unmountable, and the Stake screen's autovote planner
// is not rendered. Flipping this on reveals them. The flag is persisted
// locally via @tauri-apps/plugin-store (see ../../sdk/feature-flags.ts).

import { useState } from "react";
import { setExperimentalV5 } from "../../sdk/feature-flags";
import { useExperimentalV5 } from "../../sdk/use-feature-flags";

interface Props {
  onClose: () => void;
}

export function Experimental({ onClose }: Props) {
  const enabled = useExperimentalV5();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await setExperimentalV5(!enabled);
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
          <h3>Experimental features</h3>
        </div>

        <div className="mw-kv">
          <div className="k">Experimental v5 surfaces</div>
          <div className="v">{enabled ? "On" : "Off"}</div>
        </div>

        <div className="row-help" style={{ lineHeight: 1.5, marginTop: 8 }}>
          Reveals in-development surfaces: agent sub-account spending policies,
          the cross-chain bridge route disclosure, and the autovote cluster
          planner. These are previews and may change. Leave this off for the
          standard wallet experience.
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
