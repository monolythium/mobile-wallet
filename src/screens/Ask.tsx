// Ask — natural-language wallet helper (adapted from designs/src/ask.jsx).
// AI is advisory only — every actionable answer routes through the
// Operations drawer so a destructive step never bypasses the keychain.

import { useState } from "react";
import { Icon } from "../components/Icon";
import type { OperationRequest } from "../components/OperationsDrawer";

interface Props {
  openOperation: (req: OperationRequest) => void;
}

const SUGGESTIONS = [
  "How much LYTH did I send last week?",
  "What is my staking APR?",
  "Show me my last cluster swap.",
  "Send 50 LYTH to Mira.",
];

interface Turn {
  role: "you" | "wallet";
  text: string;
}

const SEED: Turn[] = [
  {
    role: "wallet",
    text: "Hi Nayiem. I can answer questions about your balances, recent activity, and cluster. I can draft transfers, but you always sign on this device.",
  },
];

export function Ask({ openOperation }: Props) {
  const [turns, setTurns] = useState<Turn[]>(SEED);
  const [draft, setDraft] = useState("");

  const ask = (q: string) => {
    if (!q.trim()) return;
    const next: Turn[] = [...turns, { role: "you", text: q }];
    if (q.toLowerCase().includes("send")) {
      next.push({
        role: "wallet",
        text:
          "Drafted: send 50 LYTH to Mira Bell (mono1:demo…42a8). Open the Operations drawer to sign and submit.",
      });
      setTurns(next);
      setDraft("");
      // Surface the draft as an Operation so the user signs explicitly.
      setTimeout(
        () =>
          openOperation({
            kind: "send",
            title: "Send LYTH",
            summary: "Send 50 LYTH to Mira Bell on Monolythium v2 testnet.",
            details: [
              { k: "Asset", v: "LYTH" },
              { k: "Amount", v: "50.00", mono: true },
              { k: "To", v: "Mira Bell" },
              { k: "Address", v: "mono1:demo…42a8", mono: true },
              { k: "Drafted by", v: "wallet AI" },
            ],
            confirmLabel: "Sign and send",
          }),
        320,
      );
      return;
    }
    next.push({
      role: "wallet",
      text:
        "I can read on-chain history once the SDK is wired against your validator endpoint. For now, the Tokens and Activity tabs hold the source of truth.",
    });
    setTurns(next);
    setDraft("");
  };

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Ask the wallet</h3>
          <div className="spacer" />
          <span className="mw-halo">advisory</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {turns.map((t, i) => (
            <div
              key={i}
              style={{
                alignSelf: t.role === "you" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "10px 13px",
                borderRadius: 12,
                background:
                  t.role === "you"
                    ? "rgba(242, 180, 65, 0.14)"
                    : "rgba(255, 255, 255, 0.04)",
                border:
                  t.role === "you"
                    ? "1px solid rgba(242, 180, 65, 0.35)"
                    : "1px solid var(--fg-700)",
                fontSize: 13,
                color: t.role === "you" ? "var(--gold)" : "var(--fg-100)",
                lineHeight: 1.55,
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Suggestions</h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="mw-btn"
              style={{ justifyContent: "flex-start" }}
              onClick={() => ask(s)}
            >
              <Icon name="search" size={13} />
              <span style={{ textAlign: "left", flex: 1 }}>{s}</span>
              <Icon name="chev" size={13} />
            </button>
          ))}
        </div>
      </div>

      <div className="mw-card mw-card--input">
        <label htmlFor="mw-ask-input">Your question</label>
        <input
          id="mw-ask-input"
          value={draft}
          placeholder="Ask anything…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask(draft);
          }}
        />
      </div>
      <button
        className="mw-btn mw-btn--primary mw-btn--block"
        disabled={!draft.trim()}
        onClick={() => ask(draft)}
      >
        Ask
      </button>
    </div>
  );
}
