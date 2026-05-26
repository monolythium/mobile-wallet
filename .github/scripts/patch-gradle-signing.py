#!/usr/bin/env python3
"""
Inject release signing into the Tauri-generated app/build.gradle.kts so the
release build picks up keystore.properties.

Idempotent. Compatible with Tauri 2's android init output that already
imports java.util.Properties and has a tauriProperties block. Uses
brace-counting rather than greedy regexes so nested braces inside
Properties().apply { ... } don't trip the patch.
"""
from __future__ import annotations
import sys
from pathlib import Path

GRADLE = Path(sys.argv[1])
src = GRADLE.read_text()
lines = src.splitlines(keepends=True)

if "keystoreProperties" in src:
    print("already patched")
    sys.exit(0)


def find_block_end(start_line_idx: int) -> int:
    """Given a line index that contains an opening { (the val tauriProperties =
    Properties().apply { line), return the index of the line containing the
    matching }."""
    depth = 0
    seen_open = False
    for i in range(start_line_idx, len(lines)):
        for ch in lines[i]:
            if ch == "{":
                depth += 1
                seen_open = True
            elif ch == "}":
                depth -= 1
                if seen_open and depth == 0:
                    return i
    raise RuntimeError("unbalanced braces")


# 1. Find the tauriProperties block's closing brace
tauri_start = next(
    i for i, line in enumerate(lines)
    if "val tauriProperties = Properties().apply" in line
)
tauri_end = find_block_end(tauri_start)

# 2. Insert keystoreProperties block right after tauriProperties' closing brace
KEYSTORE_BLOCK = """
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
"""
lines.insert(tauri_end + 1, KEYSTORE_BLOCK)

# 3. Insert signingConfigs.release { ... } right after `android {`
SIGNING_BLOCK = """    signingConfigs {
        create("release") {
            val storeFileName = keystoreProperties["storeFile"] as String?
            if (storeFileName != null) {
                storeFile = rootProject.file(storeFileName)
            }
            storePassword = keystoreProperties["storePassword"] as String? ?: ""
            keyAlias = keystoreProperties["keyAlias"] as String? ?: ""
            keyPassword = keystoreProperties["keyPassword"] as String? ?: ""
        }
    }
"""
android_start = next(
    i for i, line in enumerate(lines)
    if line.strip().startswith("android {") or line.strip() == "android {"
)
lines.insert(android_start + 1, SIGNING_BLOCK)

# 4. Wire signingConfig into the release buildType
for i, line in enumerate(lines):
    if 'getByName("release")' in line and "{" in line:
        # Insert signingConfig assignment on the next line, with matching indent
        indent = " " * (len(line) - len(line.lstrip()) + 4)
        lines.insert(i + 1, f'{indent}signingConfig = signingConfigs.getByName("release")\n')
        break
else:
    print("ERROR: could not find buildTypes.release", file=sys.stderr)
    sys.exit(1)

GRADLE.write_text("".join(lines))
print(f"patched {GRADLE}")
