// Reset wallet — wipe the keystore device-key + the on-disk vault
// envelope and return the app to its onboarding state. Two-step
// confirmation pattern so a fat-fingered tap doesn't nuke a wallet:
//
//   1. User opens the screen and reads the warning.
//   2. User types the literal word RESET in the confirm box.
//   3. Reset button enables; tap it to wipe + onboarding.
//
// We don't gate on biometric or password — a user who lost their
// password / biometric still needs a way out, and the recovery-phrase
// holder is the only one who can come back. If they can't restore from
// phrase, that's the consequence of "lost password" and is documented
// in onboarding.

import { useState } from "react";
import { clearUnlockSecret } from "../../sdk/auth";

interface Props {
  /** Reset side-effect: parent re-runs `hasUnlockSecret()` and falls
   *  back to onboarding. */
  onResetComplete: () => void;
  onClose: () => void;
}

const CONFIRM_WORD = "RESET";

export function ResetWallet({ onResetComplete, onClose }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = typed.trim().toUpperCase() === CONFIRM_WORD;

  const onReset = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await clearUnlockSecret();
      onResetComplete();
    } catch (cause) {
      setError((cause as Error)?.message ?? "reset failed");
      setBusy(false);
    }
  };

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3 style={{ color: "var(--err)" }}>Reset wallet</h3>
        </div>
        <p
          style={{
            margin: "0 0 12px",
            fontSize: 13,
            color: "var(--fg-200)",
            lineHeight: 1.55,
          }}
        >
          This wipes the encrypted vault, the device-key in the
          keystore, and any WalletConnect sessions stored on this
          device.
        </p>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: 13,
            color: "var(--err)",
            lineHeight: 1.55,
          }}
        >
          On-chain balances are NOT affected — they live on the chain.
          But you will only be able to recover this wallet from the
          24-word recovery phrase. If you don&apos;t have it written
          down, the funds are unreachable from this app.
        </p>

        <label
          style={{
            display: "block",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--fg-400)",
            marginBottom: 6,
          }}
        >
          Type {CONFIRM_WORD} to confirm
        </label>
        <input
          type="text"
          autoFocus
          autoCapitalize="characters"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={CONFIRM_WORD}
          style={inputStyle}
        />

        {error && (
          <p
            style={{
              margin: "10px 0 0",
              fontSize: 12,
              color: "var(--err)",
              lineHeight: 1.5,
            }}
          >
            {error}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="mw-btn" onClick={onClose} style={{ flex: 1 }}>
          Cancel
        </button>
        <button
          className="mw-btn mw-btn--block"
          onClick={() => void onReset()}
          disabled={!ready || busy}
          style={{
            flex: 1,
            color: "var(--err)",
            borderColor: "var(--err)",
            opacity: ready && !busy ? 1 : 0.5,
          }}
        >
          {busy ? "Resetting…" : "Reset wallet"}
        </button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: 14,
  fontFamily: "var(--f-mono)",
  letterSpacing: "0.05em",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "var(--fg-100)",
  outline: "none",
  textTransform: "uppercase",
};
