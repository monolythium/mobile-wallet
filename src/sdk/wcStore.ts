// Stage 4 — WalletConnect v2 session metadata persistence.
//
// `tauri-plugin-store` is a key-value JSON file the plugin keeps next to
// the vault on every target. We use it for **non-sensitive** WC v2 session
// state — the SignClient itself already persists its key material in
// IndexedDB inside the webview, but having a Rust-side file gives us:
//
//   1. A "Forget all WC sessions" affordance that survives clearing the
//      webview cache.
//   2. A list view that doesn't need to boot the WC SignClient just to
//      render "you have 3 active dapps connected" on app start.
//
// Schema (file `wc-sessions.v1.json`):
//
//   {
//     "version": 1,
//     "sessions": {
//       "<topic>": {
//         "topic":    string,
//         "expiry":   number,
//         "peerName": string,
//         "peerUrl":  string,
//         "peerIcon": string | undefined,
//         "accounts": string[],
//         "chains":   string[]
//       },
//       ...
//     }
//   }
//
// Sensitive material (symKeys, JWTs) lives only in the SignClient's own
// IndexedDB store; we don't mirror it here.

import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "wc-sessions.v1.json";
const SESSIONS_KEY = "sessions";

export interface PersistedWcSession {
  topic: string;
  expiry: number;
  peerName: string;
  peerUrl: string;
  peerIcon?: string;
  accounts: string[];
  chains: string[];
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    // `Store.load()` opens-or-creates and returns a handle. The plugin
    // serialises writes; safe to call from multiple components.
    storePromise = Store.load(STORE_FILE);
  }
  return storePromise;
}

async function readMap(): Promise<Record<string, PersistedWcSession>> {
  const store = await getStore();
  const v = await store.get<Record<string, PersistedWcSession>>(SESSIONS_KEY);
  return v ?? {};
}

async function writeMap(map: Record<string, PersistedWcSession>): Promise<void> {
  const store = await getStore();
  await store.set(SESSIONS_KEY, map);
  await store.save();
}

export async function listSessions(): Promise<PersistedWcSession[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => b.expiry - a.expiry);
}

export async function upsertSession(s: PersistedWcSession): Promise<void> {
  const map = await readMap();
  map[s.topic] = s;
  await writeMap(map);
}

export async function removeSession(topic: string): Promise<void> {
  const map = await readMap();
  if (topic in map) {
    delete map[topic];
    await writeMap(map);
  }
}

export async function clearAllSessions(): Promise<void> {
  await writeMap({});
}
