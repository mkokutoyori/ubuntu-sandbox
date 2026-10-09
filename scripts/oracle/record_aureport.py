#!/usr/bin/env python3
"""Record aureport (audit 3.1.2) output on synthetic audit.log files.

usage: record_aureport.py AUDIT_ROOT out.json

AUDIT_ROOT is a directory holding the extracted .debs (usr/sbin/aureport, usr/lib/x86_64-linux-gnu/libaudit*).
The logs come from audit_log_gen.py; every case stores the log name, the arguments, stdout, stderr and the
exit status.  LANG is unset (C locale) and TZ is UTC unless the case says otherwise.
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen

REPORTS = ["", "-au", "-l", "-m", "-x", "-f", "-u", "-t", "-tm", "-p", "-s", "-k", "-c", "-e", "-a", "-n", "-r", "-h", "-ma", "--integrity", "--crypto", "--virt", "--comm", "--tty"]
MODIFIERS = ["", "-i", "--summary", "--failed", "--success", "--summary -i", "-ts 10/09/25 13:50:00 -te 10/10/25 07:40:00", "-i --failed"]

def logs():
    return {
        "typed60": gen.gen_typed(1, 60),
        "mixed70": gen.gen_mixed(5, 70),
        "mixed40": gen.gen_mixed(9, 40),
        "typed25": gen.gen_typed(7, 25),
        "rich60": gen.gen_rich(11, 60),
        "rich30": gen.gen_rich(12, 30),
    }

def main():
    root, out = sys.argv[1], sys.argv[2]
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ="UTC", LC_ALL="C")
    env.pop("LANG", None)
    cases = []
    ls = logs()
    with tempfile.TemporaryDirectory() as d:
        for name, text in ls.items():
            path = os.path.join(d, name + ".log")
            open(path, "w").write(text)
            for rep in REPORTS:
                for mod in MODIFIERS:
                    args = (rep + " " + mod).split()
                    r = subprocess.run([root + "/usr/sbin/aureport", *args, "-if", name + ".log"], capture_output=True, text=True, env=env, cwd=d)
                    cases.append({"log": name, "args": args, "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode})
        for name in ("mixed70",):
            path = os.path.join(d, name + ".log")
            env2 = dict(env, TZ="America/New_York")
            for rep in ["", "-au", "-t", "-l"]:
                args = rep.split()
                r = subprocess.run([root + "/usr/sbin/aureport", *args, "-if", name + ".log"], capture_output=True, text=True, env=env2, cwd=d)
                cases.append({"log": name, "args": args, "tz": "America/New_York", "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode})
        specials = [["--help"], ["-v"], ["-z"], ["-au", "-f"], ["-ts"], ["-ts", "bad"], ["-ts", "10/09/25"], ["--escape", "shell", "-x"], ["--escape", "raw", "-f"], ["--escape", "shell_quote", "-f"], ["--escape", "bogus"], ["--escape"],
                    ["-c", "--add"], ["-c", "--delete"], ["-c", "-nc"], ["--node", "host1", "-l"], ["--node", "host2", "--summary"], ["--eoe-timeout", "5"], ["--eoe-timeout", "x"],
                    ["-i", "x"], ["--tty"], ["--tty", "-i"], ["-x", "-f"], ["-au", "--failed", "--success"], ["-k", "--summary", "-i"], ["-f", "--summary"], ["-a", "--summary"],
                    ["-s", "--summary", "-i"], ["-p", "--summary"], ["-h", "--summary"], ["-tm", "--summary"], ["-e", "--summary", "-i"], ["-l", "--failed", "-i"], ["--comm", "--summary"]]
        for name in ("rich60", "rich30", "mixed70"):
            for args in specials:
                r = subprocess.run([root + "/usr/sbin/aureport", *args, "-if", name + ".log"], capture_output=True, text=True, env=env, cwd=d)
                cases.append({"log": name, "args": args, "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode})
        r = subprocess.run([root + "/usr/sbin/aureport", "-if", "missing.log"], capture_output=True, text=True, env=env, cwd=d)
        cases.append({"log": "missing", "args": [], "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode})
    json.dump({"tool": "aureport 3.1.2", "logs": ls, "cases": cases}, open(out, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
