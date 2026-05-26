#!/usr/bin/env python3
"""
Inject a signingConfigs.release block into the Tauri-generated
app/build.gradle.kts so the release build picks up keystore.properties.

Tauri's `android init` ships a debug-only signingConfigs. CI calls this
after `tauri android init` to add the release config without committing
gen/android (which is gitignored and host-specific).
"""
from __future__ import annotations
import sys, re
from pathlib import Path

GRADLE = Path(sys.argv[1])
src = GRADLE.read_text()

if "keystore.properties" in src:
    print("already patched, nothing to do")
    sys.exit(0)

# 1. Insert loader at the top, after the plugins block
loader_block = """
import java.util.Properties
import java.io.FileInputStream

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}
"""

src2, n = re.subn(
    r"(plugins\s*\{[^}]*\}\s*)",
    r"\1\n" + loader_block + "\n",
    src,
    count=1,
)
if n == 0:
    print("ERROR: could not find plugins {} block", file=sys.stderr)
    sys.exit(1)
src = src2

# 2. Add signingConfigs.release { ... } inside the android {} block.
signing_block = """
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String? ?: ""
            keyPassword = keystoreProperties["keyPassword"] as String? ?: ""
            storeFile = keystoreProperties["storeFile"]?.let { rootProject.file(it as String) }
            storePassword = keystoreProperties["storePassword"] as String? ?: ""
        }
"""

# Add inside the existing signingConfigs {} block if present, otherwise create one.
if re.search(r"signingConfigs\s*\{", src):
    src = re.sub(
        r"(signingConfigs\s*\{\s*)",
        r"\1" + signing_block + "\n",
        src,
        count=1,
    )
else:
    src = re.sub(
        r"(android\s*\{\s*)",
        r"\1\n    signingConfigs {\n" + signing_block + "    }\n",
        src,
        count=1,
    )

# 3. Wire the release buildType to the release signingConfig.
if re.search(r"buildTypes\s*\{[^}]*release\s*\{[^}]*signingConfig", src, re.DOTALL):
    pass  # already wired
else:
    src = re.sub(
        r"(buildTypes\s*\{\s*[^}]*?release\s*\{\s*)",
        r"\1signingConfig = signingConfigs.getByName(\"release\")\n            ",
        src,
        count=1,
        flags=re.DOTALL,
    )

GRADLE.write_text(src)
print(f"patched {GRADLE}")
