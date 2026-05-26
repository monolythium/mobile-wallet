# Releasing — TestFlight + Google Play

Mobile wallet ships from a single tag. Push `vX.Y.Z` and the
`Release` workflow builds + uploads to **TestFlight (internal)** and
**Play Console (internal track)** in parallel.

---

## One-time setup

These steps run once per developer environment. Once done, every release
is just `bump-version → tag → push`.

### 1. Create the App Store Connect app record

The provisioning profile is generated against the dev-portal bundle id
(`com.monolythium.wallet`), but App Store Connect needs a separate app
record before TestFlight will accept an IPA.

```bash
pip install PyJWT cryptography
scripts/release/create-asc-app.py
```

Idempotent — prints the existing app id if a record already exists.

### 2. Create the Play Console app record

UI-only step at <https://play.google.com/console>:
1. Create app
2. App name: `Monolythium Wallet`
3. Default language: English (United States)
4. App or game: App
5. Free or paid: Free
6. After creation: Setup → App content → Privacy policy → publish
   `https://monolythium.com/legal/privacy`

### 3. Grant the Play service account Release Manager role

In the Play Console:
1. Users and permissions → Invite new users
2. Email: the service account email used for the Play Developer API
   (configured in the vault entry referenced by the
   `PLAY_SERVICE_ACCOUNT_JSON` GitHub Actions secret)
3. Account permissions: tick **Admin (all permissions)** for the first
   release; lock it down to **Release manager** after the first upload
   succeeds.

### 4. Stage the Android upload keystore

Generated locally with `keytool` — see [`docs/KEYSTORE.md`](./KEYSTORE.md)
for the exact command if you need to regenerate. The output is
base64-encoded into vault so CI has no extra file plumbing:

```bash
# After generating keystore + recording passwords:
base64 -i mono-mobile-wallet-upload.jks | tr -d '\n' \
    | ./scripts/vault.sh set mono/app/mobile-wallet-upload-keystore-base64

./scripts/vault.sh set mono/app/mobile-wallet-upload-keystore-password
./scripts/vault.sh set mono/app/mobile-wallet-upload-key-alias
./scripts/vault.sh set mono/app/mobile-wallet-upload-key-password
```

Keep the raw `.jks` file off-machine after vaulting (it lives in
`~/safe/` on Blackwell or wherever; never commit).

### 5. Push GitHub Actions secrets from vault

```bash
scripts/release/push-github-secrets.sh
```

Pushes every secret named in `.github/workflows/release.yml`.

---

## Every release

### 1. Bump the version

```bash
scripts/release/bump-version.sh 0.1.0
```

Updates `package.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`. The
Android `versionCode` is derived from semver
(`MAJOR*10000 + MINOR*100 + PATCH`) at gradle-write time, so it's
monotonic without a separate file.

### 2. Verify locally (optional but recommended)

```bash
# iOS dry-run — builds the IPA, does not upload
scripts/release/local-build-ios.sh

# Android dry-run — needs the keystore env vars set
export ANDROID_KEYSTORE_PATH=~/.keystores/mono-mobile-wallet-upload.jks
export ANDROID_KEYSTORE_PASSWORD=$(./scripts/vault.sh get mono/app/mobile-wallet-upload-keystore-password)
export ANDROID_KEY_ALIAS=$(./scripts/vault.sh get mono/app/mobile-wallet-upload-key-alias)
export ANDROID_KEY_PASSWORD=$(./scripts/vault.sh get mono/app/mobile-wallet-upload-key-password)
export ANDROID_NDK_ROOT=$(ls -d ~/Library/Android/sdk/ndk/26* | head -1)
scripts/release/local-build-android.sh
```

### 3. Commit + tag + push

```bash
git add -u
git commit -m "Release v0.1.0"
git tag v0.1.0
git push origin master v0.1.0
```

The `Release` workflow does the rest:
- macOS runner: build + sign IPA → TestFlight via `xcrun altool`
- Ubuntu runner: build + sign AAB → Play internal via `androidpublisher`
- A draft GitHub release pulls both artifacts together

### 4. Observe

```bash
gh run watch              # tail the running workflow
gh release view v0.1.0    # see uploaded artifacts
```

TestFlight build appears in App Store Connect → Apps → Builds within
~10 min of the workflow completing. Play internal release appears in
Play Console → Releases → Internal testing immediately.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `xcrun altool` returns `Authentication failed` | API key was rotated or `.p8` doesn't match `APPSTORE_CONNECT_KEY_ID` |
| `xcodebuild` fails with `provisioning profile doesn't match` | provisioning profile expired; re-export from Apple Developer portal and update the vault entry `mono/app/mobile-wallet-provisioning-profile-base64` |
| Play API: `applicationNotFound` | Play Console app record not yet created |
| Play API: `403 forbidden` | service account doesn't have Release Manager role on the new app |
| Gradle: `Keystore file not found` | `keystore.properties` written before `upload.jks`; check workflow step order |

---

## Tag prefix

This repo uses bare `vX.Y.Z` tags. If you tag a non-mobile release on
this repo, prefix it differently (`web-vX.Y.Z`, etc.) — the workflow
filter is `v*` so any tag matching `v*` triggers a mobile release.
