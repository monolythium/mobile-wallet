// Agent sub-account store — local registry of the sub-accounts a principal
// controls (WP §18.8 spending-policy delegation).
//
// A sub-account is just a fresh ML-DSA-65 keypair (see
// `spending-policy.ts:generateAgentSubAccount`). Its SECRET is the 24-word
// mnemonic — the same shape as the wallet's own vault payload. The split:
//
//   - the SECRET mnemonic lives in the OS keychain (biometric-gated, like the
//     wallet's `wallet.unlock` device-key), keyed per sub-account address:
//     keychain slot `agent.<lower-hex>`. We never write a sub-account
//     mnemonic to plaintext disk.
//
//   - the PUBLIC index (address, cached bech32m, user label, createdAt) lives
//     in a Tauri plugin-store file (`agents.v1.json`) — the same plaintext,
//     app-private store contacts uses. No secret material here.
//
// "Reset wallet" wipes the agents index + every agent keychain slot alongside
// the vault + contacts so a device hand-off leaves a clean slate.

import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import {
  addressToTypedBech32,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";

const STORE_FILE = "agents.v1.json";
const AGENTS_KEY = "agents";
const KEYCHAIN_PREFIX = "agent.";

export const MAX_LABEL_LEN = 64;

/** Public, non-secret record for one controlled sub-account. */
export interface AgentRecord {
  /** Canonical lower-hex address (40 chars). Storage key + keychain suffix. */
  addressHex: string;
  /** Cached `mono1…` bech32m string. */
  bech32m: string;
  /** User-provided label, 1-64 chars, trimmed. */
  label: string;
  createdAt: number;
}

export type AgentsMap = Record<string, AgentRecord>;

export class AgentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoreError";
  }
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_FILE);
  }
  return storePromise;
}

async function readMap(): Promise<AgentsMap> {
  const store = await getStore();
  const raw = await store.get<unknown>(AGENTS_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: AgentsMap = {};
  for (const [key, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (
      rec &&
      typeof rec === "object" &&
      typeof (rec as AgentRecord).addressHex === "string" &&
      typeof (rec as AgentRecord).bech32m === "string" &&
      typeof (rec as AgentRecord).label === "string" &&
      typeof (rec as AgentRecord).createdAt === "number"
    ) {
      out[key] = rec as AgentRecord;
    }
  }
  return out;
}

async function writeMap(map: AgentsMap): Promise<void> {
  const store = await getStore();
  await store.set(AGENTS_KEY, map);
  await store.save();
}

function keychainSlot(addressHex: string): string {
  return `${KEYCHAIN_PREFIX}${addressHex.toLowerCase()}`;
}

/** MRU-ish list (newest first) of controlled sub-accounts. */
export async function listAgents(): Promise<AgentRecord[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => b.createdAt - a.createdAt);
}

export interface AddAgentInput {
  /** 24-word recovery phrase (the secret) from generateAgentSubAccount. */
  mnemonic: string;
  /** Internal lower-hex address derived from the mnemonic. */
  addressHex: string;
  /** Cached typed bech32m address. */
  bech32m: string;
  /** User-facing label. */
  label: string;
}

/**
 * Register a freshly-minted sub-account: seal its mnemonic into the OS
 * keychain (slot `agent.<hex>`) and add the public record to the index.
 * Throws `AgentStoreError` if the keychain write fails (desktop dev hosts
 * without a keystore surface this) so the UI never records an agent it can't
 * later sign for.
 */
export async function addAgent(input: AddAgentInput): Promise<AgentRecord> {
  const label = input.label.trim();
  if (label.length === 0) {
    throw new AgentStoreError("Label is required.");
  }
  if (label.length > MAX_LABEL_LEN) {
    throw new AgentStoreError(
      `Label must be ${MAX_LABEL_LEN} characters or fewer.`,
    );
  }
  const hex = input.addressHex.toLowerCase();

  // Seal the secret FIRST — if the keychain rejects, we never write a public
  // record for a sub-account we can't sign for.
  try {
    await invoke("keychain_set", {
      key: keychainSlot(hex),
      value: input.mnemonic,
    });
  } catch (cause) {
    throw new AgentStoreError(
      `Could not seal sub-account key to the keychain: ${(cause as Error)?.message ?? String(cause)}`,
    );
  }

  const map = await readMap();
  const record: AgentRecord = {
    addressHex: hex,
    bech32m: input.bech32m,
    label,
    createdAt: Date.now(),
  };
  map[hex] = record;
  await writeMap(map);
  return record;
}

/**
 * Unlock a controlled sub-account's recovery phrase from the keychain. Used to
 * produce the sub-account's claim-bound signature in the §18.8 fresh-claim
 * dance. Throws `AgentStoreError` if the slot is missing (the agent was
 * created on another device, or the keychain was wiped).
 */
export async function getAgentMnemonic(addressHex: string): Promise<string> {
  let value: string | null;
  try {
    value = await invoke<string | null>("keychain_get", {
      key: keychainSlot(addressHex),
    });
  } catch (cause) {
    throw new AgentStoreError(
      `Could not read sub-account key from the keychain: ${(cause as Error)?.message ?? String(cause)}`,
    );
  }
  if (!value) {
    throw new AgentStoreError(
      "Sub-account key not found on this device — re-create or import the agent.",
    );
  }
  return value;
}

/** Remove a sub-account: delete its keychain slot + public index entry. */
export async function removeAgent(addressHex: string): Promise<void> {
  const hex = addressHex.toLowerCase();
  try {
    await invoke("keychain_delete", { key: keychainSlot(hex) });
  } catch {
    // Best-effort: still drop the public record below.
  }
  const map = await readMap();
  if (hex in map) {
    delete map[hex];
    await writeMap(map);
  }
}

/** Wipe every controlled sub-account (keychain slots + index). */
export async function clearAllAgents(): Promise<void> {
  const map = await readMap();
  for (const hex of Object.keys(map)) {
    try {
      await invoke("keychain_delete", { key: keychainSlot(hex) });
    } catch {
      // Best-effort per slot.
    }
  }
  await writeMap({});
}

/** Normalize a typed `mono1…` address to its lower-hex + bech32m forms. */
export function normalizeAgentAddress(bech32m: string): {
  hex: string;
  bech32m: string;
} {
  const parsed = typedBech32ToAddress(bech32m.trim().toLowerCase(), "user");
  return {
    hex: parsed.hex.toLowerCase(),
    bech32m: addressToTypedBech32("user", parsed.hex),
  };
}
