#!/usr/bin/env python3
"""Record screen transcripts from a real vim driven through tmux.

usage: record_vim_screen.py --corpus cells|scroll|resize [--seed N] [--cases N] out.json

A case is a buffer, a window size, a list of `:set` lines applied before the first step and a
list of steps (a step is one run of keystrokes in vim notation: <Esc> <CR> <Tab> <BS> <C-x> <Up>
...).  The real vim, started with `-u DEFAULTS --noplugin` (defaults.vim, which is what a stock Debian vim loads when there is no ~/.vimrc, without the matchparen plugin whose cursor probes move the window),
runs the steps one by one in a pane of the given size; after each step the screen rows above the
command line, the cursor cell, the ruler column and the last line are saved.  A `resize` step is
`@ROWSxCOLS` and resizes the pane.
"""
import json, os, random, re, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

SPECIAL = {"Esc": "Escape", "CR": "Enter", "Tab": "Tab", "BS": "BSpace", "Space": "Space", "Up": "Up", "Down": "Down",
           "Left": "Left", "Right": "Right", "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown", "Del": "DC"}

def tmux_keys(step):
    out = []
    literal = ""
    i = 0
    while i < len(step):
        m = re.match(r"<(C-[a-z\[]|[A-Za-z]+)>", step[i:])
        if m:
            name = m.group(1)
            token = None
            if name in SPECIAL:
                token = SPECIAL[name]
            elif name.startswith("C-"):
                token = "C-" + name[2:]
            if token:
                if literal:
                    out.append(["-l", literal])
                    literal = ""
                out.append([token])
                i += m.end()
                continue
        literal += step[i]
        i += 1
    if literal:
        out.append(["-l", literal])
    return out

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

def snapshot(name):
    cur = tmux("display", "-p", "-t", name, "#{cursor_y} #{cursor_x} #{pane_height} #{pane_width}").split()
    pane = tmux("capture-pane", "-p", "-t", name).split("\n")
    return int(cur[0]), int(cur[1]), int(cur[2]), int(cur[3]), pane

def settled(name):
    last = None
    for _ in range(40):
        time.sleep(0.04)
        snap = snapshot(name)
        if snap == last:
            return snap
        last = snap
    return last

def run_case(case, workdir):
    name = "vs%d_%s" % (os.getpid(), re.sub(r"\W", "", case["id"]))
    casedir = os.path.join(workdir, case["id"])
    os.makedirs(casedir, exist_ok=True)
    open(os.path.join(casedir, "t.txt"), "w", encoding="utf-8").write("\n".join(case["text"]) + "\n")
    rows, cols = case["rows"], case["cols"]
    tmux("kill-session", "-t", name)
    tmux("new-session", "-d", "-x", str(cols), "-y", str(rows), "-s", name,
         "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color vim -u DEFAULTS --noplugin -i NONE -n t.txt" % casedir)
    settled(name)
    for line in case.get("setup", []):
        for k in tmux_keys(":" + line + "<CR>"):
            tmux("send-keys", "-t", name, *k)
        settled(name)
    steps = []
    for step in case["steps"]:
        if step.startswith("@"):
            r, c = step[1:].split("x")
            tmux("resize-window", "-t", name, "-x", c, "-y", r)
            time.sleep(0.15)
        else:
            for k in tmux_keys(step):
                tmux("send-keys", "-t", name, *k)
                if k == ["Escape"]:
                    time.sleep(0.15)
        y, x, height, width, pane = settled(name)
        if any("Press ENTER" in row or "-- More --" in row for row in pane[-4:]):
            break
        text_rows = [row.rstrip() for row in pane[: height - 1]]
        steps.append({"y": y, "x": x, "rows": text_rows, "last": pane[height - 1].rstrip() if len(pane) >= height else "", "height": height, "width": width})
    tmux("kill-session", "-t", name)
    return dict(case, after=steps)

WORDS = ["foo", "bar", "baz", "Hello", "world", "a_b", "x", "tab\there", "中文", "café", "é", "(x)", "[1,2]", "end."]

def rand_line(r, long_chance=0.15):
    if r.random() < 0.08:
        return ""
    words = [r.choice(WORDS) for _ in range(r.randint(1, 8))]
    line = r.choice([" ", "  ", "\t"]).join(words)
    if r.random() < 0.25:
        line = r.choice(["\t", "    ", "  \t"]) + line
    if r.random() < long_chance:
        line = line + " " + " ".join(r.choice(WORDS) for _ in range(r.randint(10, 40)))
    return line

