// Tokens — dedicated screen listing the wallet's live token holdings.
//
// Reachable from Home (the Home "Tokens" card opens it). It renders the honest
// native LYTH row — read through `loadChainSnapshot` (eth_getBalance), the same
// live path Home/Activity/Stake use — plus any per-token MRC balances the
// connected node's indexer serves (`lyth_getTokenBalances` joined with MRC
// metadata). There is no on-chain price oracle, so USD stays an honest em-dash
// — never a fabricated fiat value. When the per-token index is offline the
// screen says so rather than pretending the wallet holds only LYTH.

import { useEffect, useState } from "react";
import { addressToTypedBech32 } from "@monolythium/core-sdk";
import type { TokenBalanceWithMetadata } from "@monolythium/core-sdk";
import { loadChainSnapshot, type ChainSnapshot } from "../sdk/client";
import {
  fetchTokenBalances,
  formatTokenBalance,
  tokenDisplay,
  tokenMonogram,
  type TokensCoverage,
} from "../sdk/tokens";
import type { Denom } from "../sdk/privacy";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault. `null` until resolved. */
  selfAddress: string | null;
  /** Active display denomination. Tokens are public-only; in private mode the
   *  screen shows the disclosure state rather than holdings. */
  denom: Denom;
  onClose: () => void;
}

const fmt = (n: number, f = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: f, maximumFractionDigits: f });

/** Native LYTH balance load state (mirrors Home). */
type NativeState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: ChainSnapshot }
  | { kind: "error"; message: string };

/** Indexed MRC token-list load state. */
type TokensState =
  | { kind: "loading" }
  | { kind: "ok"; tokens: TokenBalanceWithMetadata[]; coverage: TokensCoverage }
  | { kind: "error"; message: string };

