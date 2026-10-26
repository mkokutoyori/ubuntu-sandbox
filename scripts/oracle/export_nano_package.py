#!/usr/bin/env python3

import argparse
import json
import os
import subprocess

ROOTS = ["/etc/nanorc", "/usr/share/nano"]


def package_paths():
    listing = subprocess.run(["dpkg", "-L", "nano"], capture_output=True, text=True, check=True).stdout.splitlines()
    return [p for p in listing if any(p == r or p.startswith(r + "/") for r in ROOTS)]


def main():
    ap = argparse.ArgumentParser(description="Exporte /etc/nanorc et /usr/share/nano du paquet nano vers NanoPackageFiles.ts")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "src", "network", "devices", "linux", "editors", "nano", "NanoPackageFiles.ts"))
    args = ap.parse_args()
    files, links, directories = [], [], []
    for path in sorted(package_paths()):
        if os.path.islink(path):
            target = os.readlink(path)
            links.append((path, target))
        elif os.path.isdir(path):
            directories.append(path)
        else:
            with open(path, encoding="utf-8") as handle:
                files.append((path, handle.read()))
    version = subprocess.run(["dpkg-query", "-W", "-f=${Version}", "nano"], capture_output=True, text=True, check=True).stdout
    lines = [
        "export interface NanoPackageFile {",
        "  readonly path: string;",
        "  readonly content: string;",
        "}",
        "",
        "export interface NanoPackageLink {",
        "  readonly path: string;",
        "  readonly target: string;",
        "}",
        "",
        "export const NANO_PACKAGE_VERSION = %s;" % json.dumps(version),
        "",
        "export const NANO_PACKAGE_DIRECTORIES: readonly string[] = [",
    ]
    lines += ["  %s," % json.dumps(d) for d in directories]
    lines += ["];", "", "export const NANO_PACKAGE_FILES: readonly NanoPackageFile[] = ["]
    lines += ["  { path: %s, content: %s }," % (json.dumps(p), json.dumps(c, ensure_ascii=False)) for p, c in files]
    lines += ["];", "", "export const NANO_PACKAGE_LINKS: readonly NanoPackageLink[] = ["]
    lines += ["  { path: %s, target: %s }," % (json.dumps(p), json.dumps(t)) for p, t in links]
    lines += ["];", ""]
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    print(len(files), "files,", len(links), "links,", len(directories), "directories ->", args.out)


if __name__ == "__main__":
    main()
