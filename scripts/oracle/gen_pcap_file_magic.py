#!/usr/bin/env python3
"""Generate PcapFileLabels.ts: how the real file(1) (libmagic) labels the link type of a pcap savefile.

usage: gen_pcap_file_magic.py out.ts

file(1) has its own wording for the link types (Ethernet, Raw IP, Private use 0 ...), different from libpcap's, and a fallback
`linktype#N`. Each value from 0 to 399 is written into a header-only savefile and classified by the real tool; what sits between
`version 2.4 (` and `, capture length` is the label.
"""
import struct, subprocess, sys, tempfile, os

def label(path, linktype):
    open(path, "wb").write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, linktype))
    text = subprocess.run(["file", "-b", path], stdout=subprocess.PIPE, text=True).stdout.strip()
    return text.split(" - version 2.4 (", 1)[1].rsplit(", capture length", 1)[0]

def quote(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"

def main():
    with tempfile.TemporaryDirectory() as scratch:
        path = os.path.join(scratch, "probe.pcap")
        rows = [(n, label(path, n)) for n in range(400)]
    rows = [(n, text) for n, text in rows if not text.startswith("linktype#")]
    body = "\n".join("  [%d, %s]," % (n, quote(text)) for n, text in rows)
    open(sys.argv[1], "w").write("export const FILE_LINK_TYPE_LABELS: ReadonlyArray<readonly [linkType: number, label: string]> = [\n" + body + "\n];\n")

main()
