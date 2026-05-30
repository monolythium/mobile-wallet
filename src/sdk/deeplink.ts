// Stage 4 deep-link parser.
//
// Funnel for every "the OS handed us a URL" path: native URL schemes
// (`monolythium://`, `lyth:`), QR scans, and pasted strings all land here
// before the React layer routes them. Keeping a single parser means the QR
// scanner and the Send / Sign sheets don't need to know about each other's
// concerns — both consume the same typed `DeepLinkAction` value.
//
// Recognised inputs:
//
//   monolythium://send?to=mono1..&value=..&token=monoc1..
//   monolythium://stake?cluster=C-003&clusterId=3&chainId=69420
//   monolythium://sign?type=personal&message=0x..
//   monolythium://sign?type=typed&domain=..&message=..  (EIP-712, JSON-encoded)
//   lyth:<mono1-address>?value=..&token=..       (shorthand send)
//
// Anything that doesn't match returns `{ kind: "unknown", raw }` and the
// caller renders an "unrecognised request" sheet.
//
// Stage 4 NEVER ships seed material — every action below is a *request*. The
// drawer / approval sheet still gates on biometric+vault auth.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  ADDRESS_KIND_HRPS,
  typedBech32ToAddress,
  type AddressKind,
} from "@monolythium/core-sdk";

export interface SendAction {
  kind: "send";
  /** Typed ADR-0038 user address (`mono1...`). */
  to: string;
  /** Native base-unit decimal string. Optional for asset-only deep links. */
  value?: string;
  /** Typed ADR-0038 contract address (`monoc1...`). Absent = native LYTH. */
  token?: string;
  /** Optional Monolythium chain id, decimal. Absent = use the wallet's active chain. */
  chainId?: number;
  raw: string;
}

export type PersonalSignAction = {
  kind: "sign-personal";
  /** Hex-encoded message bytes. */
  message: string;
  raw: string;
};

export type TypedSignAction = {
  kind: "sign-typed";
  /** EIP-712 typed data JSON (already parsed for caller convenience). */
  typedData: unknown;
  raw: string;
};

export interface StakeAction {
  kind: "stake";
  /** Human cluster label, e.g. C-003. */
  cluster?: string;
  /** Numeric cluster id when provided by an explorer. */
  clusterId?: number;
  /** Optional Monolythium chain id, decimal. Absent = use the wallet's active chain. */
  chainId?: number;
  raw: string;
}

export interface UnknownAction {
  kind: "unknown";
  reason: string;
  raw: string;
}

export type DeepLinkAction =
  | SendAction
  | PersonalSignAction
  | TypedSignAction
  | StakeAction
  | UnknownAction;

/**
 * Parse a single string into a typed action. Returns `unknown` rather than
 * throwing — the caller decides how to surface the failure.
 */
export function parseDeepLink(raw: string): DeepLinkAction {
  if (!raw) return { kind: "unknown", reason: "empty input", raw };
  const trimmed = raw.trim();

  // 1. `lyth:` shorthand send — `lyth:<address>?value=..&token=..`.
  if (trimmed.toLowerCase().startsWith("lyth:")) {
    return parseLythShorthand(trimmed, raw);
  }

  // 2. EIP-681 `ethereum:` URIs are not a Monolythium public address
  //    surface. Reject them instead of silently coercing raw 0x recipients.
  if (trimmed.toLowerCase().startsWith("ethereum:")) {
    return {
      kind: "unknown",
      reason: "ethereum: raw 0x addresses are retired; use a typed monolythium send link",
      raw,
    };
  }

  // 3. `monolythium://...` — the wallet's own scheme, parsed via URL.
  if (trimmed.toLowerCase().startsWith("monolythium:")) {
    return parseMonolythiumScheme(trimmed, raw);
  }

  // 4. Bare 0x-prefixed addresses are retired at public wallet surfaces.
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return {
      kind: "unknown",
      reason: "raw 0x addresses are retired; use a typed mono1 address",
      raw,
    };
  }

  return { kind: "unknown", reason: "unrecognised scheme", raw };
}

