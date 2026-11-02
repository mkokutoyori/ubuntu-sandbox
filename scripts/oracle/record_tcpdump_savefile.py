#!/usr/bin/env python3
"""Record the real tcpdump 4.99.4 reading savefiles: a real capture, the same capture in other shapes, and damaged files.

usage: record_tcpdump_savefile.py TOOLS_ROOT REAL_PCAP LAB_PCAP out.json

REAL_PCAP is a capture written by the real tcpdump (ARP, then two ICMP echo exchanges); LAB_PCAP is a savefile of the simulator's "base"
lab (tcpdump-options-4.99.4.json: ICMP, fragments, IPv4 and IPv6 TCP and UDP, NDP, traceroute, HTTP, FTP, SMTP, SSH), cut at several snapshot lengths. The cases keep its packets and change what
surrounds them: nanosecond magic, snapshot shorter than the packets, Linux cooked v1 and v2 headers, a damaged tail, a header cut at
every length that matters, a version libpcap refuses. The real file(1) classifies each of them too. stdout and stderr come back in the order the tool wrote them (stdbuf -o0), in UTC.
"""
import json, os, struct, subprocess, sys, tempfile

MAGIC = 0xA1B2C3D4
MAGIC_NANO = 0xA1B23C4D

def header(magic=MAGIC, major=2, minor=4, snaplen=262144, linktype=1):
    return struct.pack("<IHHiIII", magic, major, minor, 0, 0, snaplen, linktype)

def record(sec, frac, caplen, length, data):
    return struct.pack("<IIII", sec, frac, caplen, length) + data

def records_of(real):
    out, at = [], 24
    while at < len(real):
        sec, frac, caplen, length = struct.unpack("<IIII", real[at:at + 16])
        out.append((sec, frac, length, real[at + 16:at + 16 + caplen]))
        at += 16 + caplen
    return out

def sll2(data, ifindex, pkttype):
    return data[12:14] + b"\x00\x00" + struct.pack(">IHBB", ifindex, 1, pkttype, 6) + data[6:12] + b"\x00\x00" + data[14:]

def sll1(data, pkttype):
    return struct.pack(">HHH", pkttype, 1, 6) + data[6:12] + b"\x00\x00" + data[12:14] + data[14:]

SNAPSHOTS = [14, 20, 34, 38, 40, 54, 58, 60, 68, 96, 128]

def cases(real, lab):
    packets = records_of(real)
    def file(magic=MAGIC, snaplen=262144, linktype=1, transform=lambda d: d, cut=None, major=2, minor=4, keep=None, fraction=lambda f: f):
        body = b"".join(record(sec, fraction(frac), len(transform(data)[:cut]), length - len(data) + len(transform(data)), transform(data)[:cut])
                        for sec, frac, length, data in packets[:keep])
        return header(magic, major, minor, snaplen, linktype) + body
    out = [
        ("real-capture", real, ["-nn", "-nn -e", "-nn -v", "-nn -Q in", "-nn -Q out", "-nn -c 2", "-nn -tt", "-nn --nano", "-nn icmp", "-nn -x"]),
        ("nanosecond", file(MAGIC_NANO, fraction=lambda f: f * 1000 + 789), ["-nn", "-nn --nano", "-nn -tt --nano", "-nn -ttt --nano"]),
        ("snapshot-shorter-than-packets", file(snaplen=60, cut=60), ["-nn", "-nn -v", "-nn -x", "-nn -e"]),
        ("snapshot-shorter-than-the-ip-header", file(snaplen=20, cut=20), ["-nn", "-nn -v"]),
        ("cooked-v1", file(linktype=113, transform=lambda d: sll1(d, 0)), ["-nn", "-nn -e", "-nn -x"]),
        ("cooked-v2", file(linktype=276, transform=lambda d: sll2(d, 1, 0)), ["-nn", "-nn -e", "-nn -x"]),
        ("cooked-v2-outgoing", file(linktype=276, transform=lambda d: sll2(d, 1, 4)), ["-nn", "-nn -e"]),
        ("cooked-v2-unknown-interface", file(linktype=276, transform=lambda d: sll2(d, 9999, 0)), ["-nn", "-nn -e"]),
        ("empty-file", b"", ["-nn"]),
        ("three-bytes", real[:3], ["-nn"]),
        ("header-ten-bytes", real[:10], ["-nn"]),
        ("header-only", real[:24], ["-nn", "-nn -c 1"]),
        ("record-header-cut", real[:30], ["-nn"]),
        ("record-data-cut", real[:50], ["-nn"]),
        ("tail-cut", real[:-9], ["-nn", "-nn -c 2", "-nn -c 5"]),
        ("not-a-capture", b"hello, this is not a capture\n", ["-nn"]),
        ("version-2-5", header(minor=5), ["-nn"]),
        ("version-1-0", header(major=1, minor=0), ["-nn"]),
        ("unknown-link-type", file(linktype=9999), ["-nn"]),
    ]
    lab_packets = records_of(lab)
    for snaplen in SNAPSHOTS:
        body = b"".join(record(sec, frac, min(len(data), snaplen), length, data[:snaplen]) for sec, frac, length, data in lab_packets)
        out.append(("lab-snapshot-%d" % snaplen, header(snaplen=snaplen) + body, ["-nn", "-nn -v"]))
    return out

def run(root, path, options):
    env = dict(os.environ, TZ="UTC", LD_LIBRARY_PATH=os.path.join(root, "usr/lib/x86_64-linux-gnu"))
    command = ["stdbuf", "-o0", os.path.join(root, "usr/bin/tcpdump"), "-Z", "root"] + options.split() + ["-r", path]
    done = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return {"options": options, "status": done.returncode, "output": done.stdout}

def classified(path):
    done = subprocess.run(["file", "-b", path], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return done.stdout.strip()

def main():
    root, real_path, lab_path, target = sys.argv[1:5]
    real = open(real_path, "rb").read()
    lab = open(lab_path, "rb").read()
    fixture = {"tcpdump": "4.99.4", "libpcap": "1.10.4", "cases": []}
    with tempfile.TemporaryDirectory() as scratch:
        for name, data, option_sets in cases(real, lab):
            path = os.path.join(scratch, "capture.pcap")
            open(path, "wb").write(data)
            fixture["cases"].append({
                "name": name, "hex": data.hex(), "file": classified(path), "runs": [run(root, path, options) for options in option_sets],
            })
    json.dump(fixture, open(target, "w"), separators=(",", ":"))

main()
