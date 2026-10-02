"""Offline validation of the Microsoft 365 Copilot agent package against the published JSON schemas.

`atk validate` calls the Teams Developer Portal (requires Microsoft 365 sign-in). This script lets
maintainers and CI check the built package without signing in.

Usage:
    python scripts/validate-agent-package.py agents/contoso-retail-analyst/.deploy/appPackage/build/appPackage.dev.zip
"""

from __future__ import annotations

import json
import struct
import sys
import urllib.request
import zipfile

try:
    import jsonschema
except ImportError:
    sys.exit("pip install jsonschema")


def load_schema(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8-sig"))


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", data[16:24])


def check(name: str, doc: dict, errors: list[str]) -> None:
    schema_url = doc.get("$schema")
    if not schema_url:
        errors.append(f"{name}: missing $schema")
        return
    schema = load_schema(schema_url)
    validator = jsonschema.validators.validator_for(schema)(schema)
    problems = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
    for p in problems:
        errors.append(f"{name}: {'/'.join(map(str, p.path)) or '(root)'}: {p.message}")
    print(f"  {name:<28} {'OK' if not problems else f'{len(problems)} error(s)'}  ({schema_url.rsplit('/', 2)[-2]})")


def main(path: str) -> int:
    errors: list[str] = []
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        print(f"Package {path}: {sorted(names)}")
        manifest = json.loads(z.read("manifest.json").decode("utf-8-sig"))
        check("manifest.json", manifest, errors)
        for icon, expected in ((manifest["icons"]["color"], (192, 192)), (manifest["icons"]["outline"], (32, 32))):
            size = png_size(z.read(icon))
            print(f"  {icon:<28} {size[0]}x{size[1]}")
            if size != expected:
                errors.append(f"{icon}: expected {expected}, got {size}")
        for da in manifest.get("copilotAgents", {}).get("declarativeAgents", []):
            agent = json.loads(z.read(da["file"]).decode("utf-8-sig"))
            check(da["file"], agent, errors)
            if "$[file(" in agent.get("instructions", ""):
                ref = agent["instructions"].split("'")[1]
                if ref not in names:
                    errors.append(f"{da['file']}: instructions file {ref} missing from package")
                elif len(z.read(ref).decode("utf-8-sig")) > 8000:
                    errors.append(f"{ref}: instructions exceed 8000 characters")
            for action in agent.get("actions", []):
                if action["file"] not in names:
                    errors.append(f"{da['file']}: action file {action['file']} missing")
                    continue
                check(action["file"], json.loads(z.read(action["file"]).decode("utf-8-sig")), errors)
        leftovers = [n for n in names if n.endswith((".json", ".txt")) and "${{" in z.read(n).decode("utf-8-sig")]
        for n in leftovers:
            errors.append(f"{n}: unresolved ${{{{...}}}} placeholder")
    if errors:
        print("\nFAILED")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("\nPackage is valid against the published schemas.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
