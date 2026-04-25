// Onboarding — runs once per install, before the wallet shell appears.
// Two paths:
//   1. Biometric available — prompt the user to enrol Touch ID / Face ID /
//      fingerprint. We still ask for a password as a fallback (lost device,
//      sensor failure) and persist it to the platform keystore.
//   2. Biometric unavailable (desktop dev, simulator without enrolled
//      finger, etc.) — password-only.
//
// The persisted secret is the password itself for now. When mono-core-sdk
// lands a Signer trait, that secret will become a KEK derived via
// password+salt and the keystore will hold the KEK rather than the password
// directly. Tracked at:
//   TODO(monolythium-vision): swap stored password for KDF-derived KEK
//     once mono-core-sdk Signer is available.

import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import {
  authenticateBiometric,
  biometricStatus,
  setUnlockSecret,
  type AuthError,
  type BiometricStatus,
} from "../sdk/auth";

interface Props {
  onDone: () => void;
}

type Step = "loading" | "intro" | "password" | "enrolling" | "done";

const MIN_PASSWORD_LEN = 8;

export function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState<Step>("loading");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void biometricStatus().then((s) => {
      if (cancelled) return;
      setBio(s);
      setStep("intro");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const continueFromIntro = () => {
    setError(null);
    setStep("password");
  };

  const submitPassword = async () => {
    setError(null);
    if (password.length < MIN_PASSWORD_LEN) {
      setError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setStep("enrolling");

    // If biometrics are available, run the enrolment prompt now so the
    // OS records a successful authentication for this app and surfaces
    // the platform-specific permission UX (Face ID consent, etc.).
    if (bio?.available) {
      try {
        await authenticateBiometric(
          "Enrol biometric authorisation for Monolythium Wallet",
        );
      } catch (cause) {
        const err = cause as AuthError;
        if (err?.kind === "Cancelled") {
          setError("Biometric enrolment cancelled. Continuing with password only.");
          // Keep going — password is still valid.
        } else if (err?.kind !== "Unavailable") {
          setError(`Biometric enrolment failed: ${err?.message ?? "unknown"}`);
        }
      }
    }

    // Persist the password to the platform keystore. On desktop hosts this
    // throws `Unavailable`; surface that as a non-blocking warning so the
    // user can still demo the flow without a real keystore.
    try {
      await setUnlockSecret(password);
    } catch (cause) {
      const err = cause as AuthError;
      if (err?.kind === "Unavailable") {
        // Desktop dev path: secret won't survive a restart, but the UI
        // flow still completes so the user sees the rest of the app.
        setError(
          "Keystore not available on this host build. Wallet runs in demo mode.",
        );
      } else {
        setError(`Could not save secret: ${err?.message ?? "unknown"}`);
        setStep("password");
        return;
      }
    }

    setStep("done");
  };

  return (
    <main className="mw-root" data-denom="public">
      <header className="mw-top">
        <div style={{ width: 36 }} />
        <div className="mw-top__title">
          <span className="brand" aria-hidden="true" />
          Welcome
        </div>
        <div style={{ width: 36 }} />
      </header>

      <div className="mw-scroll">
        {step === "loading" && (
          <div className="mw-card">
            <p style={{ margin: 0, color: "var(--fg-300)" }}>Checking device…</p>
          </div>
        )}

        {step === "intro" && (
          <>
            <div className="mw-card mw-hero">
              <div className="mw-hero__label">Set up</div>
              <div className="mw-hero__amount" style={{ fontSize: 28 }}>
                Secure this device
              </div>
              <p
                style={{
                  margin: "12px 0 0",
                  fontSize: 13,
                  color: "var(--fg-200)",
                  lineHeight: 1.55,
                }}
              >
                Monolythium Wallet protects every signing action with{" "}
                {bio?.available ? sensorName(bio) : "a password"} stored in your
                phone's secure enclave. Choose a fallback password — you'll need it
                if the sensor isn't available.
              </p>
            </div>

            <div className="mw-card">
              <div className="mw-card__head">
                <h3>What this device will hold</h3>
              </div>
              <div className="mw-kv">
                <div className="k">Sensor</div>
                <div className="v">
                  {bio?.available ? sensorName(bio) : "not available"}
                </div>
              </div>
              <div className="mw-kv">
                <div className="k">Storage</div>
                <div className="v">Platform keystore</div>
              </div>
              <div className="mw-kv">
                <div className="k">Recovery</div>
                <div className="v">12-word seed (Stage 4)</div>
              </div>
            </div>

            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              style={{ marginTop: 14 }}
              onClick={continueFromIntro}
            >
              Continue
            </button>
          </>
        )}

        {step === "password" && (
          <>
            <div className="mw-card">
              <div className="mw-card__head">
                <h3>Choose a wallet password</h3>
              </div>
              <p
                style={{
                  margin: "0 0 12px",
                  fontSize: 12.5,
                  color: "var(--fg-300)",
                  lineHeight: 1.55,
                }}
              >
                At least {MIN_PASSWORD_LEN} characters. This unlocks the wallet
                when biometrics aren't available.
              </p>
              <input
                type="password"
                autoFocus
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                aria-label="New wallet password"
                style={inputStyle}
              />
              <input
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm password"
                aria-label="Confirm wallet password"
                style={{ ...inputStyle, marginTop: 8 }}
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

            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              style={{ marginTop: 14 }}
              onClick={submitPassword}
              disabled={password.length < MIN_PASSWORD_LEN || confirm.length === 0}
            >
              <Icon name="face" size={16} />
              {bio?.available ? `Enrol ${sensorName(bio)}` : "Save password"}
            </button>
          </>
        )}

        {step === "enrolling" && (
          <div className="mw-card mw-auth">
            <div className="mw-spin" aria-hidden="true" />
            <div style={{ fontSize: 16, fontWeight: 500 }}>
              Enrolling {bio?.available ? sensorName(bio) : "password"}…
            </div>
          </div>
        )}

        {step === "done" && (
          <>
            <div className="mw-card mw-done">
              <div className="mw-done__ring" aria-hidden="true">
                <Icon name="check" size={36} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 500 }}>Wallet secured</div>
              {error && (
                <p
                  style={{
                    margin: "8px 0 0",
                    fontSize: 12,
                    color: "var(--fg-400)",
                    lineHeight: 1.5,
                    maxWidth: 280,
                    textAlign: "center",
                  }}
                >
                  {error}
                </p>
              )}
            </div>
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              style={{ marginTop: 14 }}
              onClick={onDone}
            >
              Open wallet
            </button>
          </>
        )}
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 14,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "var(--fg-100)",
  outline: "none",
};

function sensorName(bio: BiometricStatus): string {
  switch ((bio.kind ?? "").toLowerCase()) {
    case "face":
    case "faceid":
      return "Face ID";
    case "touch":
    case "touchid":
      return "Touch ID";
    case "fingerprint":
      return "fingerprint";
    default:
      return "biometrics";
  }
}
