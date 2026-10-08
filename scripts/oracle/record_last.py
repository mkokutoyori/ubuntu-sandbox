#!/usr/bin/env python3
"""Record the real last/lastb (util-linux 2.39.3) over generated utmp files.

usage: record_last.py out.json

The binaries run unchanged; scripts/oracle/last_shim.c (LD_PRELOAD) pins time(), the boot time, getpwnam, the
/proc/<pid>/loginuid probe and the /dev/<line> owner so that output is reproducible.  Each scenario is one
binary wtmp (or btmp) file, one environment (zone, now, boot, users) and several invocations; stdout, stderr
and the exit status of each are stored with the file bytes, so the TypeScript port replays them exactly.
"""
import base64, json, os, random, shutil, struct, subprocess, sys, tempfile

NOW = 1700000000
BOOT = NOW - 5 * 86400
USERS = {"alice": 1000, "bob": 1001, "root": 0, "carol": 1002}
LINES = ["tty1", "tty2", "pts/0", "pts/1", "pts/2", "pts/10", ":0", "ftp1234", "uucp7", "ttyS0", "x" * 32, "pts/0", "tty1"]
HOSTS = ["", "10.0.0.5", "192.168.1.20", "example.org", "5.4.3.2", "host.with.a.long.name.example.com", "fe80::1", "h" * 120, "bad\x01host", "caf\xe9"]
ADDRS = [b"\0" * 16, bytes([10, 0, 0, 5]) + b"\0" * 12, bytes([192, 168, 1, 20]) + b"\0" * 12,
         b"\0" * 8 + b"\0\0\xff\xff" + bytes([1, 2, 3, 4]), bytes.fromhex("fe800000000000000000000000000001"), bytes.fromhex("20010db8000000000000000000000042"),
         bytes.fromhex("00000000000000000000ffff0a000001"), bytes.fromhex("0000000100000000000000000000ffff")]
ZONES = ["UTC", "UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Australia/Adelaide"]

def record(kind, user, line, host, when, pid=0, addr=None, ident=b"", term=0, status=0, session=0, usec=0):
    b = bytearray(384)
    struct.pack_into("<hxxi", b, 0, kind, pid)
    b[8:8 + len(line.encode("latin-1")[:32])] = line.encode("latin-1")[:32]
    b[40:40 + len(ident[:4])] = ident[:4]
    u = user.encode("latin-1")[:32]
    b[44:44 + len(u)] = u
    h = host.encode("latin-1")[:256]
    b[76:76 + len(h)] = h
    struct.pack_into("<hhiiiii", b, 332, term, status, session, when & 0xffffffff, usec, 0, 0)
    struct.pack_into("<iiii", b, 348, *struct.unpack("<4i", addr or b"\0" * 16))
    return bytes(b)

