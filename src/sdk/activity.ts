// Activity SDK seam — wraps `lyth_getAddressActivity` and surfaces a
// mobile-friendly normalised entry shape.
//
// The chain returns `AddressActivityEntry[]` with kind / direction /
// counterparty / token / amount / cluster / weightBps / subKind. The
// indexer may be disabled or pruned for a region of the chain — in
// either case the chain returns an empty array and a sentinel via
// `lyth_addressActivityKind`. Callers render that as "indexer offline"
// rather than "no activity."

import { typedBech32ToAddress } from "@monolythium/core-sdk";
import type {
  AddressActivityEntry,
  AddressActivityKindResponse,
} from "@monolythium/core-sdk";
import { getProvider } from "./client";

export interface ActivityFetchResult {
  entries: AddressActivityEntry[];
  /** Sentinel from `lyth_addressActivityKind` if the indexer surfaces
   *  one (`found`, `not_found`, `indexer_disabled`, `pruned`, `private`). */
  coverage: AddressActivityKindResponse | null;
  /** Set when the fetch hit a network / RPC error. */
  error: string | null;
}

const DEFAULT_LIMIT = 25;

/**
 * Fetch recent activity for a typed `mono1…` address, plus the
 * coverage sentinel so the caller can render "indexer offline" when
 * the chain reports it. Failures are surfaced via the `error` field so
 * the screen never throws.
 */
export async function fetchAddressActivity(
  bech32m: string,
  limit: number = DEFAULT_LIMIT,
): Promise<ActivityFetchResult> {
  const rpc = getProvider().rpcClient;
  const hex = typedBech32ToAddress(bech32m, "user").hex;
  try {
    const [entries, coverage] = await Promise.all([
      rpc.lythGetAddressActivity(hex, limit, null),
      rpc.lythAddressActivityKind(hex).catch(() => null),
    ]);
    return { entries, coverage, error: null };
  } catch (cause) {
    return {
      entries: [],
      coverage: null,
      error: (cause as Error)?.message ?? "activity unavailable",
    };
  }
}

/**
 * Human label for an activity entry. Used in the list row's title.
 * Falls back to the raw kind / subKind string when the SDK introduces
 * a new variant.
 */
export function activityTitle(entry: AddressActivityEntry): string {
  const k = entry.kind?.toLowerCase() ?? "unknown";
  switch (k) {
    case "transfer": {
      const dir = entry.direction?.toLowerCase();
      if (dir === "in" || dir === "incoming" || dir === "receive") {
        return "Received";
      }
      if (dir === "out" || dir === "outgoing" || dir === "send") {
        return "Sent";
      }
      return "Transfer";
    }
    case "delegation":
    case "staking": {
      const sub = entry.subKind?.toLowerCase();
      if (sub === "delegate" || sub === "delegated") return "Delegated";
      if (sub === "undelegate" || sub === "unstake") return "Undelegated";
      if (sub === "redelegate") return "Redelegated";
      if (sub === "stake") return "Staked";
      return "Staking";
    }
    case "swap":
      return "Swap";
    default:
      return k.charAt(0).toUpperCase() + k.slice(1);
  }
}

/**
 * Best-effort decimal-LYTH amount. The entry carries `amount` as a
 * decimal string (or null when the event has no value movement); we
 * just trim trailing zeros so the list looks consistent.
 */
export function activityAmountLyth(entry: AddressActivityEntry): string | null {
  if (entry.amount === null) return null;
  const trimmed = entry.amount.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return trimmed;
}
