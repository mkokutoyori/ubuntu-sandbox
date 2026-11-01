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
LABS = ["base", "dns", "rip"]

def pcap(frames):
    out = bytearray(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, 1))
    for frame in frames:
        at = datetime.fromisoformat(frame["at"].replace("Z", "+00:00"))
        micros = frame.get("atMicros")
        micros = at.microsecond if micros is None else micros % 1_000_000
        raw = bytes(frame["raw"])
        out += struct.pack("<IIII", int(at.timestamp()), micros, len(raw), len(raw)) + raw
    return bytes(out)

def run(root, path, options):
    env = dict(os.environ, TZ="UTC", LD_LIBRARY_PATH=os.path.join(root, "usr/lib/x86_64-linux-gnu"))
    command = [os.path.join(root, "usr/bin/tcpdump"), "-Z", "root"] + options.split() + ["-r", path]
    return subprocess.run(command, env=env, capture_output=True, text=True).stdout

def main():
    root, directory, target = sys.argv[1:4]
    fixture = {"tcpdump": "4.99.4", "libpcap": "1.10.4", "labs": {}}
    for lab in LABS:
        capture = json.load(open(os.path.join(directory, lab + ".json")))
        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "capture.pcap")
            open(path, "wb").write(pcap(capture["frames"]))
            outputs = {options: run(root, path, options) for options in OPTION_SETS}
        fixture["labs"][lab] = {"capture": capture, "outputs": outputs}
    json.dump(fixture, open(target, "w"), separators=(",", ":"))

main()
