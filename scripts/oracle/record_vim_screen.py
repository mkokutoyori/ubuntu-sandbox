#!/usr/bin/env python3
"""Record screen transcripts from a real vim driven through tmux.

usage: record_vim_screen.py (--corpus cells|scroll|resize|click|hl|hlwide|is [--seed N] [--cases N] | --from cases.json) out.json

A case is a buffer, a window size, a list of `:set` lines applied before the first step and a
list of steps (a step is one run of keystrokes in vim notation: <Esc> <CR> <Tab> <BS> <C-x> <Up>
...).  The real vim, started with `-u DEFAULTS --noplugin` (defaults.vim, which is what a stock Debian vim loads when there is no ~/.vimrc, without the matchparen plugin whose cursor probes move the window),
runs the steps one by one in a pane of the given size; after each step the screen rows above the
command line, the cursor cell, the ruler column and the last line are saved.  A `resize` step is
`@ROWSxCOLS` and resizes the pane.  A `click` step is `@click:ROW:COL` (0-based screen cell): a left
button press and release in the SGR mouse encoding.  The click corpus starts vim with `-c 'set mouse=M ttymouse=sgr'`:
a Debian/Ubuntu vim reads `defaults.vim` with `mouse=` EMPTY, so a click does nothing until `:set mouse=` names the mode.
"""
import json, os, random, re, subprocess, sys, tempfile, time, unicodedata
from concurrent.futures import ThreadPoolExecutor

SPECIAL = {"Esc": "Escape", "CR": "Enter", "Tab": "Tab", "BS": "BSpace", "Space": "Space", "Up": "Up", "Down": "Down",
           "Left": "Left", "Right": "Right", "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown", "Del": "DC"}

def tmux_keys(step, single=False):
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
        if single:
            out.append(["-l", step[i]])
        else:
            literal += step[i]
        i += 1
    if literal:
        out.append(["-l", literal])
    return out

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

SGR = re.compile(r"\x1b\[([0-9;]*)m")

def cell_width(ch):
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1

def attribute_runs(raw):
    rows, runs_rows = [], []
    state = {"f": "", "b": "", "flags": set()}
    for line in raw.split("\n"):
        text, cells, i = "", [], 0
        while i < len(line):
            m = SGR.match(line, i)
            if m:
                parts = (m.group(1) or "0").split(";")
                j = 0
                while j < len(parts):
                    p = parts[j]
                    if p in ("0", ""):
                        state = {"f": "", "b": "", "flags": set()}
                    elif p == "49":
                        state["b"] = ""
                    elif p == "39":
                        state["f"] = ""
                    elif p in ("38", "48"):
                        key = "f" if p == "38" else "b"
                        if j + 2 < len(parts) and parts[j + 1] == "5":
                            state[key] = p + ";5;" + parts[j + 2]
                            j += 2
                    elif 40 <= int(p) <= 47 or 100 <= int(p) <= 107:
                        state["b"] = p
                    elif 30 <= int(p) <= 37 or 90 <= int(p) <= 97:
                        state["f"] = p
                    elif p == "22":
                        state["flags"].discard("1")
                    elif len(p) == 2 and p[0] == "2":
                        state["flags"].discard(str(int(p) - 20))
                    else:
                        state["flags"].add(p)
                    j += 1
                i = m.end()
                continue
            ch = line[i]
            text += ch
            width = cell_width(ch)
            attr = ",".join(([("f" + state["f"])] if state["f"] else []) + ([("b" + state["b"])] if state["b"] else []) + ["+" + f for f in sorted(state["flags"])])
            cells.extend([attr] * width)
            i += 1
        runs, start = [], 0
        while start < len(cells):
            end = start + 1
            while end < len(cells) and cells[end] == cells[start]:
                end += 1
            if cells[start] != "":
                runs.append([start, end, cells[start]])
            start = end
        rows.append(text)
        runs_rows.append(runs)
    return rows, runs_rows

def snapshot(name, attrs=False):
    cur = tmux("display", "-p", "-t", name, "#{cursor_y} #{cursor_x} #{pane_height} #{pane_width}").split()
    if attrs:
        raw = tmux("capture-pane", "-e", "-N", "-p", "-t", name)
        pane, runs = attribute_runs(raw)
        return int(cur[0]), int(cur[1]), int(cur[2]), int(cur[3]), pane, runs
    pane = tmux("capture-pane", "-p", "-t", name).split("\n")
    return int(cur[0]), int(cur[1]), int(cur[2]), int(cur[3]), pane

