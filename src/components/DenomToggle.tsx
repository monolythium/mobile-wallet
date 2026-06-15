// DenomToggle — the Public / Private segmented control (ported from
// designs/src/wallet-mobile.jsx `.mw-denom`). Sits at the top of Home when the
// privacy gate is enabled; switching it drives `data-denom` on the app root,
// which re-skins the shell and flips every denom-aware screen (Home hero,
// Tokens, Stake, Activity) into its private state.
//
// This is a DISPLAY gate only — the chain serves public-only balances, so
// private mode hides amounts client-side rather than reading a separate
// private denomination off-chain.

import type { Denom } from "../sdk/privacy";

const ORDER: Denom[] = ["public", "private"];

interface Props {
  denom: Denom;
  setDenom: (next: Denom) => void;
}

export function DenomToggle({ denom, setDenom }: Props) {
  return (
    <div className="mw-denom" data-on={denom} role="tablist" aria-label="Balance denomination">
      <div className="ind" aria-hidden="true" />
      {ORDER.map((d) => (
        <button
          key={d}
          type="button"
          role="tab"
          aria-selected={denom === d}
          className={denom === d ? "on" : ""}
          onClick={() => setDenom(d)}
        >
          {d === "public" ? "Public" : "Private"}
        </button>
      ))}
    </div>
  );
}
