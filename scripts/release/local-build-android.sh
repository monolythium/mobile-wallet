#!/usr/bin/env bash
# Build a signed Android AAB + APK locally. Mirrors the CI job.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

VAULT="$REPO_ROOT/../../../scripts/vault.sh"

: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
NDK_DIR=$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)
: "${NDK_HOME:=$NDK_DIR}"
export NDK_HOME
if [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then
    echo "✗ Android NDK not found under $ANDROID_HOME/ndk/; install via Android Studio SDK Manager" >&2
    exit 1
fi

# 1. Frontend deps + Android Rust targets
pnpm install --frozen-lockfile
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

# 2. Init + apply brand icons + patch signing
rm -rf src-tauri/gen/android
pnpm tauri android init
pnpm tauri icon src-tauri/icons/icon.png
python3 .github/scripts/patch-gradle-signing.py \
    src-tauri/gen/android/app/build.gradle.kts

# 3. Stage upload keystore from vault
"$VAULT" get mono/app/mobile-wallet-upload-keystore-base64 | base64 -d \
    > src-tauri/gen/android/upload.jks
cat > src-tauri/gen/android/keystore.properties <<EOF
storeFile=upload.jks
storePassword=$("$VAULT" get mono/app/mobile-wallet-upload-keystore-password)
keyAlias=$("$VAULT" get mono/app/mobile-wallet-upload-key-alias)
keyPassword=$("$VAULT" get mono/app/mobile-wallet-upload-key-password)
EOF

# 4. Build
pnpm tauri android build --aab --apk

AAB=$(find src-tauri/gen/android/app/build/outputs/bundle -name "*.aab" | head -1)
APK=$(find src-tauri/gen/android/app/build/outputs/apk -name "*.apk" | head -1)
echo
echo "✓ AAB: $AAB"
echo "✓ APK: $APK"
echo
echo "Upload AAB to Play Console → Internal testing."
