#!/usr/bin/env python3
import argparse
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import fcntl
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netcmds_labs

ROWS = 24
COLS = 80
BEGIN = "@@BEGIN "
END = "@@END "
PIDS = "@@PIDS "
BASE = "@@BASE"
BASE_END = "@@BASEEND"
SHELL = "@@SHELL "
LAB_TIMEOUT = 60


def tool_versions():
    def first_line(args):
        done = subprocess.run(args, capture_output=True, text=True)
        return (done.stdout + done.stderr).strip().split("\n")[0]
    return {
        "ss": first_line(["ss", "-V"]),
        "netstat": first_line(["netstat", "-V"]),
        "fuser": first_line(["fuser", "-V"]),
        "lsof": next((line.strip() for line in (subprocess.run(["lsof", "-v"], capture_output=True, text=True).stderr).split("\n") if "revision" in line), ""),
        "nc": subprocess.run(["dpkg-query", "-W", "-f", "${Package} ${Version}", "netcat-openbsd"], capture_output=True, text=True).stdout,
        "bash": first_line(["bash", "--version"]),
        "ps": first_line(["ps", "--version"]),
        "kernel": os.uname().release,
    }


def script_for(case):
    lines = ["set +m"]
    if case.get("tty"):
        lines.append("exec < /dev/null")
    lines.append("ip link set lo up")
    for address in case.get("addresses", []):
        lines.append("ip addr add %s dev lo" % address)
    lines.append("echo \"%s$$\"" % SHELL)
    lines.append("echo '%s'" % BASE)
    lines.append("ss -s")
    lines.append("echo '%s'" % BASE_END)
    lines.append("rm -rf /tmp/lab && mkdir -p /tmp/lab && cd /tmp/lab")
    lines.extend(case.get("setup", []))
    lines.append("sleep %s" % case.get("settle", 0.4))
    for index, step in enumerate(case["steps"]):
        command = step["cmd"] if isinstance(step, dict) else step
        lines.append("echo '%s%d'" % (BEGIN, index))
        lines.append(command)
        lines.append("echo \"%s%d $?\"" % (END, index))
    names = case.get("pids", [])
    if names:
        lines.append("echo \"%s%s\"" % (PIDS, " ".join("%s=$%s" % (name, name) for name in names)))
    lines.append("kill $(jobs -p) 2>/dev/null")
    return "\n".join(lines) + "\n"


def run_in_namespace(script, tty=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as handle:
        handle.write(script)
        path = handle.name
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "HOME": "/root", "TERM": "xterm"}
    shell = ["bash", "-c", 'setsid -c bash "$0" 0<&0 & wait', path] if tty else ["bash", path]
    process = subprocess.Popen(
        ["unshare", "-n", "-p", "-f", "--mount-proc", "--kill-child"] + shell,
        stdin=slave if tty else subprocess.DEVNULL, stdout=slave, stderr=slave, env=env, close_fds=True,
    )
    os.close(slave)
    chunks = []
    deadline = time.time() + LAB_TIMEOUT
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.5)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append(data)
        elif process.poll() is not None:
            break
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    os.close(master)
    os.unlink(path)
    return b"".join(chunks).decode("utf-8", "replace").replace("\r\n", "\n")


def parse(text, case):
    results = []
    current = None
    pids = {}
    base = None
    shell = None
    for line in text.split("\n"):
        if line.startswith(SHELL):
            shell = int(line[len(SHELL):])
        elif line == BASE:
            base = []
        elif line == BASE_END:
            base = base if base is None else ("\n".join(base),)
        elif isinstance(base, list):
            base.append(line)
        elif line.startswith(BEGIN):
            current = {"index": int(line[len(BEGIN):]), "lines": []}
        elif line.startswith(END) and current is not None:
            index, status = line[len(END):].split()
            current["status"] = int(status)
            results.append(current)
            current = None
        elif line.startswith(PIDS):
            for pair in line[len(PIDS):].split():
                name, _, value = pair.partition("=")
                pids[name] = int(value) if value.isdigit() else None
        elif current is not None:
            current["lines"].append(line)
    steps = []
    for entry in results:
        step = case["steps"][entry["index"]]
        steps.append({
            "cmd": step["cmd"] if isinstance(step, dict) else step,
            "output": "\n".join(entry["lines"]),
            "status": entry["status"],
        })
    return steps, pids, (base[0] if base else ""), shell


def record(case):
    text = run_in_namespace(script_for(case), bool(case.get("tty")))
    steps, pids, baseline, shell = parse(text, case)
    if len(steps) != len(case["steps"]):
        raise RuntimeError("%s: %d of %d steps ended\n%s" % (case["id"], len(steps), len(case["steps"]), text[-2000:]))
    out = {key: value for key, value in case.items() if key != "steps"}
    out["steps"] = steps
    out["recordedPids"] = pids
    out["shellPid"] = shell
    out["baseline"] = baseline
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("family", choices=sorted(netcmds_labs.FAMILIES))
    parser.add_argument("out")
    parser.add_argument("--only", default=None)
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    cases = netcmds_labs.FAMILIES[args.family]()
    if args.only:
        cases = [case for case in cases if re.search(args.only, case["id"])]
    if args.list:
        for case in cases:
            print(case["id"])
        return
    recorded = []
    for case in cases:
        recorded.append(record(case))
        sys.stderr.write("%s\n" % case["id"])
    with open(args.out, "w") as handle:
        json.dump({"family": args.family, "tools": tool_versions(), "cases": recorded}, handle, ensure_ascii=False, indent=1)
    sys.stderr.write("%d cases\n" % len(recorded))


if __name__ == "__main__":
    main()
