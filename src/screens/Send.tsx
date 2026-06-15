// Send LYTH — three-step compose wizard (Recipient → Amount → Review).
//
// Step 1 (Recipient): typed mono1 bech32m address, with a "From contacts"
//   picker + saved-name hint.
// Step 2 (Amount): amount entry with the live available-balance line, the
//   25 / 50 / Max quick-fill chips (computed against the LIVE balance minus
//   the resolved max fee, in lythoshi, so Max never over-spends), an honest
//   USD equivalent (em-dash — there is no on-chain price oracle), and an
//   optional local note/memo.
// Step 3 (Review): a read-only summary + the Private (preview) toggle, then
//   "Authorise and send" launches the OperationsDrawer.
//
// The send itself is unchanged and real: a live fee preview, an ML-DSA-65
// signature, and an encrypted-envelope submit, all driven by the drawer.
// This screen owns input + validation + the wizard; the drawer owns auth +
// write. The note is a LOCAL label only (shown in the review + drawer) — the
// native transfer carries no on-chain memo, so it is never put on the wire.

import { useEffect, useMemo, useState } from "react";
import {
  ADDRESS_KIND_HRPS,
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
  TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT,
  addressToTypedBech32,
  formatLyth,
  resolveExecutionFee,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import type { OperationRequest } from "../components/OperationsDrawer";
import { ContactsPickerSheet } from "../components/ContactsPickerSheet";
import { getProvider, loadChainSnapshot, type ChainSnapshot } from "../sdk/client";
import { bumpContactLastUsed, listContacts } from "../sdk/contacts";
import { previewMaxFeeLyth, sendLyth } from "../sdk/send";
import {
  makeBiometricBackendFactory,
  unlockViaBiometric,
} from "../sdk/signer";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. */
  selfAddress: string;
  openOperation: (req: OperationRequest) => void;
  onClose: () => void;
}

// Sane default execution-unit limit for a transfer, from the SDK 0.3.11
// fee defaults (100k — the ML-DSA-65-signed transfer cost with margin),
// NOT the old 21k intrinsic floor. The actual per-unit price + tip are
// resolved live inside `sendLyth` via the SDK fee resolver.
const DEFAULT_LIMIT = TRANSFER_DEFAULT_EXECUTION_UNIT_LIMIT;
const USER_HRP = ADDRESS_KIND_HRPS.user;

// Optional local note. Length is bounded so the summary stays legible; the
// note never leaves the device (it is not part of the signed transaction).
const MAX_NOTE_LEN = 120;

// PRIVATE (threshold-encrypted) send is a PREVIEW: threshold-encrypted
// INCLUSION is not live on the chain yet, so an encrypted tx would not
// confirm. The toggle is rendered OFF + DISABLED so a user can never
// submit a non-confirming encrypted tx; plaintext (OFF) is the working
// path. Flipping this constant is a deliberate, gated re-enable once the
// chain's threshold-inclusion path is live.
const PRIVATE_SEND_PREVIEW_ENABLED = false;

// Finality posture is fixed by the chain's consensus model (whitepaper
// §13 / §18): an anchor settles in ~1s, and ML-DSA-65 quantum-attested
// checkpoints anchor finality against a future quantum adversary. There is
// no per-tx finality RPC in 0.3.10, so this is a static, honest disclosure
// row — never a fabricated per-tx confirmation count.
const FINALITY_POSTURE =
  "Anchor-level (~1s) · ML-DSA-65 quantum-attested checkpoint";

type Step = 0 | 1 | 2;

/** Live available-balance read for the bound address. Mirrors Home/Activity. */
type BalanceState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: ChainSnapshot }
  | { kind: "error"; message: string };