export function Tokens({ selfAddress, denom, onClose }: Props) {
  const [native, setNative] = useState<NativeState>({ kind: "loading" });
  const [tokens, setTokens] = useState<TokensState>({ kind: "loading" });
  const isPrivate = denom === "private";

  // Native LYTH read — same one-shot-on-mount pattern as Home, sourced from
  // `eth_getBalance` so an offline node renders honestly rather than 0. Skipped
  // in private mode: tokens are public-only, so the screen never reads them.
  useEffect(() => {
    if (selfAddress === null || isPrivate) return;
    let cancelled = false;
    setNative({ kind: "loading" });
    void (async () => {
      try {
        const snapshot = await loadChainSnapshot(selfAddress);
        if (cancelled) return;
        if (snapshot.error) {
          setNative({ kind: "error", message: snapshot.error.message });
        } else {
          setNative({ kind: "ok", snapshot });
        }
      } catch (cause) {
        if (!cancelled) {
          setNative({
            kind: "error",
            message: (cause as Error)?.message ?? "balance unavailable",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selfAddress, isPrivate]);

  // Indexed MRC balances — best-effort. The seam reports an offline index as
  // `coverage: "indexer_disabled"` rather than an error. Skipped in private
  // mode (tokens are public-only).
  useEffect(() => {
    if (selfAddress === null || isPrivate) return;
    let cancelled = false;
    setTokens({ kind: "loading" });
    void (async () => {
      const res = await fetchTokenBalances(selfAddress);
      if (cancelled) return;
      if (res.error) {
        setTokens({ kind: "error", message: res.error });
      } else {
        setTokens({ kind: "ok", tokens: res.tokens, coverage: res.coverage });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selfAddress, isPrivate]);

  // Private mode — tokens live on the public side (the chain serves
  // public-only balances). Show the design's disclosure state rather than a
  // misleading empty list.
  if (isPrivate) {
    return (
      <div className="mw-scroll">
        <div className="mw-card" style={{ textAlign: "center", padding: 28 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>
            Private mode
          </div>
          <div
            className="row-help"
            style={{ color: "var(--fg-400)", lineHeight: 1.55 }}
          >
            Tokens are listed on the public side. Switch to Public to see your
            holdings.
          </div>
        </div>
        <div className="mw-card">
          <button
            type="button"
            className="mw-btn"
            style={{ width: "100%" }}
            onClick={onClose}
          >
            Back to wallet
          </button>
        </div>
      </div>
    );
  }

  if (selfAddress === null) {
    return (
      <div className="mw-scroll">
        <div className="mw-card">
          <p style={{ margin: 0, color: "var(--fg-300)", fontSize: 13 }}>
            Resolving wallet identity…
          </p>
        </div>
      </div>
    );
  }

  const indexedCount =
    tokens.kind === "ok" ? tokens.tokens.length : 0;
  // The native row is always present; indexed MRC rows add to the held count.
  const heldLabel =
    native.kind === "ok"
      ? `${1 + indexedCount} held`
      : native.kind === "loading"
        ? "loading"
        : indexedCount > 0
          ? `${indexedCount} held`
          : "—";

  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Tokens</h3>
          <div className="spacer" />
          <span className="more">{heldLabel}</span>
        </div>

        {/* Native LYTH — always available via eth_getBalance. */}
        {native.kind === "error" ? (
          <div className="row-help" style={{ color: "var(--err)", marginTop: 8 }}>
            Couldn&apos;t read your balance from the connected node. Recent
            transactions you submit will still confirm on-chain.
          </div>
        ) : (
          <div className="mw-row">
            <div className="mw-row__icon native">LYT</div>
            <div>
              <div className="mw-row__name">
                Monolythium
                <span className="ticker">LYTH</span>
              </div>
              <div className="mw-row__sub">
                {native.kind === "loading"
                  ? "… LYTH"
                  : `${fmt(native.snapshot.balanceLyth)} LYTH`}
              </div>
            </div>
            <div className="mw-row__right">
              {/* No price oracle on chain — USD is honestly unavailable. */}
              <div className="primary">—</div>
            </div>
          </div>
        )}

        {/* Indexed MRC balances, layered below the native row. */}
        {tokens.kind === "ok" &&
          tokens.tokens.map((entry) => (
            <TokenRow key={entry.tokenId} entry={entry} />
          ))}
      </div>

      <TokensFootnote
        nativeError={native.kind === "error"}
        tokens={tokens}
        bech32m={addressToTypedBech32("user", selfAddress)}
      />

      <div className="mw-card">
        <button
          type="button"
          className="mw-btn"
          style={{ width: "100%" }}
          onClick={onClose}
        >
          Back to wallet
        </button>
      </div>
    </div>
  );
}

function TokenRow({ entry }: { entry: TokenBalanceWithMetadata }) {
  const { name, symbol } = tokenDisplay(entry);
  return (
    <div className="mw-row">
      <div className="mw-row__icon">{tokenMonogram(entry)}</div>
      <div style={{ minWidth: 0 }}>
        <div className="mw-row__name">
          {name}
          {symbol && <span className="ticker">{symbol}</span>}
        </div>
        <div className="mw-row__sub" style={{ wordBreak: "break-all" }}>
          {formatTokenBalance(entry)}
          {symbol ? ` ${symbol}` : ""}
        </div>
      </div>
      <div className="mw-row__right">
        {/* No price oracle on chain — USD is honestly unavailable. */}
        <div className="primary">—</div>
      </div>
    </div>
  );
}

/** Honest coverage note: the chain has no price oracle (USD em-dashes
 *  everywhere) and the per-token index may be offline on the connected node. */
function TokensFootnote({
  nativeError,
  tokens,
  bech32m,
}: {
  nativeError: boolean;
  tokens: TokensState;
  bech32m: string;
}) {
  const lines: string[] = [];

  if (tokens.kind === "loading") {
    lines.push("Reading token balances from the connected node…");
  } else if (tokens.kind === "error") {
    lines.push(
      "Couldn’t read MRC token balances from the connected node. Your native LYTH balance above is still live.",
    );
  } else if (tokens.coverage === "indexer_disabled") {
    lines.push(
      "The connected node doesn’t serve the per-token index, so MRC token balances can’t be listed here. Native LYTH is read directly and stays live.",
    );
  } else if (tokens.tokens.length === 0 && !nativeError) {
    lines.push("This wallet holds no indexed MRC tokens — only native LYTH.");
  }

  lines.push(
    "USD values are unavailable — Monolythium has no on-chain price oracle.",
  );

  return (
    <div className="mw-card">
      {lines.map((line, i) => (
        <div
          key={i}
          className="row-help"
          style={{ marginTop: i === 0 ? 0 : 6, color: "var(--fg-400)" }}
        >
          {line}
        </div>
      ))}
      <div
        className="row-help"
        style={{ marginTop: 8, color: "var(--fg-500)", fontSize: 11, wordBreak: "break-all" }}
      >
        {bech32m}
      </div>
    </div>
  );
}
