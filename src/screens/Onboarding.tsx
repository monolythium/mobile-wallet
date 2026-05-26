// Onboarding — runs once per install, before the wallet shell appears.
//
// Flow (post-PQM-1 standalone wallet):
//   loading → intro → password (with acknowledgement) → deriving
//          → show-phrase → verify-phrase → enrolling → done
//
// At `deriving` we generate a fresh PQM-1 v1 24-word mnemonic, derive an
// ML-DSA-65 keypair, encrypt the mnemonic into the vault, and stage the
// device-key in the OS keystore. The mnemonic is then shown to the user
// and verified via a fill-in-the-blanks challenge before we enrol the
// biometric. The mnemonic never leaves the wallet — it sits in component
// state for the show + verify steps only, then is dropped on transition
// to enrolling.
//
// Biometric enrolment runs AFTER the vault is on disk so a sensor
// cancellation doesn't block onboarding — the user still has a working
// password fallback.

import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { MnemonicGrid } from "../components/MnemonicGrid";
import { VerifyPhrase } from "../components/VerifyPhrase";
import {
  authenticateBiometric,
  biometricStatus,
  bootstrapVault,
  type AuthError,
  type BiometricStatus,
} from "../sdk/auth";

interface Props {
  onDone: () => void;
}

type Step =
  | "loading"
  | "intro"
  | "password"
  | "deriving"
  | "show-phrase"
  | "verify-phrase"
  | "enrolling"
  | "done";

const MIN_PASSWORD_LEN = 8;

export function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState<Step>("loading");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);

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
    if (!acknowledged) {
      setError(
        "Acknowledge that the password can't be recovered before continuing.",
      );
      return;
    }

    setStep("deriving");

    let mnem: string;
    try {
      const result = await bootstrapVault(password);
      mnem = result.mnemonic;
    } catch (cause) {
      const err = cause as AuthError;
      if (err?.kind === "Unavailable") {
        setError(
          "Keystore not available on this host build. Wallet runs in demo mode.",
        );
        setStep("done");
        setPassword("");
        setConfirm("");
        return;
      }
      setError(`Could not save vault: ${err?.message ?? "unknown"}`);
      setStep("password");
      return;
    }
    // Drop the password from state as soon as the vault is sealed.
    setPassword("");
    setConfirm("");

    setMnemonic(mnem);
    setStep("show-phrase");
  };

  const onPhraseShown = () => {
    setStep("verify-phrase");
  };

  const onPhraseVerified = async () => {
    // The mnemonic was only retained to render show + verify. Drop the
    // reference now that the challenge is solved.
    setMnemonic(null);

    if (bio?.available) {
      setStep("enrolling");
      try {
        await authenticateBiometric(
          "Enrol biometric authorisation for Monolythium Wallet",
        );
      } catch (cause) {
        const err = cause as AuthError;
        if (err?.kind === "Cancelled") {
          setError("Biometric enrolment cancelled. Continuing with password only.");
        } else if (err?.kind !== "Unavailable") {
          setError(`Biometric enrolment failed: ${err?.message ?? "unknown"}`);
        }
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
                phone&apos;s secure enclave. You&apos;ll also choose a fallback
                password and back up a 24-word recovery phrase.
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
                <div className="v">Platform keystore + encrypted vault file</div>
              </div>
              <div className="mw-kv">
                <div className="k">KDF</div>
                <div className="v">Argon2id · 32 MiB · t=2</div>
              </div>
              <div className="mw-kv">
                <div className="k">Signing</div>
                <div className="v">ML-DSA-65 · PQM-1 v1</div>
              </div>
              <div className="mw-kv">
                <div className="k">Recovery</div>
                <div className="v">24-word PQM-1 phrase</div>
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
                At least {MIN_PASSWORD_LEN} characters. We never store your
                password — it&apos;s run through Argon2id to derive a key
                that unlocks your wallet.
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

              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  marginTop: 14,
                  fontSize: 12.5,
                  color: "var(--fg-200)",
                  lineHeight: 1.55,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  style={{ marginTop: 2, accentColor: "var(--gold)" }}
                />
                <span>
                  I understand the password can&apos;t be recovered. If I
                  lose it, only my 24-word recovery phrase will restore the
                  wallet.
                </span>
              </label>

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
              onClick={() => void submitPassword()}
              disabled={
                password.length < MIN_PASSWORD_LEN ||
                confirm.length === 0 ||
                !acknowledged
              }
            >
              <Icon name="face" size={16} />
              {bio?.available ? `Enrol ${sensorName(bio)}` : "Save password"}
            </button>
          </>
        )}

        {step === "deriving" && (
          <div className="mw-card mw-auth">
            <div className="mw-spin" aria-hidden="true" />
            <div style={{ fontSize: 16, fontWeight: 500 }}>
              Generating your wallet…
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--fg-300)",
                maxWidth: 280,
                lineHeight: 1.55,
                textAlign: "center",
              }}
            >
              Argon2id · 32 MiB · t=2 · PQM-1 ML-DSA-65. This runs entirely
              on this device.
            </div>
          </div>
        )}

        {step === "show-phrase" && mnemonic && (
          <>
            <div className="mw-card">
              <div className="mw-card__head">
                <h3>Your 24-word recovery phrase</h3>
              </div>
              <p
                style={{
                  margin: "0 0 14px",
                  fontSize: 12.5,
                  color: "var(--fg-300)",
                  lineHeight: 1.55,
                }}
              >
                This PQM-1 phrase is the only recovery path. Write it down
                or copy it to a password manager — it will not be shown
                again on this screen.
              </p>
              <MnemonicGrid mnemonic={mnemonic} />
            </div>
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              style={{ marginTop: 14 }}
              onClick={onPhraseShown}
            >
              I have backed it up
            </button>
          </>
        )}

        {step === "verify-phrase" && mnemonic && (
          <VerifyPhrase
            mnemonic={mnemonic}
            onVerified={() => void onPhraseVerified()}
          />
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
