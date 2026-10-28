#!/usr/bin/env python3
"""Record how the real libpcap 1.10.4 reads savefiles, valid and damaged.

usage: record_pcap_savefile.py READER WRITER REAL_PCAP out.json

READER and WRITER are scripts/oracle/pcap_savefile_reader.c and pcap_savefile_writer.c built against libpcap; REAL_PCAP is a capture
written by the real tcpdump. The files
below are built here (both byte orders, microsecond and nanosecond magics, the Kuznetsov record header, the 2.0-2.3 length order,
snapshot shorter than the packets, every kind of truncation); the fixture keeps each file's bytes beside the library's own reading of
it, so the codec test compares the whole result, failure text included. The WRITER cases keep the bytes the real pcap_dump writes
for a header and a few records, in both precisions and for three link types.
"""
import json, os, struct, subprocess, sys, tempfile

MAGIC = 0xA1B2C3D4
MAGIC_NANO = 0xA1B23C4D
MAGIC_KUZNETSOV = 0xA1B2CD34

def header(magic=MAGIC, major=2, minor=4, zone=0, sigfigs=0, snaplen=262144, linktype=1, big=False):
    order = ">" if big else "<"
    return struct.pack(order + "IHHiIII", magic, major, minor, zone, sigfigs, snaplen, linktype)

def record(sec, frac, caplen, length, data, big=False, patched=False):
    order = ">" if big else "<"
    out = struct.pack(order + "IIII", sec, frac, caplen, length)
    if patched:
        out += struct.pack(order + "IHBB", 3, 0x0800, 4, 0)
    return out + data

def payload(n, seed=0):
    return bytes((seed + i * 7) & 0xFF for i in range(n))

def cases(real):
    p60, p100 = payload(60), payload(100, 3)
    out = []
    def add(name, data):
        out.append((name, bytes(data)))
    add("empty", b"")
    add("three-bytes", b"\xd4\xc3\xb2")
    add("magic-only", struct.pack("<I", MAGIC))
    add("header-ten-bytes", header()[:10])
    add("header-twenty-three-bytes", header()[:23])
    add("header-only", header())
    add("little-endian", header() + record(1700000000, 123456, 60, 60, p60) + record(1700000001, 999999, 100, 100, p100))
    add("big-endian", header(big=True) + record(1700000000, 123456, 60, 60, p60, big=True) + record(1700000001, 5, 100, 100, p100, big=True))
    add("nanosecond-little", header(MAGIC_NANO) + record(1700000000, 123456789, 60, 60, p60))
    add("nanosecond-big", header(MAGIC_NANO, big=True) + record(1700000000, 123456789, 60, 60, p60, big=True))
    add("kuznetsov", header(MAGIC_KUZNETSOV) + record(1700000000, 42, 60, 60, p60, patched=True))
    add("kuznetsov-ethernet-snapshot", header(MAGIC_KUZNETSOV, snaplen=96) + record(1700000000, 42, 60, 60, p60, patched=True))
    add("kuznetsov-raw-snapshot", header(MAGIC_KUZNETSOV, snaplen=96, linktype=101) + record(1700000000, 42, 60, 60, p60, patched=True))
    add("caplen-shorter-than-len", header() + record(1700000000, 1, 60, 1514, p60))
    add("zero-length-packet", header() + record(1700000000, 1, 0, 0, b""))
    add("snaplen-zero", header(snaplen=0) + record(1700000000, 1, 60, 60, p60))
    add("snaplen-huge", header(snaplen=0x90000000) + record(1700000000, 1, 60, 60, p60))
    add("packet-longer-than-snapshot", header(snaplen=64) + record(1700000000, 1, 100, 100, p100) + record(1700000001, 2, 60, 60, p60))
    add("packet-longer-than-snapshot-truncated", header(snaplen=64) + record(1700000000, 1, 100, 100, p100)[:16 + 70])
    add("packet-longer-than-snapshot-cut-in-discard", header(snaplen=64) + record(1700000000, 1, 100, 100, p100)[:16 + 90])
    add("caplen-over-maximum-and-snaplen", header(snaplen=1000) + struct.pack("<IIII", 1, 1, 300000, 300000))
    add("caplen-over-maximum-within-snaplen", header(snaplen=1000000) + struct.pack("<IIII", 1, 1, 300000, 300000))
    add("version-2-3-not-swapped", header(minor=3) + record(1700000000, 1, 60, 100, p60))
    add("version-2-3-swapped", header(minor=3) + record(1700000000, 1, 100, 60, p60))
    add("version-2-2-swapped", header(minor=2) + record(1700000000, 1, 100, 60, p60))
    add("version-2-0", header(minor=0) + record(1700000000, 1, 100, 60, p60))
    add("version-543-0", header(major=543, minor=0) + record(1700000000, 1, 100, 60, p60))
    add("version-2-5", header(minor=5))
    add("version-3-0", header(major=3, minor=0))
    add("version-1-0", header(major=1, minor=0))
    add("version-543-1", header(major=543, minor=1))
    add("timezone-and-sigfigs", header(zone=-3600, sigfigs=6) + record(1700000000, 1, 60, 60, p60))
    add("negative-seconds", header() + record(0xFFFFFFF0, 7, 60, 60, p60))
    add("linktype-raw", header(linktype=101) + record(1700000000, 1, 60, 60, p60))
    add("linktype-cooked-v2", header(linktype=276) + record(1700000000, 1, 60, 60, p60))
    add("linktype-unknown", header(linktype=9999) + record(1700000000, 1, 60, 60, p60))
    add("linktype-extension-bits", header(linktype=0x10000001) + record(1700000000, 1, 60, 60, p60))
    add("record-header-cut", header() + record(1700000000, 1, 60, 60, p60) + record(1700000001, 2, 60, 60, p60)[:6])
    add("record-data-cut", header() + record(1700000000, 1, 60, 60, p60) + record(1700000001, 2, 60, 60, p60)[:30])
    add("record-data-cut-to-header", header() + record(1700000000, 1, 60, 60, p60) + record(1700000001, 2, 60, 60, p60)[:16])
    add("unknown-magic", b"hello world, this is not a capture\n")
    add("kuznetsov-record-header-cut", header(MAGIC_KUZNETSOV) + record(1700000000, 42, 60, 60, p60, patched=True)[:20])
    add("real-tcpdump-ping", real)
    add("real-tcpdump-ping-cut-in-last-record", real[:-9])
    return out

