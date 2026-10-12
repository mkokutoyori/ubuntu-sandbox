#!/usr/bin/env python3
"""Record the real lastlog (shadow 4.13 login package) over generated lastlog files.

usage: record_lastlog.py out.json

scripts/oracle/last_shim.c pins time(), the passwd database, the lastlog path and login.defs.  Each invocation runs on
a fresh copy of the scenario's lastlog file; stdout, stderr, exit status and the sha256 and size of the file afterwards
(-C / -S rewrite it) are stored.
"""
import base64, hashlib, json, os, random, shutil, struct, subprocess, sys, tempfile

NOW = 1700000000
ZONES = ["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata"]
NAMES = ["root", "daemon", "alice", "bob", "carol", "svc-backup", "a" * 31, "dave", "erin", "nobody"]
OPTIONS = [[], ["-t", "5"], ["-t", "0"], ["-b", "3"], ["-b", "0"], ["-t", "2", "-b", "1"], ["-u", "root"], ["-u", "alice"], ["-u", "nosuchuser"], ["-u", "0"], ["-u", "1000"], ["-u", "0-2"], ["-u", "-3"],
           ["-u", "1000-"], ["-u", "5-x"], ["-u", "x"], ["-u", "100-200"], ["-u", ""], ["-t", "abc"], ["-b", "-1"], ["-t", "0x10"], ["-t", "011"], ["-h"], ["--help"], ["-x"], ["--bogus"], ["extra"], ["-u", "alice", "extra"],
           ["-C"], ["-S"], ["-C", "-S", "-u", "alice"], ["-C", "-u", "alice"], ["-S", "-u", "bob"], ["-S", "-u", "0-2"], ["-C", "-u", "1000-"], ["-S", "-u", "99999"], ["-C", "-u", "-2"], ["--user=alice"], ["--time", "3"], ["--before=2"],
           ["-u"], ["-t"], ["-R"], ["-R", "relative"], ["-R", "/a", "-R", "/b"], ["--root"], ["-u", "alice", "-u", "bob"], ["-u", "carol", "-t", "400"], ["-S", "-u", "dave", "-t", "1"]]

def build(rnd):
    count = rnd.randint(1, 9)
    users = []
    used = set()
    for index in range(count):
        uid = rnd.choice([0, 1, 2, 100, 150, 250, 300, rnd.randint(3, 300)])
        while uid in used: uid += 1
        used.add(uid)
        users.append((NAMES[index % len(NAMES)] + ("" if index < len(NAMES) else str(index)), uid))
    top = max(uid for _, uid in users if uid < 70000) if any(uid < 70000 for _, uid in users) else 0
    size = (top + 1) * 292
    blob = bytearray(size if rnd.random() > 0.15 else max(0, size - rnd.randint(1, 291)))
    for _, uid in users:
        if uid >= 70000 or rnd.random() < 0.3: continue
        offset = uid * 292
        if offset + 292 > len(blob): continue
        when = rnd.choice([0, NOW - rnd.randint(0, 86400 * 20), NOW - 86400 * 3 - 5, NOW - 86400 * 400, NOW + 1000, -5, 1, 2147483647])
        line = rnd.choice(["pts/0", "tty1", "ssh", "x" * 32, "pts/12345678", "", "lastlog"])
        host = rnd.choice(["", "10.0.0.5", "example.org", "fe80::1%eth0", "h" * 255, "2001:db8::42", "bad\x01host"])
        struct.pack_into("<i", blob, offset, when)
        blob[offset + 4: offset + 4 + len(line.encode('latin-1')[:32])] = line.encode('latin-1')[:32]
        blob[offset + 36: offset + 36 + len(host.encode('latin-1')[:256])] = host.encode('latin-1')[:256]
    cells = [[uid, base64.b64encode(bytes(blob[uid * 292: uid * 292 + 292])).decode()] for _, uid in users if uid * 292 + 292 <= len(blob) and any(blob[uid * 292: uid * 292 + 292])]
    return users, bytes(blob), cells

def main():
    rnd = random.Random(20260617)
    scenarios = []
    for index in range(220):
        users, blob, cells = build(rnd)
        defs = rnd.choice([None, "", "LASTLOG_UID_MAX 1000\n", "LASTLOG_UID_MAX\t0x3e8\n", "LASTLOG_UID_MAX 99999999999999999999999\n", "LASTLOG_UID_MAX abc\n", "#LASTLOG_UID_MAX 5\n", "LASTLOG_UID_MAX 0\n", "UMASK 022\nLASTLOG_UID_MAX 1001\n"])
        zone = rnd.choice(ZONES)
        work = tempfile.mkdtemp()
        defs_path = os.path.join(work, "login.defs")
        open(defs_path, "w").write(defs if defs is not None else "")
        env = dict(os.environ, TZ=zone, LC_ALL="C", LD_PRELOAD="/tmp/last_shim.so", LAST_NOW=str(NOW), LAST_USERS=",".join(f"{n}:{u}" for n, u in users), LAST_LOGINDEFS=defs_path)
        runs = []
        for options in rnd.sample(OPTIONS, 14):
            copy = os.path.join(work, "lastlog")
            open(copy, "wb").write(blob)
            if index % 9 == 4: os.chmod(copy, 0o444)
            e = dict(env, LAST_LASTLOG=copy)
            p = subprocess.run(["lastlog"] + options, capture_output=True, env=e)
            runs.append({"argv": options, "stdout": p.stdout.decode("latin-1"), "stderr": p.stderr.decode("latin-1"), "code": p.returncode, "after": hashlib.sha256(open(copy, "rb").read()).hexdigest(), "afterSize": os.path.getsize(copy)})
        scenarios.append({"zone": zone, "now": NOW, "users": users, "defs": defs, "size": len(blob), "records": cells, "readonly": index % 9 == 4, "runs": runs})
        shutil.rmtree(work)
    json.dump({"scenarios": scenarios}, open(sys.argv[1], "w"))

main()
