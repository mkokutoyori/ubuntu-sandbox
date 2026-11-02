#!/usr/bin/env python3
"""Generate PcapLinkTypes.ts from the link types libpcap 1.10.4 names.

usage: gen_pcap_linktypes.py linktypes.tsv out.ts

linktypes.tsv is the output of scripts/oracle/pcap_linktypes.c built against the real libpcap: a savefile header carries the
LINKTYPE value, which differs from the DLT on a few platforms-dependent codes (RAW is 101 on disk and 12 in memory), so the
table is keyed by what the file holds.
"""
import sys

def main():
    rows = []
    for line in open(sys.argv[1]):
        linktype, _dlt, name, description = line.rstrip("\n").split("\t", 3)
        rows.append((int(linktype), name, description))
    rows.sort()
    seen = set()
    entries = []
    for linktype, name, description in rows:
        if linktype in seen:
            continue
        seen.add(linktype)
        entries.append("  [%d, %s, %s]," % (linktype, quote(name), quote(description)))
    body = "\n".join(entries)
    open(sys.argv[2], "w").write(
        "export const PCAP_LINK_TYPES: ReadonlyArray<readonly [linkType: number, name: string, description: string]> = [\n"
        + body + "\n];\n")

def quote(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"

main()
