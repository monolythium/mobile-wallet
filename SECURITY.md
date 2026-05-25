# Security Policy

## Supported versions

Monolythium Mobile Wallet is currently in **preview** (`v0.x.y`). The first non-preview tag will define the supported-versions window. Until then, only the latest commit on `master` is considered current.

## Reporting a vulnerability

If you believe you've found a vulnerability in the mobile wallet — particularly anything that could:

- exfiltrate the encrypted vault, the password-derived KEK, the in-memory unlocked seed, the platform-keychain-stored credentials, or a recovery phrase outside the explicit reveal flow,
- bypass the biometric authentication prompt before signing a destructive action,
- bypass the Operations drawer's preview / approval step for any send / stake / dapp-signing flow,
- forge or replay a WalletConnect v2 request so that a method appears approved without the user's explicit per-request consent,
- cause a deep link (`monolythium://...` / Universal Link / Android App Link) to trigger a privileged action without confirmation,
- promote a malicious dapp origin to the connected-sites list without explicit user approval in the popup,
- escape the platform sandbox (read another app's files, write to system storage, read the desktop-app `~/.lyth_mcp/wallets.json` file),
- forge a chain config (silently swap an operator RPC) so the wallet reads or signs against the wrong chain,
- leak a passkey / biometric usage event into a log accessible to a co-resident app or to a passively observing network party,

please **do not open a public issue or PR**.

Email `security@monolythium.com` with:

1. A clear description of the issue.
2. Reproduction steps (or a proof-of-concept) against the latest `master`.
3. The commit SHA you tested against.
4. Your assessment of impact and any suggested mitigation.

We aim to acknowledge within 3 business days and to publish a fix within 30 days for high-severity findings.

## Disclosure

Coordinated disclosure is required for any finding affecting a signed mobile release. For preview-tag findings, we will work with you on timing — typically a fix lands on `master` first, then propagates to the next TestFlight / Play Store internal-testing build, and the public disclosure follows.

## Out of scope

- Reports against builds older than the latest `master`.
- Reports requiring a malicious app already installed alongside the wallet (per-app sandbox + platform keychain isolation are the boundary).
- Reports requiring a jailbroken / rooted device — out-of-scope by definition.
- Reports requiring physical possession of an unlocked device.
- Issues in upstream dependencies (`@noble/hashes`, `@walletconnect/*`, `ethers`, Tauri plugins, platform keychain wrappers) — please report those upstream and we'll pick up the fix.
- Vulnerabilities in private Monolythium components (the chain itself, etc.) — please use the contact above; we'll route internally.

## What we won't do

- Reward bug reports with bounties. The wallet is not enrolled in a bug-bounty program at this stage. Public acknowledgment in release notes is the recognition we can offer.
