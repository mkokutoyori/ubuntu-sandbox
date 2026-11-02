#!/usr/bin/env python3
"""Record tcpreplay 4.4.4 (Ubuntu build, libpcap 1.10.4) replaying savefiles onto a veth pair.

usage: record_tcpreplay.py SAMPLE_DIR out.json

SAMPLE_DIR holds dns.pcap, rip.pcap and base.pcap, savefiles of the simulator's labs (tcpdump-options-record.test.ts). The other
captures are built here, byte by byte: four frames (ARP, ICMP echo, UDP, ICMP echo) spaced 0.2, 0.3 and 0.5 s apart; a snapshot
shorter than the frames; a Linux cooked capture; an empty one; a frame larger than the MTU; a file that is no capture; a truncated header;
timestamps going backwards; the nanosecond magic.

Every case runs in a fresh network namespace (unshare -n) with two veth pairs, veth0-veth1 and veth2-veth3, `stdbuf -o0` so that stdout
and stderr come back in the order the tool wrote them. The frames that reach the far end of the pair are captured by the real tcpdump
and stored as hex, so the replay test can compare the bytes the simulator puts on its wire with the bytes the tool put on the veth.
"""
import base64, json, os, shlex, shutil, struct, subprocess, sys, tempfile

SETUP = ("ip link set lo up; ip link add veth0 type veth peer name veth1; ip link add veth2 type veth peer name veth3; "
         "for i in veth0 veth1 veth2 veth3; do ip link set $i up; done; ")
T = 1793610000


def savefile(frames, snaplen=262144, linktype=1, magic=0xA1B2C3D4):
    out = struct.pack("<IHHiIII", magic, 2, 4, 0, 0, snaplen, linktype)
    for sec, frac, data, whole in frames:
        out += struct.pack("<IIII", sec, frac, len(data), whole or len(data)) + data
    return out


def mac(text):
    return bytes(int(part, 16) for part in text.split(":"))


def ethernet(dst, src, ethertype, payload):
    return mac(dst) + mac(src) + struct.pack(">H", ethertype) + payload


