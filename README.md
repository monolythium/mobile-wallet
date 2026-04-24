# mobile-wallet

Monolythium mobile wallet (iOS and Android via Tauri 2)

> Part of the [Monolythium](https://monolythium.com) ecosystem — a sovereign Layer-1 for finality-first apps.

---

## What this is

A native mobile wallet for Monolythium, built on Tauri 2's mobile targets with a Rust backend and a React 19 frontend. It is designed to share its core code with the desktop wallet and lean on each platform's secure storage (iOS Keychain Services, Android Keystore) and biometric prompts. Stage 0 ships only the cross-platform scaffold — the iOS and Android native projects are not yet initialized, and the full feature set lands incrementally.

## Who this is for

End users and mobile-first traders who want to hold and move MNLX from their phone, with biometric-gated signing and an Operations drawer that previews every destructive action before it leaves the device.

## Install

TestFlight (iOS) and Play Store internal-testing track (Android) — coming soon.

Until the first signed release ships, run from source (see "Building from source" below).

## Getting started

The wallet currently boots a placeholder screen. Once a release lands, install it, open it, and follow the in-app onboarding to create or import a wallet.

## Documentation

- [monolythium.com](https://monolythium.com) — project home
- Public user docs and release notes will be linked here once published

## Building from source

This repo currently ships only the cross-platform scaffold. The iOS and Android native projects (`src-tauri/gen/apple/` and `src-tauri/gen/android/`) are **not yet initialized** — they require Xcode (iOS) and Android Studio + the Android NDK (Android) on the build host, and will be added in a follow-up.

```bash
pnpm install
pnpm typecheck            # TypeScript-only check
pnpm tauri ios init       # one-time, requires Xcode 16+ and an Apple developer setup
pnpm tauri android init   # one-time, requires Android Studio + NDK + the ANDROID_HOME / NDK_HOME env vars
pnpm tauri ios dev        # run on iOS simulator
pnpm tauri android dev    # run on Android emulator
```

Requirements:

- Rust 1.77+
- Node 22+
- pnpm 10+
- For iOS: macOS host, Xcode 16+, an Apple developer account for signing
- For Android: Android Studio, Android SDK, Android NDK, JDK 17+
- Platform-specific Tauri prerequisites — see https://v2.tauri.app/start/prerequisites/ and https://v2.tauri.app/start/prerequisites/#mobile-targets

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the guidelines.

## Security

Found a vulnerability? Please **do not open a public issue**. Email security@monolythium.com instead. See [SECURITY.md](./SECURITY.md) for the full disclosure policy.

## License

MIT
