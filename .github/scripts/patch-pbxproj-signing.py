#!/usr/bin/env python3
"""
Switch the Tauri-generated .xcodeproj from automatic to manual signing
for the iOS target. Idempotent.
"""
import sys, re
from pathlib import Path

PBX = Path(sys.argv[1])
team = sys.argv[2]
ident = sys.argv[3]
profile = sys.argv[4]

src = PBX.read_text()

# Replace the iPhone Developer auto-sign identity with our Apple Distribution
src = re.sub(
    r'CODE_SIGN_IDENTITY\s*=\s*"iPhone Developer";',
    f'CODE_SIGN_IDENTITY = "{ident}";',
    src,
)

# Inject manual-signing settings into every iOS build configuration block.
# Each build configuration is wrapped in `buildSettings = { ... };`. We add the
# settings INSIDE buildSettings, idempotently.
def add_settings(match):
    body = match.group(1)
    additions = []
    if "CODE_SIGN_STYLE" not in body:
        additions.append('				CODE_SIGN_STYLE = Manual;\n')
    if "DEVELOPMENT_TEAM" not in body:
        additions.append(f'				DEVELOPMENT_TEAM = {team};\n')
    if "PROVISIONING_PROFILE_SPECIFIER" not in body:
        additions.append(f'				PROVISIONING_PROFILE_SPECIFIER = "{profile}";\n')
    return "buildSettings = {\n" + "".join(additions) + body + "};"

# Match buildSettings blocks. Be conservative: only those that mention the iOS
# target identity we just rewrote (so we don't touch macOS-only configs).
def patch_for_ios(match):
    body = match.group(0)
    if ident in body:
        # Add the manual-signing settings after `buildSettings = {`
        return re.sub(
            r'buildSettings = \{(\n)',
            'buildSettings = {\\1'
            + f'\t\t\t\tCODE_SIGN_STYLE = Manual;\n'
            + f'\t\t\t\tDEVELOPMENT_TEAM = {team};\n'
            + f'\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{profile}";\n',
            body,
            count=1,
        )
    return body


src = re.sub(
    r'buildSettings = \{[^}]*?\};',
    patch_for_ios,
    src,
    flags=re.DOTALL,
)

PBX.write_text(src)

# Quick sanity check
hits = src.count("CODE_SIGN_STYLE = Manual")
print(f"patched: {hits} build configs now use manual signing")
