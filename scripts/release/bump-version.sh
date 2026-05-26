#!/usr/bin/env bash
# Bump the wallet version across every file that pins it. Tauri reads
# tauri.conf.json for both iOS CFBundleShortVersionString and Android
# versionName; android versionCode is derived as a monotonic integer from
# the semver (MAJOR*10000 + MINOR*100 + PATCH).
#
# Usage: scripts/release/bump-version.sh 0.1.0
set -euo pipefail

NEW=${1:?usage: bump-version.sh <semver>}
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "version must be MAJOR.MINOR.PATCH (got $NEW)" >&2
    exit 2
fi

CUR_PKG=$(jq -r .version package.json)
CUR_TAURI=$(jq -r .version src-tauri/tauri.conf.json)
CUR_CARGO=$(awk -F'"' '/^version =/ {print $2; exit}' src-tauri/Cargo.toml)

if [[ "$CUR_PKG" != "$CUR_TAURI" || "$CUR_TAURI" != "$CUR_CARGO" ]]; then
    echo "warn: versions drifted before bump (pkg=$CUR_PKG tauri=$CUR_TAURI cargo=$CUR_CARGO)" >&2
fi

# package.json
tmp=$(mktemp); jq --arg v "$NEW" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json

# tauri.conf.json
tmp=$(mktemp); jq --arg v "$NEW" '.version = $v' src-tauri/tauri.conf.json > "$tmp" && mv "$tmp" src-tauri/tauri.conf.json

# Cargo.toml (only the [package] version, not deps)
awk -v new="$NEW" 'BEGIN{done=0} /^\[package\]/{in_pkg=1} in_pkg && !done && /^version = "/ {print "version = \"" new "\""; done=1; next} /^\[/ && !/\[package\]/{in_pkg=0} {print}' src-tauri/Cargo.toml > /tmp/Cargo.toml.new
mv /tmp/Cargo.toml.new src-tauri/Cargo.toml

echo "bumped to $NEW"
echo "  package.json:           $(jq -r .version package.json)"
echo "  tauri.conf.json:        $(jq -r .version src-tauri/tauri.conf.json)"
echo "  Cargo.toml [package]:   $(awk -F'"' '/^version =/ {print $2; exit}' src-tauri/Cargo.toml)"

# Android versionCode is monotonic; computed here for the gradle write step.
IFS='.' read -r MAJ MIN PAT <<< "$NEW"
VERSION_CODE=$((MAJ*10000 + MIN*100 + PAT))
echo "  android versionCode:    $VERSION_CODE (computed)"