function parseMonolythiumScheme(input: string, raw: string): DeepLinkAction {
  // `URL` requires `://` even for a custom scheme; accept both
  // `monolythium://send?...` and `monolythium:send?...` — the latter is
  // technically a colon-separated form some wallets emit. We normalise.
  const normalised = input.includes("://")
    ? input
    : input.replace(/^monolythium:/i, "monolythium://");
  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    return { kind: "unknown", reason: "invalid monolythium URL", raw };
  }

  // host carries the verb (`send`, `sign`). Pathname is reserved.
  const verb = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const params = url.searchParams;

  switch (verb) {
    case "send": {
      const to = params.get("to");
      if (!to) return { kind: "unknown", reason: "send: missing to", raw };
      return buildSendAction(to, {
        value: params.get("value") ?? undefined,
        token: params.get("token") ?? undefined,
        chainId: optInt(params.get("chainId")),
        raw,
      });
    }
    case "stake": {
      const cluster = params.get("cluster") ?? undefined;
      const clusterId = optInt(params.get("clusterId"));
      if (!cluster && clusterId === undefined) {
        return { kind: "unknown", reason: "stake: missing cluster", raw };
      }
      return {
        kind: "stake",
        cluster,
        clusterId,
        chainId: optInt(params.get("chainId")),
        raw,
      };
    }
    case "sign": {
      const type = (params.get("type") ?? "personal").toLowerCase();
      const message = params.get("message");
      if (!message) {
        return { kind: "unknown", reason: "sign: missing message", raw };
      }
      if (type === "personal") {
        return { kind: "sign-personal", message, raw };
      }
      if (type === "typed" || type === "typed-data" || type === "eip712") {
        try {
          // EIP-712 payloads are large — usually base64 / URL-encoded JSON.
          // Try a JSON parse first, fall through to base64 → JSON.
          let typedData: unknown;
          try {
            typedData = JSON.parse(message);
          } catch {
            typedData = JSON.parse(atob(message));
          }
          return { kind: "sign-typed", typedData, raw };
        } catch {
          return { kind: "unknown", reason: "sign: typed-data not JSON", raw };
        }
      }
      return { kind: "unknown", reason: `sign: unknown type ${type}`, raw };
    }
    default:
      return { kind: "unknown", reason: `unknown verb: ${verb || "(none)"}`, raw };
  }
}

function parseLythShorthand(input: string, raw: string): SendAction | UnknownAction {
  // Format: `lyth:<address>?value=..&token=..&chainId=..`
  const stripped = input.slice("lyth:".length);
  const qIdx = stripped.indexOf("?");
  const addr = qIdx === -1 ? stripped : stripped.slice(0, qIdx);
  if (!addr) return { kind: "unknown", reason: "lyth: missing address", raw };
  const params = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(stripped.slice(qIdx + 1));
  return buildSendAction(addr, {
    value: params.get("value") ?? undefined,
    token: params.get("token") ?? undefined,
    chainId: optInt(params.get("chainId")),
    raw,
  });
}

function buildSendAction(
  to: string,
  opts: { value?: string; token?: string; chainId?: number; raw: string },
): SendAction | UnknownAction {
  let typedTo: string;
  try {
    typedTo = requireDeepLinkAddress(to, "user", "send.to");
  } catch (err) {
    return {
      kind: "unknown",
      reason: err instanceof Error ? err.message : String(err),
      raw: opts.raw,
    };
  }

  let typedToken: string | undefined;
  if (opts.token !== undefined) {
    try {
      typedToken = requireDeepLinkAddress(opts.token, "contract", "send.token");
    } catch (err) {
      return {
        kind: "unknown",
        reason: err instanceof Error ? err.message : String(err),
        raw: opts.raw,
      };
    }
  }

  return {
    kind: "send",
    to: typedTo,
    value: opts.value,
    token: typedToken,
    chainId: opts.chainId,
    raw: opts.raw,
  };
}

function requireDeepLinkAddress(address: string, expectedKind: AddressKind, label: string): string {
  if (address.startsWith("0x") || address.startsWith("0X")) {
    throw new Error(
      `${label} raw 0x addresses are retired; use typed ${ADDRESS_KIND_HRPS[expectedKind]} bech32m addresses`,
    );
  }
  try {
    return typedBech32ToAddress(address, expectedKind).address;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${label} must be typed ${ADDRESS_KIND_HRPS[expectedKind]} bech32m address: ${message}`,
    );
  }
}

function optInt(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined || s === "") return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

// -----------------------------------------------------------------------------
// Runtime listener — wires the Rust-side `mw:deep-link` event into the React
// app. Two channels are subscribed because the deep-link plugin's
// `onOpenUrl` is the canonical mobile path, and the manual emit from
// `lib.rs` covers any edge case (e.g., `register_all` round trip).
// -----------------------------------------------------------------------------

export type DeepLinkSubscriber = (action: DeepLinkAction) => void;

/**
 * Subscribe to OS-delivered deep links. Returns an unsubscribe fn.
 * Every URL is parsed and forwarded as a typed `DeepLinkAction`.
 */
export async function subscribeDeepLinks(cb: DeepLinkSubscriber): Promise<UnlistenFn> {
  const dispatch = (raw: string) => {
    if (!raw) return;
    cb(parseDeepLink(raw));
  };

  // Path A — the plugin's own callback (preferred). May fire one URL per call.
  const unsubA = await onOpenUrl((urls) => {
    for (const u of urls) dispatch(u);
  });

  // Path B — the manual emit from `lib.rs`. Carries an array of strings.
  const unsubB = await listen<string[]>("mw:deep-link", (event) => {
    const payload = event.payload;
    if (Array.isArray(payload)) {
      for (const u of payload) dispatch(u);
    }
  });

  return () => {
    unsubA();
    unsubB();
  };
}
