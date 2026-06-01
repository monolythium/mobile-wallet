// Ask — natural-language wallet helper.
//
// Experimental surface (flag-gated). It does NOT parse a free-text request
// into a draft transaction: there is no on-device natural-language model and
// guessing a recipient/amount from a string is a safety hazard. Instead it
// points the user at the real, typed flows (Send, Activity, Stake) where every
// destructive step routes through the Operations drawer + keychain.

import { useState } from "react";
import { Icon } from "../components/Icon";
import type { OperationRequest } from "../components/OperationsDrawer";

interface Props {
  // Kept for signature compatibility with the host shell; this screen no
  // longer drafts operations on its own (see file header).
  openOperation: (req: OperationRequest) => void;
}

const SUGGESTIONS = [
  "How do I send LYTH?",
  "Where do I see my recent activity?",
  "How do I stake to a cluster?",
];

interface Turn {
  role: "you" | "wallet";
  text: string;
}

const SEED: Turn[] = [
  {
    role: "wallet",
    text: "I can point you to the right place in the wallet. I won't draft a transaction for you — you compose and sign every transfer yourself on this device.",
  },
];

export function Ask(_props: Props) {
  const [turns, setTurns] = useState<Turn[]>(SEED);
  const [draft, setDraft] = useState("");

  const ask = (q: string) => {
    if (!q.trim()) return;
    const lower = q.toLowerCase();
    const next: Turn[] = [...turns, { role: "you", text: q }];

    let reply: string;
    if (lower.includes("send") || lower.includes("transfer") || lower.includes("pay")) {
      reply =
        "Open the Wallet tab and tap Send. You enter the recipient and amount yourself, then authorize with biometrics or your password — nothing is pre-filled.";
    } else if (lower.includes("stake") || lower.includes("delegate") || lower.includes("cluster")) {
      reply =
        "The Stake tab lists clusters and your current delegations. Pick a cluster there to start a delegation.";
    } else if (lower.includes("activity") || lower.includes("history") || lower.includes("recent")) {
      reply =
        "The Activity tab shows your on-chain history for this wallet, read live from the connected node.";
    } else {
      reply =
        "I can guide you to the Wallet, Activity, and Stake tabs. For balances and history, those tabs read live from the chain — they're the source of truth.";
    }

    next.push({ role: "wallet", text: reply });
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
