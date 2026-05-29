# Contributing to Monolythium Mobile Wallet

Thanks for considering a contribution. This is a **preview** Tauri 2 mobile wallet (iOS + Android) that holds Monolythium keys behind platform-native biometric authentication. The threat model is meaningful — please respect the boundaries below.

## Before opening a pull request

Run the gates locally — there is no public CI workflow that exercises them today:

```bash
pnpm install
pnpm typecheck                                    # tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml  # Rust side
pnpm test                                         # vitest run
```

Keep all four green before opening the PR.

## What we're looking for

- **Bug fixes** in `src/` or `src-tauri/src/` — welcome any time.
- **Doc fixes** in `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/` — welcome any time.
- **Test coverage improvements** for the encrypted-vault path, the biometric auth flow, and the deep-link pairing router.
- **iOS / Android polish** as the native targets get initialized (`src-tauri/gen/apple/`, `src-tauri/gen/android/`).
- **New SDK hook wrappers** in `src/` as additional `@monolythium/core-sdk` methods become useful for mobile flows.

## What we'll push back on

- **Adding a Tier-3 shared-store reader** that reaches into desktop file-system paths from the mobile sandbox. See [`docs/wallet-tier-integration.md`](./docs/wallet-tier-integration.md) — mobile is intentionally sandboxed at Tier 2 (platform keychain only). Cross-device sharing happens via explicit QR import or encrypted cloud backup, not implicit file access.
- **Bypassing the Operations drawer / biometric prompt for destructive actions.** Every send / sign / approval routes through the platform's biometric auth + the Operations drawer's preview/confirm step. Don't add a "silent sign" path.
- **Replacing the KDF-derived KEK / encrypted vault with plaintext password storage.** Keys must stay sealed behind the password-derived KEK + AES vault — never store a password or seed in plaintext.
- **Hardcoding production operator RPC IPs** anywhere in source. Default RPC discovery goes through the SDK chain-registry; placeholder addresses (when needed for tests) use the IETF-reserved `192.0.2.0/24` block.
- **Commits without an honest author.** Sign each commit with your own identity.

## Commit + PR conventions

- Plain English in the imperative ("Add foo", "Fix bar") — no emoji, no `:phase:` or colon-prefixes.
- One logical change per commit when practical. Squash before merge if a PR grew several commits during review.
- For changes touching the keystore, the biometric flow, the deep-link pairing router, or the Operations drawer, link the matching test file in the PR description.

## Security

If you've found a vulnerability, please **do not open a public issue**. Email `security@monolythium.com` — see [`SECURITY.md`](./SECURITY.md) for the full policy.

## Code of conduct

Be respectful. Disagree on technical merit. Don't be a jerk.
