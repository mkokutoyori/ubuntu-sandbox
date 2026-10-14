#!/usr/bin/env python3
"""Record chrony 4.5's command and monitoring protocol (cmdmon, UDP/323) on the wire.

usage: record_chrony_cmdmon.py NTP_ROOT out.json

chronyd runs as in record_chronyc_live.py (stub stratum 2 server, -x) with its command socket on 127.0.0.1:12302.  A logging UDP
proxy sits between the real chronyc and chronyd so that every request and reply datagram is captured as hex together with the text
chronyc prints.  Raw probes (bad version, short packet, unknown command, wrong packet type, a request shorter than its reply) are sent
by this script and their replies, or their absence, are recorded.
"""
import json, os, socket, struct, subprocess, sys, tempfile, threading, time

ERA = 2208988800
OFFSET_MS = 12.5
STUB = ("127.0.0.2", 12399)
CMD_PORT = 12302
PROXY_PORT = 12303

def ntp_time(t):
    return struct.pack("!II", int(t) + ERA, int((t % 1) * (1 << 32)))

def stub(stop):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(STUB); s.settimeout(0.2)
    while not stop.is_set():
        try:
            data, addr = s.recvfrom(2048)
        except Exception:
            continue
        rx = time.time() + OFFSET_MS / 1000
        reply = bytearray(48)
        reply[0] = (0 << 6) | (4 << 3) | 4
        reply[1], reply[2], reply[3] = 2, data[2], 0xEC
        struct.pack_into("!I", reply, 4, 0x00000A00)
        struct.pack_into("!I", reply, 8, 0x00000800)
        reply[12:16] = bytes([192, 0, 2, 9])
        reply[16:24] = ntp_time(rx - 30)
        reply[24:32] = data[40:48]
        reply[32:40] = ntp_time(rx)
        reply[40:48] = ntp_time(time.time() + OFFSET_MS / 1000)
        s.sendto(bytes(reply), addr)

LOG = []
def proxy(stop):
    front = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    front.bind(("127.0.0.1", PROXY_PORT)); front.settimeout(0.2)
    back = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    back.bind(("127.0.0.1", 0)); back.settimeout(0.3)
    while not stop.is_set():
        try:
            data, addr = front.recvfrom(4096)
        except Exception:
            continue
        entry = {"request": data.hex(), "replies": []}
        LOG.append(entry)
        back.sendto(data, ("127.0.0.1", CMD_PORT))
        try:
            while True:
                reply, _ = back.recvfrom(4096)
                entry["replies"].append(reply.hex())
                front.sendto(reply, addr)
                break
        except Exception:
            pass

def start(root, conf, run, port):
    path = os.path.join(run, "c.conf")
    open(path, "w").write(conf + "\nuser root\nport %d\ncmdport %d\nbindcmdaddress 127.0.0.1\nbindaddress 127.0.0.1\npidfile %s/c.pid\ndumpdir %s\nlogdir %s\n" % (port, CMD_PORT, run, run, run))
    return subprocess.Popen([root + "/usr/sbin/chronyd", "-x", "-d", "-f", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu"))

def chronyc(root, args):
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", LC_ALL="C", TZ="UTC")
    before = len(LOG)
    r = subprocess.run([root + "/usr/bin/chronyc", "-h", "127.0.0.1", "-p", str(PROXY_PORT), *args], capture_output=True, env=env, timeout=30, stdin=subprocess.DEVNULL)
    return {"args": args, "stdout": r.stdout.decode(errors="replace"), "stderr": r.stderr.decode(errors="replace"), "code": r.returncode, "exchanges": LOG[before:]}

def probe(data):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.6)
    s.sendto(data, ("127.0.0.1", CMD_PORT))
    try:
        reply, _ = s.recvfrom(4096)
        return reply.hex()
    except Exception:
        return None

def request(command, length, version=6, pkt_type=1, res1=0, res2=0, sequence=0x01020304):
    body = struct.pack("!BBBBHHIII", version, pkt_type, res1, res2, command, 0, sequence, 0, 0)
    return (body + bytes(max(0, length - len(body))))[:length]

READS = [["tracking"], ["sources"], ["sourcestats"], ["activity"], ["smoothing"], ["manual", "list"], ["rtcdata"], ["sourcename", "127.0.0.2"],
         ["-c", "tracking"], ["-c", "sources"], ["sources", "-v"], ["makestep"], ["serverstats"], ["clients"], ["ntpdata"], ["selectdata"], ["authdata"],
         ["online"], ["offline"], ["burst", "1/2"], ["reselect"], ["settime", "now"], ["manual", "on"], ["allow", "10.0.0.0/8"], ["delete", "127.0.0.2"], ["shutdown"]]

PROBES = {
    "null-request": request(0, 28),
    "tracking-exact": request(33, 104),
    "tracking-short": request(33, 60),
    "tracking-too-short-for-header": request(33, 24),
    "bad-version-5": request(33, 104, version=5),
    "bad-version-4": request(33, 104, version=4),
    "bad-version-3": request(33, 104, version=3),
    "unknown-command": request(200, 104),
    "unsupported-command": request(6 + 32, 104),
    "wrong-packet-type": request(33, 104, pkt_type=2),
    "res1-set": request(33, 104, res1=1),
    "online-unauthorised": request(1, 100),
    "local-length-table-zero": request(12, 100),
}

def main():
    root, target = sys.argv[1], sys.argv[2]
    stop = threading.Event()
    threading.Thread(target=stub, args=(stop,), daemon=True).start()
    threading.Thread(target=proxy, args=(stop,), daemon=True).start()
    conf = "server 127.0.0.2 port 12399 minpoll 0 maxpoll 0 iburst\nallow 127.0.0.0/8\nratelimit\nmakestep 1000 3\nlocal stratum 10\nsmoothtime 400 0.001\n"
    cases, probes = [], []
    with tempfile.TemporaryDirectory() as run:
        p = start(root, conf, run, 12301)
        try:
            time.sleep(14)
            for args in READS:
                cases.append(chronyc(root, args))
            for name, data in PROBES.items():
                probes.append({"name": name, "request": data.hex(), "reply": probe(data)})
        finally:
            p.terminate(); p.wait(); stop.set()
    json.dump({"tool": "chrony 4.5 cmdmon", "cases": cases, "probes": probes}, open(target, "w"), indent=1)
    print(len(cases), "chronyc runs,", len(probes), "probes")

main()
