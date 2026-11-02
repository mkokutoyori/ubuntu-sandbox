#!/usr/bin/env python3
"""Record tcpdump 4.99.4 printing the capture files of the simulator's two labs.

usage: record_tcpdump_options.py TOOLS_ROOT CAPTURE_DIR out.json

CAPTURE_DIR holds base.json and dns.json, written by tcpdump-options-record.test.ts (TCPDUMP_RECORD_DIR=CAPTURE_DIR). Each frame of a
capture file carries the bytes it put on the wire; they are written here into a classic pcap file and printed by the real tcpdump with
every option set below, in UTC and with the user lookup disabled (-Z root). The fixture stores the capture file itself beside the
outputs, so the replay test feeds the same frames to the simulator's tcpdump and compares the whole text.
"""
import json, os, struct, subprocess, sys, tempfile
from datetime import datetime

OPTION_SETS = [
    "-nn", "-tttt", "-vvv", "-XX", "-nn -tttt -vvv -XX", "-X", "-e -nn -vvv", "-q -nn", "-nn -ttt", "-nn -tt", "-nn -S -vv",
    "-A -nn", "-AA -nn", "-A -nn -vvv", "-A -nn -x", "-A -nn -q",
    "-qq -nn", "-q -nn -v", "-nn -c 5 -s 60", "-nn -e -q", "-nn -N", "-nn -O", "-nn -vv", "-nn -t", "-nn -tttt -S", "-qq -nn -v", "-nn -e -q -v", "-nn -v -vv",
]
EXTRA_OPTION_SETS = {"stpcraft": ["-nn -vv -s 60", "-nn -vv -s 70", "-nn -s 100 -x", "-nn -e -vv -s 45", "-nn -vv -s 30 -A"]}
LABS = ["base", "dns", "rip", "ospf", "cdp", "lldp", "stp", "rstp", "pvst", "mstp", "stppair", "rstppair", "stpcraft", "eigrp"]

def stp_bridge(priority, last):
    return struct.pack(">H", priority) + bytes([2, 0, 0, 0, 0, last])

def stp_config(version, kind, flags=0, root=8192, bridge=32769, cost=19, port=0x8001, ages=(512, 5120, 512, 3840), protocol=0):
    return (struct.pack(">HBBB", protocol, version, kind, flags) + stp_bridge(root, 1) + struct.pack(">I", cost)
            + stp_bridge(bridge, 2) + struct.pack(">H", port) + b"".join(struct.pack(">H", a) for a in ages))

def stp_mstp(msti_count, v1_length=0):
    body = bytes([0]) + b"REGION-" + bytes(25) + struct.pack(">H", 7) + bytes(range(16)) + struct.pack(">I", 5) + stp_bridge(4096, 3) + bytes([19])
    mstis = b"".join(bytes([0x3c]) + stp_bridge(4096 * (i + 1) + i + 1, 9) + struct.pack(">I", 20000 * (i + 1)) + bytes([0x20 * (i + 1), 0x80, 18 - i]) for i in range(msti_count))
    version3 = body + mstis
    return stp_config(3, 2, 0x4e)[:35] + bytes([v1_length]) + struct.pack(">H", len(version3)) + version3

def stp_spb():
    extension = (bytes([2]) + b"AUX" + bytes(29) + struct.pack(">H", 3) + bytes(range(16, 32)) + bytes([0xb4, 0, 0x21, 0x32])
                 + struct.pack(">H", 9) + bytes(8) + bytes(range(40, 60)))
    packet = bytearray(stp_mstp(1) + struct.pack(">H", len(extension)) + extension)
    packet[2] = 4
    return bytes(packet)

def stp_frame(second, payload, destination="01:80:c2:00:00:00"):
    mac = lambda text: bytes(int(part, 16) for part in text.split(":"))
    body = bytes([0x42, 0x42, 0x03]) + payload
    raw = mac(destination) + mac("02:00:00:00:00:aa") + struct.pack(">H", len(body)) + body
    raw += bytes(max(0, 60 - len(raw)))
    return {"at": "2026-11-02T09:00:%02d.000Z" % second, "atMicros": 1793610000000000 + second * 1000000, "iface": "eth0", "direction": "in", "linkType": "EN10MB",
            "srcMac": "02:00:00:00:00:aa", "dstMac": destination, "etherType": 0x4242, "l3": "stp", "l4": "none", "length": len(raw), "raw": list(raw), "rawLinkOffset": 17}

def craft_stp_capture(template):
    cases = [
        stp_config(0, 0), stp_config(0, 0, 0x01), stp_config(0, 0, 0x80)[:30], bytes([0, 0, 0, 0x80]), bytes([0, 0]),
        stp_config(2, 2, 0x7c)[:35], stp_config(2, 2, 0x5a, ages=(0, 0, 0, 0)) + bytes([0]), stp_config(2, 2, 0x3e, ages=(64, 640, 192, 960)) + bytes([0]),
        stp_config(0, 5), stp_config(0, 2), stp_config(5, 0), stp_config(0, 0, protocol=1), stp_config(0, 0xff),
        stp_mstp(0), stp_mstp(2), stp_mstp(0)[:100], stp_mstp(0, v1_length=1), stp_mstp(2)[:120], stp_spb(), stp_spb()[:120], stp_config(4, 2),
        stp_config(0, 0, 0xff, ages=(1, 32, 96, 160)),
    ]
    frames = [stp_frame(index, payload) for index, payload in enumerate(cases)]
    for index, cut in enumerate([37, 41, 45, 52, 60]):
        frame = stp_frame(len(cases) + index, cases[[0, 6, 14, 14, 18][index]])
        whole = len(frame["raw"])
        frame.update(raw=frame["raw"][:cut], truncated=True, length=whole)
        frames.append(frame)
    return dict(template, frames=frames)

def pcap(frames):
    out = bytearray(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, 1))
    for frame in frames:
        at = datetime.fromisoformat(frame["at"].replace("Z", "+00:00"))
        micros = frame.get("atMicros")
        micros = at.microsecond if micros is None else micros % 1_000_000
        raw = bytes(frame["raw"])
        out += struct.pack("<IIII", int(at.timestamp()), micros, len(raw), frame["length"] if frame.get("truncated") else len(raw)) + raw
    return bytes(out)

def run(root, path, options):
    env = dict(os.environ, TZ="UTC", LD_LIBRARY_PATH=os.path.join(root, "usr/lib/x86_64-linux-gnu"))
    command = [os.path.join(root, "usr/bin/tcpdump"), "-Z", "root"] + options.split() + ["-r", path]
    return subprocess.run(command, env=env, capture_output=True, text=True).stdout

def main():
    root, directory, target = sys.argv[1:4]
    fixture = {"tcpdump": "4.99.4", "libpcap": "1.10.4", "labs": {}}
    for lab in LABS:
        capture = craft_stp_capture(json.load(open(os.path.join(directory, "stp.json")))) if lab == "stpcraft" else json.load(open(os.path.join(directory, lab + ".json")))
        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "capture.pcap")
            open(path, "wb").write(pcap(capture["frames"]))
            outputs = {options: run(root, path, options) for options in OPTION_SETS + EXTRA_OPTION_SETS.get(lab, [])}
        fixture["labs"][lab] = {"capture": capture, "outputs": outputs}
    json.dump(fixture, open(target, "w"), separators=(",", ":"))

main()
