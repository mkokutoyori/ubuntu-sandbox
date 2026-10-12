#!/usr/bin/env python3
"""Record ausearch -i / --format interpret (audit 3.1.2) output.

usage: record_ausearch_interpret.py AUDIT_ROOT out.json

Same layout as record_ausearch.py.  The fixture also carries the lab host's passwd, group and protocols databases:
the interpreter resolves uids, gids and protocol numbers through them, so the replay must see the same ones.
"""
import json, os, random, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen
import record_ausearch as base

def logs():
    out = base.logs()
    out["sys120"] = gen.gen_syscalls(31, 120)
    out["sys60"] = gen.gen_syscalls(32, 60)
    out["sys100"] = gen.gen_syscalls(33, 100)
    out["sys200"] = gen.gen_syscalls(34, 200)
    return out

def main():
    root, outfile = sys.argv[1], sys.argv[2]
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ="UTC", LC_ALL="C")
    env.pop("LANG", None)
    rnd = random.Random(7)
    cases = []
    ls = logs()
    with tempfile.TemporaryDirectory() as d:
        for name, text in ls.items():
            open(os.path.join(d, name + ".log"), "w").write(text)
            facts = base.facts(text)
            argsets = [["-i"], ["--format", "interpret"], ["-i", "-m", "SYSCALL"], ["-i", "--escape", "raw"], ["-i", "--escape", "shell"], ["-i", "--escape", "shell_quote"], ["-i", "--escape", "tty"],
                       ["-i", "-sv", "no"], ["-i", "--just-one"], ["-i", "-m", "PATH,CWD,PROCTITLE"], ["-i", "-m", "TTY,USER_TTY"], ["-i", "-m", "SOCKADDR"], ["-i", "-m", "AVC,USER_AVC"], ["-i", "-m", "ANOM_PROMISCUOUS,SECCOMP,CAPSET"]]
            for t in facts["type"]:
                argsets.append(["-i", "-m", t])
            for k in facts["syscall"][:10]:
                argsets.append(["-i", "-sc", k])
            for v in facts["key"][:3]:
                argsets.append(["-i", "-k", v])
            for v in facts["uid"][:3]:
                argsets.append(["-i", "-ui", v])
            for args in argsets:
                full = [*args, "-if", name + ".log"]
                r = subprocess.run([root + "/usr/sbin/ausearch", *full], capture_output=True, text=True, env=env, cwd=d, stdin=subprocess.DEVNULL, errors="replace")
                cases.append({"log": name, "args": full, "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode})
        env2 = dict(env, TZ="America/New_York")
        for name in ("sys60", "mixed70"):
            full = ["-i", "-if", name + ".log"]
            r = subprocess.run([root + "/usr/sbin/ausearch", *full], capture_output=True, text=True, env=env2, cwd=d, stdin=subprocess.DEVNULL, errors="replace")
            cases.append({"log": name, "args": full, "tz": "America/New_York", "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode})
    def getent(db):
        return subprocess.run(["getent", db], capture_output=True, text=True).stdout
    hostdb = {"passwd": getent("passwd"), "group": getent("group"), "protocols": open("/etc/protocols").read()}
    json.dump({"tool": "ausearch 3.1.2 -i", "logs": ls, "hostdb": hostdb, "cases": cases}, open(outfile, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