export function Send({ selfAddress, openOperation, onClose }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  // Live max-fee, kept both as the human preview string AND the raw lythoshi
  // total so the quick-fill chips can subtract it from the balance exactly.
  const [feePreview, setFeePreview] = useState<string | null>(null);
  const [feeLythoshi, setFeeLythoshi] = useState<bigint | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState>({ kind: "loading" });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Private (threshold-encrypted) send toggle. Default OFF = plaintext, the
  // working inclusion path. The ON state would route the encrypted preview
  // path, but the control is disabled (see PRIVATE_SEND_PREVIEW_ENABLED) so a
  // user can never submit a non-confirming encrypted tx today.
  const [privateSend, setPrivateSend] = useState(false);
  // Saved contact name resolved after a pick. Cleared on any manual
  // edit of the recipient field so a stale name never travels with a
  // fresh address.
  const [resolvedContactName, setResolvedContactName] = useState<string | null>(null);

  const selfBech32m = useMemo(
    () => addressToTypedBech32("user", selfAddress),
    [selfAddress],
  );

  // Pull a fresh fee preview on mount. Re-runs only if the screen is
  // unmounted and re-opened. Uses the SDK 0.3.11 fee resolver so the
  // previewed max fee matches what `sendLyth` actually declares (the
  // per-unit max price derived from the live quote × the default limit).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fee = await resolveExecutionFee(getProvider().rpcClient, {
          executionUnitLimit: DEFAULT_LIMIT,
        });
        if (cancelled) return;
        setFeeLythoshi(fee.maxFeePerGas * fee.gasLimit);
        setFeePreview(previewMaxFeeLyth(fee.maxFeePerGas, fee.gasLimit));
      } catch (cause) {
        if (cancelled) return;
        setFeeError((cause as Error)?.message ?? "fee preview unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Read the live native balance for the bound address — the same path
  // Home/Activity use. Drives the available-balance line + the quick-fill
  // chips. The snapshot carries its own RPC-error state so an offline node
  // renders honestly rather than as a fabricated 0.
  useEffect(() => {
    let cancelled = false;
    setBalance({ kind: "loading" });
    void (async () => {
      try {
        const snapshot = await loadChainSnapshot(selfAddress);
        if (cancelled) return;
        if (snapshot.error) {
          setBalance({ kind: "error", message: snapshot.error.message });
        } else {
          setBalance({ kind: "ok", snapshot });
        }
      } catch (cause) {
        if (!cancelled) {
          setBalance({
            kind: "error",
            message: (cause as Error)?.message ?? "balance unavailable",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selfAddress]);

  // Raw spendable balance in lythoshi, read straight off the wire. `null`
  // until the balance resolves (or on an RPC error) — the chips stay disabled
  // in that window rather than guessing.
  const balanceLythoshi = useMemo<bigint | null>(() => {
    if (balance.kind !== "ok") return null;
    try {
      return BigInt(balance.snapshot.balanceLythoshiHex);
    } catch {
      return null;
    }
  }, [balance]);

  const validateRecipient = (): string | null => {
    const trimmedTo = recipient.trim();
    if (!trimmedTo) return "Recipient address is required.";
    if (!trimmedTo.toLowerCase().startsWith(`${USER_HRP}1`)) {
      return `Recipient must be a typed ${USER_HRP}1… address.`;
    }
    try {
      typedBech32ToAddress(trimmedTo, "user");
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
    if (trimmedTo.toLowerCase() === selfBech32m.toLowerCase()) {
      return "Recipient cannot be the wallet's own address.";
    }
    return null;
  };

  const validateAmount = (): string | null => {
    const trimmedAmt = amount.trim();
    if (!trimmedAmt) return "Amount is required.";
    if (!new RegExp(`^\\d+(\\.\\d{1,${NATIVE_LYTH_DECIMALS}})?$`).test(trimmedAmt)) {
      return `Amount must have at most ${NATIVE_LYTH_DECIMALS} decimal places.`;
    }
    if (Number(trimmedAmt) === 0) return "Amount must be greater than 0.";
    return null;
  };

  // Quick-fill: write a clean plain-decimal LYTH string into the amount field.
  // `fraction` is the share of the SPENDABLE balance (balance − max fee), in
  // basis points, so 25/50 leave headroom for the fee and Max (10_000) spends
  // everything affordable. Computed in lythoshi so the value is exact.
  const fillFraction = (bps: number) => {
    if (balanceLythoshi === null || feeLythoshi === null) return;
    const spendable = balanceLythoshi - feeLythoshi;
    if (spendable <= 0n) {
      setAmount("0");
      setValidationError(null);
      return;
    }
    const target = (spendable * BigInt(bps)) / 10_000n;
    setAmount(lythoshiToPlainLyth(target));
    setValidationError(null);
  };

  const onNext = () => {
    if (step === 0) {
      const err = validateRecipient();
      setValidationError(err);
      if (err) return;
      setStep(1);
      return;
    }
    if (step === 1) {
      const err = validateAmount();
      setValidationError(err);
      if (err) return;
      setStep(2);
      return;
    }
  };

  const onBack = () => {
    setValidationError(null);
    if (step === 0) {
      onClose();
      return;
    }
    setStep((s) => (s - 1) as Step);
  };

  const onSubmit = async () => {
    const err = validateRecipient() ?? validateAmount();
    setValidationError(err);
    if (err) {
      // Bounce back to the offending step so the user can fix it.
      setStep(validateRecipient() ? 0 : 1);
      return;
    }

    const toBech32m = recipient.trim();
    const amountLyth = amount.trim();
    const trimmedNote = note.trim();

    // §25.2 item 6 — recipient name. A picked contact already set
    // `resolvedContactName`; for a manually-typed address, look it up in the
    // local address book so a saved name surfaces even without the picker.
    // The address book is the ONLY source of recipient names — there is no
    // on-chain reverse resolver in the SDK.
    let recipientName = resolvedContactName;
    if (recipientName === null) {
      try {
        const contacts = await listContacts();
        const lower = toBech32m.toLowerCase();
        const match = contacts.find((c) => c.bech32m.toLowerCase() === lower);
        if (match) recipientName = match.name;
      } catch {
        // Address-book read is best-effort; absence of a name is fine.
      }
    }

    const toLabel = recipientName
      ? `${recipientName} (${shortAddr(toBech32m)})`
      : shortAddr(toBech32m);
    // The encrypted (preview) path is only ever engaged when BOTH the
    // user toggled it on AND the preview flag is enabled — the toggle is
    // disabled today, so this resolves to plaintext (false) in shipping
    // builds. Plaintext is the working inclusion path.
    const usePrivate = privateSend && PRIVATE_SEND_PREVIEW_ENABLED;
    const summary = `Send ${amountLyth} LYTH to ${toLabel} on the Monolythium testnet${usePrivate ? " (private / threshold-encrypted preview)" : ""}.`;

    openOperation({
      kind: "send",
      title: `Send ${amountLyth} LYTH`,
      summary,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        ...(recipientName ? [{ k: "Recipient", v: recipientName }] : []),
        { k: "To", v: toBech32m, mono: true },
        { k: "Amount", v: `${amountLyth} LYTH`, mono: true },
        // No on-chain price oracle — USD is honestly unavailable.
        { k: "USD value", v: "—" },
        ...(trimmedNote
          ? [{ k: "Note (local only)", v: trimmedNote }]
          : []),
        ...(feePreview !== null
          ? [{ k: "Max fee", v: `${feePreview} LYTH`, mono: true }]
          : []),
        {
          k: "Privacy",
          v: usePrivate
            ? "Private (threshold-encrypted preview)"
            : "Plaintext (public mempool)",
        },
        { k: "Finality", v: FINALITY_POSTURE },
      ],
      confirmLabel: "Authorise and send",
      // Notifications-center metadata (experimental-v5). Amount + 0x
      // counterparty only — never the saved contact name or the local note,
      // per the no-secrets rule. The drawer records this on the tx's real
      // terminal receipt.
      notify: {
        kind: "send",
        amountDecimal: amountLyth,
        counterparty: typedBech32ToAddress(toBech32m, "user").hex.toLowerCase(),
      },
      execute: async () => {
        const result = await sendLyth(
          {
            unlockBackend: makeBiometricBackendFactory({
              unlock: unlockViaBiometric,
            }),
          },
          {
            from: selfBech32m,
            to: toBech32m,
            amountLyth,
            executionUnitLimit: DEFAULT_LIMIT,
            // DEFAULT plaintext (false). Only true when the user enabled the
            // (disabled-today) Private preview toggle — see usePrivate above.
            privatePreview: usePrivate,
          },
        );
        // Best-effort: if the recipient is a saved contact, bump
        // lastUsedAt so the MRU sort surfaces them on next send. No-op
        // if they aren't in the address book.
        void bumpContactLastUsed(toBech32m).catch(() => {});
        return result.txHash;
      },
    });

    onClose();
  };

  const recipientReady = recipient.trim().length > 0;
  const amountReady = amount.trim().length > 0;

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Send LYTH</h3>
        </div>

        {/* Step indicator (reuses the shared .mw-steps rail). */}
        <div className="mw-steps" aria-hidden="true">
          <span className={step >= 0 ? "on" : ""} />
          <span className={step >= 1 ? "on" : ""} />
          <span className={step >= 2 ? "on" : ""} />
        </div>

        <p
          style={{
            margin: "0 0 14px",
            fontSize: 13,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          {STEP_TITLES[step]} · from{" "}
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--fg-200)" }}>
            {shortAddr(selfBech32m)}
          </span>
        </p>

        {step === 0 && (
          <RecipientStep
            recipient={recipient}
            resolvedContactName={resolvedContactName}
            onChange={(v) => {
              setRecipient(v);
              if (resolvedContactName !== null) setResolvedContactName(null);
            }}
            onPick={() => setPickerOpen(true)}
          />
        )}

        {step === 1 && (
          <AmountStep
            amount={amount}
            onChangeAmount={(v) => setAmount(v)}
            note={note}
            onChangeNote={(v) => setNote(v.slice(0, MAX_NOTE_LEN))}
            balance={balance}
            balanceReady={balanceLythoshi !== null && feeLythoshi !== null}
            onFill={fillFraction}
            feePreview={feePreview}
            feeError={feeError}
          />
        )}

        {step === 2 && (
          <ReviewStep
            from={selfBech32m}
            to={recipient.trim()}
            recipientName={resolvedContactName}
            amount={amount.trim()}
            note={note.trim()}
            feePreview={feePreview}
            privateSend={privateSend}
            onTogglePrivate={(checked) => setPrivateSend(checked)}
          />
        )}

        {validationError && (
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 12,
              color: "var(--err)",
              lineHeight: 1.5,
            }}
          >
            {validationError}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="mw-btn" onClick={onBack} style={{ flex: 1 }}>
          {step === 0 ? "Cancel" : "Back"}
        </button>
        {step < 2 ? (
          <button
            className="mw-btn mw-btn--primary mw-btn--block"
            onClick={onNext}
            style={{ flex: 1 }}
            disabled={step === 0 ? !recipientReady : !amountReady}
          >
            Next
          </button>
        ) : (
          <button
            className="mw-btn mw-btn--primary mw-btn--block"
            onClick={() => void onSubmit()}
            style={{ flex: 1 }}
          >
            Review and send
          </button>
        )}
      </div>

      {pickerOpen && (
        <ContactsPickerSheet
          onSelect={(contact) => {
            setRecipient(contact.bech32m);
            setResolvedContactName(contact.name);
            setValidationError(null);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

const STEP_TITLES: Record<Step, string> = {
  0: "Recipient",
  1: "Amount",
  2: "Review",
};

/* ---- Step 1: Recipient ---- */

function RecipientStep({
  recipient,
  resolvedContactName,
  onChange,
  onPick,
}: {
  recipient: string;
  resolvedContactName: string | null;
  onChange: (v: string) => void;
  onPick: () => void;
}) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label style={{ ...fieldLabel, marginBottom: 0 }}>Recipient</label>
        <button
          type="button"
          className="mw-btn"
          onClick={onPick}
          style={{ padding: "5px 10px", fontSize: 11 }}
        >
          From contacts
        </button>
      </div>
      <input
        type="text"
        autoCapitalize="none"
        spellCheck={false}
        value={recipient}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${USER_HRP}1…`}
        aria-label="Recipient typed bech32m address"
        style={inputStyle}
      />
      {resolvedContactName && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--fg-400)",
            letterSpacing: "0.04em",
          }}
        >
          Saved as{" "}
          <strong style={{ color: "var(--fg-200)" }}>{resolvedContactName}</strong>
        </div>
      )}
    </>
  );
}

/* ---- Step 2: Amount ---- */

function AmountStep({
  amount,
  onChangeAmount,
  note,
  onChangeNote,
  balance,
  balanceReady,
  onFill,
  feePreview,
  feeError,
}: {
  amount: string;
  onChangeAmount: (v: string) => void;
  note: string;
  onChangeNote: (v: string) => void;
  balance: BalanceState;
  balanceReady: boolean;
  onFill: (bps: number) => void;
  feePreview: string | null;
  feeError: string | null;
}) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label style={{ ...fieldLabel, marginBottom: 0 }}>Amount (LYTH)</label>
        <AvailableBalance balance={balance} />
      </div>
      <input
        type="text"
        inputMode="decimal"
        autoCapitalize="none"
        spellCheck={false}
        value={amount}
        onChange={(e) => onChangeAmount(e.target.value)}
        placeholder="0.0"
        aria-label="Amount in LYTH"
        style={inputStyle}
      />

      {/* USD equivalent — honestly unavailable (no on-chain price oracle). */}
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          color: "var(--fg-400)",
        }}
      >
        ≈ <span style={{ fontFamily: "var(--f-mono)" }}>—</span> USD · no price
        oracle on chain
      </div>

      {/* Quick-fill chips: 25% / 50% / Max of the spendable balance. */}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        {QUICK_FILL.map((q) => (
          <button
            key={q.bps}
            type="button"
            className="mw-btn"
            onClick={() => onFill(q.bps)}
            disabled={!balanceReady}
            style={{
              flex: 1,
              padding: "8px 10px",
              fontSize: 12,
              opacity: balanceReady ? 1 : 0.4,
            }}
          >
            {q.label}
          </button>
        ))}
      </div>

      <label style={{ ...fieldLabel, marginTop: 14 }}>Note (optional)</label>
      <input
        type="text"
        autoCapitalize="sentences"
        value={note}
        onChange={(e) => onChangeNote(e.target.value)}
        placeholder="What's this for?"
        aria-label="Optional local note"
        maxLength={MAX_NOTE_LEN}
        style={{ ...inputStyle, fontFamily: "var(--f-sans)" }}
      />
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: "var(--fg-400)",
          lineHeight: 1.5,
        }}
      >
        Stays on this device — a native LYTH transfer carries no on-chain memo,
        so the note is never sent on-chain.
      </div>

      {feePreview !== null && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
          }}
        >
          Max fee preview · {feePreview} LYTH
        </div>
      )}
      {feeError !== null && feePreview === null && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "var(--warn)",
            lineHeight: 1.5,
          }}
        >
          Could not preview fee: {feeError}. You can still send.
        </div>
      )}
    </>
  );
}

const QUICK_FILL: { label: string; bps: number }[] = [
  { label: "25%", bps: 2_500 },
  { label: "50%", bps: 5_000 },
  { label: "Max", bps: 10_000 },
];

/** Available-balance line, honest about every state (resolving / loading /
 *  RPC error / the real native LYTH amount). */
function AvailableBalance({ balance }: { balance: BalanceState }) {
  let body: string;
  if (balance.kind === "loading") {
    body = "Available … LYTH";
  } else if (balance.kind === "error") {
    body = "Available — LYTH";
  } else {
    body = `Available ${formatLyth(BigInt(balance.snapshot.balanceLythoshiHex))}`;
  }
  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--fg-400)",
        fontFamily: "var(--f-mono)",
      }}
    >
      {body}
    </span>
  );
}

/* ---- Step 3: Review ---- */

function ReviewStep({
  from,
  to,
  recipientName,
  amount,
  note,
  feePreview,
  privateSend,
  onTogglePrivate,
}: {
  from: string;
  to: string;
  recipientName: string | null;
  amount: string;
  note: string;
  feePreview: string | null;
  privateSend: boolean;
  onTogglePrivate: (checked: boolean) => void;
}) {
  return (
    <>
      <ReviewRow k="From" v={from} mono />
      {recipientName && <ReviewRow k="Recipient" v={recipientName} />}
      <ReviewRow k="To" v={to} mono />
      <ReviewRow k="Amount" v={`${amount} LYTH`} mono />
      {/* No on-chain price oracle — USD is honestly an em-dash. */}
      <ReviewRow k="USD value" v="—" />
      {note && <ReviewRow k="Note (local only)" v={note} />}
      {feePreview !== null && <ReviewRow k="Max fee" v={`${feePreview} LYTH`} mono />}
      <ReviewRow k="Finality" v={FINALITY_POSTURE} />

      {/* Private (threshold-encrypted) send — PREVIEW, default OFF and
          disabled. Threshold-encrypted inclusion is not live on the chain
          yet, so an encrypted tx would not confirm. The control stays
          disabled so a user can never submit a non-confirming encrypted tx;
          plaintext (OFF) is the working path. */}
      <div
        style={{
          marginTop: 16,
          padding: "12px 12px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--fg-700)",
          borderRadius: 10,
          opacity: PRIVATE_SEND_PREVIEW_ENABLED ? 1 : 0.7,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <label
            htmlFor="mw-private-send"
            style={{
              fontSize: 13,
              color: "var(--fg-200)",
              fontWeight: 600,
            }}
          >
            Private (preview)
          </label>
          <input
            id="mw-private-send"
            type="checkbox"
            role="switch"
            checked={privateSend && PRIVATE_SEND_PREVIEW_ENABLED}
            disabled={!PRIVATE_SEND_PREVIEW_ENABLED}
            onChange={(e) => onTogglePrivate(e.target.checked)}
            aria-label="Private (threshold-encrypted) send — preview, not yet available"
            style={{
              width: 18,
              height: 18,
              cursor: PRIVATE_SEND_PREVIEW_ENABLED ? "pointer" : "not-allowed",
            }}
          />
        </div>
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 11.5,
            color: "var(--fg-400)",
            lineHeight: 1.5,
          }}
        >
          Off — your send goes through the public mempool (plaintext), which is
          the path that confirms today. Threshold-encrypted (private) inclusion
          is a preview and not live yet, so it stays disabled to avoid sending a
          transaction that would not confirm.
        </p>
      </div>
    </>
  );
}

function ReviewRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="mw-kv">
      <div className="k">{k}</div>
      <div
        className={mono ? "v mono" : "v"}
        style={{
          fontFamily: mono ? "var(--f-mono)" : undefined,
          wordBreak: "break-all",
        }}
      >
        {v}
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-400)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: 14,
  fontFamily: "var(--f-mono)",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "var(--fg-100)",
  outline: "none",
};

function shortAddr(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

/**
 * Format a lythoshi `bigint` to a clean plain-decimal LYTH string (no
 * thousands separators, no unit) suitable for writing back into the amount
 * input — `formatLyth` adds commas + a "LYTH" suffix, which the amount
 * validator rejects, so the quick-fill chips use this instead.
 */
function lythoshiToPlainLyth(lythoshi: bigint): string {
  if (lythoshi <= 0n) return "0";
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const fraction = lythoshi % LYTHOSHI_PER_LYTH;
  if (fraction === 0n) return whole.toString();
  const fracStr = fraction
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .replace(/0+$/, "");
  return fracStr.length === 0 ? whole.toString() : `${whole}.${fracStr}`;
}
