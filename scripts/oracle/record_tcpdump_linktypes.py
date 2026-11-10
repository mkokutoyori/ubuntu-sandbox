#!/usr/bin/env python3
"""Record the real tcpdump 4.99.4 reading savefiles of the BSD loopback, OpenBSD loopback and raw IP link types.

usage: record_tcpdump_linktypes.py out.json

The packets are built here (IPv4 TCP SYN, ICMP echo, UDP DNS, a TCP segment with data, IPv6 ICMPv6 echo) and wrapped in the link
headers of NULL (host-order family, read by tcpdump with the byte-order heuristic of print-null.c), LOOP (network-order family), RAW
(none), and, for the filter errors that depend on the link type, Linux cooked v1. Each file is read with several option sets and filters;
stdout and stderr come back in the order the tool wrote them (stdbuf -o0), in UTC. The -w cases keep the bytes the real tool writes.
"""
import json, os, struct, subprocess, sys, tempfile

def csum(b):
    if len(b) % 2: b += b"\0"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b)); s = (s >> 16) + (s & 0xffff); s += s >> 16
    return (~s) & 0xffff

def ip4(proto, payload, src=(10, 0, 0, 1), dst=(10, 0, 0, 2), ident=0x1234, ttl=64):
    head = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), ident, 0x4000, ttl, proto, 0, bytes(src), bytes(dst))
    return head[:10] + struct.pack("!H", csum(head)) + head[12:] + payload

