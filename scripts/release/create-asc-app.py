#!/usr/bin/env python3
"""
Check whether an App Store Connect app record exists for
`com.monolythium.wallet`. Apple does not allow creating apps via the
API — `POST /v1/apps` returns 403 FORBIDDEN_ERROR — so creation is a
one-time web-UI step. This script tells you if the record is there yet
and prints the exact UI steps if it isn't.

Reads from vault:
    mono/app/appstore-connect-key-id
    mono/app/appstore-connect-issuer-id
    mono/app/appstore-connect-key-base64
"""
from __future__ import annotations
import base64, json, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

try:
    import jwt as pyjwt
except ImportError:
    print("pip install PyJWT cryptography", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WORKSPACE = REPO_ROOT.parent.parent.parent
VAULT = WORKSPACE / "scripts" / "vault.sh"

BUNDLE_ID = "com.monolythium.wallet"
APP_NAME = "Monolythium Wallet"
SKU = "monolythium-wallet-ios"


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


def api(path: str):
    url = f"https://api.appstoreconnect.apple.com/v1{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {sign()}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()}


def main():
    apps = api(f"/apps?filter[bundleId]={BUNDLE_ID}")
    matches = [a for a in apps.get("data", []) if a["attributes"]["bundleId"] == BUNDLE_ID]
    if matches:
        a = matches[0]
        print(f"✓ App Store Connect record exists")
        print(f"   id:           {a['id']}")
        print(f"   bundle id:    {a['attributes'].get('bundleId')}")
        print(f"   name:         {a['attributes'].get('name')}")
        print(f"   sku:          {a['attributes'].get('sku')}")
        print(f"   primary loc:  {a['attributes'].get('primaryLocale')}")
        return

    bids = api(f"/bundleIds?filter[identifier]={BUNDLE_ID}")
    bid_ok = any(b["attributes"]["identifier"] == BUNDLE_ID for b in bids.get("data", []))

    print(f"❌ No App Store Connect record for '{BUNDLE_ID}'")
    print()
    print(f"   Dev-portal bundle id registered: {'yes' if bid_ok else 'NO — needs registering first'}")
    print()
    print(f"Apple's API does not allow creating apps. Do this in the web UI:")
    print(f"  1. Sign in to https://appstoreconnect.apple.com/apps")
    print(f"  2. Click the blue '+' button → New App")
    print(f"  3. Platforms:       iOS")
    print(f"  4. Name:            {APP_NAME}")
    print(f"  5. Primary Language: English (U.S.)")
    print(f"  6. Bundle ID:       {BUNDLE_ID}  (select from dropdown)")
    print(f"  7. SKU:             {SKU}")
    print(f"  8. User Access:     Full Access")
    print()
    print(f"Then re-run this script to confirm.")
    sys.exit(1)


if __name__ == "__main__":
    main()
