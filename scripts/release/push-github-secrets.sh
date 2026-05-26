#!/usr/bin/env bash
# Push every GitHub Actions secret the release workflow needs, sourced
# from the macOS keychain vault. Run once after the keystore is staged.
#
# Required vault entries:
#   mono/app/apple-team-id
#   mono/app/apple-distribution-cert-base64
#   mono/app/apple-distribution-cert-password
#   mono/app/mobile-wallet-provisioning-profile-base64
#   mono/app/appstore-connect-key-id
#   mono/app/appstore-connect-issuer-id
#   mono/app/appstore-connect-key-base64
#   mono/app/mobile-wallet-upload-keystore-base64
#   mono/app/mobile-wallet-upload-keystore-password
#   mono/app/mobile-wallet-upload-key-alias
#   mono/app/mobile-wallet-upload-key-password
#   mono/google/cws-service-account-json    (or a play-specific one)
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VAULT="$REPO_ROOT/../../../scripts/vault.sh"
REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner)

push() {
    local secret_name="$1" vault_key="$2"
    local val
    val=$("$VAULT" get "$vault_key")
    if [ -z "$val" ]; then
        echo "skip $secret_name (vault $vault_key empty)"
        return
    fi
    printf '%s' "$val" | gh secret set "$secret_name" --repo "$REPO_SLUG" --body -
    echo "✓ pushed $secret_name from $vault_key"
}

echo "Pushing secrets to $REPO_SLUG..."

push APPLE_TEAM_ID                          mono/app/apple-team-id
push APPLE_DISTRIBUTION_CERT_BASE64         mono/app/apple-distribution-cert-base64
push APPLE_DISTRIBUTION_CERT_PASSWORD       mono/app/apple-distribution-cert-password
push APPLE_PROVISIONING_PROFILE_BASE64      mono/app/mobile-wallet-provisioning-profile-base64
push APPSTORE_CONNECT_KEY_ID                mono/app/appstore-connect-key-id
push APPSTORE_CONNECT_ISSUER_ID             mono/app/appstore-connect-issuer-id
push APPSTORE_CONNECT_KEY_BASE64            mono/app/appstore-connect-key-base64

push ANDROID_KEYSTORE_BASE64                mono/app/mobile-wallet-upload-keystore-base64
push ANDROID_KEYSTORE_PASSWORD              mono/app/mobile-wallet-upload-keystore-password
push ANDROID_KEY_ALIAS                      mono/app/mobile-wallet-upload-key-alias
push ANDROID_KEY_PASSWORD                   mono/app/mobile-wallet-upload-key-password

push PLAY_SERVICE_ACCOUNT_JSON              mono/google/cws-service-account-json

echo "done"
