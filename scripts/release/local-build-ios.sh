#!/usr/bin/env bash
# Dry-run the full TestFlight build path locally (no upload).
# Mirrors .github/workflows/release.yml's ios job.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

if ! command -v xcodebuild >/dev/null; then
    echo "xcodebuild missing — install Xcode" >&2
    exit 1
fi

pnpm install --frozen-lockfile
[ -d src-tauri/gen/apple ] || pnpm tauri ios init
pnpm tauri ios build --export-method app-store-connect "$@"

IPA=$(find src-tauri/gen/apple/build -name "*.ipa" | head -1)
echo
echo "✓ IPA ready:"
echo "    $IPA"
echo
echo "Upload manually with:"
echo "    xcrun altool --upload-app -f \"$IPA\" -t ios \\"
echo "      --apiKey \$ASC_KEY_ID --apiIssuer \$ASC_ISSUER_ID"