def session_records(rnd, count):
    out, clock = [], NOW - 40 * 86400 + rnd.randint(0, 1000)
    for _ in range(count):
        clock += rnd.randint(1, 4 * 86400 // max(count, 1) * 3 + 60)
        roll = rnd.random()
        if roll < 0.06:
            out.append(record(2, "reboot", "~", "6.5.0-generic", clock, ident=b"~~", addr=None))
        elif roll < 0.10:
            out.append(record(1, "runlevel", "~", "6.5.0-generic", clock, pid=ord(rnd.choice("0623")) | (ord("S") << 8), ident=b"~~"))
        elif roll < 0.13:
            out.append(record(254, "shutdown", "~", "6.5.0-generic", clock, ident=b"~~"))
        elif roll < 0.15:
            out.append(record(3 if rnd.random() < .5 else 4, "date", rnd.choice(["{", "|"]), "", clock, ident=b"~~"))
        elif roll < 0.18:
            out.append(record(rnd.choice([0, 5, 6, 9, 77]), rnd.choice(["LOGIN", "alice", ""]), rnd.choice(LINES), "", clock, pid=rnd.randint(1, 5000)))
        elif roll < 0.60:
            user = rnd.choice(list(USERS) + ["longnamelongnamelongnamelongname", "caf\xe9", "a\x02b", "LOGINx"])
            out.append(record(7, user, rnd.choice(LINES), rnd.choice(HOSTS), clock, pid=rnd.randint(100, 5000), addr=rnd.choice(ADDRS), ident=b"ts/0", session=rnd.randint(0, 9)))
        else:
            out.append(record(8, rnd.choice(list(USERS) + [""]), rnd.choice(LINES), "", clock, pid=rnd.randint(100, 5000), ident=b"ts/0"))
    return out

OPTION_SETS = [[], ["-x"], ["-F"], ["-i"], ["-a"], ["-R"], ["-w"], ["-d"], ["-n", "3"], ["-5"], ["-12", "-x"], ["--time-format=iso"], ["--time-format", "notime"], ["--time-format=full"],
               ["--time-format=short"], ["--time-format=bogus"], ["-F", "--time-format=iso"], ["--limit=2"], ["-n", "0"], ["-n", "-1"], ["-n", "x"], ["-x", "-F", "-i", "-a"], ["-xw"], ["--fullnames", "--hostlast"],
               ["-s", "2023-11-01"], ["-t", "2023-11-10 12:00:00"], ["-s", "yesterday"], ["-t", "-1day"], ["-p", "2023-11-12 10:00"], ["-p", "@1699800000"], ["-s", "bogus"], ["-s", "-2weeks", "-t", "now"],
               ["alice"], ["bob", "root"], ["tty1"], ["1"], ["pts/0"], ["~"], ["-q"], ["--foo"], ["--f"], ["--system=1"], ["-f"], ["-V"], ["-h"], ["--help"], ["--version"], ["-s", "Tue 2023-11-14 22:13:20"],
               ["-s", "2023-11-01 10:00:00.5"], ["-s", "20231101000000"], ["-t", "14:00"], ["-p", "5min ago"], ["-p", "+3h"], ["--since=2023-10-20", "--until=2023-11-05", "-x"], ["-n", "99999999999"], ["alice", "-n", "2", "-R"]]

def main():
    rnd = random.Random(20260617)
    out_path = sys.argv[1]
    scenarios = []
    for index in range(260):
        lastb = index % 7 == 3
        count = rnd.choice([0, 1, 2, 5, 12, 30, 60, 120]) if index % 11 else rnd.choice([50, 90, 140])
        records = session_records(rnd, count)
        data = b"".join(records)
        if index % 13 == 5 and data:
            data += rnd.randbytes(rnd.randint(1, 383))
        if index % 17 == 6 and data:
            data = data[rnd.randint(1, 383):]
        if index % 19 == 7:
            data = data[:rnd.randint(0, 383)]
        env = {"TZ": rnd.choice(ZONES), "now": NOW, "boot": BOOT + rnd.choice([0, -86400 * 30, 3600 * 24 * 20]),
               "users": USERS if index % 5 else {"alice": 1000, "root": 0},
               "loginuids": {str(rnd.randint(100, 5000)): rnd.choice([0, 1000, 1001, "bad"]) for _ in range(40)} if index % 3 else {},
               "ttyowners": {l: rnd.choice([0, 1000, 1001]) for l in ["tty1", "tty2", "pts/0", "pts/1", "ttyS0"]}}
        work = tempfile.mkdtemp()
        path = os.path.join(work, "btmp" if lastb else "wtmp")
        open(path, "wb").write(data)
        os.utime(path, (NOW - 3000, NOW - 3000))
        ctime = int(os.stat(path).st_ctime)
        program = "/usr/bin/lastb" if lastb else "/usr/bin/last"
        runs = []
        for options in rnd.sample(OPTION_SETS, 14):
            argv = list(options)
            if "-f" in argv and argv[-1] == "-f":
                pass
            else:
                argv = ["-f", path] + argv if rnd.random() < .5 else argv + ["-f", path]
            e = dict(os.environ, TZ=env["TZ"], LC_ALL="C", LD_PRELOAD="/tmp/last_shim.so", LAST_NOW=str(env["now"]), LAST_BOOT=str(env["boot"]),
                     LAST_USERS=",".join(f"{k}:{v}" for k, v in env["users"].items()), LAST_LOGINUIDS=",".join(f"{k}:{v}" for k, v in env["loginuids"].items()),
                     LAST_TTYOWNERS=",".join(f"{k}:{v}" for k, v in env["ttyowners"].items()))
            p = subprocess.run([os.path.basename(program)] + argv, executable=program, capture_output=True, env=e)
            norm = lambda b: b.decode("latin-1").replace(work, "/data")
            runs.append({"argv": [a.replace(work, "/data") for a in argv], "stdout": norm(p.stdout), "stderr": norm(p.stderr), "code": p.returncode})
        scenarios.append({"program": "lastb" if lastb else "last", "env": env, "ctime": ctime, "data": base64.b64encode(data).decode(), "runs": runs})
        shutil.rmtree(work)
    json.dump({"scenarios": scenarios}, open(out_path, "w"))

main()
