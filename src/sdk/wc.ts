// Stage 4 WalletConnect v2 — SignClient wrapper.
//
// SignClient (vs EthereumProvider) gives us the wallet side of the protocol.
// EthereumProvider is the *dapp* helper; we never want to be a dapp. Public
// API:
//
//   wc.init()                     — boot the relay client (cached after first call)
//   wc.pair(uri)                  — pair from a `wc:<topic>@2?...` URI
//   wc.approveSession(proposal)   — accept the proposal with our chains+accounts
//   wc.rejectSession(proposal)    — explicit reject
//   wc.getSessions()              — current persisted sessions
//   wc.disconnect(topic)          — drop a session
//   wc.respondRequest(topic, id, result) — reply to a JSON-RPC request
//   wc.subscribe(handler)         — listen for `session_proposal` and
//                                   `session_request` events
//
// Compatibility note (tracked in Stage 4 brief): `@walletconnect/sign-client`
// 2.23.x relies on `BroadcastChannel`, `MessageChannel`, IndexedDB, and a
// WebSocket relay. WebKit on iOS, WebView2 on Windows, and Chromium on
// Android System WebView all expose these. Tauri 2's stock webviews are
// the same engines, so the polyfill list is empty in our build. If a
// platform smoke test fails on `BroadcastChannel`, ship a 6-line shim
// inside `boot()` rather than trying to lift this whole stack out — the
// fallback (deep-links + QR address scan) already works without WC.

import SignClient from "@walletconnect/sign-client";
import type {
  CoreTypes,
  SessionTypes,
  SignClientTypes,
} from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";

