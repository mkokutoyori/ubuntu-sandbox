#!/usr/bin/env python3
"""Record how a real bash on a real pty reports its window size.

usage: record_tty_geometry.py out.json

For each pane size, a bash started by tmux runs `stty size`, `stty -a`, `tput cols`, `tput lines`
and `echo "[$COLUMNS][$LINES]"`; the pane is then resized and the same probes run again, which is
what a SIGWINCH does to a shell.  The output of each probe is kept verbatim.
"""
import json, subprocess, sys, time

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

PROBES = ["stty size", "stty -a", "tput cols", "tput lines", 'echo "[$COLUMNS][$LINES]"', "env | grep -c '^COLUMNS=\\|^LINES='"]

def run_probe(name, command):
    tmux("send-keys", "-t", name, "clear", "Enter")
    time.sleep(0.25)
    tmux("send-keys", "-t", name, command, "Enter")
    time.sleep(0.35)
    rows = [r.rstrip() for r in tmux("capture-pane", "-p", "-t", name).split("\n")]
    out = []
    for row in rows[1:]:
        if row == "$":
            break
        out.append(row)
    while out and out[-1] == "":
        out.pop()
    return out

def record(sizes):
    results = []
    name = "tty%d" % int(time.time())
    for rows, cols in sizes:
        tmux("kill-session", "-t", name)
        tmux("new-session", "-d", "-x", str(cols), "-y", str(rows), "-s", name, "env PS1='$ ' TERM=xterm-256color bash --norc -i")
        time.sleep(0.5)
        entry = {"rows": rows, "cols": cols, "probes": {}}
        for p in PROBES:
            entry["probes"][p] = run_probe(name, p)
        results.append(entry)
    tmux("kill-session", "-t", name)
    return results

def main():
    out = sys.argv[1]
    sizes = [(24, 80), (30, 100), (40, 50), (40, 72), (10, 132), (50, 40)]
    json.dump({"bash": subprocess.run(["bash", "--version"], capture_output=True, text=True).stdout.splitlines()[0],
               "stty": subprocess.run(["stty", "--version"], capture_output=True, text=True).stdout.splitlines()[0],
               "sizes": record(sizes)}, open(out, "w"), indent=1)

main()
