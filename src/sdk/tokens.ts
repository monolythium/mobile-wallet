// Tokens SDK seam — wraps `lyth_getTokenBalances` joined with per-token MRC
// metadata (`lythGetTokenBalancesWithMetadata`) and surfaces a mobile-friendly
// normalised shape.
//
// The chain returns PUBLIC-only balances by construction (private-denomination
// balances are excluded by the node). Raw `balance` strings are decimal atomic
// units; `metadata.decimals` is applied client-side for display. When the
// indexer is disabled / pruned on the connected node the per-token surface is
// unavailable — the seam surfaces that as a `coverage` sentinel so the screen
// can render "token index offline" rather than a misleading empty list. The
// native LYTH row is NOT sourced here (it comes from `loadChainSnapshot`,
// `eth_getBalance` — always available); this seam only carries indexed MRC
// balances layered on top of the honest native row.

import { SdkError, addressToTypedBech32 } from "@monolythium/core-sdk";
import type { TokenBalanceWithMetadata } from "@monolythium/core-sdk";
import { getProvider } from "./client";

/** Coverage state for the per-token balance read. `available` ⇒ the node
 *  served a (possibly empty) token list; `indexer_disabled` ⇒ the per-token
 *  index isn't served on the connected node so balances can't be enumerated. */
export type TokensCoverage = "available" | "indexer_disabled";

export interface TokensFetchResult {
  /** Indexed MRC token balances joined with metadata. Empty when the address
   *  holds no indexed MRC assets (or when the index is offline — read
   *  `coverage`). Never includes the native LYTH row. */
  tokens: TokenBalanceWithMetadata[];
  /** Whether the per-token index is served by the connected node. */
  coverage: TokensCoverage;
  /** Set when the fetch hit a network / RPC error other than a disabled index. */
  error: string | null;
}

/**
 * Fetch indexed MRC token balances for a hex (`0x…`) address, joined with
 * per-token MRC metadata. Mirrors `fetchAddressActivity`: failures are
 * surfaced via the `error` / `coverage` fields so the screen never throws.
 *
 * `address` is the bound wallet's raw hex (`0x…`) form; the SDK token read
 * requires a typed `mono1…` bech32m address (raw 0x addresses are retired), so
 * it's converted here before the call — the same hex↔bech32m seam Activity
 * uses.
 *
 * A node that doesn't serve the token index returns a method-disabled /
 * method-not-found SDK error — that's reported as `coverage:
 * "indexer_disabled"` (an honest "offline", not an error), exactly as Activity
 * treats `lyth_addressActivityKind`'s `indexer_disabled` sentinel.
 */
export async function fetchTokenBalances(
  address: string,
): Promise<TokensFetchResult> {
  const rpc = getProvider().rpcClient;
  const typed = addressToTypedBech32("user", address);
  try {
    const tokens = await rpc.lythGetTokenBalancesWithMetadata(typed);
    return { tokens, coverage: "available", error: null };
  } catch (cause) {
    if (isIndexerUnavailable(cause)) {
      return { tokens: [], coverage: "indexer_disabled", error: null };
    }
    return {
      tokens: [],
      coverage: "available",
      error: (cause as Error)?.message ?? "token balances unavailable",
    };
  }
}

/** JSON-RPC error codes that mean "the connected node doesn't serve this
 *  method": `-32601` method-not-found (standard) and `-32045` method-disabled
 *  (the chain's code for a method gated off on this node). */
const METHOD_UNAVAILABLE_CODES = new Set([-32601, -32045]);

/** A method-disabled / method-not-found RPC error means the connected node
 *  simply doesn't serve the per-token index — render it as "offline", not as
 *  a hard error. Gate on the JSON-RPC `code` (robust) and fall back to the
 *  message for transports that don't carry one. */
function isIndexerUnavailable(cause: unknown): boolean {
  if (cause instanceof SdkError) {
    if (cause.kind === "rpc" && typeof cause.code === "number") {
      return METHOD_UNAVAILABLE_CODES.has(cause.code);
    }
  }
  const message = ((cause as Error)?.message ?? "").toLowerCase();
  return (
    message.includes("method disabled") ||
    message.includes("method not found") ||
    message.includes("not supported")
  );
}

/**
 * Display name / symbol for an indexed token row. Falls back to a shortened
 * token id when the indexer carries no MRC metadata for the asset — never a
 * fabricated name.
 */
export function tokenDisplay(entry: TokenBalanceWithMetadata): {
  name: string;
  symbol: string | null;
} {
  const name = entry.metadata?.name?.trim();
  const symbol = entry.metadata?.symbol?.trim();
  return {
    name: name && name.length > 0 ? name : shortTokenId(entry.tokenId),
    symbol: symbol && symbol.length > 0 ? symbol : null,
  };
}

/**
 * Format a raw decimal `balance` string into a human-readable amount using the
 * token's `decimals`. The chain returns `balance` as decimal atomic units; we
 * shift the decimal point by `decimals` (default 0 when the indexer carries no
 * decimals) without going through a lossy `Number`. Trailing fractional zeros
 * are trimmed so whole-token balances render cleanly.
 */
export function formatTokenBalance(entry: TokenBalanceWithMetadata): string {
  const raw = (entry.balance ?? "").trim();
  if (raw.length === 0) return "0";
  const decimals = entry.metadata?.decimals ?? 0;
  if (decimals <= 0) return raw;

  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  const whole = padded.slice(0, cut);
  const fraction = padded.slice(cut).replace(/0+$/, "");
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/** Shorten a 32-byte `0x` token id for display when no symbol is available. */
function shortTokenId(tokenId: string): string {
  if (tokenId.length <= 14) return tokenId;
  return `${tokenId.slice(0, 8)}…${tokenId.slice(-6)}`;
}

/** Short MRC monogram for the row icon (no native gold styling — these are
 *  MRC assets, not native LYTH). Derives from a REAL metadata symbol or name;
 *  when the indexer carries neither it falls back to a generic "MRC" rather
 *  than mining letters out of the raw token-id hex. */
export function tokenMonogram(entry: TokenBalanceWithMetadata): string {
  const symbol = entry.metadata?.symbol?.trim();
  const name = entry.metadata?.name?.trim();
  const source = symbol && symbol.length > 0 ? symbol : name;
  if (!source || source.length === 0) return "MRC";
  const letters = source.replace(/[^A-Za-z0-9]/g, "").slice(0, 3);
  return letters.length > 0 ? letters.toUpperCase() : "MRC";
}
