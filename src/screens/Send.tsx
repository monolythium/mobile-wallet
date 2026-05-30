// Send LYTH — compose screen. User enters recipient (typed mono1
// bech32m) + amount, sees a max-fee preview, and taps Review to launch
// the OperationsDrawer (biometric prompt → encrypted-envelope submit →
// done with on-chain tx hash).
//
// The Send screen owns input + validation. The drawer owns auth + write.

import { useEffect, useMemo, useState } from "react";
import {
  ADDRESS_KIND_HRPS,
  addressToTypedBech32,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";
import type { OperationRequest } from "../components/OperationsDrawer";
import { ContactsPickerSheet } from "../components/ContactsPickerSheet";
import { getProvider } from "../sdk/client";
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

const DEFAULT_LIMIT = 21_000n;
const USER_HRP = ADDRESS_KIND_HRPS.user;

// Finality posture is fixed by the chain's consensus model (whitepaper
// §13 / §18): an anchor settles in ~1s, and ML-DSA-65 quantum-attested
// checkpoints anchor finality against a future quantum adversary. There is
// no per-tx finality RPC in 0.3.10, so this is a static, honest disclosure
// row — never a fabricated per-tx confirmation count.
const FINALITY_POSTURE =
  "Anchor-level (~1s) · ML-DSA-65 quantum-attested checkpoint";

export function Send({ selfAddress, openOperation, onClose }: Props) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [feePreview, setFeePreview] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Saved contact name resolved after a pick. Cleared on any manual
  // edit of the recipient field so a stale name never travels with a
  // fresh address.
  const [resolvedContactName, setResolvedContactName] = useState<string | null>(null);

  const selfBech32m = useMemo(
    () => addressToTypedBech32("user", selfAddress),
    [selfAddress],
  );

  // Pull a fresh fee preview on mount. Re-runs only if the screen is
  // unmounted and re-opened.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const price = await getProvider().rpcClient.ethGasPrice();
        if (cancelled) return;
        setFeePreview(previewMaxFeeLyth(price, DEFAULT_LIMIT));
      } catch (cause) {
        if (cancelled) return;
        setFeeError((cause as Error)?.message ?? "fee preview unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const validate = (): string | null => {
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
    const trimmedAmt = amount.trim();
    if (!trimmedAmt) return "Amount is required.";
    if (!/^\d+(\.\d{1,8})?$/.test(trimmedAmt)) {
      return "Amount must have at most 8 decimal places.";
    }
    if (Number(trimmedAmt) === 0) return "Amount must be greater than 0.";
    if (trimmedTo.toLowerCase() === selfBech32m.toLowerCase()) {
      return "Recipient cannot be the wallet's own address.";
    }
    return null;
  };

  const onReview = async () => {
    const err = validate();
    setValidationError(err);
    if (err) return;

    const toBech32m = recipient.trim();
    const amountLyth = amount.trim();

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
    const summary = `Send ${amountLyth} LYTH to ${toLabel} on the Monolythium testnet.`;

    openOperation({
      kind: "send",
      title: `Send ${amountLyth} LYTH`,
      summary,
      details: [
        { k: "From", v: selfBech32m, mono: true },
        ...(recipientName ? [{ k: "Recipient", v: recipientName }] : []),
        { k: "To", v: toBech32m, mono: true },
        { k: "Amount", v: `${amountLyth} LYTH`, mono: true },
        ...(feePreview !== null
          ? [{ k: "Max fee", v: `${feePreview} LYTH`, mono: true }]
          : []),
        { k: "Finality", v: FINALITY_POSTURE },
      ],
      confirmLabel: "Authorise and send",
      // Notifications-center metadata (experimental-v5). Amount + 0x
      // counterparty only — never the saved contact name, per the no-secrets
      // rule. The drawer records this on the tx's real terminal receipt.
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

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Send LYTH</h3>
        </div>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: 13,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          From{" "}
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--fg-200)" }}>
            {shortAddr(selfBech32m)}
          </span>
        </p>

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
            onClick={() => setPickerOpen(true)}
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
          onChange={(e) => {
            setRecipient(e.target.value);
            if (resolvedContactName !== null) setResolvedContactName(null);
          }}
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
            Saved as <strong style={{ color: "var(--fg-200)" }}>{resolvedContactName}</strong>
          </div>
        )}

        <label style={{ ...fieldLabel, marginTop: 12 }}>Amount (LYTH)</label>
        <input
          type="text"
          inputMode="decimal"
          autoCapitalize="none"
          spellCheck={false}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          aria-label="Amount in LYTH"
          style={inputStyle}
        />

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
        <button className="mw-btn" onClick={onClose} style={{ flex: 1 }}>
          Cancel
        </button>
        <button
          className="mw-btn mw-btn--primary mw-btn--block"
          onClick={() => void onReview()}
          style={{ flex: 1 }}
          disabled={!recipient.trim() || !amount.trim()}
        >
          Review
        </button>
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
