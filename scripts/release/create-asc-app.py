#!/usr/bin/env python3
"""
Create the App Store Connect app record for `com.monolythium.wallet`
using the API key in the macOS keychain vault. Idempotent: prints the
existing app id if one already exists.

Reads from vault:
    mono/app/appstore-connect-key-id
    mono/app/appstore-connect-issuer-id
    mono/app/appstore-connect-key-base64

Usage:
    scripts/release/create-asc-app.py
"""
from __future__ import annotations
import base64, json, subprocess, sys, time
from pathlib import Path

try:
    import jwt as pyjwt
except ImportError:
    print("pip install PyJWT cryptography", file=sys.stderr)
    sys.exit(2)

import urllib.request, urllib.error

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WORKSPACE = REPO_ROOT.parent.parent.parent  # monolythium-ecosystem
VAULT = WORKSPACE / "scripts" / "vault.sh"

BUNDLE_ID = "com.monolythium.wallet"
APP_NAME = "Monolythium Wallet"
SKU = "monolythium-wallet-ios"
PRIMARY_LOCALE = "en-US"


def vault(key: str) -> str:
    return subprocess.check_output([str(VAULT), "get", key]).decode().strip()


def sign() -> str:
    kid = vault("mono/app/appstore-connect-key-id")
    iss = vault("mono/app/appstore-connect-issuer-id")
    pem = base64.b64decode(vault("mono/app/appstore-connect-key-base64")).decode()
    return pyjwt.encode(
        {"iss": iss, "exp": int(time.time()) + 1200, "aud": "appstoreconnect-v1"},
        pem, algorithm="ES256", headers={"kid": kid, "typ": "JWT"},
    )


def api(method: str, path: str, body: dict | None = None):
    url = f"https://api.appstoreconnect.apple.com/v1{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {sign()}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_error_code": e.code, "_error_body": e.read().decode()}


def find_existing() -> str | None:
    res = api("GET", f"/apps?filter[bundleId]={BUNDLE_ID}")
    for a in res.get("data", []):
        if a["attributes"]["bundleId"] == BUNDLE_ID:
            return a["id"]
    return None


def find_bundle_id_resource_id() -> str | None:
    res = api("GET", f"/bundleIds?filter[identifier]={BUNDLE_ID}")
    for b in res.get("data", []):
        if b["attributes"]["identifier"] == BUNDLE_ID:
            return b["id"]
    return None


def create_app(bundle_id_resource: str) -> dict:
    return api("POST", "/apps", {
        "data": {
            "type": "apps",
            "attributes": {
                "bundleId": BUNDLE_ID,
                "name": APP_NAME,
                "primaryLocale": PRIMARY_LOCALE,
                "sku": SKU,
            },
            "relationships": {
                "bundleId": {
                    "data": {"type": "bundleIds", "id": bundle_id_resource}
                }
            },
        }
    })


def main():
    existing = find_existing()
    if existing:
        print(f"✓ app already exists: {existing}")
        return

    bid = find_bundle_id_resource_id()
    if not bid:
        print(f"❌ bundle id '{BUNDLE_ID}' not registered in dev portal", file=sys.stderr)
        sys.exit(1)

    res = create_app(bid)
    if "_error_code" in res:
        print(f"❌ create failed ({res['_error_code']}):\n{res['_error_body']}", file=sys.stderr)
        sys.exit(1)
    print(f"✓ created app: {res['data']['id']}")
    print(f"   bundle: {BUNDLE_ID}")
    print(f"   name:   {APP_NAME}")
    print(f"   sku:    {SKU}")


if __name__ == "__main__":
    main()