// Project ID. WalletConnect v2 requires a Cloud project ID for the relay.
// Override at build time via `VITE_WC_PROJECT_ID`. Stage 4 ships with no
// default — callers without a project ID get a clear error rather than a
// silent relay rejection on first pair.
const PROJECT_ID = (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? "";

const RELAY_URL =
  (import.meta.env.VITE_WC_RELAY_URL as string | undefined) ??
  "wss://relay.walletconnect.com";

const APP_METADATA: CoreTypes.Metadata = {
  name: "Monolythium Wallet",
  description: "Monolythium mobile wallet",
  url: "https://monolythium.io",
  icons: ["https://monolythium.io/icon-512.png"],
};

// LythiumDAG-BFT testnet — chain id 6940. Stage 4 advertises only the
// active test chain. Multi-chain support arrives when the wallet ships a
// chain-picker UI (Stage 5+).
const DEFAULT_CHAIN_EIP155_ID = 6940;
const SUPPORTED_METHODS = [
  "eth_sendTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "eth_chainId",
  "eth_accounts",
];
const SUPPORTED_EVENTS = ["accountsChanged", "chainChanged"];

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let client: InstanceType<typeof SignClient> | null = null;
let bootPromise: Promise<InstanceType<typeof SignClient>> | null = null;

// Subscribers receive every WC event the wallet cares about. The drawer +
// session list both subscribe; events are multiplexed here so we don't open
// per-component listeners on the SignClient.
type Sub = (e: WcEvent) => void;
const subscribers = new Set<Sub>();

export type WcEvent =
  | {
      kind: "session_proposal";
      proposal: SignClientTypes.EventArguments["session_proposal"];
    }
  | {
      kind: "session_request";
      request: SignClientTypes.EventArguments["session_request"];
    }
  | { kind: "session_delete"; topic: string }
  | { kind: "session_expire"; topic: string };

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

/**
 * Returns true iff a project id is configured. The QR/deep-link parser
 * still recognises `wc:` URIs without one, but pairing throws — the UI
 * uses this to render a "WalletConnect not configured" diagnostic instead
 * of an opaque relay error.
 */
export function isConfigured(): boolean {
  return PROJECT_ID.length > 0;
}

/**
 * Lazy boot. Multiple callers race-safe — the second call awaits the first.
 */
export async function init(): Promise<InstanceType<typeof SignClient>> {
  if (client) return client;
  if (bootPromise) return bootPromise;
  if (!isConfigured()) {
    throw new Error(
      "WalletConnect not configured — set VITE_WC_PROJECT_ID at build time",
    );
  }
  bootPromise = (async () => {
    const c = await SignClient.init({
      projectId: PROJECT_ID,
      relayUrl: RELAY_URL,
      metadata: APP_METADATA,
    });
    wireClientEvents(c);
    client = c;
    return c;
  })();
  return bootPromise;
}

function wireClientEvents(c: InstanceType<typeof SignClient>) {
  c.on("session_proposal", (proposal) => {
    fanout({ kind: "session_proposal", proposal });
  });
  c.on("session_request", (request) => {
    fanout({ kind: "session_request", request });
  });
  c.on("session_delete", (e) => {
    fanout({ kind: "session_delete", topic: e.topic });
  });
  c.on("session_expire", (e) => {
    fanout({ kind: "session_expire", topic: e.topic });
  });
}

function fanout(e: WcEvent) {
  for (const s of subscribers) {
    try {
      s(e);
    } catch (err) {
      // Subscriber threw — log and continue; one bad listener can't kill the
      // whole event stream.
      console.error("wc subscriber threw", err);
    }
  }
}

export function subscribe(cb: Sub): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// -----------------------------------------------------------------------------
// Pair / Approve / Reject
// -----------------------------------------------------------------------------

/**
 * Pair from a raw `wc:<topic>@2?...` URI. Resolves once the relay has the
 * pair handshake; the matching `session_proposal` arrives via the event
 * stream a moment later.
 */
export async function pair(uri: string): Promise<void> {
  const c = await init();
  await c.core.pairing.pair({ uri });
}

/**
 * Approve a pending session proposal. The caller decides which accounts to
 * advertise — Stage 4 ships an empty `accounts: []` placeholder until
 * Stage 5 lands real keys, so the JSON-RPC request handlers can still pop
 * the approval sheet but `eth_sendTransaction` has nothing to sign with.
 */
export async function approveSession(
  proposal: SignClientTypes.EventArguments["session_proposal"],
  accounts: string[],
  chainEip155Id: number = DEFAULT_CHAIN_EIP155_ID,
): Promise<SessionTypes.Struct> {
  const c = await init();
  const ns = `eip155:${chainEip155Id}`;
  const accountIds = accounts.map((a) => `${ns}:${a}`);
  const { acknowledged } = await c.approve({
    id: proposal.id,
    namespaces: {
      eip155: {
        chains: [ns],
        accounts: accountIds,
        methods: SUPPORTED_METHODS,
        events: SUPPORTED_EVENTS,
      },
    },
  });
  return acknowledged();
}

export async function rejectSession(
  proposal: SignClientTypes.EventArguments["session_proposal"],
  reason: "user-rejected" | "unsupported-chains" = "user-rejected",
): Promise<void> {
  const c = await init();
  await c.reject({
    id: proposal.id,
    reason: getSdkError(
      reason === "unsupported-chains" ? "UNSUPPORTED_CHAINS" : "USER_REJECTED",
    ),
  });
}

// -----------------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------------

export interface WcSessionView {
  topic: string;
  expiry: number;
  peerName: string;
  peerUrl: string;
  peerIcon?: string;
  accounts: string[];
  chains: string[];
}

export async function getSessions(): Promise<WcSessionView[]> {
  if (!client) {
    // Don't boot here — callers can render an empty list before the WC
    // client has been touched. `init()` is on first pair / first request.
    return [];
  }
  return client.session.getAll().map(viewSession);
}

function viewSession(s: SessionTypes.Struct): WcSessionView {
  const ns = s.namespaces["eip155"];
  return {
    topic: s.topic,
    expiry: s.expiry,
    peerName: s.peer.metadata.name,
    peerUrl: s.peer.metadata.url,
    peerIcon: s.peer.metadata.icons?.[0],
    accounts: ns?.accounts ?? [],
    chains: ns?.chains ?? [],
  };
}

export async function disconnect(topic: string): Promise<void> {
  const c = await init();
  await c.disconnect({
    topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
}

// -----------------------------------------------------------------------------
// JSON-RPC responses
// -----------------------------------------------------------------------------

/**
 * Reply to a `session_request` with a successful result.
 */
export async function respondRequest(
  topic: string,
  id: number,
  result: unknown,
): Promise<void> {
  const c = await init();
  await c.respond({
    topic,
    response: {
      id,
      jsonrpc: "2.0",
      result,
    },
  });
}

/**
 * Reply to a `session_request` with a JSON-RPC error.
 */
export async function rejectRequest(
  topic: string,
  id: number,
  reason: "user-rejected" | "unsupported-method" = "user-rejected",
): Promise<void> {
  const c = await init();
  const err = getSdkError(
    reason === "unsupported-method" ? "WC_METHOD_UNSUPPORTED" : "USER_REJECTED",
  );
  await c.respond({
    topic,
    response: {
      id,
      jsonrpc: "2.0",
      error: {
        code: err.code,
        message: err.message,
      },
    },
  });
}
