#!/usr/bin/env python3
"""Record logrotate transcripts from a real logrotate binary.

usage: LOGROTATE_BIN=/path/to/logrotate [LD_LIBRARY_PATH=...] \
       record_logrotate.py scenarios.json out.json

Each scenario describes a file tree, config files, an optional state file and an
argument vector.  The tree is created under the real filesystem (the scenario
paths are absolute and live under /var/log/lr*, /etc/lr*, /var/lib/lr*), the real
binary is run, and the transcript, exit status and resulting tree are saved.
"""
import json, os, shutil, subprocess, sys, time, gzip, stat

ROOTS = ["/var/log/lr", "/etc/lr", "/var/lib/lr", "/srv/lr"]

def wipe():
    for r in ROOTS:
        shutil.rmtree(r, ignore_errors=True)

def build(scn, now):
    for d in scn.get("dirs", []):
        os.makedirs(d["path"], exist_ok=True)
        os.chmod(d["path"], d.get("mode", 0o755))
        os.chown(d["path"], d.get("uid", 0), d.get("gid", 0))
    for f in scn.get("files", []):
        os.makedirs(os.path.dirname(f["path"]), exist_ok=True)
        with open(f["path"], "w") as h:
            h.write(f.get("content", ""))
            if f.get("sizeBytes") and f["sizeBytes"] > len(f.get("content", "")):
                h.write("x" * (f["sizeBytes"] - len(f.get("content", ""))))
        os.chmod(f["path"], f.get("mode", 0o644))
        os.chown(f["path"], f.get("uid", 0), f.get("gid", 0))
        ago = f.get("mtimeAgoSec", 0)
        os.utime(f["path"], (now - ago, now - ago))
    for l in scn.get("symlinks", []):
        os.makedirs(os.path.dirname(l["path"]), exist_ok=True)
        os.symlink(l["target"], l["path"])
    for h in scn.get("hardlinks", []):
        os.link(h["target"], h["path"])
    for c in scn.get("configs", []):
        os.makedirs(os.path.dirname(c["path"]), exist_ok=True)
        with open(c["path"], "w") as h:
            h.write(c["content"])
        os.chmod(c["path"], c.get("mode", 0o644))
        os.chown(c["path"], c.get("uid", 0), c.get("gid", 0))
    if scn.get("state") is not None:
        st = scn["state"]
        for tag, secs in sorted(scn.get("stateAgo", {}).items()):
            t = time.localtime(now - secs)
            st = st.replace("{" + tag + "}", "%d-%d-%d-%d:%d:%d" % (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec))
        os.makedirs(os.path.dirname(scn["statePath"]), exist_ok=True)
        with open(scn["statePath"], "w") as h:
            h.write(st)
        os.chmod(scn["statePath"], scn.get("stateMode", 0o640))

def snapshot():
    out = []
    for r in ROOTS:
        for root, dirs, files in os.walk(r):
            for n in sorted(dirs + files):
                p = os.path.join(root, n)
                s = os.lstat(p)
                e = {"path": p, "mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid, "size": s.st_size}
                if stat.S_ISLNK(s.st_mode):
                    e["type"] = "symlink"; e["target"] = os.readlink(p)
                elif stat.S_ISDIR(s.st_mode):
                    e["type"] = "dir"
                else:
                    e["type"] = "file"
                    raw = open(p, "rb").read()
                    if raw[:2] == b"\x1f\x8b":
                        e["gzip"] = True
                        e["content"] = gzip.decompress(raw).decode("utf-8", "replace")
                    else:
                        e["content"] = raw.decode("utf-8", "replace")
                    e["mtimeAgoSec"] = None
                out.append(e)
    return sorted(out, key=lambda e: e["path"])

def run_one(scn, binary):
    for _ in range(4):
        wipe()
        now = int(time.time())
        build(scn, now)
        started = int(time.time())
        env = dict(os.environ)
        env["TZ"] = scn.get("tz", "UTC")
        r = subprocess.run([binary] + scn["args"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, cwd=scn.get("cwd", "/"))
        finished = int(time.time())
        if started // 60 == finished // 60:
            return {
                "name": scn["name"], "nowSec": started, "buildNowSec": now, "tz": scn.get("tz", "UTC"),
                "scenario": scn, "output": r.stdout,
                "exit": r.returncode, "tree": snapshot(),
            }
        time.sleep(61 - time.time() % 60)
    raise SystemExit("could not record %s within one minute" % scn["name"])

def main():
    os.umask(0o022)
    binary = os.environ["LOGROTATE_BIN"]
    scenarios = json.load(open(sys.argv[1]))
    results = []
    for scn in scenarios:
        res = run_one(scn, binary)
        results.append(res)
        print(scn["name"], res["exit"], file=sys.stderr)
    wipe()
    json.dump(results, open(sys.argv[2], "w"), indent=1)

main()
