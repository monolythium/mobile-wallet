// Receive — show the wallet's typed `mono1…` address as a QR code, plus
// a copy-with-clear affordance for paste-into-paper-wallet flows.

import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import { copyWithAutoClear } from "../lib/clipboard-with-clear";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. */
  selfAddress: string;
  onClose: () => void;
}

const COPY_RESET_MS = 1_800;

export function Receive({ selfAddress, onClose }: Props) {
  const bech32m = useMemo(
    () => addressToTypedBech32("user", selfAddress),
    [selfAddress],
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_RESET_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const onCopy = async () => {
    try {
      await copyWithAutoClear(bech32m, 30_000);
      setCopied(true);
    } catch {
      // Clipboard denied — silent; user can still long-press the address.
    }
  };

  return (
    <div className="mw-scroll">
      <div
        className="mw-card"
        style={{ display: "flex", flexDirection: "column", alignItems: "center" }}
      >
        <div className="mw-card__head" style={{ alignSelf: "stretch" }}>
          <h3>Receive LYTH</h3>
        </div>
        <p
          style={{
            margin: "0 0 18px",
            fontSize: 13,
            color: "var(--fg-300)",
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          Share this typed address with the sender. Only Monolythium
          transactions arrive here.
        </p>

        <div
          style={{
            padding: 16,
            borderRadius: 16,
            background: "#fff",
          }}
        >
          <QRCodeSVG
            value={bech32m}
            size={196}
            level="M"
            marginSize={0}
            bgColor="#ffffff"
            fgColor="#0a0a14"
          />
        </div>

        <div
          style={{
            marginTop: 18,
            fontFamily: "var(--f-mono)",
            fontSize: 12.5,
            color: "var(--fg-200)",
            wordBreak: "break-all",
            textAlign: "center",
            padding: "10px 12px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid var(--fg-700)",
            borderRadius: 10,
            width: "100%",
          }}
        >
          {bech32m}
        </div>

        <button
          className="mw-btn mw-btn--primary mw-btn--block"
          onClick={() => void onCopy()}
          style={{ marginTop: 14 }}
        >
          {copied ? "Copied" : "Copy address"}
        </button>
      </div>

      <button
        className="mw-btn mw-btn--block"
        onClick={onClose}
        style={{ marginTop: 12 }}
      >
        Close
      </button>
    </div>
  );
}
