#!/usr/bin/env python3
"""Record ausearch --checkpoint behaviour (audit 3.1.2) over a growing log.

usage: record_ausearch_checkpoint.py AUDIT_ROOT out.json

Each scenario runs ausearch repeatedly against the same checkpoint file while the log grows, and stores the
output of every step plus the checkpoint file after it (dev/inode lines are host specific and are replaced
by placeholders so the replay can compare the rest byte for byte).
"""
import json, os, re, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen

def serial_cut(text, count):
    lines = text.splitlines(keepends=True)
    seen, out = [], []
    for line in lines:
        m = re.match(r"type=\S+ msg=audit\(\d+\.\d+:(\d+)\)", line)
        s = m.group(1) if m else None
        if s is not None and s not in seen:
            if len(seen) == count:
                break
            seen.append(s)
        out.append(line)
    return "".join(out)

def normalise(text):
    text = re.sub(r"^dev=0x[0-9A-F]+$", "dev=DEV", text, flags=re.M)
    return re.sub(r"^inode=\d+$", "inode=INODE", text, flags=re.M)

def main():
    root, out = sys.argv[1], sys.argv[2]
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", TZ="UTC", LC_ALL="C")
    env.pop("LANG", None)
    full = gen.gen_typed(21, 40)
    logs = {"full": full, "part1": serial_cut(full, 12), "part2": serial_cut(full, 25)}
    scenarios = {
        "grow": [("part1", ["-m", "SYSCALL,USER_AUTH"]), ("part1", ["-m", "SYSCALL,USER_AUTH"]), ("part2", ["-m", "SYSCALL,USER_AUTH"]), ("full", ["-m", "SYSCALL,USER_AUTH"]), ("full", ["-m", "SYSCALL,USER_AUTH"])],
        "all": [("part1", []), ("part2", []), ("full", [])],
        "timeonly": [("part2", ["-m", "SYSCALL"]), ("full", ["-ts", "checkpoint", "-m", "SYSCALL"]), ("full", ["-ts", "checkpoint", "-m", "SYSCALL"])],
        "rawformat": [("part1", ["-r", "-m", "USER_AUTH"]), ("full", ["-r", "-m", "USER_AUTH"])],
    }
    cases = []
    with tempfile.TemporaryDirectory() as d:
        for sname, steps in scenarios.items():
            ck = os.path.join(d, sname + ".ck")
            if os.path.exists(ck):
                os.unlink(ck)
            log = os.path.join(d, "live.log")
            record = []
            for lname, args in steps:
                open(log, "w").write(logs[lname])
                full_args = [*args, "-if", "live.log", "--checkpoint", sname + ".ck"]
                r = subprocess.run([root + "/usr/sbin/ausearch", *full_args], capture_output=True, text=True, env=env, cwd=d, stdin=subprocess.DEVNULL)
                ckt = normalise(open(os.path.join(d, sname + ".ck")).read()) if os.path.exists(os.path.join(d, sname + ".ck")) else None
                record.append({"log": lname, "args": full_args, "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode, "checkpoint": ckt})
            cases.append({"scenario": sname, "steps": record})
    json.dump({"tool": "ausearch 3.1.2 --checkpoint", "logs": logs, "scenarios": cases}, open(out, "w"), separators=(",", ":"))
    print(len(cases), "scenarios")

main()
