#!/usr/bin/env python3
"""Record ausearch (audit 3.1.2) --format csv and --format text on the synthetic logs of record_ausearch.py.

usage: record_ausearch_formats.py AUDIT_ROOT out.json
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import record_ausearch as base
import audit_log_gen as gen

def cases(facts):
    out = []
    for fmt in ("csv", "text"):
        out += [["--format", fmt], ["--format", fmt, "-m", "SYSCALL"], ["--format", fmt, "-m", "USER_AUTH,USER_LOGIN"], ["--format", fmt, "-m", "ALL"]]
        out += [["--format", fmt, "--extra-time"], ["--format", fmt, "--extra-labels"], ["--format", fmt, "--extra-keys"], ["--format", fmt, "--extra-obj2"]]
        out += [["--format", fmt, "--extra-time", "--extra-labels", "--extra-keys", "--extra-obj2"], ["--format", fmt, "-i"], ["--format", fmt, "-m", "PATH"], ["--format", fmt, "-m", "EXECVE"]]
        for key in facts["key"][:2]: out.append(["--format", fmt, "-k", key])
        for syscall in facts["syscall"][:12]: out.append(["--format", fmt, "-sc", syscall])
        for kind in facts["type"]: out.append(["--format", fmt, "-m", kind])
        for serial in facts["serial"][:3]: out.append(["--format", fmt, "-a", serial])
    out += [["--extra-time"], ["--extra-keys", "--format", "raw"], ["--format", "csv", "--format", "text"], ["--format", "csv", "-r"], ["--format", "text", "-i"], ["-i", "--format", "csv"], ["--format", "csv", "--extra-time", "--format", "csv"]]
    return out

def main():
    root, target = sys.argv[1], sys.argv[2]
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ="UTC", LC_ALL="C")
    env.pop("LANG", None)
    logs = base.logs()
    logs["sys120"] = gen.gen_syscalls(31, 120)
    logs["sys60"] = gen.gen_syscalls(32, 60)
    logs["sys100"] = gen.gen_syscalls(33, 100)
    logs["sys200"] = gen.gen_syscalls(34, 200)
    results = []
    with tempfile.TemporaryDirectory() as directory:
        for name, text in logs.items():
            open(os.path.join(directory, name + ".log"), "w").write(text)
            for args in cases(base.facts(text)):
                full = [*args, "-if", name + ".log"]
                results.append({"log": name, "args": full, **base.run(root, env, directory, full)})
        for name in ("mixed70", "rich60", "sys60"):
            for args in (["--format", "csv", "--extra-time"], ["--format", "text"]):
                full = [*args, "-if", name + ".log"]
                results.append({"log": name, "args": full, "tz": "America/New_York", **base.run(root, dict(env, TZ="America/New_York"), directory, full)})
    hostdb = {"passwd": open("/etc/passwd").read(), "group": open("/etc/group").read(), "protocols": open("/etc/protocols").read()}
    json.dump({"tool": "ausearch 3.1.2", "logs": logs, "cases": results, "hostdb": hostdb}, open(target, "w"), separators=(",", ":"))
    print(len(results), "cases")

main()