WRITTEN = [
    ("micro-ethernet", "micro", 1, 262144, [(1700000000, 123456, 60, payload(60)), (1700000001, 999999, 1514, payload(100, 3)), (0, 0, 0, b"")]),
    ("nano-ethernet", "nano", 1, 262144, [(1700000000, 123456789, 60, payload(60))]),
    ("micro-raw-short-snaplen", "micro", 12, 96, [(1700000000, 5, 60, payload(60))]),
    ("micro-cooked-v2", "micro", 276, 65535, [(1700000000, 5, 60, payload(60))]),
    ("empty", "micro", 1, 262144, []),
]

def written(writer, scratch):
    out = []
    for name, precision, dlt, snaplen, records in WRITTEN:
        path = os.path.join(scratch, "written.pcap")
        stdin = "".join("%d %d %d %s\n" % (sec, sub, length, data.hex()) for sec, sub, length, data in records)
        subprocess.run([writer, precision, str(dlt), str(snaplen), path], input=stdin, text=True, check=True)
        header = open(path, "rb").read()[:24]
        linktype = struct.unpack("<I", header[20:24])[0]
        out.append({
            "name": name, "nanosecond": precision == "nano", "linkType": linktype, "snaplen": snaplen,
            "records": [{"seconds": sec, "subsecond": sub, "originalLength": length, "data": data.hex()} for sec, sub, length, data in records],
            "hex": open(path, "rb").read().hex(),
        })
    return out

def main():
    reader, writer, real_path, target = sys.argv[1:5]
    real = open(real_path, "rb").read()
    result = {"libpcap": "1.10.4", "cases": [], "written": []}
    with tempfile.TemporaryDirectory() as scratch:
        for index, (name, data) in enumerate(cases(real)):
            path = os.path.join(scratch, "case%03d.pcap" % index)
            open(path, "wb").write(data)
            line = subprocess.run([reader, path], capture_output=True, text=True).stdout.strip()
            reading = json.loads(line)
            del reading["file"]
            result["cases"].append({"name": name, "hex": data.hex(), "reading": reading})
        result["written"] = written(writer, scratch)
    json.dump(result, open(target, "w"), separators=(",", ":"))

main()
