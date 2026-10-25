#!/usr/bin/env python3
"""Record what a real bash 5 prints for command lines that end in, or hand each other, unterminated output.

usage: record_shell_output.py out.json

Each command line is run with `bash -c` and its standard output is kept byte for byte. The simulator replays the same lines in
shell-fin-de-ligne-oracle.test.ts. The inputs are printf'd, with and without a final newline, so the difference between "the command
wrote a line" and "the command wrote bytes" shows in what follows it (`; echo END`).
"""
import json, subprocess, sys

DATA = "printf 'b 2\\na 1\\nb 2\\nc'"
DATAN = "printf 'b 2\\na 1\\nb 2\\nc\\n'"

FILTERS = [
    "cat", "head -2", "head -n 1", "head -n -1", "head -c 3", "tail -2", "tail -n 1", "tail -n +2", "tail -c 3", "sort", "sort -r", "sort -n",
    "sort -u", "uniq", "tr a-z A-Z", "tr -d b", "tr -s b", "sed s/b/X/", "sed -n 2p", "sed -n '$p'", "sed 2d", "sed -n 'p;p'", "sed '$d'", "sed 1q",
    "sed -n '/b/p'", "sed 's/b/X/;s/X/Y/'", "sed =", "awk '{print $1}'", "awk 'NR==2'", "awk 'END{print NR}'", "awk '{print}'", "wc -l", "wc -c", "wc",
    "cut -d' ' -f1", "cut -c1-2", "rev", "tac", "nl", "nl -ba", "grep b", "grep -c b", "grep -v b", "grep -n b", "base64", "xargs echo", "sort | uniq -c",
    "uniq -d", "paste -sd,", "tee /tmp/t.txt", "cat -n", "cat -A", "cat -b", "cat -E", "cat -s", "head -n 0", "sed -n 2p; echo mid",
]
REDIRECTIONS = ["", " 2>/dev/null"]

def commands():
    out = []
    for source in (DATA, DATAN):
        for f in FILTERS:
            for r in REDIRECTIONS:
                out.append(f"{source} | {f}{r}; echo END")
        for f in ("cat", "head -2", "tail -1", "grep b", "wc -l", "sort", "sed -n 2p", "cat /tmp/d.txt /tmp/d.txt"):
            out.append(f"{source} > /tmp/d.txt; {f if f.startswith('cat /') else f + ' /tmp/d.txt' if f != 'cat' else 'cat /tmp/d.txt'}; echo END")
    out += [
        "echo hi; echo END", "echo -n hi; echo END", "echo -n hi 2>/dev/null; echo END", "printf 'x'; printf 'y'; echo", "printf abc 2>/dev/null; echo END",
        "echo a; echo b 2>/dev/null; echo END", "true; echo END", "printf 'a\\n' 2>&1; echo END", "printf abc 2>&1; echo END", 'echo "$(printf abc)-"; echo END',
        "printf abc | cat; echo END", "printf abc | cat | cat; echo END", "printf a; printf b; printf c; echo; echo END",
        "printf 'a\\nb' | wc -l; echo END", "printf '' | cat; echo END", "printf '\\n' | cat; echo END", "printf 'a\\n\\n\\nb\\n' | cat -s; echo END",
    ]
    return out

def main():
    cases = []
    for command in commands():
        run = subprocess.run(["bash", "-c", command], capture_output=True, text=True)
        cases.append({"command": command, "stdout": run.stdout})
    json.dump({"bash": subprocess.run(["bash", "--version"], capture_output=True, text=True).stdout.split("\n")[0], "cases": cases},
              open(sys.argv[1], "w"), indent=1)

if __name__ == "__main__":
    main()
