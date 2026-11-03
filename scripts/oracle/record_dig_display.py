#!/usr/bin/env python3
"""Record what a real dig 9.18 prints, option by option, for replies whose content is fixed.

usage: record_dig_display.py out.json

A thread answers on 127.0.0.1:5353 with three crafted replies chosen by the name asked: www.example.org (CNAME + A, two NS, two glue addresses, an OPT record), absent.example.org (NXDOMAIN, SOA in the
authority section, OPT) and nodata.example.org (NOERROR, no answer, SOA, OPT). The same bytes are stored in the fixture, so that the replay decodes the reply the real dig decoded and compares what is
printed, not what a server happens to answer. Every combination of OPTIONS is run against every name; the output of dig is kept verbatim (stdout, then stderr).
"""
import json, socket, struct, subprocess, sys, threading

PORT = 5353
NAMES = {"www.example.org": "full", "absent.example.org": "nxdomain", "nodata.example.org": "nodata"}
OPTIONS = [
    [], ["+noall"], ["+all"], ["+noall", "+answer"], ["+noall", "+comments"], ["+noall", "+comments", "+answer"], ["+noall", "+authority"],
    ["+noall", "+additional"], ["+noall", "+question"], ["+noall", "+stats"], ["+noall", "+cmd"], ["+noall", "+answer", "+authority", "+additional"],
    ["+noall", "+comments", "+answer", "+authority", "+additional"], ["+nocomments"], ["+noanswer"], ["+noquestion"], ["+nostats"], ["+nocmd"],
    ["+nocmd", "+noall", "+answer"], ["+all", "+noanswer"], ["+noall", "+answer", "+stats"], ["+noall", "+question", "+answer"],
    ["+nocomments", "+nostats", "+nocmd"], ["+noall", "+answer", "+noanswer"], ["+noall", "+cmd", "+answer"], ["+noall", "+comments", "+stats"],
    ["+noall", "+question", "+comments"], ["+short"], ["+short", "+noall"], ["+noauthority"], ["+noadditional"], ["+nocomments", "+noquestion"],
    ["+noedns"], ["+noall", "+answer", "+noedns"], ["-t", "MX"], ["+noall", "+short"], ["+short", "+authority"], ["+short", "+comments"], ["+short", "+stats"],
    ["+short", "+answer"],
]
SILENT_PORT = 5354
CLOSED_PORT = 5355
FAILURES = [
    ("timeout", SILENT_PORT, []), ("timeout", SILENT_PORT, ["+short"]), ("timeout", SILENT_PORT, ["+nocmd"]), ("timeout", SILENT_PORT, ["+tries=2"]),
    ("refused", CLOSED_PORT, []), ("refused", CLOSED_PORT, ["+short"]), ("refused", CLOSED_PORT, ["+tries=2"])
]
ALIGNED = ["a.example.org", "mid-size.example.org", "longer-name-for-alignment.example.org"]


def label(name):
    out = b""
    for part in name.strip(".").split("."):
        out += bytes([len(part)]) + part.encode()
    return out + b"\0"


def record(name, rtype, ttl, rdata):
    return label(name) + struct.pack(">HHIH", rtype, 1, ttl, len(rdata)) + rdata


SOA = label("ns1.example.org") + label("hostmaster.example.org") + struct.pack(">IIIII", 2026110301, 7200, 900, 1209600, 300)
OPT = b"\0" + struct.pack(">HHIH", 41, 1232, 0, 0)


def shape_body(shape):
    if shape == "full":
        return (0x8580, 2, 2, 3,
                record("www.example.org", 5, 300, label("web.example.org")) + record("web.example.org", 1, 300, bytes([192, 0, 2, 7])),
                record("example.org", 2, 3600, label("ns1.example.org")) + record("example.org", 2, 3600, label("ns2.example.org")),
                record("ns1.example.org", 1, 3600, bytes([192, 0, 2, 53])) + record("ns2.example.org", 1, 3600, bytes([192, 0, 2, 54])) + OPT)
    if shape == "nxdomain":
        return (0x8583, 0, 1, 1, b"", record("example.org", 6, 300, SOA), OPT)
    return (0x8580, 0, 1, 1, b"", record("example.org", 6, 300, SOA), OPT)


def reply_for(query):
    end = 12
    while query[end] != 0:
        end += query[end] + 1
    end += 5
    question = query[12:end]
    shape = "full"
    for known, kind in NAMES.items():
        if known.split(".")[0].encode() in question:
            shape = kind
    flags, ancount, nscount, arcount, answers, authorities, additionals = shape_body(shape)
    header = query[:2] + struct.pack(">HHHHH", flags, 1, ancount, nscount, arcount)
    return shape, header + question + answers + authorities + additionals


def serve(shapes):
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", PORT))
    while True:
        data, peer = server.recvfrom(512)
        shape, answer = reply_for(data)
        shapes[shape] = answer[2:].hex()
        server.sendto(answer, peer)


def stay_silent():
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.bind(("127.0.0.1", SILENT_PORT))
    while True:
        server.recvfrom(512)


def main():
    out = sys.argv[1]
    shapes = {}
    threading.Thread(target=serve, args=(shapes,), daemon=True).start()
    threading.Thread(target=stay_silent, daemon=True).start()
    version = subprocess.run(["dig", "-v"], capture_output=True, text=True)
    cases = []
    for name in list(NAMES) + ALIGNED:
        for options in OPTIONS if name in NAMES else [[], ["+noall", "+question", "+answer"]]:
            run = subprocess.run(["dig", "@127.0.0.1", "-p", str(PORT), name, *options, "+tries=1", "+time=2"], capture_output=True, text=True)
            cases.append({"name": name, "options": options, "output": run.stdout, "errors": run.stderr})
    failures = []
    for kind, port, options in FAILURES:
        run = subprocess.run(["dig", "@127.0.0.1", "-p", str(port), "example.org", *options, "+time=1"], capture_output=True, text=True)
        failures.append({"kind": kind, "port": port, "options": options, "output": run.stderr + run.stdout, "status": run.returncode})
    with open(out, "w") as handle:
        json.dump({"dig": (version.stdout + version.stderr).strip(), "shapes": shapes, "cases": cases, "failures": failures}, handle, indent=1)
    print(len(cases), "cases", len(failures), "failures", sorted(shapes))


if __name__ == "__main__":
    main()