def tcp(sport, dport, flags=0x02, seq=1000, ack=0, data=b"", src=(10, 0, 0, 1), dst=(10, 0, 0, 2)):
    options = struct.pack("!BBHBBBBBBBB", 2, 4, 1460, 4, 2, 1, 3, 3, 7, 0, 0)[:12] if flags == 0x02 else b""
    head = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, ((20 + len(options)) // 4) << 4, flags, 64240, 0, 0) + options
    pseudo = bytes(src) + bytes(dst) + struct.pack("!BBH", 0, 6, len(head) + len(data))
    return head[:16] + struct.pack("!H", csum(pseudo + head + data)) + head[18:] + data

def udp(sport, dport, data, src=(10, 0, 0, 1), dst=(10, 0, 0, 2)):
    length = 8 + len(data); head = struct.pack("!HHHH", sport, dport, length, 0)
    pseudo = bytes(src) + bytes(dst) + struct.pack("!BBH", 0, 17, length)
    return struct.pack("!HHHH", sport, dport, length, csum(pseudo + head + data) or 0xffff) + data

def icmp_echo(seq=1):
    body = struct.pack("!BBHHH", 8, 0, 0, 0x4321, seq) + b"abcdefgh"
    return body[:2] + struct.pack("!H", csum(body)) + body[4:]

SRC6 = bytes.fromhex("fd000001000000000000000000000001")
DST6 = bytes.fromhex("fd000001000000000000000000000002")

def ip6(next_header, payload):
    return struct.pack("!IHBB16s16s", 0x60000000, len(payload), next_header, 64, SRC6, DST6) + payload

def icmp6_echo():
    body = struct.pack("!BBHHH", 128, 0, 0, 0x1111, 1) + b"12345678"
    pseudo = SRC6 + DST6 + struct.pack("!IBBBB", len(body), 0, 0, 0, 58)
    return body[:2] + struct.pack("!H", csum(pseudo + body)) + body[4:]

DNS = struct.pack("!HHHHHH", 0xbeef, 0x0100, 1, 0, 0, 0) + b"\x03www\x07example\x03com\x00" + struct.pack("!HH", 1, 1)
V4 = [ip4(6, tcp(1234, 80)), ip4(1, icmp_echo()), ip4(17, udp(5353, 53, DNS)),
      ip4(6, tcp(1234, 80, 0x18, 1001, 5000, b"GET / HTTP/1.0\r\n\r\n"))]
V6 = ip6(58, icmp6_echo())

def savefile(linktype, packets, big=False, snaplen=262144):
    order = ">" if big else "<"
    out = struct.pack(order + "IHHiIII", 0xa1b2c3d4, 2, 4, 0, 0, snaplen, linktype)
    for at, data in enumerate(packets):
        out += struct.pack(order + "IIII", 1700000000 + at, 100000 * at, len(data), len(data)) + data
    return out

def with_lengths(linktype, records):
    out = struct.pack("<IHHiIII", 0xa1b2c3d4, 2, 4, 0, 0, 262144, linktype)
    for at, (caplen, length, data) in enumerate(records):
        out += struct.pack("<IIII", 1700000000 + at, 100000 * at, caplen, length) + data
    return out

def null(family, payload, order="<"): return struct.pack(order + "I", family) + payload

def cases():
    families6 = (24, 28, 30)
    yield "raw", savefile(101, V4 + [V6]), None
    yield "null", savefile(0, [null(2, p) for p in V4] + [null(f, V6) for f in families6]), None
    yield "loop", savefile(108, [null(2, p, ">") for p in V4] + [null(f, V6, ">") for f in families6]), None
    yield "null-big-endian-file", savefile(0, [null(2, p, ">") for p in V4], big=True), None
    yield "null-unknown-families", savefile(0, [null(10, V4[0]), null(99, V4[0]), null(0, V4[0]), null(2, V4[0])]), None
    yield "loop-unknown-families", savefile(108, [null(10, V4[0], ">"), null(99, V4[0], ">"), null(2, V4[0], ">")]), None
    yield "raw-unknown-versions", savefile(101, [V4[0], b"\x00" + V4[0][1:], b"\x30" + V4[0][1:], V6]), None
    yield "null-cut-in-the-family", savefile(0, [b"\x02\x00", V4[0]]) , None
    yield "loop-cut-in-the-family", savefile(108, [b"\x00\x00", null(2, V4[0], ">")]), None
    damaged = [(0, 60, b""), (10, 0, V4[0][:10]), (10, 5, V4[0][:10]), (0, 0, b""), (len(V4[1]), len(V4[1]), V4[1])]
    yield "invalid-headers-raw", with_lengths(101, damaged), None
    yield "invalid-headers-ethernet", with_lengths(1, damaged), None
    sll = lambda p: struct.pack("!HHH", 0, 1, 6) + bytes.fromhex("001122334455") + b"\0\0" + struct.pack("!H", 0x0800) + p
    yield "cooked-v1", savefile(113, [sll(V4[0]), sll(V4[1])]), None

PRINT = ["-nn", "-nn -e", "-nn -q", "-nn -q -e", "-nn -v", "-nn -x", "-nn -xx", "-nn -X", "-nn -XX", "-nn -A", "-nn -t", "-nn -tt", "-nn -c 2", "-nn -s 40"]
FILTERS = ["ip", "ip6", "tcp port 80", "tcp and not port 22", "icmp", "udp", "host 10.0.0.1", "len > 50", "ip[0] = 0x45", "proto 1",
           "arp", "vlan", "vlan 5", "ether host 00:11:22:33:44:55", "ether src 00:11:22:33:44:55", "ether dst 00:11:22:33:44:55", "ether broadcast",
           "ether multicast", "broadcast", "multicast", "ip multicast", "ether proto 0x800", "not arp", "arp or ip", "ip6 or arp"]

def option_sets(name):
    sets = [(flags, "") for flags in PRINT]
    if name in ("raw", "null", "loop", "cooked-v1"):
        sets += [("-nn", expression) for expression in FILTERS] + [("-nn -e", expression) for expression in ("ip", "ip6", "tcp")]
    return sets

def run(path, flags, expression):
    env = dict(os.environ, TZ="UTC")
    command = ["stdbuf", "-o0", "tcpdump", "-Z", "root"] + flags.split() + ["-r", path] + expression.split()
    done = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return {"flags": flags, "expression": expression, "status": done.returncode, "output": done.stdout}

def main():
    target = sys.argv[1]
    fixture = {"tcpdump": "4.99.4", "libpcap": "1.10.4", "cases": []}
    with tempfile.TemporaryDirectory() as scratch:
        for name, data, _ in cases():
            path = os.path.join(scratch, "capture.pcap")
            open(path, "wb").write(data)
            runs = [run(path, flags, expression) for flags, expression in option_sets(name)]
            written = None
            if name in ("raw", "null", "loop"):
                out = os.path.join(scratch, "out.pcap")
                subprocess.run(["tcpdump", "-Z", "root", "-nn", "-r", path, "-c", "3", "-w", out], env=dict(os.environ, TZ="UTC"),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                written = open(out, "rb").read().hex()
            fixture["cases"].append({"name": name, "hex": data.hex(), "runs": runs, "written": written})
    json.dump(fixture, open(target, "w"), indent=1)

main()
