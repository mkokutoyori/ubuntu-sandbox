#!/usr/bin/env python3
"""Record ausyscall (audit 3.1.2) on every architecture token, name, number, --exact and --dump.

usage: record_ausyscall.py AUDIT_ROOT out.json

Dumps are stored as a digest and a line count: they run to tens of kilobytes per architecture.
"""
import hashlib, json, os, subprocess, sys

ARCHES = ["", "i386", "i486", "i586", "i686", "x86_64", "b32", "b64", "B64", "arm", "armeb", "armv7l", "aarch64", "armv8l", "ppc", "ppc64", "ppc64le", "ppcle", "s390", "s390x", "uring", "io_uring", "ia64", "alpha", "riscv64", "native", "40000003", "c000003e", "0xc00000b7", "12345", "zz"]
NAMES = ["open", "OPEN", "exec", "read", "socket", "nosuch", "stat", "setuid", "io_uring_setup", "openat2", "a", "0"]
NUMBERS = ["0", "1", "2", "3", "56", "257", "425", "999", "1399", "1400", "5000", "99999", "00012", "7x"]

def run(root, args):
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", LC_ALL="C")
    r = subprocess.run([root + "/usr/bin/ausyscall", *args], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, errors="replace")
    entry = {"args": args, "stderr": r.stderr, "code": r.returncode}
    if "--dump" in args:
        entry["stdout_sha256"] = hashlib.sha256(r.stdout.encode()).hexdigest()
        entry["stdout_lines"] = r.stdout.count("\n")
        entry["stdout_head"] = "".join(r.stdout.splitlines(True)[:3])
    else:
        entry["stdout"] = r.stdout
    return entry

def main():
    root, target = sys.argv[1], sys.argv[2]
    cases = []
    for arch in ARCHES:
        prefix = [arch] if arch else []
        for name in NAMES:
            cases.append(run(root, prefix + [name]))
            cases.append(run(root, prefix + ["--exact", name]))
            cases.append(run(root, [name, *prefix]))
        for number in NUMBERS:
            cases.append(run(root, prefix + [number]))
        cases.append(run(root, prefix + ["--dump"]))
        cases.append(run(root, prefix))
    for args in ([], ["--dump"], ["--exact"], ["open", "close"], ["1", "2"], ["x86_64", "i386", "open"], ["x86_64", "open", "1", "2"], ["--bogus"], ["-h"], ["--help"], ["open", "--dump"], ["--dump", "--exact", "open"], ["uring"], ["uring", "--dump"], ["uring", "io_uring_setup"], ["b32", "x86_64"], ["aarch64", "b32"], ["arm", "b64"], ["ppc64le", "b32"], ["b64", "b32"]):
        cases.append(run(root, args))
    json.dump({"tool": "ausyscall 3.1.2", "machine": "x86_64", "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "cases")

main()
