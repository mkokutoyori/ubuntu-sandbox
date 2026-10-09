#!/usr/bin/env python3
"""Embed the systemd 255.4 message catalog sources (English and French) as a TypeScript module.

usage: gen_systemd_catalog.py out.ts

The files come from /usr/lib/systemd/catalog of the Ubuntu 24.04 package; journalctl -x and --list-catalog read them through catalog_update, so
the module holds the sources verbatim and the parser in journal/Catalog.ts ports catalog_import_file.
"""
import json, sys

FILES = ["systemd.catalog", "systemd.fr.catalog"]

def main():
    body = ["export const SYSTEMD_CATALOG_SOURCES: Readonly<Record<string, string>> = {"]
    for name in FILES:
        body.append(f"  {json.dumps(name)}: {json.dumps(open('/usr/lib/systemd/catalog/' + name, encoding='utf-8').read(), ensure_ascii=False)},")
    body.append("};")
    open(sys.argv[1], "w", encoding="utf-8").write("\n".join(body) + "\n")

main()
