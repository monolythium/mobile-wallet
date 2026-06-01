// Onboarding — runs once per install, before the wallet shell appears.
//
// Two paths, both ending at enrolling → done:
//
//   Create:  loading → intro → password+ack → deriving → show-phrase
//                    → verify-phrase → enrolling → done
//   Import:  loading → intro → import-phrase → password+ack
//                    → deriving → enrolling → done
//
// At `deriving` we either generate a fresh PQM-1 v1 24-word mnemonic
// (Create) or accept the imported phrase verbatim after PQM-1 algo/version
// validation (Import). In both cases the mnemonic is encrypted into the
// vault and the device-key is staged in the OS keystore.
//
// The Create flow shows + verifies the mnemonic before enrolling the
// biometric. The Import flow skips show/verify — the user already has
// the phrase. Biometric enrolment runs AFTER the vault is on disk so a
// sensor cancellation doesn't block onboarding.

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
import {
  addressHexFromMnemonic,
  VaultMnemonicError,
} from "../sdk/vault";
import { generatePqm1Mnemonic } from "@monolythium/core-sdk/crypto";
import { explainImportError } from "../lib/import-error";

interface Props {
  onDone: () => void;
}

type Step =
  | "loading"
  | "intro"
  | "import-phrase"
  | "password"
  | "deriving"
  | "show-phrase"
  | "verify-phrase"
  | "enrolling"
  | "done";

const MIN_PASSWORD_LEN = 12;
const PQM1_WORDS = 24;

export function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState<Step>("loading");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [isImport, setIsImport] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

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
    setIsImport(false);
    setStep("password");
  };

  const beginImport = () => {
    setError(null);
    setIsImport(true);
    setImportDraft("");
    setImportError(null);
    setStep("import-phrase");
  };

  const submitImport = () => {
    const cleaned = importDraft.trim().split(/\s+/).join(" ").toLowerCase();
    const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
    if (wordCount !== PQM1_WORDS) {
      setImportError(
        `Expected ${PQM1_WORDS} words, got ${wordCount}. PQM-1 v1 recovery phrases are exactly 24 words.`,
      );
      return;
    }
    try {
      addressHexFromMnemonic(cleaned);
    } catch (cause) {
      const msg =
        cause instanceof VaultMnemonicError
          ? cause.message
          : (cause as Error)?.message ?? "phrase rejected";
      setImportError(explainImportError(msg));
      return;
    }
    setMnemonic(cleaned);
    setImportError(null);
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

    if (isImport) {
      // Import path: phrase already collected, persist now. The user
      // explicitly already has the phrase, so there's no
      // abandon-after-show window to mitigate.
      if (!mnemonic) {
        setError("Recovery phrase missing — re-enter it.");
        setStep("import-phrase");
        return;
      }
      await persistAndFinish(mnemonic);
      return;
    }

    // Create path: generate the mnemonic in component state ONLY.
    // Nothing persists until verify-success — porting browser-wallet
    // 2f83e28 (same persist-before-verify bug existed here).
    try {
      const fresh = generatePqm1Mnemonic();
      setMnemonic(fresh);
      setStep("show-phrase");
    } catch (cause) {
      setError(`Could not generate phrase: ${(cause as Error)?.message ?? "unknown"}`);
    }
  };

  const persistAndFinish = async (mnemonicToSeal: string) => {
    setStep("deriving");
    try {
      await bootstrapVault(password, { importMnemonic: mnemonicToSeal });
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
    // Drop password + mnemonic from state as soon as the vault is sealed.
    setPassword("");
    setConfirm("");
    setMnemonic(null);
    await enrolBiometricAndFinish();
  };

  const enrolBiometricAndFinish = async () => {
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

  const onPhraseShown = () => {
    setStep("verify-phrase");
  };

  const onPhraseVerified = async () => {
    // Persist NOW — only after the user has correctly placed the
    // missing words. Browser-wallet 2f83e28 fixed the same
    // persist-before-verify bug; this is the mobile port.
    if (!mnemonic) {
      setError("Lost the recovery phrase — restart onboarding.");
      setStep("intro");
      return;
    }
    await persistAndFinish(mnemonic);
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
              Create new wallet
            </button>
            <button
              className="mw-btn mw-btn--block"
              style={{ marginTop: 8 }}
              onClick={beginImport}
            >
              I already have a recovery phrase
            </button>
          </>
        )}

        {step === "import-phrase" && (
          <>
            <div className="mw-card">
              <div className="mw-card__head">
                <h3>Import recovery phrase</h3>
              </div>
              <p
                style={{
                  margin: "0 0 14px",
                  fontSize: 12.5,
                  color: "var(--fg-300)",
                  lineHeight: 1.55,
                }}
              >
                Paste your 24-word PQM-1 v1 phrase. Words are separated by
                spaces or line breaks. Only ML-DSA-65 phrases generated by
                Monolythium wallets are accepted — MetaMask or Cosmos
                BIP-39 phrases will be rejected.
              </p>
              <textarea
                autoFocus
                autoCapitalize="none"
                spellCheck={false}
                value={importDraft}
                onChange={(e) => setImportDraft(e.target.value)}
                placeholder={`word1 word2 word3 …\n(24 words total)`}
                rows={5}
                style={{
                  width: "100%",
                  padding: "11px 12px",
                  fontSize: 14,
                  fontFamily: "var(--f-mono)",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  color: "var(--fg-100)",
                  outline: "none",
                  resize: "vertical",
                }}
              />
              {importError && (
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: 12,
                    color: "var(--err)",
                    lineHeight: 1.5,
                  }}
                >
                  {importError}
                </p>
              )}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="mw-btn"
                onClick={() => {
                  setStep("intro");
                  setImportDraft("");
                  setImportError(null);
                }}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                className="mw-btn mw-btn--primary mw-btn--block"
                onClick={submitImport}
                disabled={importDraft.trim().length === 0}
                style={{ flex: 1 }}
              >
                Continue
              </button>
            </div>
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
