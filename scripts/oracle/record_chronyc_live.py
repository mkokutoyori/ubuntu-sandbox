#!/usr/bin/env python3
"""Record chronyc 4.5 against a chronyd that really synchronises to a stub NTP server.

usage: record_chronyc_live.py NTP_ROOT out.json

The stub answers as a stratum 2 server whose clock runs OFFSET_MS ahead of the host.  chronyd runs with -x (no clock control) and
polls it every second, so after a few seconds `sources` shows a selected source.  Then client datagrams are sent to chronyd's server
port so that `clients` and `serverstats` have something to report.  Values change from run to run; the fixture is replayed for FORMAT only.
"""
import json, os, socket, struct, subprocess, sys, tempfile, threading, time

ERA = 2208988800
OFFSET_MS = 12.5
STUB = ("127.0.0.2", 12399)

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

def start(root, conf, run, port):
    path = os.path.join(run, "c.conf")
    open(path, "w").write(conf + "\nuser root\nport %d\ncmdport 0\nbindcmdaddress %s/chronyd.sock\nbindaddress 127.0.0.1\npidfile %s/c.pid\ndumpdir %s\nlogdir %s\n" % (port, run, run, run, run))
    return subprocess.Popen([root + "/usr/sbin/chronyd", "-x", "-d", "-f", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu"))

def chronyc(root, run, args):
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", LC_ALL="C", TZ="UTC")
    r = subprocess.run([root + "/usr/bin/chronyc", "-h", run + "/chronyd.sock", *args], capture_output=True, env=env, timeout=15, stdin=subprocess.DEVNULL)
    return {"args": args, "stdout": r.stdout.decode(errors="replace"), "stderr": r.stderr.decode(errors="replace"), "code": r.returncode}

READS = [["tracking"], ["sources"], ["sources", "-v"], ["sourcestats"], ["sourcestats", "-v"], ["ntpdata"], ["selectdata"], ["selectdata", "-v"], ["activity"],
         ["serverstats"], ["clients"], ["clients", "-k"], ["authdata"], ["manual", "list"], ["accheck", "127.0.0.1"], ["waitsync", "1", "1", "0", "0.1"],
         ["makestep"], ["tracking"], ["-c", "tracking"], ["-c", "sources"], ["-c", "sourcestats"], ["-c", "ntpdata"], ["-c", "selectdata"],
         ["-c", "activity"], ["-c", "serverstats"], ["-c", "clients"], ["-c", "authdata"], ["-c", "manual", "list"], ["-c", "accheck", "127.0.0.1"],
         ["-n", "sources"], ["-N", "sources"], ["sources", "-a"], ["offline", "127.0.0.2"], ["sources"], ["activity"], ["online", "127.0.0.2"],
         ["burst", "2/4", "127.0.0.2"], ["activity"], ["ntpdata", "127.0.0.2"]]

def main():
    root, target = sys.argv[1], sys.argv[2]
    out = []
    stop = threading.Event()
    threading.Thread(target=stub, args=(stop,), daemon=True).start()
    conf = "server 127.0.0.2 port 12399 minpoll 0 maxpoll 0 iburst\nallow 127.0.0.0/8\nratelimit\nmakestep 1000 3\nlocal stratum 10\n"
    with tempfile.TemporaryDirectory() as run:
        p = start(root, conf, run, 12301)
        try:
            time.sleep(14)
            c = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); c.settimeout(0.5)
            for i in range(3):
                req = bytearray(48); req[0] = 0x23; req[40:48] = ntp_time(time.time())
                c.sendto(bytes(req), ("127.0.0.1", 12301))
                try: c.recvfrom(2048)
                except Exception: pass
                time.sleep(0.3)
            for args in READS:
                out.append({"scenario": "live", "offset_ms": OFFSET_MS, **chronyc(root, run, args)})
        finally:
            p.terminate(); p.wait(); stop.set()
    json.dump({"tool": "chrony 4.5", "cases": out}, open(target, "w"), indent=1)
    print(len(out), "cases")

main()
