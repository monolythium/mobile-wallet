// Reveal recovery phrase — password challenge gates the display, then
// shows the 24-word recovery phrase with the standard copy-with-clear
// affordance. The password path is mandatory (not biometric) so a
// device thief with a brief unlocked-phone window can't grab the seed.

import { useState } from "react";
import { MnemonicGrid } from "../../components/MnemonicGrid";
import { unlockViaPassword } from "../../sdk/signer";

interface Props {
  onClose: () => void;
}

type State =
  | { kind: "password" }
  | { kind: "verifying" }
  | { kind: "revealed"; mnemonic: string }
  | { kind: "error"; message: string };

export function RevealPhrase({ onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "password" });
  const [password, setPassword] = useState("");

  const onUnlock = async () => {
    if (!password) return;
    setState({ kind: "verifying" });
    try {
      const payload = await unlockViaPassword(password);
      setState({ kind: "revealed", mnemonic: payload.mnemonic });
      setPassword("");
    } catch (cause) {
      const message = (cause as Error)?.message ?? "wrong password";
      setState({ kind: "error", message });
    }
  };

  return (
    <div className="mw-scroll">
      {state.kind === "revealed" ? (
        <>
          <div className="mw-card">
            <div className="mw-card__head">
              <h3>Recovery phrase</h3>
            </div>
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 12.5,
                color: "var(--fg-300)",
                lineHeight: 1.55,
              }}
            >
              Anyone with these 24 words can spend the wallet. Store them
              offline; never paste them into a website, message, or
              support form.
            </p>
            <MnemonicGrid mnemonic={state.mnemonic} />
          </div>
          <button
            className="mw-btn mw-btn--block"
            onClick={onClose}
            style={{ marginTop: 14 }}
          >
            Done
          </button>
        </>
      ) : (
        <>
          <div className="mw-card">
            <div className="mw-card__head">
              <h3>Reveal recovery phrase</h3>
            </div>
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 12.5,
                color: "var(--fg-300)",
                lineHeight: 1.55,
              }}
            >
              Confirm your password to display the 24-word recovery phrase
              for this wallet.
            </p>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Wallet password"
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onUnlock();
              }}
            />
            {state.kind === "error" && (
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 12,
                  color: "var(--err)",
                  lineHeight: 1.5,
                }}
              >
                {state.message}
              </p>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="mw-btn" onClick={onClose} style={{ flex: 1 }}>
              Cancel
            </button>
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              onClick={() => void onUnlock()}
              disabled={state.kind === "verifying" || password.length === 0}
              style={{ flex: 1 }}
            >
              {state.kind === "verifying" ? "Verifying…" : "Reveal"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: 14,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "var(--fg-100)",
  outline: "none",
};
