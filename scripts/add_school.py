#!/usr/bin/env python3
"""
Canvascope — Add School Domain (core logic)

Adds a new Canvas domain to all extension files:
  1. manifest.json  (host_permissions + content_scripts.matches)
  2. content.js     (isCanvasDomain + isCanvasUrl)
  3. background.js  (isCanvasDomain)
  4. popup.js       (checkCurrentTab + isValidCanvasUrl)
"""

import json
import re
import sys
import os

GREEN = "\033[0;32m"
RED = "\033[0;31m"
NC = "\033[0m"


def ok(msg):
    print(f"  {GREEN}✓{NC} {msg}")


def fail(msg):
    print(f"  {RED}✗{NC} {msg}", file=sys.stderr)


# ─── manifest.json ───────────────────────────────────────────

def update_manifest(filepath, domain):
    with open(filepath, "r") as f:
        data = json.load(f)

    pattern = f"*://{domain}/*"

    # host_permissions
    if pattern not in data.get("host_permissions", []):
        data["host_permissions"].append(pattern)

    # content_scripts[].matches
    for cs in data.get("content_scripts", []):
        if pattern not in cs.get("matches", []):
            cs["matches"].append(pattern)

    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    ok("manifest.json — host_permissions + content_scripts")


# ─── JS files ────────────────────────────────────────────────
#
# Strategy: find the last `hostname === '...'` in a domain-check
# block and append `||\n<indent>hostname === '<new>'` with the
# same trailing token (`;`, `) {`, `) return;`, etc.).

def add_domain_to_js(filepath, domain):
    """
    Scans the file for lines matching:
        hostname === '<something>'<tail>
    where <tail> ends the chain (e.g. `;`, `) {`, `) return;`).
    For each such line, it inserts a new `hostname === '<domain>'`
    line with the same indent and tail.
    """
    with open(filepath, "r") as f:
        lines = f.readlines()

    # Regex to match the LAST hostname in a chain
    # Captures: (leading whitespace)(hostname === 'xxx')(tail like `) {` or `;` or `) return;`)
    pattern = re.compile(
        r"^(\s*)(hostname === '[^']+')(.*?)$"
    )

    new_lines = []
    changes = 0

    i = 0
    while i < len(lines):
        line = lines[i]
        m = pattern.match(line)

        if m:
            indent = m.group(1)
            _match_part = m.group(2)  # e.g. hostname === 'canvas.asu.edu'
            tail = m.group(3)         # e.g. `) {` or `;` or `) return;`

            # Only modify if this is the END of a chain
            # (i.e. tail is not just ` ||`)
            tail_stripped = tail.strip()

            # Check if domain is already present anywhere in the file near here
            if f"'{domain}'" in line:
                new_lines.append(line)
                i += 1
                continue

            if tail_stripped and tail_stripped != "||":
                # This is the last hostname line in a chain.
                # Convert it to continue the chain, then add our new domain.
                # current line becomes: <indent><match_part> ||
                # new line becomes:     <indent>hostname === '<domain>'<tail>
                new_current = f"{indent}{_match_part} ||\n"
                new_entry = f"{indent}hostname === '{domain}'{tail}\n"
                new_lines.append(new_current)
                new_lines.append(new_entry)
                changes += 1
                i += 1
                continue

        new_lines.append(line)
        i += 1

    if changes > 0:
        with open(filepath, "w") as f:
            f.writelines(new_lines)

    return changes


def main():
    if len(sys.argv) != 3:
        print("Usage: add_school.py <project_dir> <domain>", file=sys.stderr)
        sys.exit(1)

    project_dir = sys.argv[1]
    domain = sys.argv[2].lower()

    manifest = os.path.join(project_dir, "manifest.json")
    content_js = os.path.join(project_dir, "content.js")
    background_js = os.path.join(project_dir, "background.js")
    popup_js = os.path.join(project_dir, "popup.js")

    # Check files exist
    for f in [manifest, content_js, background_js, popup_js]:
        if not os.path.isfile(f):
            fail(f"File not found: {f}")
            sys.exit(1)

    # Check if domain already exists
    with open(manifest, "r") as f:
        if domain in f.read():
            sys.exit(2)  # Already exists

    # 1. manifest.json
    update_manifest(manifest, domain)

    # 2. content.js
    n = add_domain_to_js(content_js, domain)
    ok(f"content.js — {n} domain check(s) updated")

    # 3. background.js
    n = add_domain_to_js(background_js, domain)
    ok(f"background.js — {n} domain check(s) updated")

    # 4. popup.js
    n = add_domain_to_js(popup_js, domain)
    ok(f"popup.js — {n} domain check(s) updated")


if __name__ == "__main__":
    main()