def settled(name, attrs=False):
    last = None
    for _ in range(40):
        time.sleep(0.04)
        snap = snapshot(name, attrs)
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
         "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color vim -u DEFAULTS --noplugin -i NONE -n %s t.txt" % (casedir, "-c 'set mouse=%s ttymouse=sgr'" % case["mouse"] if "mouse" in case else ""))
    attrs = bool(case.get("attrs"))
    settled(name, attrs)
    for line in case.get("setup", []):
        for k in tmux_keys(":" + line + "<CR>"):
            tmux("send-keys", "-t", name, *k)
        settled(name, attrs)
    steps = []
    for step in case["steps"]:
        if step.startswith("@click:"):
            _, row, col = step.split(":")
            for final in ("M", "m"):
                tmux("send-keys", "-t", name, "-l", "\x1b[<0;%d;%d%s" % (int(col) + 1, int(row) + 1, final))
            time.sleep(0.1)
        elif step == "@wait":
            time.sleep(0.8)
        elif step.startswith("@"):
            r, c = step[1:].split("x")
            tmux("resize-window", "-t", name, "-x", c, "-y", r)
            time.sleep(0.15)
        else:
            for k in tmux_keys(step, case.get("slow", False)):
                tmux("send-keys", "-t", name, *k)
                if case.get("slow"):
                    time.sleep(0.12)
                if k == ["Escape"]:
                    time.sleep(0.15)
        snap = settled(name, attrs)
        y, x, height, width, pane = snap[:5]
        if any("Press ENTER" in row or "-- More --" in row for row in pane[-4:]):
            break
        text_rows = [row.rstrip() for row in pane[: height - 1]]
        recorded = {"y": y, "x": x, "rows": text_rows, "last": pane[height - 1].rstrip() if len(pane) >= height else "", "height": height, "width": width}
        if attrs:
            recorded["attrs"] = snap[5][: height]
        steps.append(recorded)
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

CLICK_MOVES = ["l", "j", "k", "$", "0", "w", "G", "gg", "i", "a", "A", "<Esc>", "v", "V", "x", "10l", "20l", "<C-f>", "<C-e>", "3<C-e>", "zz", "zt", "5j", "20j", "<C-d>"]

