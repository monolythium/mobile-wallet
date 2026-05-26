#!/usr/bin/env bash
# Dry-run the Android release build path locally. Mirrors the CI job.
# Expects $ANDROID_KEYSTORE_PATH + $ANDROID_KEYSTORE_PASSWORD +
#         $ANDROID_KEY_ALIAS + $ANDROID_KEY_PASSWORD in the env.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

: "${ANDROID_KEYSTORE_PATH:?set ANDROID_KEYSTORE_PATH to an existing .jks file}"
: "${ANDROID_KEYSTORE_PASSWORD:?}"
: "${ANDROID_KEY_ALIAS:?}"
: "${ANDROID_KEY_PASSWORD:?}"
: "${ANDROID_NDK_ROOT:?set ANDROID_NDK_ROOT (e.g. \$ANDROID_HOME/ndk/26.1.10909125)}"

pnpm install --frozen-lockfile
[ -d src-tauri/gen/android ] || pnpm tauri android init

cp "$ANDROID_KEYSTORE_PATH" src-tauri/gen/android/upload.jks

cat > src-tauri/gen/android/keystore.properties <<EOF
storeFile=upload.jks
storePassword=$ANDROID_KEYSTORE_PASSWORD
keyAlias=$ANDROID_KEY_ALIAS
keyPassword=$ANDROID_KEY_PASSWORD
EOF

APP_GRADLE=src-tauri/gen/android/app/build.gradle.kts
if ! grep -q "keystore.properties" "$APP_GRADLE"; then
    python3 .github/scripts/patch-gradle-signing.py "$APP_GRADLE"
fi

NDK_HOME="$ANDROID_NDK_ROOT" pnpm tauri android build --aab "$@"

AAB=$(find src-tauri/gen/android/app/build/outputs/bundle -name "*.aab" | head -1)
echo
echo "✓ AAB ready:"
echo "    $AAB"
