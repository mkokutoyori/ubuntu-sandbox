#!/usr/bin/env python3
"""Record tcpdump 4.99.4 printing NTP datagrams.

usage: record_tcpdump_ntp.py TOOLS_ROOT out.json

The datagrams are built here (real chronyd replies taken from the ntp-chrony fixture, plus crafted ones for every mode, kiss code,
crypto-NAK, MAC length and extension field), written to a pcap file and printed by the real tcpdump with several verbosity levels.
The fixture stores each datagram once with the output of every option set, so the replay test feeds the same bytes to the simulator.
"""
import json, os, struct, subprocess, sys, tempfile

OPTIONS = [["-nn"], ["-nn", "-q"], ["-nn", "-v"], ["-nn", "-vv"], ["-nn", "-vvv"], ["-nn", "-tt"]]
ERA = 2208988800

def ts(sec, frac):
    return struct.pack("!II", int(sec) + ERA, frac)

def header(li=0, vn=4, mode=3, stratum=0, poll=0, prec=-20, rdelay=0, rdisp=0, ref=b"\0\0\0\0", reft=b"\0" * 8, org=b"\0" * 8, rec=b"\0" * 8, xmt=b"\0" * 8):
    return struct.pack("!BBBb", (li << 6) | (vn << 3) | mode, stratum, poll, prec) + struct.pack("!II", rdelay, rdisp) + ref + reft + org + rec + xmt

def ip_checksum(data):
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 0xffff) + (total >> 16)
    return (~total) & 0xffff

def frame(payload, src="10.0.0.2", dst="10.0.0.1", sport=123, dport=123, when=(1760000000, 123456)):
    udp_len = 8 + len(payload)
    ip_src = bytes(int(x) for x in src.split("."))
    ip_dst = bytes(int(x) for x in dst.split("."))
    pseudo = ip_src + ip_dst + struct.pack("!BBH", 0, 17, udp_len)
    udp = struct.pack("!HHHH", sport, dport, udp_len, 0)
    cksum = ip_checksum(pseudo + udp + payload) or 0xffff
    udp = struct.pack("!HHHH", sport, dport, udp_len, cksum)
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + udp_len, 0x1234, 0x4000, 64, 17, 0, ip_src, ip_dst)
    ip = ip[:10] + struct.pack("!H", ip_checksum(ip)) + ip[12:]
    eth = bytes.fromhex("525400000002") + bytes.fromhex("525400000001") + struct.pack("!H", 0x0800)
    data = eth + ip + udp + payload
    return struct.pack("<IIII", when[0], when[1], len(data), len(data)) + data

