#!/usr/bin/env python3
"""Record ausearch (audit 3.1.2) output on synthetic audit.log files.

usage: record_ausearch.py AUDIT_ROOT out.json

AUDIT_ROOT holds the extracted .debs (usr/sbin/ausearch, usr/lib/x86_64-linux-gnu/libaudit*).  Logs come from
audit_log_gen.py; filter values are drawn from the logs themselves so that most queries match something.
LANG is unset (C locale) and TZ is UTC unless the case says otherwise.
"""
import json, os, random, re, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen

def logs():
    return {
        "typed60": gen.gen_typed(1, 60),
        "mixed70": gen.gen_mixed(5, 70),
        "typed25": gen.gen_typed(7, 25),
        "rich60": gen.gen_rich(11, 60),
        "rich30": gen.gen_rich(12, 30),
    }

def facts(text):
    f = {k: set() for k in ("type", "serial", "comm", "exe", "key", "pid", "ppid", "uid", "auid", "euid", "gid", "egid", "ses", "tty", "host", "syscall", "exit", "name", "term", "ts")}
    for line in text.splitlines():
        m = re.match(r"type=(\S+) msg=audit\((\d+)\.\d+:(\d+)\)", line)
        if m:
            f["type"].add(m.group(1)); f["serial"].add(m.group(3)); f["ts"].add(int(m.group(2)))
        for key, pat in (("comm", r'comm="([^"]*)"'), ("exe", r'exe="([^"]*)"'), ("key", r'key="([^"]*)"'), ("pid", r" pid=(\d+)"), ("ppid", r"ppid=(\d+)"),
                         ("uid", r" uid=(\d+)"), ("auid", r"auid=(\d+)"), ("euid", r"euid=(\d+)"), ("gid", r" gid=(\d+)"), ("egid", r"egid=(\d+)"),
                         ("ses", r" ses=(\d+)"), ("host", r"hostname=([^ ']+)"), ("syscall", r"syscall=(\d+)"), ("exit", r"exit=(-?\d+)"),
                         ("name", r'name="([^"]*)"'), ("term", r"terminal=([^ ']+)")):
            for v in re.findall(pat, line):
                f[key].add(v)
    return {k: sorted(v, key=str) for k, v in f.items()}

