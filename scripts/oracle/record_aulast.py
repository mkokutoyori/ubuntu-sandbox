#!/usr/bin/env python3
"""Record aulast and aulastlog (audit 3.1.2) on synthetic login logs.

usage: record_aulast.py AUDIT_ROOT out.json

Sources: -f FILE, --stdin and the AUSOURCE_LOGS path (auditd.conf pointing at a rotated log set, which is rewritten for the
duration of the run).  The fixture carries the lab host's passwd database, which aulastlog enumerates.
"""
import json, os, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen

CONF = "/etc/audit/auditd.conf"

def logs():
    return {"s20": gen.gen_sessions(1, 20), "s60": gen.gen_sessions(2, 60), "s150": gen.gen_sessions(3, 150), "s400": gen.gen_sessions(4, 400),
            "empty": "", "junk": "hello\nnot an audit line\n\n" + gen.gen_sessions(5, 10)}

def run(root, tool, args, cwd, stdin=None, tz="UTC"):
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ=tz, LC_ALL="C", LD_PRELOAD="/tmp/fake_time.so", FAKE_NOW="1760000000")
    env.pop("LANG", None)
    r = subprocess.run([root + "/usr/bin/" + tool, *args], capture_output=True, env=env, cwd=cwd, input=(stdin or "").encode() if stdin is not None else None, stdin=None if stdin is not None else subprocess.DEVNULL)
    entry = {"tool": tool, "args": args, "stdout": r.stdout.decode(errors="replace"), "stderr": r.stderr.decode(errors="replace"), "code": r.returncode, "tz": tz}
    extracted = os.path.join(cwd, "aulast.log")
    if "--extract" in args and os.path.exists(extracted):
        entry["extracted"] = open(extracted).read()
        os.unlink(extracted)
    return entry

def main():
    root, target = sys.argv[1], sys.argv[2]
    all_logs = logs()
    cases = []
    with tempfile.TemporaryDirectory() as d:
        for name, text in all_logs.items():
            path = os.path.join(d, name + ".log")
            open(path, "w").write(text)
            variants = [[], ["--bad"], ["--proof"], ["--bad", "--proof"], ["--debug"], ["--user", "root"], ["--user", "alice"], ["--user", "unknown(1100)"], ["--tty", "pts/0"], ["--tty", "ssh"], ["--tty", "tty1"], ["--user", "bob", "--tty", "pts"], ["--extract"], ["--bad", "--debug"], ["--proof", "--debug", "--user", "root"]]
            for variant in variants:
                cases.append({"log": name, "source": "file", **run(root, "aulast", ["-f", path, *variant], d)})
                cases.append({"log": name, "source": "stdin", **run(root, "aulast", ["--stdin", *variant], d, stdin=text)})
            cases.append({"log": name, "source": "file", **run(root, "aulast", ["-f", path], d, tz="America/New_York")})
            for variant in ([], ["--user", "root"], ["--user", "ubuntu"], ["--user", "nosuchuser"], ["-u", "alice"]):
                cases.append({"log": name, "source": "stdin", **run(root, "aulastlog", ["--stdin", *variant], d, stdin=text)})
            cases.append({"log": name, "source": "stdin", **run(root, "aulastlog", ["--stdin"], d, stdin=text, tz="America/New_York")})
        for args in ([], ["--bogus"], ["--stdin", "-f", "x"], ["-f", "x", "--stdin"], ["--user"], ["--tty"], ["-f"], ["-f", "/no/such/file"], ["--user", "a", "--user", "b"], ["--tty", "a", "--tty", "b"]):
            cases.append({"log": None, "source": "args", **run(root, "aulast", args, d)})
        for args in ([], ["--bogus"], ["--user"], ["-u"], ["--stdin", "extra"]):
            cases.append({"log": None, "source": "args", **run(root, "aulastlog", args, d, stdin="")})
        backup = None
        if os.path.exists(CONF):
            backup = open(CONF).read()
        try:
            for name in ("s60", "s150"):
                text = all_logs[name]
                lines = text.splitlines(True)
                third = len(lines) // 3
                parts = [lines[:third], lines[third:2 * third], lines[2 * third:]]
                base = os.path.join(d, "logset")
                shutil.rmtree(base, ignore_errors=True)
                os.makedirs(base)
                open(CONF, "w").write("log_file = %s/audit.log\nend_of_event_timeout = 2\n" % base)
                open(base + "/audit.log.2", "w").write("".join(parts[0]))
                open(base + "/audit.log.1", "w").write("".join(parts[1]))
                open(base + "/audit.log", "w").write("".join(parts[2]))
                for tool, args in (("aulast", []), ("aulast", ["--bad"]), ("aulast", ["--proof", "--user", "root"]), ("aulastlog", []), ("aulastlog", ["--user", "root"])):
                    entry = run(root, tool, args, d)
                    entry.update({"log": name, "source": "logs", "files": {"audit.log.2": "".join(parts[0]), "audit.log.1": "".join(parts[1]), "audit.log": "".join(parts[2])}})
                    cases.append(entry)
            os.unlink(CONF)
            for tool in ("aulast", "aulastlog"):
                entry = run(root, tool, [], d)
                entry.update({"log": None, "source": "no-config-no-log", "files": {}})
                cases.append(entry)
        finally:
            if backup is not None:
                open(CONF, "w").write(backup)
            elif os.path.exists(CONF):
                os.unlink(CONF)
    hostdb = {"passwd": open("/etc/passwd").read()}
    json.dump({"tool": "aulast/aulastlog 3.1.2", "logs": all_logs, "hostdb": hostdb, "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
