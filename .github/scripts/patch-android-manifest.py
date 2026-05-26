#!/usr/bin/env python3
"""
Add CAMERA permission + feature declaration to Tauri's generated
AndroidManifest.xml. Idempotent. Camera is needed for the QR scanner
that reads addresses and send links.
"""
from __future__ import annotations
import sys, re
from pathlib import Path

XML = Path(sys.argv[1])
src = XML.read_text()

INSERTS = [
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />',
    '<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
]

# Add only those that aren't already present, just before the opening `<application` tag
needed = [line for line in INSERTS if line.split('"')[1] not in src]
if not needed:
    print("already patched")
    sys.exit(0)

new_src, n = re.subn(
    r"(\n\s*)(<application)",
    r"\n    " + "\n    ".join(needed) + r"\1\2",
    src,
    count=1,
)
if n == 0:
    print("ERROR: <application not found in AndroidManifest.xml", file=sys.stderr)
    sys.exit(1)

XML.write_text(new_src)
print(f"patched {XML} (+{len(needed)} entries)")
