// Stage 4 deep-link parser.
//
// Funnel for every "the OS handed us a URL" path: native URL schemes
// (`monolythium://`, `lyth:`), QR scans, and pasted strings all land here
// before the React layer routes them. Keeping a single parser means the QR
// scanner doesn't need to know about WalletConnect, and Send / Sign sheets
// don't need to know about QR camera state — both consume the same typed
// `DeepLinkAction` value.
//
// Recognised inputs:
//
//   monolythium://send?to=0x..&value=..&token=0x..
//   monolythium://stake?cluster=C-003&clusterId=3&chainId=69420
//   monolythium://sign?type=personal&message=0x..
//   monolythium://sign?type=typed&domain=..&message=..  (EIP-712, JSON-encoded)
//   monolythium://wc?uri=wc:<topic>@2?relay-protocol=irn&symKey=..
//   lyth:<address>?value=..&token=..             (shorthand send)
//   wc:<topic>@2?relay-protocol=irn&symKey=..    (raw WalletConnect URI)
//   ethereum:<address>?value=..                  (EIP-681, narrow accept)
//   <0x...>                                       (bare 20-byte address, plain text)
//
// Anything that doesn't match returns `{ kind: "unknown", raw }` and the
// caller renders an "unrecognised request" sheet.
//
// Stage 4 NEVER ships seed material — every action below is a *request*. The
// drawer / approval sheet still gates on biometric+vault auth.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";

export interface SendAction {
  kind: "send";
  to: string;
  /** Native base-unit decimal string. Optional for asset-only deep links. */
  value?: string;
  /** ERC-20 contract address. Absent = native LYTH. */
  token?: string;
  /** Optional EVM chain id, decimal. Absent = use the wallet's active chain. */
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

export interface WalletConnectAction {
  kind: "walletconnect";
  /** The full `wc:<topic>@2?...` URI passed straight to SignClient.pair(). */
  uri: string;
  raw: string;
}

export interface StakeAction {
  kind: "stake";
  /** Human cluster label, e.g. C-003. */
  cluster?: string;
  /** Numeric cluster id when provided by an explorer. */
  clusterId?: number;
  /** Optional EVM chain id, decimal. Absent = use the wallet's active chain. */
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
  | WalletConnectAction
  | StakeAction
  | UnknownAction;

/**
 * Parse a single string into a typed action. Returns `unknown` rather than
 * throwing — the caller decides how to surface the failure.
 */
export function parseDeepLink(raw: string): DeepLinkAction {
  if (!raw) return { kind: "unknown", reason: "empty input", raw };
  const trimmed = raw.trim();

  // 1. WalletConnect v2 — match early because the URI looks like
  //    `wc:<hex>@2?relay-protocol=irn&symKey=<hex>` and the leading scheme
  //    is what the relay routes on.
  if (trimmed.toLowerCase().startsWith("wc:")) {
    return validateWcUri(trimmed)
      ? { kind: "walletconnect", uri: trimmed, raw }
      : { kind: "unknown", reason: "malformed wc: uri", raw };
  }

  // 2. `lyth:` shorthand send — `lyth:<address>?value=..&token=..`.
  if (trimmed.toLowerCase().startsWith("lyth:")) {
    return parseLythShorthand(trimmed, raw);
  }

  // 3. EIP-681 `ethereum:` URIs — accept a narrow subset (address-only and
  //    `address?value=`) so users who scan a generic Ethereum QR can still
  //    fund a send. Token-transfer ABI calls (`/transfer?...`) deferred.
  if (trimmed.toLowerCase().startsWith("ethereum:")) {
    return parseEthereumEip681(trimmed, raw);
  }

  // 4. `monolythium://...` — the wallet's own scheme, parsed via URL.
  if (trimmed.toLowerCase().startsWith("monolythium:")) {
    return parseMonolythiumScheme(trimmed, raw);
  }

  // 5. Bare 0x-prefixed address — common QR encoding for "share my address".
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { kind: "send", to: trimmed, raw };
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

  // host carries the verb (`send`, `sign`, `wc`). Pathname is reserved.
  const verb = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const params = url.searchParams;

  switch (verb) {
    case "send": {
      const to = params.get("to");
      if (!to) return { kind: "unknown", reason: "send: missing to", raw };
      return {
        kind: "send",
        to,
        value: params.get("value") ?? undefined,
        token: params.get("token") ?? undefined,
        chainId: optInt(params.get("chainId")),
        raw,
      };
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
    case "wc": {
      const uri = params.get("uri") ?? params.get("u");
      if (!uri) {
        return { kind: "unknown", reason: "wc: missing uri", raw };
      }
      return validateWcUri(uri)
        ? { kind: "walletconnect", uri, raw }
        : { kind: "unknown", reason: "wc: malformed uri", raw };
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
  return {
    kind: "send",
    to: addr,
    value: params.get("value") ?? undefined,
    token: params.get("token") ?? undefined,
    chainId: optInt(params.get("chainId")),
    raw,
  };
}

function parseEthereumEip681(input: string, raw: string): SendAction | UnknownAction {
  // EIP-681 minimal: `ethereum:<address>[@chainId][?value=..&...]`
  const stripped = input.slice("ethereum:".length);
  const qIdx = stripped.indexOf("?");
  const head = qIdx === -1 ? stripped : stripped.slice(0, qIdx);
  // Drop any `/<function>` suffix (we don't model token transfers here).
  const headBare = head.split("/")[0]!;
  const [addrRaw, chainPart] = headBare.split("@");
  const addr = addrRaw ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return { kind: "unknown", reason: "ethereum: invalid address", raw };
  }
  const params = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(stripped.slice(qIdx + 1));
  return {
    kind: "send",
    to: addr,
    value: params.get("value") ?? undefined,
    token: undefined,
    chainId: optInt(chainPart) ?? optInt(params.get("chainId")),
    raw,
  };
}

function validateWcUri(uri: string): boolean {
  // Minimal sanity check — the SignClient enforces the rest. Spec form:
  //   `wc:<topic>@2?relay-protocol=irn&symKey=<hex>`
  // Topic is hex; symKey is hex. We're only filtering obvious junk so the
  // user gets an immediate "this isn't a WC URI" instead of an opaque
  // SignClient error.
  if (!/^wc:[a-f0-9]{1,128}@[12]/i.test(uri)) return false;
  const qIdx = uri.indexOf("?");
  if (qIdx === -1) return false;
  const params = new URLSearchParams(uri.slice(qIdx + 1));
  return Boolean(params.get("symKey")) && Boolean(params.get("relay-protocol"));
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
