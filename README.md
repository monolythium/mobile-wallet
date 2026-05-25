# mobile-wallet

> Monolythium Mobile Wallet — iOS + Android via Tauri 2. Holds Monolythium keys behind platform-native biometric authentication.

**License:** Apache-2.0 · **Status:** preview (testnet only) · **Stack:** Tauri 2 mobile · React 19 · TypeScript · Vite

---

## Status: preview

Functional cross-platform shell with real Rust crypto, biometric integration, and WalletConnect v2 pairing — but not yet production-grade. Set expectations before adopting:

- **Chain target is testnet.** Monolythium mainnet has not launched. Anything you connect to here runs against the public testnet today; mainnet activation is gated on separate protocol milestones.
- **Native iOS / Android projects under `src-tauri/gen/` are not committed.** `pnpm tauri ios init` and `pnpm tauri android init` are one-time host-side bootstrap steps that produce regenerable per-host paths and raw Xcode / Gradle artifacts (intentionally gitignored). You initialize them locally on your build host.
- **No TestFlight or Play Store internal-testing build is published.** Until a signed release ships, the only install path is "clone, init the native projects, run a debug build to your device/simulator."
- **External builds need a sibling SDK checkout for now.** `package.json` consumes `@monolythium/core-sdk` from `file:../mono-core-sdk/packages/ts`. The SDK is public ([`monolythium/mono-core-sdk`](https://github.com/monolythium/mono-core-sdk), `@monolythium/core-sdk@0.1.0` on npm) — but master here uses SDK exports ahead of the published `0.1.0`. Until the next SDK release, `pnpm install` requires cloning `monolythium/mono-core-sdk` as a sibling directory.
- **WalletConnect v2 pairing is scaffolded; signing surfaces still iterating.** The pairing surface and the deep-link router are live; per-method approval UX is converging.

Watch this repo for the first non-preview tag before treating any build as production-grade.

---

## What this is

A native mobile wallet for Monolythium, built on Tauri 2's mobile targets with a Rust backend and a React 19 frontend. It is designed to share core code with the desktop wallet and lean on each platform's secure storage (iOS Keychain Services, Android Keystore) plus biometric prompts.

The wallet:

- Holds Monolythium keys in a **password-derived KEK + AES-encrypted vault**, with the vault entry sealed in the **platform keychain** (iOS Keychain Services / Android Keystore).
- Gates every signing operation behind a **biometric prompt** (Face ID / Touch ID / Android BiometricPrompt).
- Routes every destructive action through an **Operations drawer** with a preview / confirm step (no silent signing).
- Supports **WalletConnect v2** for dapp pairing.
- Supports **deep links** (`monolythium://...` / Universal Links / Android App Links) for incoming send / stake / pairing flows from a paired desktop or browser.
- Reads chain state through `@monolythium/core-sdk` against the SDK chain-registry endpoints.

## Who this is for

End users and mobile-first traders who want to hold and move MNLX from their phone, with biometric-gated signing and an Operations drawer that previews every destructive action before it leaves the device.

## Prerequisites

To inspect, audit, or develop the cross-platform layer:

- **Node** 22+
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10 --activate`)
- **Rust** 1.77+

To complete `pnpm install` you currently also need:

- A sibling **[`mono-core-sdk`](https://github.com/monolythium/mono-core-sdk) checkout** at `../mono-core-sdk`. The SDK is public — `@monolythium/core-sdk@0.1.0` is on npm — but master here uses exports ahead of the published `0.1.0`. Until the next SDK release, the `file:` path in `package.json` requires the sibling. Clone with:

  ```bash
  git clone https://github.com/monolythium/mono-core-sdk.git ../mono-core-sdk
  ```

To build for a device or simulator:

- **iOS:** macOS host, Xcode 16+, an Apple developer account for signing.
- **Android:** Android Studio, Android SDK, Android NDK, JDK 17+. Set `ANDROID_HOME` and `NDK_HOME` env vars.
- Platform-specific Tauri prerequisites — see <https://v2.tauri.app/start/prerequisites/> and <https://v2.tauri.app/start/prerequisites/#mobile-targets>.

## Quick start

For external readers — the most useful actions today are auditing the source and reading the security model:

```bash
git clone https://github.com/monolythium/mobile-wallet.git
cd mobile-wallet

# Read the wallet-tier integration doc (where the wallet sits relative
# to desktop wallets' shared store — mobile is intentionally sandboxed)
less docs/wallet-tier-integration.md

# Read the encrypted-vault path
less src/    # navigate to the keystore + KDF + AES vault files

# Read the Operations drawer's preview/confirm contract
less src/    # navigate to the operations module

# Read the WalletConnect v2 pairing surface
less src/    # navigate to the walletconnect module
```

With the sibling `mono-core-sdk` checkout in place:

```bash
pnpm install
pnpm typecheck                                    # tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml  # Rust side
pnpm test                                         # vitest run
```

To bring up the native targets (one-time per host):

```bash
pnpm tauri ios init        # requires Xcode 16+ and an Apple developer setup
pnpm tauri android init    # requires Android Studio + NDK + ANDROID_HOME / NDK_HOME
```

Then run a debug build:

```bash
pnpm tauri ios dev         # boots on the configured iOS simulator
pnpm tauri android dev     # boots on the configured Android emulator
```

## Repo layout

```
mobile-wallet/
├── manifest / Tauri config (src-tauri/tauri.conf.json
│                            — bundle id com.monolythium.wallet)
├── src/                          # React 19 + TypeScript frontend
│   ├── App.tsx, main.tsx
│   ├── views / pages / components / etc.
│   └── (keystore, KDF, AES vault, biometric auth bridge,
│        Operations drawer, WalletConnect v2 pairing surface,
│        deep-link router, SDK consumption)
├── src-tauri/                    # Tauri 2 Rust backend
│   ├── tauri.conf.json
│   ├── src/main.rs, src/lib.rs
│   └── (gen/apple/ + gen/android/ created on `tauri ios|android init`,
│        intentionally gitignored)
└── docs/
    └── wallet-tier-integration.md  # How mobile sits relative to the
                                    # desktop apps' shared wallet store
```

## Wallet-tier integration

Mobile stores wallet keys in the platform-native keychain **per app**. It does **not** read or write the `~/.lyth_mcp/wallets.json` file that desktop wallets share — that path doesn't exist on iOS / Android, and cross-app access would require explicit OS-mediated dialogs anyway.

Cross-device sharing happens via:

- **QR import** from a paired desktop wallet (the desktop side renders an encrypted blob + one-time passphrase as a QR; mobile camera reads it, re-encrypts into the platform keychain).
- **Encrypted cloud backup** (planned — iCloud / Google Drive / S3 with E2E encryption keyed off the user's master passphrase).

See [`docs/wallet-tier-integration.md`](./docs/wallet-tier-integration.md) for the full architecture, threat model cross-references, and rationale.

## Crypto stack

- **`@noble/hashes`** for the KDF + AES-GCM vault encryption (sibling of the desktop wallet's crypto module).
- **Platform keychain** for vault storage (iOS Keychain Services with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; Android Keystore with hardware-backed strongbox when available).
- **`@walletconnect/sign-client`** + **`@walletconnect/utils`** for dapp pairing (WalletConnect v2).
- **`@zxing/browser`** for QR scanning (deep-link recipient capture, WC pairing URIs, wallet import).
- **`@tauri-apps/plugin-deep-link`** for the OS-native deep-link surfaces.
- **`@tauri-apps/plugin-store`** for non-secret app preferences.

No custom crypto. All sensitive operations go through the noble stack — audited, well-known, RustCrypto-aligned.

## Related projects

- [**monolythium.com**](https://monolythium.com) — protocol home, whitepaper, ecosystem links.
- [**`monolythium/mono-core-sdk`**](https://github.com/monolythium/mono-core-sdk) — public TypeScript + Rust SDK consumed here as `@monolythium/core-sdk`.
- [**`monolythium/browser-wallet`**](https://github.com/monolythium/browser-wallet) — sibling consumer wallet for desktop browsers (Manifest V3 extension).
- [**`monolythium/monoscan`**](https://github.com/monolythium/monoscan) — public block explorer the wallet links out to for tx receipts.
- [**`monolythium/mono-studio`**](https://github.com/monolythium/mono-studio) — public developer toolchain for MRV contracts and MRC assets.
- [**`monolythium/protocore`**](https://github.com/monolythium/protocore) — public binary releases for the `protocore` node binary.
- [**`monolythium/monarch-desktop`**](https://github.com/monolythium/monarch-desktop) — operator console (distinct app — for running nodes, not for end users).
- [**`monolythium/monarch-mobile`**](https://github.com/monolythium/monarch-mobile) — operator-side phone companion (also a distinct app).
- **`monolythium/mono-core`** *(private; source flips to BSL-1.1 at mainnet)* — the chain itself.
- **`monolythium/desktop-wallet`** *(private)* — sibling consumer desktop wallet (Tauri-based native desktop app).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Short version: run the four gates (`pnpm typecheck`, `cargo check`, `pnpm test`, `pnpm install`) locally before opening a PR. Do not bypass the biometric / Operations drawer flow; do not reach into desktop-wallet file paths from the mobile sandbox; do not hardcode production RPC IPs.

## Security

See [`SECURITY.md`](./SECURITY.md). Short version: vulnerability reports to `security@monolythium.com`, **not** the public issue tracker. The in-scope categories cover vault exfiltration, biometric bypass, Operations drawer bypass, WalletConnect request forgery, deep-link abuse, connected-site promotion, platform sandbox escape, chain-config corruption, and biometric-usage-event leaks.

## License

Released under the Apache License, Version 2.0. See [`LICENSE`](./LICENSE) for the full text.
