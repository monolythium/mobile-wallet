#!/usr/bin/env bash
# Build and export a signed App-Store IPA locally. Mirrors the CI job.
#
# Expects local-keychain state populated with the Apple Distribution cert.
# Reads team id + signing identity + provisioning-profile UUID from vault.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

VAULT="$REPO_ROOT/../../../scripts/vault.sh"
TEAM=$("$VAULT" get mono/app/apple-team-id)
SIGN_IDENT="Apple Distribution: Nayiem Willems ($TEAM)"

# 1. Stage distribution cert + provisioning profile if not already on host
if ! security find-identity -v -p codesigning | grep -q "$SIGN_IDENT"; then
    echo "→ importing Apple Distribution cert from vault"
    "$VAULT" get mono/app/apple-distribution-cert-base64 | base64 -d > /tmp/dist.p12
    CERT_PASS=$("$VAULT" get mono/app/apple-distribution-cert-password)
    security import /tmp/dist.p12 \
        -k ~/Library/Keychains/login.keychain-db \
        -P "$CERT_PASS" -T /usr/bin/codesign -T /usr/bin/security
    rm /tmp/dist.p12
fi

PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILE_DIR"
PROFILE_FILE=$(mktemp /tmp/lyth-profile.XXXXXX.mobileprovision)
"$VAULT" get mono/app/mobile-wallet-provisioning-profile-base64 | base64 -d > "$PROFILE_FILE"
PROFILE_UUID=$(/usr/libexec/PlistBuddy -c "Print UUID" /dev/stdin \
    <<< "$(security cms -D -i "$PROFILE_FILE")")
cp "$PROFILE_FILE" "$PROFILE_DIR/$PROFILE_UUID.mobileprovision"
rm "$PROFILE_FILE"

# 2. Install frontend deps
pnpm install --frozen-lockfile

# 3. Initialize the Xcode project, then APPLY the brand icons (must come AFTER
#    init — `tauri ios init` wipes Assets.xcassets) and PATCH the project for
#    manual signing (Tauri's default is automatic, which needs a dev profile
#    we don't carry).
rm -rf src-tauri/gen/apple
pnpm tauri ios init
pnpm tauri icon src-tauri/icons/icon.png
python3 .github/scripts/patch-pbxproj-signing.py \
    src-tauri/gen/apple/mobile-wallet.xcodeproj/project.pbxproj \
    "$TEAM" "$SIGN_IDENT" "$PROFILE_UUID"

# 4. Stage App Store Connect API key for altool
KEY_ID=$("$VAULT" get mono/app/appstore-connect-key-id)
mkdir -p ~/.appstoreconnect/private_keys
"$VAULT" get mono/app/appstore-connect-key-base64 | base64 -d \
    > "$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
chmod 600 "$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"

# 5. Build (Tauri runs xcodebuild archive; its export step will fail with
#    manual signing — we run our own xcodebuild -exportArchive after).
echo "→ Building archive via tauri ios build (export step expected to fail)…"
set +e
pnpm tauri ios build --export-method app-store-connect \
    --config "{\"bundle\":{\"iOS\":{\"developmentTeam\":\"$TEAM\"}}}"
set -e

ARCHIVE=src-tauri/gen/apple/build/mobile-wallet_iOS.xcarchive
if [ ! -d "$ARCHIVE" ]; then
    echo "✗ archive missing — Tauri archive failed before our export takeover" >&2
    exit 1
fi

# 6. Write ExportOptions.plist with manual signing baked in
EXPORT_DIR="$REPO_ROOT/build/ios-export"
rm -rf "$EXPORT_DIR"; mkdir -p "$EXPORT_DIR"
cat > "$EXPORT_DIR/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>$TEAM</string>
    <key>signingStyle</key><string>manual</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.monolythium.wallet</key>
        <string>com.monolythium.wallet AppStore</string>
    </dict>
    <key>uploadBitcode</key><false/>
    <key>uploadSymbols</key><true/>
    <key>destination</key><string>export</string>
</dict>
</plist>
EOF

xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_DIR/ExportOptions.plist" \
    -allowProvisioningUpdates

IPA=$(find "$EXPORT_DIR" -name "*.ipa" | head -1)
if [ -z "$IPA" ]; then
    echo "✗ no IPA produced" >&2
    exit 1
fi
echo
echo "✓ IPA: $IPA"
echo
echo "Upload to TestFlight:"
echo "  xcrun altool --upload-app -f \"$IPA\" -t ios \\"
echo "    --apiKey $KEY_ID \\"
echo "    --apiIssuer $("$VAULT" get mono/app/appstore-connect-issuer-id)"