def rand_buffer(r, n):
    return [rand_line(r) for _ in range(n)]

CELL_SETUPS = [[], ["set nu"], ["set list"], ["set list lcs=tab:>-,trail:-,eol:$"], ["set ts=4"], ["set ts=3 nu"], ["set nowrap"],
               ["set nowrap nu"], ["set list lcs=tab:\\ \\ ,eol:$"], ["set rnu"], ["set nu rnu"], ["set nuw=6 nu"], ["set list lcs=space:.,lead:-,trail:~"],
               ["set list lcs=nbsp:+,extends:>,precedes:<,tab:xyz"], ["set nowrap list lcs=extends:>,precedes:<"], ["set nowrap ss=1"], ["set nowrap ss=5 siso=3"],
               ["set cc=10,20"], ["set so=0"], ["set so=3"], ["set dy="], ["set dy=lastline"], ["set noruler noshowcmd"]]
CELL_STEPS = ["l", "h", "j", "k", "$", "0", "^", "w", "b", "e", "A", "I", "i", "a", "<Esc>", "G", "gg", "x", "u", "10l", "20l", "30l", "40l", "5j", "5k", "10|", "40|", "$a", "<Tab>", "<Esc>$", "3w", "f ", "Fe", "gj", "gk", "g$", "g0"]

def gen_cells(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.randint(1, 12)
        cases.append({"id": "cell%d-%d" % (seed, i), "text": rand_buffer(r, n), "rows": r.choice([6, 10, 14, 24]), "cols": r.choice([30, 40, 60, 80]),
                      "setup": r.choice(CELL_SETUPS), "steps": [r.choice(CELL_STEPS) for _ in range(r.randint(2, 8))]})
    return cases

SCROLL_SETUPS = [[], ["set so=0"], ["set so=3"], ["set nu"], ["set nowrap"], ["set so=8"], ["set so=999"], ["set scroll=3"], ["set dy="], ["set dy=lastline"]]
SCROLL_STEPS = ["<C-f>", "<C-b>", "<C-d>", "<C-u>", "<C-e>", "<C-y>", "3<C-e>", "3<C-y>", "2<C-f>", "2<C-b>", "5<C-d>", "5<C-u>", "<PageDown>", "<PageUp>",
                "zt", "zz", "zb", "z<CR>", "z.", "z-", "H", "M", "L", "3H", "3L", "G", "gg", "j", "k", "5j", "5k", "20j", "20k", "50G", "30G", "10G", "/foo<CR>", "n", "N", "?bar<CR>",
                "3dd", "p", "dd", "u", "o<Esc>", "ix<Esc>", "$", "0", "10|", "%", "{", "}", "zh", "zl", "zH", "zL", "zs", "ze"]

def gen_scroll(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([3, 8, 20, 40, 80, 150])
        cases.append({"id": "scr%d-%d" % (seed, i), "text": rand_buffer(r, n), "rows": r.choice([6, 8, 10, 12, 16, 24]), "cols": r.choice([30, 40, 80]),
                      "setup": r.choice(SCROLL_SETUPS), "steps": [r.choice(SCROLL_STEPS) for _ in range(r.randint(3, 10))]})
    return cases

def gen_resize(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([5, 20, 60])
        steps = []
        for _ in range(r.randint(3, 9)):
            if r.random() < 0.35:
                steps.append("@%dx%d" % (r.choice([5, 8, 12, 20, 30]), r.choice([30, 40, 50, 80, 100])))
            else:
                steps.append(r.choice(SCROLL_STEPS + CELL_STEPS))
        cases.append({"id": "rsz%d-%d" % (seed, i), "text": rand_buffer(r, n), "rows": r.choice([8, 12, 24]), "cols": r.choice([30, 80]),
                      "setup": r.choice(SCROLL_SETUPS), "steps": steps})
    return cases

def main():
    args = sys.argv[1:]
    seed, count, corpus, out = 1, 60, "cells", None
    i = 0
    while i < len(args):
        if args[i] == "--seed": seed = int(args[i + 1]); i += 2
        elif args[i] == "--cases": count = int(args[i + 1]); i += 2
        elif args[i] == "--corpus": corpus = args[i + 1]; i += 2
        else: out = args[i]; i += 1
    cases = {"cells": gen_cells, "scroll": gen_scroll, "resize": gen_resize}[corpus](seed, count)
    with tempfile.TemporaryDirectory() as workdir:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda c: run_case(c, workdir), cases))
    version = subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    json.dump({"vim": version, "corpus": corpus, "cases": results}, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(results), "cases ->", out)

main()