def checksum(data):
    total = sum(struct.unpack(">%dH" % (len(data) // 2), data))
    total = (total & 0xFFFF) + (total >> 16)
    total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def ipv4(src, dst, proto, payload, ident=1):
    header = struct.pack(">BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), ident, 0x4000, 64, proto, 0, bytes(src), bytes(dst))
    return header[:10] + struct.pack(">H", checksum(header)) + header[12:] + payload


def udp(sport, dport, data):
    return struct.pack(">HHHH", sport, dport, 8 + len(data), 0) + data


def echo(kind, ident, seq):
    body = struct.pack(">BBHHH", kind, 0, 0, ident, seq) + b"abcdefgh"
    return body[:2] + struct.pack(">H", checksum(body)) + body[4:]


def tcp(sport, dport, flags=0x02):
    return struct.pack(">HHIIBBHHH", sport, dport, 1, 0, 0x50, flags, 8192, 0, 0)


def flowmix():
    a, b = [10, 0, 0, 1], [10, 0, 0, 2]
    ma, mb = "02:00:00:00:00:01", "02:00:00:00:00:02"
    v6 = bytes([0x60, 0, 0, 0, 0, 8, 17, 64]) + bytes(15) + bytes([1]) + bytes([0xFE, 0x80]) + bytes(13) + bytes([2]) + struct.pack(">HHHH", 5000, 53, 8, 0)
    v6hop = bytes([0x60, 0, 0, 0, 0, 16, 0, 64]) + bytes(15) + bytes([1]) + bytes([0xFE, 0x80]) + bytes(13) + bytes([2]) + bytes([17, 0, 0, 0, 0, 0, 0, 0]) + struct.pack(">HHHH", 5000, 53, 8, 0)
    ip_with_options = bytearray(ipv4(a, b, 17, b"\x00" * 4 + udp(5000, 53, b"x"), ident=9))
    ip_with_options[0] = 0x46
    mpls = struct.pack(">I", (100 << 12) | 0x100 | 64) + ipv4(a, b, 17, udp(5000, 53, b"x"))
    vlan = struct.pack(">HH", 100, 0x0800) + ipv4(a, b, 6, tcp(1234, 80))
    qinq = struct.pack(">HH", 200, 0x8100) + struct.pack(">HH", 100, 0x0800) + ipv4(a, b, 17, udp(5000, 53, b"x"))
    llc = ipv4(a, b, 17, udp(5000, 53, b"x"))
    frames = [
        (T, 0, ethernet(mb, ma, 0x0800, ipv4(a, b, 6, tcp(1234, 80, 0x02))), 0),
        (T, 100000, ethernet(mb, ma, 0x0800, ipv4(a, b, 6, tcp(1234, 80, 0x10), ident=2)), 0),
        (T, 200000, ethernet(ma, mb, 0x0800, ipv4(b, a, 6, tcp(80, 1234, 0x12), ident=3)), 0),
        (T, 300000, ethernet(mb, ma, 0x0800, ipv4(a, b, 17, udp(5000, 53, b"query"), ident=4)), 0),
        (T + 3, 0, ethernet(mb, ma, 0x0800, ipv4(a, b, 17, udp(5000, 53, b"again"), ident=5)), 0),
        (T + 3, 100000, ethernet(mb, ma, 0x0800, ipv4(a, b, 1, echo(8, 1, 1) + b"0123456789abcdef"[:12], ident=6)), 0),
        (T + 3, 200000, ethernet(mb, ma, 0x0800, ipv4(a, b, 1, echo(8, 1, 2), ident=7)), 0),
        (T + 3, 300000, ethernet(mb, ma, 0x0800, bytes(ip_with_options)), 0),
        (T + 4, 0, ethernet(mb, ma, 0x8100, vlan), 0),
        (T + 4, 100000, ethernet(mb, ma, 0x88A8, qinq), 0),
        (T + 4, 200000, ethernet(mb, ma, 0x8847, mpls), 0),
        (T + 5, 0, ethernet(mb, ma, 0x86DD, v6), 0),
        (T + 5, 100000, ethernet("60:00:00:00:00:02", ma, 0x86DD, v6), 0),
        (T + 5, 200000, ethernet("60:00:00:00:00:02", ma, 0x86DD, v6hop), 0),
        (T + 5, 300000, ethernet("ff:ff:ff:ff:ff:ff", ma, 0x0806, struct.pack(">HHBBH", 1, 0x800, 6, 4, 1) + mac(ma) + bytes(a) + bytes(6) + bytes(b)), 0),
        (T + 6, 0, ethernet(mb, ma, 0x0800, bytes([0x55]) + bytes(40)), 0),
        (T + 6, 100000, ethernet(mb, ma, 0x0030, llc), 0),
        (T + 6, 200000, ethernet(mb, ma, 0x0800, ipv4(a, b, 132, bytes(12), ident=8)), 0),
        (T + 6, 300000, ethernet(mb, ma, 0x0800, ipv4(a, b, 6, tcp(1234, 80)[:8], ident=10)), 0),
        (T + 7, 0, ethernet(mb, ma, 0x0800, ipv4(a, b, 17, b"", ident=11)[:12]), 0),
    ]
    return savefile(frames)


def crafted():
    a, b = [10, 0, 0, 1], [10, 0, 0, 2]
    ma, mb = "02:00:00:00:00:01", "02:00:00:00:00:02"
    arp = ethernet("ff:ff:ff:ff:ff:ff", ma, 0x0806, struct.pack(">HHBBH", 1, 0x800, 6, 4, 1) + mac(ma) + bytes(a) + bytes(6) + bytes(b))
    echo1 = ethernet(mb, ma, 0x0800, ipv4(a, b, 1, echo(8, 1, 1)))
    datagram = ethernet(mb, ma, 0x0800, ipv4(a, b, 17, udp(40000, 9000, b"hello udp"), ident=2))
    echo2 = ethernet(mb, ma, 0x0800, ipv4(a, b, 1, echo(8, 1, 2), ident=3))
    tiny = savefile([(T, 0, arp, 0), (T, 200000, echo1, 0), (T, 500000, datagram, 0), (T + 1, 0, echo2, 0)])
    cooked = struct.pack(">HHH", 0, 1, 6) + mac(ma) + b"\0\0" + struct.pack(">H", 0x0800) + echo1[14:]
    return {
        "tiny.pcap": tiny,
        "snap40.pcap": savefile([(T, 0, echo1, 0), (T, 100000, datagram[:40], len(datagram))], snaplen=40),
        "sll.pcap": savefile([(T, 0, cooked, 0)], linktype=113),
        "empty.pcap": savefile([]),
        "jumbo.pcap": savefile([(T, 0, ethernet(mb, ma, 0x0800, ipv4(a, b, 17, udp(1, 2, b"x" * 1900))), 0)]),
        "junk.bin": b"this is not a capture file\n",
        "trunc.pcap": tiny[:60],
        "backwards.pcap": savefile([(T + 2, 0, echo1, 0), (T + 1, 0, datagram, 0), (T + 3, 0, echo2, 0)]),
        "nano.pcap": savefile([(T, 0, echo1, 0), (T, 5000, echo2, 0)], magic=0xA1B23C4D),
        "slow.pcap": savefile([(T, 0, echo1, 0), (T + 3, 0, echo2, 0)]),
        "ipv6.pcap": savefile([(T, 0, ethernet("33:33:00:00:00:01", ma, 0x86DD, bytes([0x60, 0, 0, 0, 0, 8, 58, 255]) + bytes(15) + bytes([1]) + bytes([0xFF, 2]) + bytes(13) + bytes([1]) + bytes([128, 0, 0, 0, 0, 0, 0, 0])), 0)]),
        "other.pcap": savefile([(T, 0, ethernet("ff:ff:ff:ff:ff:ff", ma, 0x88CC, bytes(30)), 0)]),
        "short.pcap": savefile([(T, 0, echo1[:20], len(echo1))]),
        "answers.txt": b"2\n1\n",
        "flowmix.pcap": flowmix(),
        "good.rc": b"intf1 veth0\nloop = 3\ntopspeed\n",
        "colon.rc": b"intf1: veth0\ntimer \"gtod\"\ntopspeed\n",
        "mix.rc": b"# comment\n\nintf1 = veth0\nquiet\n",
        "bogus.rc": b"bogus 3\nintf1 veth0\n",
        "badnum.rc": b"loop abc\n",
        "ppsonly.rc": b"pps 5\n",
        "dup.rc": b"loop 2\nloop 3\n",
    }


CASES = []


def case(name, args, files=None, pre="", user=None, stdin=None, wire=True, folders=None, generated=None):
    CASES.append({"name": name, "args": args, "files": files or [], "pre": pre, "user": user, "stdin": stdin, "wire": wire, "folders": folders or {}, "generated": generated or []})


def corpus():
    i = "-i veth0 "
    case("version", "-V")
    case("version-long", "--version")
    case("version-with-other-arguments", "-i veth0 --version tiny.pcap", ["tiny.pcap"])
    case("less-help", "-h")
    case("extended-help", "-H")
    case("no-arguments", "")
    case("no-interface", "tiny.pcap", ["tiny.pcap"])
    case("no-file", "-i veth0")
    case("unknown-interface", "-i veth9 tiny.pcap", ["tiny.pcap"])
    case("missing-file", i + "nofile.pcap")
    case("not-a-capture", i + "junk.bin", ["junk.bin"])
    case("empty-capture", i + "empty.pcap", ["empty.pcap"])
    case("truncated-header", i + "trunc.pcap", ["trunc.pcap"])
    case("illegal-option", i + "-z tiny.pcap", ["tiny.pcap"])
    case("illegal-long-option", i + "--nosuchopt tiny.pcap", ["tiny.pcap"])
    case("ambiguous-option", i + "--lo=3 -t tiny.pcap", ["tiny.pcap"])
    case("abbreviated-option", i + "--topsp tiny.pcap", ["tiny.pcap"])
    case("missing-argument", "-i")
    case("argument-refused", i + "--quiet=3 tiny.pcap", ["tiny.pcap"])
    case("not-a-number", i + "--dbug tiny.pcap", ["tiny.pcap"])
    case("maxsleep-not-a-number", i + "--maxsleep=x tiny.pcap", ["tiny.pcap"])
    case("interface-twice", "-i veth0 -i veth2 -t tiny.pcap", ["tiny.pcap"])
    case("dbug-out-of-range", i + "--dbug=9 tiny.pcap", ["tiny.pcap"])
    case("loop-negative", i + "-l -1 tiny.pcap", ["tiny.pcap"])
    case("limit-zero", i + "-L 0 tiny.pcap", ["tiny.pcap"])
    case("duration-zero", i + "--duration=0 tiny.pcap", ["tiny.pcap"])
    case("loopdelay-without-loop", i + "--loopdelay-ms=5 tiny.pcap", ["tiny.pcap"])
    case("multiplier-and-topspeed", i + "-x 2 -t tiny.pcap", ["tiny.pcap"])
    case("pps-and-mbps", i + "-p 5 -M 1 tiny.pcap", ["tiny.pcap"])
    case("oneatatime-and-topspeed", i + "-o -t tiny.pcap", ["tiny.pcap"])
    case("decode-without-verbose", i + "-A -x tiny.pcap", ["tiny.pcap"])
    case("dualfile-without-intf2", i + "-2 tiny.pcap tiny.pcap", ["tiny.pcap"])
    case("cachefile-without-intf2", i + "-c cache tiny.pcap", ["tiny.pcap"])
    case("intf2-alone", i + "-I veth2 tiny.pcap", ["tiny.pcap"])
    case("pps-multi-without-pps", i + "-t --pps-multi=3 tiny.pcap", ["tiny.pcap"])
    case("unique-ip-without-loop", i + "-t --unique-ip tiny.pcap", ["tiny.pcap"])
    case("unique-ip-loops-small", i + "-t -l 2 --unique-ip --unique-ip-loops=0.5 tiny.pcap", ["tiny.pcap"])
    case("flow-expiry-and-no-flow-stats", i + "-t --no-flow-stats --flow-expiry=2 tiny.pcap", ["tiny.pcap"])
    case("pps-zero", i + "-p 0 tiny.pcap", ["tiny.pcap"])
    case("pps-not-a-number", i + "-p abc tiny.pcap", ["tiny.pcap"])
    case("timer-unknown", i + "-T bogus tiny.pcap", ["tiny.pcap"])
    case("timer-abstime", i + "-T abstime tiny.pcap", ["tiny.pcap"])
    case("timer-ioport", i + "-T ioport tiny.pcap", ["tiny.pcap"])
    case("terminal-end-of-options", i + "-- -t tiny.pcap", ["tiny.pcap"])
    case("topspeed", i + "-t tiny.pcap", ["tiny.pcap"], wire=True)
    case("topspeed-quiet", i + "-t -q tiny.pcap", ["tiny.pcap"])
    case("clustered-flags", i + "-tq tiny.pcap", ["tiny.pcap"])
    case("attached-value", "-iveth0 -l2 -t tiny.pcap", ["tiny.pcap"], wire=True)
    case("long-option-equals", "--intf1=veth0 --topspeed tiny.pcap", ["tiny.pcap"])
    case("original-speed", i + "tiny.pcap", ["tiny.pcap"], wire=True)
    case("original-speed-slow", i + "slow.pcap", ["slow.pcap"])
    case("multiplier-2", i + "-x 2 tiny.pcap", ["tiny.pcap"])
    case("multiplier-half", i + "-x 0.5 tiny.pcap", ["tiny.pcap"])
    case("multiplier-zero", i + "-x 0 tiny.pcap", ["tiny.pcap"])
    case("multiplier-not-a-number", i + "-x abc tiny.pcap", ["tiny.pcap"])
    case("pps-10", i + "-p 10 tiny.pcap", ["tiny.pcap"])
    case("pps-2-multi-2", i + "-p 2 --pps-multi=2 tiny.pcap", ["tiny.pcap"])
    case("mbps-small", i + "-M 0.001 tiny.pcap", ["tiny.pcap"])
    case("mbps-zero", i + "-M 0 tiny.pcap", ["tiny.pcap"])
    case("maxsleep", i + "--maxsleep=100 slow.pcap", ["slow.pcap"])
    case("timer-gtod", i + "-T gtod tiny.pcap", ["tiny.pcap"])
    case("timer-nano", i + "-T nano tiny.pcap", ["tiny.pcap"])
    case("timer-select", i + "-T select tiny.pcap", ["tiny.pcap"])
    case("loop-2", i + "-t -l 2 tiny.pcap", ["tiny.pcap"])
    case("loop-3-delay", i + "-t -l 3 --loopdelay-ms=50 tiny.pcap", ["tiny.pcap"])
    case("loop-with-stats-0", i + "-t -l 2 --stats=0 tiny.pcap", ["tiny.pcap"])
    case("stats-0", i + "-t --stats=0 tiny.pcap", ["tiny.pcap"])
    case("stats-1-slow", i + "--stats=1 slow.pcap", ["slow.pcap"])
    case("limit", i + "-t -L 2 tiny.pcap", ["tiny.pcap"], wire=True)
    case("limit-over-loops", i + "-t -L 6 -l 3 tiny.pcap", ["tiny.pcap"])
    case("duration", i + "--duration=1 -l 5 tiny.pcap", ["tiny.pcap"])
    case("preload", i + "-t -K tiny.pcap", ["tiny.pcap"])
    case("preload-loop", i + "-t -K -l 3 tiny.pcap", ["tiny.pcap"])
    case("preload-quiet", i + "-t -K -q tiny.pcap", ["tiny.pcap"])
    case("two-files", i + "-t tiny.pcap tiny.pcap", ["tiny.pcap"])
    case("two-different-files", i + "-t tiny.pcap ipv6.pcap", ["tiny.pcap", "ipv6.pcap"], wire=True)
    case("snapshot-shorter", i + "snap40.pcap", ["snap40.pcap"])
    case("cooked-capture", i + "-t sll.pcap", ["sll.pcap"])
    case("larger-than-mtu", i + "-t jumbo.pcap", ["jumbo.pcap"])
    case("larger-than-mtu-then-others", i + "-t jumbo.pcap tiny.pcap", ["jumbo.pcap", "tiny.pcap"])
    case("backwards-timestamps", i + "backwards.pcap", ["backwards.pcap"])
    case("nanosecond-capture", i + "-t nano.pcap", ["nano.pcap"])
    case("short-frame", i + "-t short.pcap", ["short.pcap"])
    case("pktlen", i + "--pktlen -t snap40.pcap", ["snap40.pcap"], wire=True)
    case("flows-ipv6-and-others", i + "-t tiny.pcap ipv6.pcap other.pcap", ["tiny.pcap", "ipv6.pcap", "other.pcap"])
    case("no-flow-stats", i + "-t --no-flow-stats tiny.pcap", ["tiny.pcap"])
    case("flow-expiry", i + "-t --flow-expiry=2 tiny.pcap", ["tiny.pcap"])
    case("flow-expiry-slow-loop", i + "-t -l 2 --flow-expiry=1 slow.pcap", ["slow.pcap"])
    case("unique-ip", i + "-t -l 3 --unique-ip tiny.pcap", ["tiny.pcap"], wire=True)
    case("unique-ip-loops", i + "-t -l 4 --unique-ip --unique-ip-loops=2 tiny.pcap", ["tiny.pcap"])
    case("unique-ip-preload", i + "-t -K -l 3 --unique-ip tiny.pcap", ["tiny.pcap"], wire=True)
    case("directory", i + "-t dir", ["tiny.pcap", "snap40.pcap"], folders={"dir": ["tiny.pcap", "snap40.pcap"]})
    case("directory-with-text", i + "-t dirx", ["tiny.pcap"], folders={"dirx": ["tiny.pcap", "junk.bin"]})
    case("stdin", i + "-t -", ["tiny.pcap"], stdin="tiny.pcap")
    case("pid", i + "-t -P tiny.pcap", ["tiny.pcap"])
    case("dbug-1", i + "-t -d 1 tiny.pcap", ["tiny.pcap"])
    case("loopback", "-i lo -t tiny.pcap", ["tiny.pcap"])
    case("listnics", "--listnics")
    case("interface-down", i + "-t tiny.pcap", ["tiny.pcap"], pre="ip link set veth0 down")
    case("peer-down", i + "-t tiny.pcap", ["tiny.pcap"], pre="ip link set veth1 down")
    case("not-root", i + "-t tiny.pcap", ["tiny.pcap"], user="nobody")
    case("verbose", i + "-t -v tiny.pcap", ["tiny.pcap"])
    case("verbose-decode", i + "-t -v -A '-nn -e' tiny.pcap", ["tiny.pcap"])
    case("verbose-loop", i + "-t -v -l 2 snap40.pcap", ["snap40.pcap"])
    case("dual-interfaces-without-cache", "-i veth0 -I veth2 -2 tiny.pcap tiny.pcap", ["tiny.pcap"], wire=True)
    case("dual-odd-files", "-i veth0 -I veth2 -2 tiny.pcap tiny.pcap tiny.pcap", ["tiny.pcap"])
    case("dual-one-file", "-i veth0 -I veth2 -2 tiny.pcap", ["tiny.pcap"])
    case("dual-cache-and-dual", "-i veth0 -I veth2 -2 -c cache tiny.pcap tiny.pcap", ["tiny.pcap"])
    case("oneatatime", i + "-o tiny.pcap", ["tiny.pcap"], stdin="")
    case("dns-capture", i + "-p 3000 dns.pcap", ["dns.pcap"])
    case("rip-capture", i + "-p 3000 rip.pcap", ["rip.pcap"])
    case("base-capture", i + "-p 3000 base.pcap", ["base.pcap"])
    case("base-capture-original-speed", i + "-x 100 base.pcap", ["base.pcap"])
    case("dual-different-files", "-i veth0 -I veth2 -2 -p 3000 dns.pcap rip.pcap", ["dns.pcap", "rip.pcap"])
    case("dual-loop", "-i veth0 -I veth2 -2 -t -l 2 tiny.pcap tiny.pcap", ["tiny.pcap"])
    prep = "tcpprep %s -i dns.pcap -o c.cache"
    for mode in ("--auto=first", "--auto=client", "--auto=server", "--auto=bridge", "--port"):
        case("cache-" + mode.lstrip("-").replace("=", "-"), "-i veth0 -I veth2 -p 3000 -c c.cache dns.pcap", ["dns.pcap"], pre=prep % mode, generated=["c.cache"])
    case("cache-rip", "-i veth0 -I veth2 -t -c c.cache rip.pcap", ["rip.pcap"], pre="tcpprep --auto=first -i rip.pcap -o c.cache", generated=["c.cache"])
    case("cache-shorter-than-capture", "-i veth0 -I veth2 -p 3000 -c c.cache dns.pcap", ["dns.pcap", "tiny.pcap"], pre="tcpprep --auto=first -i tiny.pcap -o c.cache", generated=["c.cache"])
    case("cache-with-loop", "-i veth0 -I veth2 -t -l 2 -c c.cache tiny.pcap", ["tiny.pcap"], pre="tcpprep --auto=first -i tiny.pcap -o c.cache", generated=["c.cache"])
    case("cache-not-a-cache", "-i veth0 -I veth2 -t -c junk.bin tiny.pcap", ["junk.bin", "tiny.pcap"])
    case("cache-missing", "-i veth0 -I veth2 -t -c nofile.cache tiny.pcap", ["tiny.pcap"])
    case("cache-cut", "-i veth0 -I veth2 -t -c cut.cache tiny.pcap", ["tiny.pcap"], pre="tcpprep --auto=first -i tiny.pcap -o c.cache; head -c 25 c.cache > cut.cache", generated=["cut.cache"])
    case("cache-header-only", "-i veth0 -I veth2 -t -c cut.cache tiny.pcap", ["tiny.pcap"], pre="tcpprep --auto=first -i tiny.pcap -o c.cache; head -c 24 c.cache > cut.cache", generated=["cut.cache"])
    case("cache-and-quiet-preload", "-i veth0 -I veth2 -t -K -c c.cache tiny.pcap", ["tiny.pcap"], pre="tcpprep --auto=first -i tiny.pcap -o c.cache", generated=["c.cache"])
    case("oneatatime-input", i + "-o tiny.pcap", ["tiny.pcap", "answers.txt"], stdin="answers.txt")
    case("more-help", "--more-help")
    case("sigint-free-infinite-with-limit", i + "-t -l 0 -L 6 tiny.pcap", ["tiny.pcap"])
    case("loop-zero-duration", i + "-l 0 --duration=1 tiny.pcap", ["tiny.pcap"])
    case("flows-mix", i + "-t flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-expiry", i + "-t --flow-expiry=1 flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-expiry-loop", i + "-t -l 3 --flow-expiry=1 flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-preload", i + "-t -K flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-preload-loop", i + "-t -K -l 3 flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-unique-ip", i + "-t -l 3 --unique-ip flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-unique-ip-preload", i + "-t -K -l 3 --unique-ip flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-unique-loops", i + "-t -l 5 --unique-ip --unique-ip-loops=2 flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-two-files", i + "-t flowmix.pcap flowmix.pcap", ["flowmix.pcap"])
    case("flows-mix-dual", "-i veth0 -I veth2 -2 -t flowmix.pcap flowmix.pcap", ["flowmix.pcap"])
    case("save-opts", "-i veth0 -t -l 3 -x 2.5 --loopdelay-ms=4 --save-opts=out.rc", generated=["out.rc"])
    case("save-opts-strings", "-i veth0 -T nano -v -A nn --maxsleep=7 -P --save-opts=out.rc", generated=["out.rc"])
    case("save-opts-nothing-else", "--save-opts=out.rc", generated=["out.rc"])
    case("load-opts", "--load-opts=good.rc tiny.pcap", ["good.rc", "tiny.pcap"])
    case("load-opts-colon", "--load-opts=colon.rc -t tiny.pcap", ["colon.rc", "tiny.pcap"])
    case("load-opts-comments", "--load-opts=mix.rc -t tiny.pcap", ["mix.rc", "tiny.pcap"])
    case("load-opts-unknown-name", "--load-opts=bogus.rc -t tiny.pcap", ["bogus.rc", "tiny.pcap"])
    case("load-opts-bad-number", "--load-opts=badnum.rc -i veth0 -t tiny.pcap", ["badnum.rc", "tiny.pcap"])
    case("load-opts-conflict-with-command-line", "--load-opts=ppsonly.rc -i veth0 -t tiny.pcap", ["ppsonly.rc", "tiny.pcap"])
    case("load-opts-missing", "--load-opts=nofile.rc -i veth0 -t tiny.pcap", ["tiny.pcap"])
    case("load-opts-after-option", "-i veth0 --load-opts=dup.rc -t tiny.pcap", ["dup.rc", "tiny.pcap"])


def run(case, files, scratch):
    work = tempfile.mkdtemp(dir=scratch)
    os.chmod(work, 0o777)
    for name in case["files"]:
        open(os.path.join(work, name), "wb").write(files[name])
    for folder, members in case["folders"].items():
        os.makedirs(os.path.join(work, folder), exist_ok=True)
        for member in members:
            open(os.path.join(work, folder, member), "wb").write(files[member])
    peer = os.path.join(work, "peer.pcap")
    command = case["args"]
    runner = "stdbuf -o0 tcpreplay " + command + " 2>&1; echo \"STATUS:$?\""
    if case["user"]:
        runner = "su -s /bin/sh " + case["user"] + " -c " + shlex.quote("stdbuf -o0 tcpreplay " + command + " 2>&1; echo STATUS:$?")
    script = SETUP + (case["pre"] + "; " if case["pre"] else "")
    if case["wire"]:
        script += ("tcpdump -i veth1 -nn -U --immediate-mode -w peer.pcap >/dev/null 2>td.err & TD=$!; "
                   "tcpdump -i veth3 -nn -U --immediate-mode -w peer2.pcap >/dev/null 2>td2.err & TD2=$!; "
                   "until { grep -q listening td.err || ! kill -0 $TD 2>/dev/null; } && { grep -q listening td2.err || ! kill -0 $TD2 2>/dev/null; }; do sleep 0.02; done; ")
    stdin_name = case["stdin"]
    if stdin_name is not None and stdin_name != "":
        script += "(" + runner + ") < " + stdin_name + "; "
    elif stdin_name == "":
        script += "(" + runner + ") < /dev/null; "
    else:
        script += runner + "; "
    if case["wire"]:
        script += "sleep 0.3; kill $TD $TD2 2>/dev/null; wait $TD $TD2 2>/dev/null; "
    done = subprocess.run(["unshare", "-n", "sh", "-c", script], cwd=work, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    text = done.stdout.decode("latin-1")
    body, _, status = text.rpartition("STATUS:")
    entry = {"name": case["name"], "args": case["args"], "files": case["files"], "folders": case["folders"], "pre": case["pre"], "user": case["user"],
             "stdin": case["stdin"], "status": int(status.split()[0]), "output": body}
    if case["generated"]:
        entry["generated"] = {name: base64.b64encode(open(os.path.join(work, name), "rb").read()).decode() for name in case["generated"]}
    if case["wire"] and os.path.exists(peer):
        entry["peer"] = [frame.hex() for frame in frames_of(open(peer, "rb").read())]
        entry["peer2"] = [frame.hex() for frame in frames_of(open(os.path.join(work, "peer2.pcap"), "rb").read())]
    shutil.rmtree(work, ignore_errors=True)
    return entry


def frames_of(data):
    at, out = 24, []
    while at + 16 <= len(data):
        caplen = struct.unpack("<I", data[at + 8:at + 12])[0]
        out.append(data[at + 16:at + 16 + caplen])
        at += 16 + caplen
    return out


def main():
    sample, target = sys.argv[1:3]
    files = crafted()
    for name in ("dns.pcap", "rip.pcap", "base.pcap"):
        files[name] = open(os.path.join(sample, name), "rb").read()
    corpus()
    with tempfile.TemporaryDirectory() as scratch:
        recorded = [run(c, files, scratch) for c in CASES]
    fixture = {"tcpreplay": "4.4.4", "libpcap": "1.10.4", "files": {name: base64.b64encode(data).decode() for name, data in files.items()}, "cases": recorded}
    json.dump(fixture, open(target, "w"), separators=(",", ":"))


main()