def gen_click(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([3, 8, 20, 40])
        rows, cols = r.choice([6, 10, 14, 24]), r.choice([30, 40, 60, 80])
        steps = []
        for _ in range(r.randint(3, 9)):
            if r.random() < 0.55:
                steps.append("@click:%d:%d" % (r.randint(0, rows - 1), r.randint(0, cols - 1)))
            else:
                steps.append(r.choice(CLICK_MOVES))
        cases.append({"id": "clk%d-%d" % (seed, i), "text": rand_buffer(r, n), "rows": rows, "cols": cols, "mouse": r.choice(["a", "a", "a", "n", "nv", "i", "v", "nvi", ""]),
                      "setup": r.choice(CELL_SETUPS + SCROLL_SETUPS), "steps": steps})
    return cases

HL_PATTERNS = ["foo", "bar", "a", "x", "o", "e$", "^", "$", "x*", "b\\|f", "[a-z]\\+", "中", "é", "tab", "\\.", "a_b", ".", "end\\.$", "[[]", "\\(foo\\)", "foo\\|bar", "ba."]
HL_WORD_STEPS = ["*", "#", "g*", "g#"]
ASCII_WORDS = ["foo", "bar", "baz", "Hello", "world", "a_b", "x", "tab\there", "(x)", "[1,2]", "end."]
HL_PATTERNS_WIDE = HL_PATTERNS + ["\\n", "foo\\nba", "\\v(foo|bar)", "\\cHELLO", "\\CHello", "\\s\\+", "\\t", "\\<\\w", "\\zsfoo", "\\%2l", "\\%>5c", "x\\|", "\\(foo\\)\\@<=", "\\d"]
HL_SETUPS = [["set hls"]] * 5 + [["set hls", "set ic"], ["set hls", "set nu"], ["set hls", "set list"], ["set hls", "set nowrap"], ["set hls", "set cc=10"], ["set hls", "set ts=4"],
             ["set hls", "set so=3"], ["set hls", "set rnu"], ["set hls", "set list lcs=tab:>-,trail:~,eol:$"], ["set hls", "set dy=lastline"], [], ["set hls", "set nowrap list"],
             ["set hls", "set ic", "set nu"], ["set hls", "set ss=1 nowrap"]]
HL_FIXED = ["n", "n", "N", ":noh<CR>", ":noh<CR>", ":set nohls<CR>", ":set hls<CR>", ":set hls!<CR>", ":set hls<CR>", "v", "V", "<C-v>", "<Esc>", "l", "j", "k", "w", "b", "$", "0",
            "G", "gg", "x", "dd", "u", "ix<Esc>", "ofoo<Esc>", "A bar<Esc>", "<C-e>", "<C-y>", "<C-d>", "<C-u>", "zt", "zz", "gn", "3j", "5k", "10l", "<C-r>", "J"]

def hl_step(r, patterns, ascii_only):
    pick = r.random()
    pat = r.choice(patterns)
    if ascii_only and pick > 0.95:
        return r.choice(HL_WORD_STEPS)
    if pick < 0.22:
        return "/%s<CR>" % pat
    if pick < 0.30:
        return "?%s<CR>" % pat
    if pick < 0.34:
        return ":s/%s/X/<CR>" % pat
    if pick < 0.37:
        return ":%%s/%s/Y/g<CR>" % pat
    if pick < 0.39:
        return ":g/%s/s/o/0/<CR>" % pat
    return r.choice(HL_FIXED)

def leave_visual(steps):
    out, visual = [], False
    for step in steps:
        if visual and step.startswith(":"):
            step = "<Esc>" + step
        if step in ("v", "V", "<C-v>"):
            visual = True
        elif step.startswith(":") or step.startswith("<Esc>") or step in ("gn",):
            visual = step == "gn"
        out.append(step)
    return out

def gen_hl(seed, count, patterns=None):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([3, 6, 10, 20, 40])
        ascii_only = r.random() < 0.4
        steps = leave_visual([hl_step(r, patterns or HL_PATTERNS, ascii_only) for _ in range(r.randint(3, 9))])
        text = [" ".join(r.choice(ASCII_WORDS) for _ in range(r.randint(0, 9))) for _ in range(n)] if ascii_only else rand_buffer(r, n)
        cases.append({"id": "hl%d-%d" % (seed, i), "text": text, "rows": r.choice([6, 8, 10, 14, 24]), "cols": r.choice([30, 40, 60, 80]),
                      "setup": r.choice(HL_SETUPS), "steps": steps, "attrs": True})
    return cases

IS_SETUPS = [[], [], ["set hls"], ["set hls"], ["set so=3"], ["set nu"], ["set nowrap"], ["set ic"], ["set nows"], ["set nois"], ["set hls", "set nowrap list"],
             ["set hls", "set ic"], ["set so=0"], ["set so=999"], ["set list lcs=tab:>-,trail:~,eol:$"], ["set sidescroll=0 nowrap"]]
IS_PATTERNS = ["foo", "bar", "a_b", "x", "o", "e$", "^", "$", "x*", "b\\|f", "tab", "ba.", "end\\.$", "Hello", "world", "(x)", "[1,2]", "foo\\|bar", "[a-z]\\+", "\\.", "."]
IS_MOVES = ["n", "N", "j", "k", "G", "gg", "<C-e>", "<C-y>", "zt", "zz", "zb", "5j", "5k", "<C-d>", "<C-u>", "$", "0", "w", "x", "dd", "u", ":noh<CR>", "3j", "10l"]

def chunks(r, text):
    out, i = [], 0
    while i < len(text):
        n = r.choice([1, 1, 2, 3])
        out.append(text[i:i + n])
        i += n
    return out

def is_session(r):
    steps = []
    opener = r.choice(["/", "/", "/", "?", "?", "2/", "3/", "2?"])
    pat = r.choice(IS_PATTERNS)
    parts = chunks(r, pat)
    steps.append(opener + parts[0])
    for part in parts[1:]:
        steps.append(part)
        if r.random() < 0.15:
            steps.append("<BS>")
            steps.append(part[-1:] if part else "x")
    roll = r.random()
    if roll < 0.06:
        steps.append("<C-l>")
    elif roll < 0.09:
        steps.append("<C-w>")
    elif roll < 0.11:
        steps.append("<C-u>")
        steps.append(r.choice(IS_PATTERNS))
    elif roll < 0.18:
        steps.append("<C-g>")
    elif roll < 0.26:
        steps.append("<C-t>")
    elif roll < 0.32:
        steps.append("<C-g><C-g>")
    elif roll < 0.37:
        steps.append("<C-t><C-t>")
    steps.append(r.choice(["<CR>", "<CR>", "<CR>", "<Esc>", "<Esc>"]))
    return steps

def gen_is(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([20, 40, 80, 150])
        text = rand_buffer(r, n)
        steps = []
        for _ in range(r.randint(1, 3)):
            if r.random() < 0.5:
                steps.append(r.choice(IS_MOVES))
            steps.extend(is_session(r))
        cases.append({"id": "is%d-%d" % (seed, i), "text": text, "rows": r.choice([6, 8, 10, 14, 24]), "cols": r.choice([40, 60, 80]),
                      "setup": r.choice(IS_SETUPS), "steps": steps, "attrs": True, "slow": True})
    return cases

IS_EX_OPENERS = [":s/", ":s/", ":%s/", ":%s/", ":g/", ":v/", ":2,5s/", ":.,+3s/", ":$s/", ":s#", ":g!/"]

def is_ex_session(r):
    opener = r.choice(IS_EX_OPENERS)
    pat = r.choice(IS_PATTERNS)
    parts = chunks(r, pat)
    steps = [opener + parts[0]]
    steps.extend(parts[1:])
    substitute = ":s" in opener or ":%s" in opener or "s#" in opener
    if substitute and r.random() < 0.5:
        steps.append("#" if "#" in opener else "/")
        steps.append(r.choice(["X", "Y/g", "0"]))
    steps.append(r.choice(["<CR>", "<CR>", "<Esc>"]) if substitute else "<Esc>")
    return steps

def gen_is_ex(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([20, 40, 80])
        text = rand_buffer(r, n)
        steps = []
        for _ in range(r.randint(1, 3)):
            if r.random() < 0.5:
                steps.append(r.choice(IS_MOVES))
            steps.extend(is_ex_session(r))
        cases.append({"id": "ise%d-%d" % (seed, i), "text": text, "rows": r.choice([6, 8, 10, 14, 24]), "cols": r.choice([40, 60, 80]),
                      "setup": r.choice(IS_SETUPS), "steps": steps, "attrs": True, "slow": True})
    return cases

SM_LINES = ["if (x) {", "    foo(bar[1], baz);", "}", "int main(void)", "{", "    return (a + (b * c));", "}", "x = [1, 2, [3, 4]];", "call(a, b", "    , c);",
            "} else {", "unbalanced )", "plain text", "", "    {", "(a) (b) (c)", "<tag attr=\"v\">", "func(\"a)\", 'b)')", "#define M(x) ((x) + 1)", "a[i] = b[(j + 1) % n];"]
SM_SETUPS = [["set sm"], ["set sm"], ["set sm"], ["set sm", "set mat=0"], ["set sm", "set mps+=<:>"], ["set sm", "set nowrap"], ["set sm", "set nu"],
             ["set sm", "set so=0"], [], ["set sm", "set mps="], ["set sm", "set mps=(:)"], ["set sm", "set list"], ["set sm", "set ts=4"], ["set sm", "set nowrap", "set ss=1"]]
SM_CHUNKS = ["foo", "x", "1", " ", "(", "[", "{", "<", ")", "]", "}", ">", "a)", "b]", "c}", "d>", "(x)", "[y]", "{z}", "\"", "'", ",", ":"]

def sm_session(r):
    steps = []
    steps.append(r.choice(["A", "A", "o", "O", "i", "I", "a", "cc", "S"]))
    for _ in range(r.randint(2, 6)):
        chunk = r.choice(SM_CHUNKS)
        steps.append(chunk)
        if chunk[-1:] in ")]}>":
            if r.random() < 0.5:
                steps.append("@wait")
    steps.append("<Esc>")
    return steps

def gen_sm(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([4, 8, 14, 20])
        text = [r.choice(SM_LINES) for _ in range(n)]
        steps = []
        for _ in range(r.randint(1, 2)):
            steps.append(r.choice(["gg", "G", "j", "k", "2j", "3j", "$", "0", "w", "5j", "%", "l"]))
            steps.extend(sm_session(r))
            if r.random() < 0.3:
                steps.extend(["r" + r.choice(")]}>"), "@wait"])
        cases.append({"id": "sm%d-%d" % (seed, i), "text": text, "rows": r.choice([5, 6, 8, 10, 24]), "cols": r.choice([30, 40, 60, 80]),
                      "setup": r.choice(SM_SETUPS), "steps": steps, "attrs": True, "slow": True})
    return cases

def main():
    args = sys.argv[1:]
    seed, count, corpus, out, source = 1, 60, "cells", None, None
    i = 0
    while i < len(args):
        if args[i] == "--seed": seed = int(args[i + 1]); i += 2
        elif args[i] == "--cases": count = int(args[i + 1]); i += 2
        elif args[i] == "--corpus": corpus = args[i + 1]; i += 2
        elif args[i] == "--from": source = args[i + 1]; i += 2
        else: out = args[i]; i += 1
    if source is not None:
        cases = json.load(open(source))["cases"]
        corpus = "labs"
    else:
        cases = {"cells": gen_cells, "scroll": gen_scroll, "resize": gen_resize, "click": gen_click, "hl": gen_hl, "is": gen_is, "isex": gen_is_ex, "sm": gen_sm, "hlwide": lambda seed, count: gen_hl(seed, count, HL_PATTERNS_WIDE)}[corpus](seed, count)
    with tempfile.TemporaryDirectory() as workdir:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda c: run_case(c, workdir), cases))
    version = subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    json.dump({"vim": version, "corpus": corpus, "cases": results}, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(results), "cases ->", out)

main()
