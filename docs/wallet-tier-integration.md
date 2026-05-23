# Wallet Tier Integration — Mobile

> How `mobile-wallet` participates (and deliberately does not participate)
> in the cross-app shared wallet store. Cross-reference:
> `mono-labs-archive/stele-desktop/docs/wallet-architecture.md` (tier
> model) and `mono-labs-archive/stele-desktop/docs/security-cross-app-wallet-visibility.md`
> (threat model).

## Where wallets live on mobile

Mobile-wallet stores keys in the OS-native secure store **per app**:

- **iOS:** Keychain Services with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
- **Android:** Android Keystore with hardware-backed strongbox when available

This is Tier 2 in the cross-app tier model. It is **not** shared with
other apps on the device — that's enforced by the OS sandbox.

## Why mobile does not read `~/.lyth_mcp/wallets.json`

The shared file the desktop apps use lives at `$HOME/.lyth_mcp/wallets.json`.
That path:

1. **Does not exist on iOS / Android.** Mobile filesystems are sandboxed
   per-app; there is no `$HOME` reachable from a Tauri-mobile app.
2. **Cannot be read across apps** even if it did exist — iOS App Groups
   and Android Storage Access Framework both require deliberate opt-in
   from the user with platform-mediated dialogs.
3. **Should not be the only mechanism.** Even on jailbroken / rooted
   devices where it might be reachable, the right architecture is OS-
   keychain primary + explicit import flows, not implicit file access.

## How wallets get onto mobile — the two supported paths

### Path A — QR import from a desktop app (v1)

The user has a wallet in `~/.lyth_mcp/wallets.json` on their laptop. They
open the desktop wallet (Stele or desktop-wallet) → pick the wallet →
**Export to mobile** → app displays a QR code encoding the
already-encrypted blob + a one-time passphrase.

Mobile-wallet → **Import from QR** → camera scans → re-encrypts the
mnemonic under the platform keystore. Wallet is now in mobile's Tier 2.

**Security properties:**
- QR carries the ciphertext, not the plaintext mnemonic.
- The one-time passphrase is needed to decrypt; the user types it on
  mobile separately, or it's encoded into a second QR shown only briefly.
- No network involved. Air-gapped, leaves no trace beyond what the user
  can see.

**Status:** designed, not built. Tracked as v1 mobile feature.

### Path B — Encrypted cloud backup (deferred)

User opts to back the wallet up to iCloud / Google Drive / S3. Mobile
fetches the encrypted blob on first install, decrypts with the user's
master passphrase.

**Security properties:**
- Cloud provider sees only ciphertext.
- Master passphrase derives the unwrap key client-side via the same scrypt
  parameters lyth_mcp uses, so a single passphrase decrypts on any device.
- Cloud-account compromise (without the passphrase) cannot drain the wallet,
  but raises the brute-force surface — the attacker has the ciphertext to
  attack offline.

**Status:** Has its own threat model that has not been completed. Not in
scope for v1 mobile.

## What mobile-wallet does *not* do

- Open `~/.lyth_mcp/wallets.json` directly (not possible on mobile).
- Run lyth_mcp as a sidecar (Node runtime cost too high on mobile; chain
  reads should go via the SDK + an HTTPS RPC endpoint).
- Maintain a shared wallet list with desktop apps in real time. The user
  brings wallets across via QR / cloud explicitly.

## Trust boundaries

| Boundary | Enforced by | Notes |
|---|---|---|
| One app cannot read another's keychain | OS sandbox (iOS Keychain ACL, Android Keystore alias) | Same property as on desktop OS keychains |
| QR import requires both desktop unlock + mobile unlock | Two-factor (device-bound) | User must hold both devices to complete |
| Cloud backup (when wired) requires master passphrase | scrypt + AES-GCM, key never leaves device | Cloud account compromise alone is not sufficient |

## Pointer

The full tier model and per-app decision matrix lives at:
`mono-labs-archive/stele-desktop/docs/wallet-architecture.md` and
`mono-labs-archive/stele-desktop/docs/security-cross-app-wallet-visibility.md`.