def datagrams(chrony):
    base = 1760000000
    out = []
    def add(name, payload, **kw):
        out.append((name, payload, kw))
    t = ts(base, 0x80000000)
    add("client-v4-unsync", header(li=3, mode=3, xmt=t))
    add("client-v4", header(mode=3, poll=6, prec=-23, xmt=t, ref=b"\0\0\0\0"))
    add("client-v3", header(vn=3, mode=3, poll=6, xmt=t))
    add("client-v2", header(vn=2, mode=3, poll=6, xmt=t))
    add("client-v1", header(vn=1, mode=3, poll=6, xmt=t))
    add("server-v4-stratum2", header(mode=4, stratum=2, poll=6, prec=-20, rdelay=0x00000a3d, rdisp=0x0000147a, ref=bytes([192, 0, 2, 1]), reft=ts(base - 30, 0x1000), org=t, rec=ts(base, 0x80000100), xmt=ts(base, 0x80000200)), sport=123, dport=123)
    add("server-v4-stratum1-gps", header(mode=4, stratum=1, poll=10, prec=-24, ref=b"GPS\0", reft=ts(base - 1, 5), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-v4-stratum1-locl", header(mode=4, stratum=1, poll=6, ref=b"LOCL", reft=ts(base - 1, 5), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-v4-stratum8-local", header(mode=4, stratum=8, poll=6, ref=bytes([127, 127, 1, 1]), reft=ts(base - 1, 5), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-kiss-rate", header(li=3, mode=4, stratum=0, poll=6, ref=b"RATE", org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-kiss-deny", header(li=3, mode=4, stratum=0, poll=6, ref=b"DENY", org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-kiss-init", header(li=3, mode=4, stratum=0, poll=6, ref=b"INIT", org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-leap-insert", header(li=1, mode=4, stratum=2, ref=bytes([10, 1, 1, 1]), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-leap-delete", header(li=2, mode=4, stratum=2, ref=bytes([10, 1, 1, 1]), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-poll17-prec-neg", header(mode=4, stratum=3, poll=17, prec=-32, ref=bytes([10, 1, 1, 2]), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("server-bigroot", header(mode=4, stratum=3, poll=6, rdelay=0x0003ffff, rdisp=0xfffffff0, ref=bytes([10, 1, 1, 2]), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    add("symmetric-active", header(mode=1, stratum=3, poll=6, ref=bytes([10, 0, 0, 7]), reft=ts(base - 60, 1), org=t, rec=ts(base, 2), xmt=ts(base, 3)))
    add("symmetric-passive", header(mode=2, stratum=3, poll=6, ref=bytes([10, 0, 0, 7]), reft=ts(base - 60, 1), org=t, rec=ts(base, 2), xmt=ts(base, 3)))
    add("broadcast", header(mode=5, stratum=2, poll=6, ref=bytes([10, 0, 0, 7]), reft=ts(base - 60, 1), xmt=ts(base, 3)), dst="255.255.255.255")
    add("broadcast-multicast", header(mode=5, stratum=2, poll=6, ref=bytes([10, 0, 0, 7]), reft=ts(base - 60, 1), xmt=ts(base, 3)), dst="224.0.1.1")
    add("mode0", header(mode=0, xmt=t))
    add("mode7-private", header(mode=7, xmt=t))
    add("with-md5", header(mode=3, xmt=t) + struct.pack("!I", 1) + bytes(range(16)))
    add("with-sha1", header(mode=3, xmt=t) + struct.pack("!I", 2) + bytes(range(20)))
    add("crypto-nak", header(mode=4, stratum=2, ref=bytes([10, 0, 0, 7]), org=t, rec=ts(base, 9), xmt=ts(base, 99)) + struct.pack("!I", 0))
    add("keyid-only", header(mode=3, xmt=t) + struct.pack("!I", 5))
    add("extension-field", header(mode=3, xmt=t) + struct.pack("!HH", 0x0104, 32) + bytes(28))
    add("extension-and-mac", header(mode=3, xmt=t) + struct.pack("!HH", 0x0104, 32) + bytes(28) + struct.pack("!I", 3) + bytes(range(16)))
    add("trailing-garbage", header(mode=3, xmt=t) + b"\x01\x02\x03")
    add("truncated-40", header(mode=3, xmt=t)[:40])
    add("truncated-20", header(mode=3, xmt=t)[:20])
    add("control-mode6", struct.pack("!BBHHHHH", (2 << 3) | 6, 0x02, 0x1234, 0x0000, 0, 0, 0))
    add("control-mode6-response", struct.pack("!BBHHHHH", (2 << 3) | 6, 0x82, 0x1234, 0x0618, 0, 0, 5) + b"abcde\0\0\0")
    for poll in (-1, -5, -30, -31, -32, -33, -64, 1, 2, 3, 10, 30, 31, 32, 33, 60, 100, 127, -128):
        add("poll%d" % poll, header(mode=3, poll=poll & 0xff if poll < 0 else poll, xmt=t))
    for st in (2, 15, 16, 17, 100, 255):
        add("stratum%d" % st, header(mode=4, stratum=st, ref=bytes([10, 1, 2, 3]), org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    for label, ref in (("ascii", b"ABCD"), ("short", b"AB\0\0"), ("nonprint", b"\x01\xffAB"), ("space", b"A B "), ("nul-first", b"\0ABC")):
        add("s1-ref-" + label, header(mode=4, stratum=1, ref=ref, org=t, rec=ts(base, 9), xmt=ts(base, 99)))
        add("s0-ref-" + label, header(mode=4, stratum=0, ref=ref, org=t, rec=ts(base, 9), xmt=ts(base, 99)))
    for prec in (0, 1, -1, -127, 127, -128):
        add("prec%d" % prec, header(mode=3, prec=prec, xmt=t))
    for label, org, rec, xmt in (("delta-zero", ts(base, 5), ts(base, 5), ts(base, 5)), ("delta-over-1s", ts(base, 5), ts(base + 3, 7), ts(base + 70000, 8)),
                                 ("delta-negative-big", ts(base + 50, 5), ts(base, 7), ts(base - 100000, 8)), ("delta-frac-borrow", ts(base, 0xf0000000), ts(base + 1, 0x10000000), ts(base + 2, 0x0fffffff)),
                                 ("ts-1900", struct.pack("!II", 5, 7), struct.pack("!II", 6, 9), struct.pack("!II", 100, 0)), ("ts-max", struct.pack("!II", 0xffffffff, 0xffffffff), struct.pack("!II", 0xffffffff, 0), struct.pack("!II", 0x7fffffff, 1)),
                                 ("ts-era1", struct.pack("!II", 0x1000, 3), struct.pack("!II", 0x2000, 4), struct.pack("!II", 0x3000, 5)), ("ts-1970", struct.pack("!II", 2208988800, 0), struct.pack("!II", 2208988801, 0), struct.pack("!II", 2208988802, 77)),
                                 ("ts-2033", struct.pack("!II", 2208988800 + 2000000000, 1), struct.pack("!II", 2208988800 + 2000000001, 2), struct.pack("!II", 2208988800 + 2000000002, 3))):
        add(label, header(mode=4, stratum=2, ref=bytes([10, 1, 2, 3]), reft=org, org=org, rec=rec, xmt=xmt))
    for v in (0, 5, 6, 7):
        add("version%d-client" % v, header(vn=v, mode=3, xmt=t))
    for m in range(0, 8):
        add("v3-mode%d" % m, header(vn=3, mode=m, xmt=t))
        add("v2-mode%d" % m, header(vn=2, mode=m, xmt=t))
    add("org-set-rec-zero", header(mode=4, stratum=2, ref=bytes([10, 1, 2, 3]), org=t, rec=b"\0" * 8, xmt=ts(base, 99)))
    add("org-zero-rec-set", header(mode=4, stratum=2, ref=bytes([10, 1, 2, 3]), rec=ts(base, 9), xmt=ts(base, 99)))
    add("org-set-all-zero", header(mode=4, stratum=2, ref=bytes([10, 1, 2, 3]), org=t))
    add("mac-long", header(mode=3, xmt=t) + struct.pack("!I", 9) + bytes(range(32)))
    add("mac-odd", header(mode=3, xmt=t) + struct.pack("!I", 9) + bytes(range(7)))
    add("ext-2", header(mode=3, xmt=t) + struct.pack("!HH", 0x0104, 16) + bytes(12) + struct.pack("!HH", 0x0204, 32) + bytes(28))
    add("ext-bad-len", header(mode=3, xmt=t) + struct.pack("!HH", 0x0104, 4000) + bytes(28))
    add("control-v3-error", struct.pack("!BBHHHHH", (3 << 3) | 6, 0xc1, 7, 0x0800, 0, 0, 0))
    add("control-more", struct.pack("!BBHHHHH", (2 << 3) | 6, 0xa2, 7, 0x0618, 7, 100, 4) + b"abcd")
    add("control-short", struct.pack("!BBHHH", (2 << 3) | 6, 0x02, 7, 0, 0))
    add("control-opcodes", b"".join([]) + struct.pack("!BBHHHHH", (2 << 3) | 6, 0x01, 1, 0, 0, 0, 0))
    add("control-opcode-7", struct.pack("!BBHHHHH", (2 << 3) | 6, 0x07, 1, 0, 0, 0, 0))
    add("control-opcode-31", struct.pack("!BBHHHHH", (2 << 3) | 6, 0x1f, 1, 0, 0, 0, 0))
    add("private-mode7-impl", struct.pack("!BBBB", (2 << 3) | 7, 0, 3, 42) + bytes(40))
    for name, payload in chrony:
        add("chrony-" + name, payload, src="127.0.0.1", dst="127.0.0.1", sport=123 if name.endswith("reply") else 40000, dport=40000 if name.endswith("reply") else 123)
    return out

def main():
    root, target = sys.argv[1], sys.argv[2]
    chrony_fixture = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "__tests__", "support", "oracle", "ntp-chrony-4.5.json")))
    chrony = []
    for c in chrony_fixture["cases"]:
        if c.get("reply") and c["case"] in ("local5:v4-client", "unsync:v4", "local1:v4", "keys:md5-ok", "keys:sha1-ok", "local5:v1-client", "local5:v3-client"):
            chrony.append((c["case"].replace(":", "-") + "-reply", bytes.fromhex(c["reply"])))
            chrony.append((c["case"].replace(":", "-") + "-request", bytes.fromhex(c["request"])))
    cases = []
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ="UTC", LC_ALL="C")
    for name, payload, kw in datagrams(chrony):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "x.pcap")
            with open(path, "wb") as f:
                f.write(struct.pack("<IHHiIII", 0xa1b2c3d4, 2, 4, 0, 0, 262144, 1))
                f.write(frame(payload, **kw))
            outputs = {}
            for opts in OPTIONS:
                r = subprocess.run([root + "/usr/bin/tcpdump", "-Z", "root", *opts, "-r", path], capture_output=True, env=env)
                outputs[" ".join(opts)] = r.stdout.decode(errors="replace") + (("\nSTDERR:" + r.stderr.decode(errors="replace")) if r.stderr and b"reading from file" not in r.stderr[:20] else "")
        cases.append({"name": name, "payload": payload.hex(), "src": kw.get("src", "10.0.0.2"), "dst": kw.get("dst", "10.0.0.1"),
                      "sport": kw.get("sport", 123), "dport": kw.get("dport", 123), "outputs": outputs})
    json.dump({"tool": "tcpdump 4.99.4 / libpcap 1.10.4", "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
