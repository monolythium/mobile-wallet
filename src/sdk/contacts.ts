// Contacts — address book persisted to a local Tauri plugin-store file.
//
// Schema (file `contacts.v1.json`):
//
//   {
//     "version": 1,
//     "contacts": {
//       "<lower-hex-address>": {
//         "address":   string,   // canonical lower-hex (storage key)
//         "bech32m":   string,   // mono1… cached for render paths
//         "name":      string,   // 1-64 chars, trimmed
//         "addedAt":   number,   // ms epoch
//         "lastUsedAt": number?, // ms epoch, bumped on send
//         "notes":     string?   // 0-256 chars
//       },
//       ...
//     }
//   }
//
// Contacts are NOT secret. The plugin-store file is plaintext JSON on
// disk; it's app-private (sandboxed by iOS/Android) but not encrypted.
// A "Reset wallet" wipes both the vault and contacts so a device
// hand-off leaves a clean slate.

import { Store } from "@tauri-apps/plugin-store";
import {
  addressToTypedBech32,
  typedBech32ToAddress,
} from "@monolythium/core-sdk";

const STORE_FILE = "contacts.v1.json";
const CONTACTS_KEY = "contacts";

export const MAX_NAME_LEN = 64;
export const MAX_NOTE_LEN = 256;

export interface ContactRecord {
  /** Canonical lower-hex address (40 chars). Storage key form. */
  address: string;
  /** Cached `mono1…` bech32m string. */
  bech32m: string;
  /** User-provided name, 1-64 chars, trimmed. */
  name: string;
  addedAt: number;
  lastUsedAt?: number;
  notes?: string;
}

export type ContactsMap = Record<string, ContactRecord>;

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_FILE);
  }
  return storePromise;
}

async function readMap(): Promise<ContactsMap> {
  const store = await getStore();
  const raw = await store.get<unknown>(CONTACTS_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: ContactsMap = {};
  for (const [key, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (
      rec &&
      typeof rec === "object" &&
      typeof (rec as ContactRecord).address === "string" &&
      typeof (rec as ContactRecord).bech32m === "string" &&
      typeof (rec as ContactRecord).name === "string" &&
      typeof (rec as ContactRecord).addedAt === "number"
    ) {
      out[key] = rec as ContactRecord;
    }
  }
  return out;
}

async function writeMap(map: ContactsMap): Promise<void> {
  const store = await getStore();
  await store.set(CONTACTS_KEY, map);
  await store.save();
}

export async function listContacts(): Promise<ContactRecord[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => {
    // MRU first: lastUsedAt desc, fallback addedAt desc.
    const aT = a.lastUsedAt ?? a.addedAt;
    const bT = b.lastUsedAt ?? b.addedAt;
    return bT - aT;
  });
}

export interface AddContactInput {
  /** Typed `mono1…` bech32m or lower-hex address. */
  address: string;
  name: string;
  notes?: string;
}

export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactValidationError";
  }
}

function normalizeAddress(addr: string): { hex: string; bech32m: string } {
  const t = addr.trim();
  if (t.startsWith("mono1") || t.startsWith("MONO1")) {
    const parsed = typedBech32ToAddress(t.toLowerCase(), "user");
    return {
      hex: parsed.hex.toLowerCase(),
      bech32m: addressToTypedBech32("user", parsed.hex),
    };
  }
  if (t.startsWith("0x") || t.startsWith("0X")) {
    throw new ContactValidationError(
      "Raw 0x addresses are not supported. Use a typed mono1… address.",
    );
  }
  throw new ContactValidationError(
    "Address must be a typed mono1… bech32m address.",
  );
}

export async function addContact(input: AddContactInput): Promise<ContactRecord> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ContactValidationError("Name is required.");
  }
  if (name.length > MAX_NAME_LEN) {
    throw new ContactValidationError(
      `Name must be ${MAX_NAME_LEN} characters or fewer.`,
    );
  }
  const notes = input.notes?.trim() ?? "";
  if (notes.length > MAX_NOTE_LEN) {
    throw new ContactValidationError(
      `Note must be ${MAX_NOTE_LEN} characters or fewer.`,
    );
  }
  const { hex, bech32m } = normalizeAddress(input.address);
  const map = await readMap();
  const record: ContactRecord = {
    address: hex,
    bech32m,
    name,
    addedAt: Date.now(),
    ...(notes ? { notes } : {}),
  };
  map[hex] = record;
  await writeMap(map);
  return record;
}

export async function removeContact(hexAddress: string): Promise<void> {
  const key = hexAddress.toLowerCase();
  const map = await readMap();
  if (!(key in map)) return;
  delete map[key];
  await writeMap(map);
}

export async function renameContact(
  hexAddress: string,
  newName: string,
): Promise<void> {
  const key = hexAddress.toLowerCase();
  const trimmed = newName.trim();
  if (trimmed.length === 0) {
    throw new ContactValidationError("Name is required.");
  }
  if (trimmed.length > MAX_NAME_LEN) {
    throw new ContactValidationError(
      `Name must be ${MAX_NAME_LEN} characters or fewer.`,
    );
  }
  const map = await readMap();
  const existing = map[key];
  if (!existing) return;
  existing.name = trimmed;
  await writeMap(map);
}

export async function isContactKnown(hexOrBech32m: string): Promise<boolean> {
  let hex: string;
  try {
    hex = normalizeAddress(hexOrBech32m).hex;
  } catch {
    return false;
  }
  const map = await readMap();
  return Object.prototype.hasOwnProperty.call(map, hex);
}

export async function bumpContactLastUsed(
  hexOrBech32m: string,
): Promise<void> {
  let hex: string;
  try {
    hex = normalizeAddress(hexOrBech32m).hex;
  } catch {
    return;
  }
  const map = await readMap();
  const existing = map[hex];
  if (!existing) return;
  existing.lastUsedAt = Date.now();
  await writeMap(map);
}

export async function clearAllContacts(): Promise<void> {
  await writeMap({});
}