def cases_for(name, text, rnd):
    f = facts(text)
    out = []
    def pick(k, n=3):
        vals = f[k]
        return rnd.sample(vals, min(n, len(vals)))
    for t in f["type"]:
        out.append(["-m", t]); out.append(["-m", t, "-r"])
    for _ in range(8):
        ts = rnd.sample(f["type"], min(3, len(f["type"])))
        out.append(["-m", ",".join(ts)])
    out += [["-m", "ALL"], ["-m", "all", "--just-one"], ["-m", "NOPE"], ["-m", "1300"], ["-m", "USER_AUTH,1006"], ["-m"]]
    for s in pick("serial", 6): out.append(["-a", s])
    out += [["-a"], ["-a", "x"], ["-a", "999999999"]]
    for v in pick("comm"): out += [["-c", v], ["-c", v, "-w"]]
    out.append(["-c", "vi"])
    for v in pick("exe"): out += [["-x", v], ["-x", v, "-w"]]
    for v in pick("key"): out += [["-k", v], ["-k", v, "-w"], ["-k", v, "-sv", "yes"]]
    for v in pick("name"): out += [["-f", v], ["-f", v, "-w"], ["-f", v, "-m", "PATH"]]
    out += [["-f", "/etc"], ["-f", "passwd", "-w"]]
    for v in pick("pid"): out.append(["-p", v])
    for v in pick("ppid"): out.append(["-pp", v])
    for v in pick("uid"): out += [["-ui", v], ["-ua", v], ["-ue", v], ["-ul", v]]
    for v in pick("auid"): out += [["-ul", v], ["-ua", v]]
    for v in pick("gid"): out += [["-gi", v], ["-ga", v], ["-ge", v]]
    out += [["-ui", "root"], ["-ua", "root"], ["-ul", "root"], ["-ue", "root"], ["-gi", "root"], ["-ga", "root"], ["-ui", "nosuchuser"], ["-gi", "nosuchgroup"], ["-ul", "-1"], ["-ul", "4294967295"]]
    for v in pick("ses"): out.append(["--session", v])
    out += [["--session", "-1"], ["--session", "x"]]
    for v in pick("term"): out.append(["-tm", v])
    for v in pick("host"): out += [["-hn", v], ["-hn", v, "-w"]]
    for v in pick("syscall"): out += [["-sc", v], ["-sc", v, "-sv", "no"]]
    out += [["-sc", "openat"], ["-sc", "execve"], ["-sc", "unlink"], ["-sc", "bogus"], ["--arch", "x86_64", "-sc", "openat"], ["--arch", "b64"], ["--arch", "b32", "-sc", "open"], ["--arch", "c000003e"], ["--arch", "bogus"], ["-sc", "openat", "--arch", "b64"]]
    for v in pick("exit"): out.append(["-e", v])
    out += [["-e", "EACCES"], ["-e", "-EACCES"], ["-e", "-13"], ["-e", "ENOENT"], ["-e", "BOGUS"], ["-e"], ["-e", "0"]]
    out += [["-sv", "yes"], ["-sv", "no"], ["-sv", "maybe"], ["-sv"], ["--success", "yes", "-m", "SYSCALL"]]
    out += [["-n", "host1"], ["-n", "host2", "-r"], ["--node", "x"]]
    lo, hi = min(f["ts"]), max(f["ts"])
    mid = (lo + hi) // 2
    import time
    def dstr(t):
        g = time.gmtime(t)
        return "%02d/%02d/%02d" % (g.tm_mon, g.tm_mday, g.tm_year % 100), "%02d:%02d:%02d" % (g.tm_hour, g.tm_min, g.tm_sec)
    d, t = dstr(mid)
    d0, t0 = dstr(lo); d1, t1 = dstr(hi)
    out += [["-ts", d, t], ["-te", d, t], ["-ts", d0, t0, "-te", d1, t1], ["-ts", d, t, "-te", d1, t1], ["-ts", d], ["-ts", "01/01/26"], ["-ts", "bad"], ["-ts"], ["-ts", d, "bad"], ["-te", d, t, "-m", "SYSCALL"]]
    out += [["-ts", "checkpoint"]]
    out += [["-m", "SYSCALL", "--just-one"], ["--just-one", "-k", pick("key")[0] if f["key"] else "x"], ["-m", "SYSCALL", "-r"], ["-r", "-m", "PATH,CWD"], ["--raw", "-i"], ["--format", "raw", "-m", "SYSCALL"], ["--format", "default", "-m", "SYSCALL"], ["--format", "bogus"], ["--format"], ["--format", "raw", "-r"]]
    out += [["--escape", "raw", "-m", "TTY"], ["--escape", "shell", "-m", "SYSCALL"], ["--escape", "shell_quote", "-m", "SYSCALL"], ["--escape", "tty", "-m", "SYSCALL"], ["--escape", "bogus"], ["--escape"]]
    out += [["--eoe-timeout", "5", "-m", "SYSCALL"], ["--eoe-timeout", "0"], ["--eoe-timeout", "x"], ["--eoe-timeout"]]
    out += [["-se", "unconfined"], ["-su", "unconfined"], ["-o", "x"], ["-uu", "abc"], ["-vm", "abc"]]
    out += [["-m", "SYSCALL", "-k", pick("key")[0] if f["key"] else "x", "-sv", "yes"], ["-ui", "1100", "-m", "USER_AUTH"], ["-c", "cat", "-sc", "openat"], ["-x", "/usr/bin/vim", "-f", "/etc/passwd"]]
    out += [["--help"], ["-h"], ["-v"], ["--version"], [], ["-z"], ["--bogus"], ["-m", "SYSCALL", "-m", "PATH"], ["-i", "-r"], ["-r", "-i"], ["-w"], ["-l", "-m", "PATH"], ["--debug", "-m", "SYSCALL"], ["--extra-keys"], ["--input-logs", "-m", "SYSCALL"]]
    return out

def run(root, env, cwd, args):
    r = subprocess.run([root + "/usr/sbin/ausearch", *args], capture_output=True, text=True, env=env, cwd=cwd, stdin=subprocess.DEVNULL)
    return {"stdout": r.stdout, "stderr": r.stderr, "code": r.returncode}

def main():
    root, out = sys.argv[1], sys.argv[2]
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ="UTC", LC_ALL="C")
    env.pop("LANG", None)
    rnd = random.Random(42)
    cases = []
    ls = logs()
    with tempfile.TemporaryDirectory() as d:
        for name, text in ls.items():
            open(os.path.join(d, name + ".log"), "w").write(text)
            for args in cases_for(name, text, rnd):
                full = [*args, "-if", name + ".log"] if args and args not in (["--help"], ["-h"], ["-v"], ["--version"]) else args
                res = run(root, env, d, full)
                cases.append({"log": name, "args": full, **res})
        for name in ("mixed70", "rich60"):
            env2 = dict(env, TZ="America/New_York")
            for args in (["-m", "USER_AUTH"], ["-m", "SYSCALL"], [], ["-m", "ALL"]):
                full = [*args, "-if", name + ".log"] if args else ["-if", name + ".log"]
                res = run(root, env2, d, full)
                cases.append({"log": name, "args": full, "tz": "America/New_York", **res})
        res = run(root, env, d, ["-if", "missing.log"])
        cases.append({"log": "missing", "args": ["-if", "missing.log"], **res})
    json.dump({"tool": "ausearch 3.1.2", "logs": ls, "cases": cases}, open(out, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
