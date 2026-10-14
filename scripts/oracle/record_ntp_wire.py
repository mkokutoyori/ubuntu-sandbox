#!/usr/bin/env python3
"""Record chronyd 4.5 (Ubuntu 24.04) as an NTP server and as an NTP client.

usage: record_ntp_wire.py NTP_ROOT out.json

NTP_ROOT holds the extracted chrony and ntpsec debs.  The server part sends crafted requests to a real chronyd bound on loopback
and stores request and reply bytes; the client part runs chronyd -Q against a stub that records the datagrams chronyd emits.
Timestamps differ from run to run, so the fixture stores bytes and the replay test compares fields, never the whole datagram.
"""
import hashlib, json, os, socket, struct, subprocess, sys, tempfile, time

ERA = 2208988800

def start(root, conf, port, run):
    path = os.path.join(run, "c.conf")
    open(path, "w").write(conf + "\nuser root\nport %d\nbindcmdaddress 127.0.0.1\ncmdport 0\nbindaddress 127.0.0.1\n" % port)
    p = subprocess.Popen([root + "/usr/sbin/chronyd", "-x", "-d", "-f", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu"))
    time.sleep(1.2)
    return p

def header(first, stratum=0, poll=0, org=b"\0" * 8, xmt=None):
    pkt = bytearray(48)
    pkt[0], pkt[1], pkt[2] = first, stratum, poll
    pkt[24:32] = org
    struct.pack_into("!II", pkt, 40, int(time.time()) + ERA, 0xdeadbeef) if xmt is None else pkt.__setitem__(slice(40, 48), xmt)
    return bytes(pkt)

def exchange(data, port, wait=0.8):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(wait)
    s.sendto(data, ("127.0.0.1", port))
    try:
        reply, _ = s.recvfrom(2048)
        return reply.hex()
    except Exception:
        return None

def signed(first, key, algo, secret):
    pkt = header(first)
    return pkt + struct.pack("!I", key) + hashlib.new(algo, secret + pkt).digest()

def server_cases(root, run):
    cases = []
    def record(name, config, requests, port=12300, extra=None):
        p = start(root, config, port, run)
        try:
            for label, data, wait in requests:
                cases.append({"case": name + ":" + label, "config": config, "request": data.hex(), "reply": exchange(data, port, wait), **(extra or {})})
        finally:
            p.terminate(); p.wait()
    mode = lambda v, m, li=0: (li << 6) | (v << 3) | m
    plain = []
    for v in (0, 1, 2, 3, 4, 5):
        plain.append(("v%d-client" % v, header(mode(v, 3)), 0.6))
    for m in (0, 1, 2, 3, 4, 5, 6, 7):
        plain.append(("v4-mode%d" % m, header(mode(4, m)), 0.6))
    for m in (0, 1, 3):
        plain.append(("v3-mode%d" % m, header(mode(3, m)), 0.6))
    plain += [("li3", header(mode(4, 3, 3)), 0.6), ("poll17", header(mode(4, 3), poll=17), 0.6), ("poll3", header(mode(4, 3), poll=3), 0.6),
              ("poll250", header(mode(4, 3), poll=250), 0.6), ("stratum-in", header(mode(4, 3), stratum=5), 0.6),
              ("len49", header(mode(4, 3)) + b"\0", 0.6), ("len-keyid-only", header(mode(4, 3)) + b"\0\0\0\1", 0.6),
              ("mac-unknown-key-md5", header(mode(4, 3)) + b"\0\0\0\1" + b"\x11" * 16, 0.6), ("mac-unknown-key-sha1", header(mode(4, 3)) + b"\0\0\0\1" + b"\x11" * 20, 0.6),
              ("ext-field", header(mode(4, 3)) + struct.pack("!HH", 0x0104, 28) + b"\0" * 24, 0.6), ("len-short-47", header(mode(4, 3))[:47], 0.6),
              ("org-nonzero", header(mode(4, 3), org=b"\x11" * 8), 0.6), ("xmt-zero", header(mode(4, 3), xmt=b"\0" * 8), 0.6)]
    record("local5", "local stratum 5\nallow", plain)
    record("unsync", "allow", [("v4", header(mode(4, 3)), 0.8), ("v3", header(mode(3, 3)), 0.8)], extra=None)
    record("local1", "local stratum 1\nallow", [("v4", header(mode(4, 3)), 0.8)])
    record("local0", "local stratum 0\nallow", [("v4", header(mode(4, 3)), 0.8)])
    keys = os.path.join(run, "keys")
    open(keys, "w").write("1 MD5 secretsecret\n2 SHA1 HEX:0123456789abcdef0123456789abcdef01234567\n3 SHA256 ASCII:abc\n4 SHA512 ASCII:abc\n5 SHA384 ASCII:abc\n6 SHA224 ASCII:abc\n7 MD5 HEX:00112233445566778899aabbccddeeff\n")
    auth = [("md5-ok", signed(mode(4, 3), 1, "md5", b"secretsecret"), 0.8), ("md5-bad", signed(mode(4, 3), 1, "md5", b"wrongsecret"), 0.6),
            ("unknown-key", signed(mode(4, 3), 9, "md5", b"x"), 0.6), ("sha1-ok", signed(mode(4, 3), 2, "sha1", bytes.fromhex("0123456789abcdef0123456789abcdef01234567")), 0.8),
            ("sha256-ok", signed(mode(4, 3), 3, "sha256", b"abc"), 0.8), ("sha512-ok", signed(mode(4, 3), 4, "sha512", b"abc"), 0.8),
            ("sha384-ok", signed(mode(4, 3), 5, "sha384", b"abc"), 0.8), ("sha224-ok", signed(mode(4, 3), 6, "sha224", b"abc"), 0.8),
            ("md5-hexkey-ok", signed(mode(4, 3), 7, "md5", bytes.fromhex("00112233445566778899aabbccddeeff")), 0.8),
            ("plain-with-keys", header(mode(4, 3)), 0.6), ("v3-md5-ok", signed(mode(3, 3), 1, "md5", b"secretsecret"), 0.8)]
    record("keys", "local stratum 5\nallow\nkeyfile " + keys, auth, extra={"keys": open(keys).read()})
    record("deny", "local stratum 5\nallow\ndeny 127.0.0.1", [("v4", header(mode(4, 3)), 0.6)])
    record("allow-other", "local stratum 5\nallow 10.0.0.0/8", [("v4", header(mode(4, 3)), 0.6)])
    record("ratelimit", "local stratum 5\nallow\nratelimit interval 1 burst 2 leak 1", [("burst%d" % i, header(mode(4, 3)), 0.3) for i in range(14)])
    record("ratelimit-kod", "local stratum 5\nallow\nratelimit interval 1 burst 2 leak 2 kod", [("burst%d" % i, header(mode(4, 3)), 0.3) for i in range(24)])
    return cases

def client_cases(root, run):
    out = []
    for label, conf in (("plain", "server 127.0.0.1 port 12301 minpoll 0 maxpoll 0"), ("iburst", "server 127.0.0.1 port 12301 iburst minpoll 0 maxpoll 0"),
                        ("version3", "server 127.0.0.1 port 12301 version 3 minpoll 0 maxpoll 0"), ("polltwo", "server 127.0.0.1 port 12301 minpoll 2 maxpoll 4"),
                        ("peer", "peer 127.0.0.1 port 12301 minpoll 0 maxpoll 0")):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.1", 12301)); s.settimeout(0.3)
        path = os.path.join(run, "client.conf")
        open(path, "w").write(conf + "\nuser root\nbindcmdaddress 127.0.0.1\ncmdport 0\nport 0\n")
        p = subprocess.Popen([root + "/usr/sbin/chronyd", "-Q", "-x", "-d", "-f", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu"))
        seen = []
        t0 = time.time()
        while time.time() - t0 < 9 and p.poll() is None:
            try:
                data, addr = s.recvfrom(2048)
            except Exception:
                continue
            seen.append({"at": round(time.time() - t0, 2), "bytes": data.hex()})
        p.terminate(); p.wait(); s.close()
        out.append({"case": "chronyd-client:" + label, "config": conf, "packets": seen})
    return out

def main():
    root, target = sys.argv[1], sys.argv[2]
    with tempfile.TemporaryDirectory() as run:
        cases = server_cases(root, run) + client_cases(root, run)
    json.dump({"tool": "chronyd 4.5", "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
