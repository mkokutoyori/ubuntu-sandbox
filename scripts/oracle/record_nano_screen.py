#!/usr/bin/env python3
"""Record whole-screen transcripts from a real GNU nano driven through tmux.

usage: record_nano_screen.py --corpus cells|scroll|resize [--seed N] [--cases N] out.json

A case is a buffer, a pane size, nano's command-line flags and a list of steps; a step is a tmux
key token (`Left`, `C-a`, `M-n`, `PageDown`, ...), a run of literal text (`-l`) or `@ROWSxCOLS`,
which resizes the pane.  The real nano runs inside a pane of the given size (started with `-I`, so
no rc file is read); the first record is the screen right after nano opened the file, then one
record per step: every row of the pane (title bar, edit window, status bar and the two shortcut
rows), the cursor cell and the pane size.
"""
import argparse, json, os, random, re, subprocess, tempfile, time
from concurrent.futures import ThreadPoolExecutor

LITERAL = re.compile(r"^[^A-Z][\s\S]*$")
KEYS = {"Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "Enter", "Tab", "BSpace", "DC", "Escape", "Space"}

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

def send(name, token):
    if token in KEYS or re.match(r"^(C|M)-.+$", token) or token in ("C-Left", "C-Right"):
        tmux("send-keys", "-t", name, token)
    else:
        tmux("send-keys", "-t", name, "-l", token)

def snapshot(name):
    cur = tmux("display", "-p", "-t", name, "#{cursor_y} #{cursor_x} #{pane_height} #{pane_width}").split()
    pane = tmux("capture-pane", "-p", "-t", name).split("\n")
    return int(cur[0]), int(cur[1]), int(cur[2]), int(cur[3]), pane

def settled(name):
    last = None
    for _ in range(40):
        time.sleep(0.05)
        snap = snapshot(name)
        if snap == last:
            return snap
        last = snap
    return last

def record(name):
    y, x, height, width, pane = settled(name)
    return {"y": y, "x": x, "height": height, "width": width, "rows": [r.rstrip() for r in pane[:height]]}

def run_case(case, workdir):
    name = "ns%d_%s" % (os.getpid(), re.sub(r"\W", "", case["id"]))
    casedir = os.path.join(workdir, case["id"])
    os.makedirs(casedir, exist_ok=True)
    open(os.path.join(casedir, "t.txt"), "w", encoding="utf-8").write("\n".join(case["text"]) + "\n")
    tmux("kill-session", "-t", name)
    flags = " ".join(case.get("flags", []))
    tmux("new-session", "-d", "-x", str(case["cols"]), "-y", str(case["rows"]), "-s", name,
         "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color nano -I %s t.txt" % (casedir, flags))
    opened = record(name)
    after = []
    for step in case["steps"]:
        if step.startswith("@"):
            r, c = step[1:].split("x")
            tmux("resize-window", "-t", name, "-x", c, "-y", r)
            time.sleep(0.2)
        else:
            send(name, step)
            if step == "Escape":
                time.sleep(0.15)
        after.append(record(name))
    tmux("kill-session", "-t", name)
    return dict(case, opened=opened, after=after)

WORDS = ["foo", "bar", "baz", "Hello", "world", "a_b", "x", "tab\there", "中文", "café", "é", "(x)", "[1,2]", "end."]

def rand_line(r, long_chance=0.2):
    if r.random() < 0.08:
        return ""
    line = r.choice([" ", "  ", "\t"]).join(r.choice(WORDS) for _ in range(r.randint(1, 8)))
    if r.random() < 0.25:
        line = r.choice(["\t", "    ", "  \t"]) + line
    if r.random() < long_chance:
        line += " " + " ".join(r.choice(WORDS) for _ in range(r.randint(12, 40)))
    return line

def rand_buffer(r, n):
    return [rand_line(r) for _ in range(n)]

FLAGS = [[], [], ["-l"], ["-S"], ["-l", "-S"], ["-c"], ["-v"]]
MOVES = ["Left", "Right", "Up", "Down", "Home", "End", "C-a", "C-e", "C-y", "C-v", "PageUp", "PageDown", "C-Left", "C-Right", "M-\\", "M-/", "C-p", "C-n", "C-b", "C-f"]
EDITS = ["x", "yz", "BSpace", "DC", "Enter", "Tab", "C-k", "C-u", "M-6", "C-d"]
TOGGLES = ["M-n", "M-s"]
SCROLLS = ["M-Up", "M-Down"]

PROMPT_WORDS = ["foo", "bar", "world", "x", "end.", "Hello", "a_b", "tab", "zzz", "é", "中文"]

def prompt_text(r):
    kind = r.random()
    if kind < 0.15:
        return ""
    if kind < 0.75:
        return r.choice(PROMPT_WORDS)
    return " ".join(r.choice(PROMPT_WORDS) for _ in range(r.randint(8, 30)))

def prompt_edit(r):
    return [r.choice(["Left", "Right", "Home", "End", "BSpace", "DC"]) for _ in range(r.randint(0, 4))]

def prompt_script(r):
    kind = r.choice(["search", "search", "search-flag", "replace", "goto", "write-out", "read-file", "execute", "exit", "cancelled"])
    if kind == "search":
        return ["C-w", prompt_text(r)] + prompt_edit(r) + [r.choice(["Enter", "C-c", "Enter"])]
    if kind == "search-flag":
        return ["C-w", r.choice(["M-c", "M-r", "M-b"])] + ([r.choice(["M-c", "M-r", "M-b"])] if r.random() < 0.4 else []) + [prompt_text(r)] + prompt_edit(r) + ["C-c"]
    if kind == "replace":
        script = ["C-\\", prompt_text(r)] + prompt_edit(r) + ["Enter", prompt_text(r), "Enter"]
        return script + [r.choice(["y", "n", "a", "C-c"])]
    if kind == "goto":
        return ["C-_", r.choice(["1", "3", "7", "2,4", "99", "x", ""]) ] + prompt_edit(r) + [r.choice(["Enter", "C-c"])]
    if kind == "write-out":
        return ["C-o", prompt_text(r)] + prompt_edit(r) + ["C-c"] + (["C-c"] if r.random() < 0.3 else [])
    if kind == "read-file":
        return ["C-r"] + ([prompt_text(r)] if r.random() < 0.6 else []) + ["C-c"]
    if kind == "execute":
        return ["C-t"] + ([prompt_text(r)] if r.random() < 0.6 else []) + ["C-c"]
    if kind == "exit":
        return ["x", "C-x", "C-c"]
    if kind == "help":
        return ["C-g", "C-x"]
    return ["C-w", "C-c", "C-o", "C-c"]

def gen_prompts(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = rand_buffer(r, r.choice([3, 6, 12, 30]))
        rows, cols = r.choice([(10, 30), (14, 40), (14, 60), (24, 80), (12, 100)])
        steps = []
        for _ in range(r.randint(1, 3)):
            steps.extend(prompt_script(r))
        cases.append({"id": "pro%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "flags": r.choice([[], [], ["-l"], ["-S"]]), "steps": steps})
    return cases

def gen(seed, count, corpus):
    if corpus == "prompts":
        return gen_prompts(seed, count)
    r = random.Random(seed)
    cases = []
    for i in range(count):
        if corpus == "cells":
            text = rand_buffer(r, r.randint(1, 12))
            sizes = [(10, 30), (14, 40), (14, 60), (24, 80), (12, 100)]
            steps = [r.choice(MOVES + EDITS) for _ in range(r.randint(3, 10))]
            rows, cols = r.choice(sizes)
        elif corpus == "scroll":
            text = rand_buffer(r, r.choice([20, 40, 80]))
            rows, cols = r.choice([(8, 40), (10, 60), (14, 40), (24, 80), (16, 100)])
            steps = [r.choice(MOVES * 3 + SCROLLS + EDITS) for _ in range(r.randint(4, 14))]
        else:
            text = rand_buffer(r, r.choice([5, 20, 50]))
            rows, cols = r.choice([(10, 40), (14, 60), (24, 80)])
            steps = []
            for _ in range(r.randint(4, 12)):
                if r.random() < 0.3:
                    steps.append("@%dx%d" % (r.choice([8, 10, 14, 20, 30]), r.choice([30, 40, 60, 80, 100])))
                else:
                    steps.append(r.choice(MOVES + EDITS))
        flags = r.choice(FLAGS)
        if r.random() < 0.2:
            steps.insert(r.randint(0, len(steps)), r.choice(TOGGLES))
        cases.append({"id": "%s%d-%d" % (corpus[:3], seed, i), "text": text, "rows": rows, "cols": cols, "flags": flags, "steps": steps})
    return cases

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="cells")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--cases", type=int, default=60)
    ap.add_argument("out")
    a = ap.parse_args()
    cases = gen(a.seed, a.cases, a.corpus)
    with tempfile.TemporaryDirectory() as workdir:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda c: run_case(c, workdir), cases))
    version = subprocess.run(["nano", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    json.dump({"nano": version, "corpus": a.corpus, "cases": results}, open(a.out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(results), "cases ->", a.out)

main()
