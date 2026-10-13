#!/usr/bin/env python3
"""Record whole-screen transcripts from a real GNU nano driven through tmux.

usage: record_nano_screen.py --corpus cells|scroll|resize|prompts|cli|place|layout|edit|wrap [--seed N] [--cases N] [--from cases.json] out.json

A case is a buffer, a pane size, nano's command-line flags and a list of steps; a step is a tmux
key token (`Left`, `C-a`, `M-n`, `PageDown`, ...), a run of literal text (`-l`) or `@ROWSxCOLS`,
which resizes the pane (a run of literal text is sent one character at a time, 40 ms apart, because nano
wraps a burst of typed characters once at its end).  The real nano runs inside a pane of the given size (started with `-I`, so
no rc file is read); the first record is the screen right after nano opened the file, then one
record per step: every row of the pane (title bar, edit window, status bar and the two shortcut
rows), the cursor cell and the pane size.  A case with `"disk": true` (every case of the edit
corpus) also records the files left in the directory after each step.
"""
import argparse, json, os, random, re, shlex, subprocess, tempfile, time
from concurrent.futures import ThreadPoolExecutor

LITERAL = re.compile(r"^[^A-Z][\s\S]*$")
KEYS = {"Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "Enter", "Tab", "BSpace", "DC", "Escape", "Space"}

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

def send(name, token):
    if token in KEYS or re.match(r"^(C|M)-.+$", token) or token in ("C-Left", "C-Right"):
        tmux("send-keys", "-t", name, token)
    else:
        for index, char in enumerate(token):
            if index:
                time.sleep(0.04)
            tmux("send-keys", "-t", name, "-l", "\\;" if char == ";" else char)

def snapshot(name):
    cur = tmux("display", "-p", "-t", name, "#{cursor_y} #{cursor_x} #{pane_height} #{pane_width}").split()
    if len(cur) < 4:
        return None
    pane = tmux("capture-pane", "-p", "-t", name).split("\n")
    return int(cur[0]), int(cur[1]), int(cur[2]), int(cur[3]), pane

def settled(name):
    last = None
    for _ in range(40):
        time.sleep(0.05)
        snap = snapshot(name)
        if snap is None:
            return None
        if snap == last:
            return snap
        last = snap
    return last

def record_disk(casedir):
    disk = {}
    for entry in sorted(os.listdir(casedir)):
        path = os.path.join(casedir, entry)
        if not entry.startswith(".") and os.path.isfile(path):
            disk[entry] = open(path, "rb").read().decode("utf-8", "replace")
    return disk

def record_screen(name, casedir=None):
    snap = settled(name)
    if snap is None:
        return None
    y, x, height, width, pane = snap
    record = {"y": y, "x": x, "height": height, "width": width, "rows": [r.rstrip() for r in pane[:height]]}
    if casedir is not None:
        record["disk"] = record_disk(casedir)
    return record

def run_case(case, workdir):
    name = "ns%d_%s" % (os.getpid(), re.sub(r"\W", "", case["id"]))
    casedir = os.path.join(workdir, case["id"])
    os.makedirs(casedir, exist_ok=True)
    open(os.path.join(casedir, "t.txt"), "w", encoding="utf-8").write("\n".join(case["text"]) + "\n")
    tmux("kill-session", "-t", name)
    flags = " ".join(case.get("flags", []))
    tmux("new-session", "-d", "-x", str(case["cols"]), "-y", str(case["rows"]), "-s", name,
         "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color nano -I %s t.txt" % (casedir, flags))
    opened = record_screen(name, casedir if case.get("disk") else None)
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
        snap = record_screen(name, casedir if case.get("disk") else None)
        if snap is None:
            break
        after.append(snap)
    tmux("kill-session", "-t", name)
    return dict(case, steps=case["steps"][:len(after)], opened=opened, after=after)

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
TOGGLES = ["M-n", "M-s", "M-x", "M-c", "M-z"]
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

ANSI = re.compile(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|[=>])|\x0f")

def run_cli_case(case, workdir):
    casedir = os.path.join(workdir, case["id"])
    os.makedirs(casedir, exist_ok=True)
    open(os.path.join(casedir, "t.txt"), "w", encoding="utf-8").write("\n".join(case["text"]) + "\n")
    for extra_name, extra_lines in case.get("files", {}).items():
        open(os.path.join(casedir, extra_name), "w", encoding="utf-8").write("\n".join(extra_lines) + "\n")
    env = dict(os.environ, LANG="C.UTF-8", LC_ALL="C.UTF-8", TERM="xterm-256color")
    done = subprocess.run(["nano", "-I"] + case["args"], cwd=casedir, capture_output=True, text=True, stdin=subprocess.DEVNULL, env=env, timeout=10)
    stderr = ANSI.sub("", done.stderr).rstrip("\n")
    opens = stderr.endswith("Standard input is not a terminal")
    record = dict(case, status=done.returncode)
    if opens:
        record["opens"] = True
        name = "nc%d_%s" % (os.getpid(), re.sub(r"\W", "", case["id"]))
        tmux("kill-session", "-t", name)
        tmux("new-session", "-d", "-x", str(case["cols"]), "-y", str(case["rows"]), "-s", name,
             "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color nano -I %s" % (casedir, " ".join(shlex.quote(a) for a in case["args"])))
        record["opened"] = record_screen(name, casedir if case.get("disk") else None)
        record["after"] = []
        for step in case.get("steps", []):
            if step.startswith("@"):
                rows_, cols_ = step[1:].split("x")
                tmux("resize-window", "-t", name, "-x", cols_, "-y", rows_)
                time.sleep(0.2)
            else:
                send(name, step)
            snap = record_screen(name, casedir if case.get("disk") else None)
            if snap is None:
                break
            record["after"].append(snap)
        record["steps"] = case.get("steps", [])[:len(record["after"])]
        tmux("kill-session", "-t", name)
    else:
        record["opens"] = False
        record["stdout"] = ANSI.sub("", done.stdout).rstrip("\n")
        record["stderr"] = stderr
    return record

CLI_FLAGS_PLAIN = list("ABDEFGHIKLMNOPRSUWZacdegijklmnpqtuvwxy%_0$")
CLI_LONG_FLAGS = ["smarthome", "backup", "boldtext", "tabstospaces", "multibuffer", "locking", "historylog", "ignorercfiles", "rawsequences", "nonewlines", "noconvert", "bookstyle", "positionlog", "restricted", "softwrap", "quickblank", "wordbounds", "zap", "atblanks", "breaklonglines", "constantshow", "cutfromcursor", "rebinddelete", "emptyline", "showcursor", "autoindent", "jumpyscrolling", "linenumbers", "mouse", "noread", "preserve", "indicator", "saveonexit", "unix", "view", "nowrap", "nohelp", "afterends", "stateflags", "minibar", "zero", "trimblanks"]
CLI_NUMBERS = ["4", "4", "8", "2", "0", "-3", "abc", "", "+2", " 4", "4 ", "08", "99999999999999999999", "1k"]
CLI_PLUS = ["+3", "+1", "+5,2", "+,3", "+0", "+-1", "+99", "+3,", "+5x", "+3.4", "+3:4", "+/foo", "+?foo", "+c/Foo", "+C/Foo", "+r/f.o", "+R/f.o", "+/", "+x", "+b/foo", "+cr/fo+", "+/zzz", "+?", "+ 3", "+3,2,1", "+-2,-1", "+/foo/bar"]
CLI_ERRORS = ["--zork", "--zork=3", "--no", "--tab", "--tab=4", "--v", "--nowrap=3", "--help=3", "-z", "-?", "-@", "-1", "-Tx", "-T", "-r", "-J", "-!", "--=3"]
CLI_PRINTS = ["-h", "-V", "--help", "--version", "--he", "--ver", "-vh", "-hv", "-Vh", "-h", "-V"]

def cli_flag_group(r):
    letters = r.sample(CLI_FLAGS_PLAIN, r.randint(1, 3))
    return "-" + "".join(letters)

def cli_arguments(r):
    args = []
    for _ in range(r.randint(0, 4)):
        kind = r.random()
        if kind < 0.35:
            args.append(cli_flag_group(r))
        elif kind < 0.50:
            args.append("--" + r.choice(CLI_LONG_FLAGS))
        elif kind < 0.58:
            name = r.choice(CLI_LONG_FLAGS)
            args.append("--" + name[: r.randint(max(2, len(name) - 4), len(name))])
        elif kind < 0.70:
            letter, long = r.choice([("T", "tabsize"), ("r", "fill"), ("J", "guidestripe")])
            value = r.choice(CLI_NUMBERS)
            form = r.random()
            if form < 0.4:
                args.extend(["-" + letter, value])
            elif form < 0.6:
                args.append("-" + letter + value)
            elif form < 0.8:
                args.append("--" + long + "=" + value)
            else:
                args.extend(["--" + long, value])
        elif kind < 0.78:
            args.append(r.choice(CLI_PLUS))
        elif kind < 0.84:
            args.append(r.choice(CLI_ERRORS))
        elif kind < 0.88:
            args.append(r.choice(CLI_PRINTS))
        elif kind < 0.92:
            args.extend([r.choice(["-X", "-Y", "-s", "-Q"]), r.choice(["ab", "sh", "x"])])
        elif kind < 0.95:
            args.extend([r.choice(["-o", "-C"]), "/tmp"])
        else:
            args.append("--")
    return args

def gen_cli(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        args = cli_arguments(r)
        operands = r.choice([["t.txt"], ["t.txt"], ["t.txt"], ["t.txt"], ["u.txt"], [], ["t.txt", "u.txt"], ["+2", "t.txt"]])
        if r.random() < 0.7:
            args = args + operands
        else:
            at = r.randint(0, len(args))
            args = args[:at] + operands + args[at:]
        text = rand_buffer(r, r.choice([3, 6, 12, 30]))
        text[r.randrange(len(text))] += " foo bar"
        rows, cols = r.choice([(10, 50), (14, 60), (24, 80), (12, 40)])
        steps = r.choice([[], [], [], ["C-w"], ["C-w", "C-c"], ["C-w", "Enter"], ["Down", "Right"], ["C-_", "C-c"]])
        cases.append({"id": "cli%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": args, "steps": steps})
    return cases

def gen_place(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        n = r.choice([3, 6, 12, 25, 60])
        text = []
        for _ in range(n):
            kind = r.random()
            if kind < 0.1:
                text.append("")
            elif kind < 0.55:
                text.append(" ".join(r.choice(WORDS) for _ in range(r.randint(1, 6))))
            else:
                text.append(" ".join(r.choice(WORDS) for _ in range(r.randint(10, 60))))
        rows, cols = r.choice([(8, 30), (10, 40), (10, 60), (14, 50), (14, 60), (14, 70), (20, 60), (24, 80)])
        flags = r.choice([["-S"], ["-S"], ["-Sl"], ["-l"], []])
        target = r.choice(["+", "+-1", "+99", "+3", "+5", "+%d" % r.randint(2, n + 2), "+%d,%d" % (r.randint(1, n), r.randint(1, 30)), "+%d,-1" % r.randint(1, n)])
        cases.append({"id": "plc%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + [target, "t.txt"], "steps": []})
    return cases

LAYOUT_FLAGS = ["-x", "-e", "-%", "-_", "-0"]
LAYOUT_EXTRA = ["-l", "-S", "-c", "-v"]

def gen_layout(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = rand_buffer(r, r.choice([1, 3, 8, 20, 40]))
        rows, cols = r.choice([(2, 40), (3, 40), (4, 40), (5, 40), (6, 40), (7, 50), (8, 40), (10, 30), (10, 60), (14, 60), (24, 80), (24, 40)])
        flags = r.sample(LAYOUT_FLAGS, r.choice([1, 1, 1, 2, 2, 3])) + r.sample(LAYOUT_EXTRA, r.choice([0, 0, 1, 2]))
        steps = [r.choice(MOVES + EDITS + ["M-a"]) for _ in range(r.randint(2, 8))]
        if r.random() < 0.3:
            steps = steps + prompt_script(r)
        if r.random() < 0.25:
            steps.insert(r.randint(0, len(steps)), "@%dx%d" % (r.choice([3, 4, 5, 6, 8, 12, 20]), r.choice([30, 40, 60, 80])))
        if r.random() < 0.2:
            steps.insert(r.randint(0, len(steps)), r.choice(TOGGLES))
        cases.append({"id": "lay%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "flags": flags, "steps": steps})
    return cases

EDIT_FOCUS = {
    "-i": ["Enter", "Enter", "End", "Home", "C-e", "Tab", "x"],
    "-E": ["Tab", "Tab", "BSpace", "Enter", "Home", "x"],
    "-T3": ["Tab", "Tab", "Enter", "Home", "End"],
    "-T4": ["Tab", "Tab", "Enter", "Home", "End"],
    "-A": ["Home", "Home", "Home", "C-a", "End", "Down", "Up"],
    "-k": ["C-k", "C-k", "C-u", "Right", "Right", "M-6", "C-u"],
    "-Z": ["M-a", "Right", "Right", "Down", "BSpace", "DC", "M-a"],
    "-L": ["Enter", "C-e", "M-/", "BSpace", "x"],
    "-y": ["C-Right", "C-Right", "C-Left", "C-Right"],
    "-W": ["C-Right", "C-Right", "C-Left", "C-Right"],
    "-Xab": ["C-Right", "C-Right", "C-Left", "C-Right"],
    "-j": ["Down", "Down", "Down", "Up", "Up", "PageDown", "Down"],
    "-O": ["C-j", "Down", "M-j"],
}
EDIT_KEYS = ["Tab", "Tab", "Enter", "Enter", "Home", "End", "C-a", "C-e", "C-k", "C-k", "C-u", "C-d", "BSpace", "DC", "Left", "Right", "Up", "Down", "C-Left", "C-Right", "M-6", "M-a", "x", "yz", " ", "  ", "a_b", "M-\\", "M-/", "PageDown", "PageUp"]

def edit_line(r):
    line = rand_line(r, long_chance=0.1)
    if r.random() < 0.35:
        line = r.choice([" ", "  ", "\t", "    ", " \t", "\t\t", "   "]) + line.lstrip()
    if r.random() < 0.2:
        line += r.choice([" ", "  ", "\t", " \t "])
    if r.random() < 0.2:
        line = line.replace(" ", "." if r.random() < 0.5 else ",", 1)
    return line

def gen_edit(seed, count):
    r = random.Random(seed)
    focus = list(EDIT_FOCUS)
    cases = []
    for i in range(count):
        flag = focus[i % len(focus)]
        n = r.choice([3, 6, 12, 40]) if flag == "-j" else r.choice([1, 3, 6, 12])
        text = [edit_line(r) for _ in range(n)]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50)]) if flag != "-j" else r.choice([(6, 40), (8, 50), (10, 40)])
        others = r.sample(["-i", "-E", "-T2", "-T4", "-A", "-k", "-Z", "-L", "-y", "-W", "-l", "-S"], r.choice([0, 0, 1, 1, 2]))
        flags = list(dict.fromkeys([flag] + others))
        steps = [r.choice(EDIT_FOCUS[flag] * 2 + EDIT_KEYS) for _ in range(r.randint(4, 14))]
        for _ in range(r.choice([0, 1, 1])):
            at = r.randint(1, len(steps))
            steps[at:at] = ["C-o", "Enter"]
        steps = steps + ["C-o", "Enter"]
        cases.append({"id": "edt%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "flags": flags, "steps": steps, "disk": True})
    return cases

WRAP_FLAGS = ["-O", "-M", "-b", "-r20", "-r30", "-r10", "-r0", "-r-4", "-i", "-w", "-S", "-a", "-k", "-E"]
WRAP_KEYS = ["C-j", "C-j", "M-j", "M-a", "Down", "Down", "Up", "End", "Home", "C-e", "Enter", "BSpace", "DC", "Tab", "Left", "Right", "C-Right", "PageDown", "M-\\", "M-/", "C-u", "C-k"]
WRAP_TYPED = ["the quick brown fox jumps over the lazy dog", "a b c d e f g h i j k l m n o p", "supercalifragilisticexpialidocious and more", "x", "yz  ", "end. Next sentence! Another? Yes.", "foo,bar baz;qux", "word ", "  ", "\tindented words keep going on and on"]

def wrap_paragraph(r):
    prefix = r.choice(["", "", "", "> ", "# ", "// ", ">> ", "  "])
    indent = r.choice(["", "", "", "  ", "    ", "\t"])
    lines = []
    for i in range(r.randint(1, 5)):
        words = " ".join(r.choice(WORDS + ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "end.", "Hello!", "why?"]) for _ in range(r.randint(2, 14)))
        lead = prefix + (indent if i == 0 or r.random() < 0.7 else r.choice(["", "  ", "    "]))
        trail = r.choice(["", "", "", " ", "  ", "\t"]) if r.random() < 0.3 else ""
        lines.append(lead + words + trail)
    return lines

def gen_wrap(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = []
        for _ in range(r.randint(1, 4)):
            text.extend(wrap_paragraph(r))
            if r.random() < 0.85:
                text.append(r.choice(["", "", " "]))
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50), (10, 30)])
        flags = r.sample(WRAP_FLAGS, r.choice([0, 1, 1, 2, 2, 3]))
        if "-r0" in flags or "-r10" in flags:
            flags = [f for f in flags if f not in ("-r20", "-r30", "-r-4")]
        steps = []
        for _ in range(r.randint(3, 10)):
            if r.random() < 0.3:
                steps.append(r.choice(WRAP_TYPED))
            else:
                steps.append(r.choice(WRAP_KEYS))
        steps += ["C-o", "Enter"]
        cases.append({"id": "wrp%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "flags": flags, "steps": steps, "disk": True})
    return cases

def gen(seed, count, corpus):
    if corpus == "prompts":
        return gen_prompts(seed, count)
    if corpus == "cli":
        return gen_cli(seed, count)
    if corpus == "place":
        return gen_place(seed, count)
    if corpus == "layout":
        return gen_layout(seed, count)
    if corpus == "edit":
        return gen_edit(seed, count)
    if corpus == "wrap":
        return gen_wrap(seed, count)
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
    ap.add_argument("--from", dest="source")
    ap.add_argument("out")
    a = ap.parse_args()
    cases = json.load(open(a.source))["cases"] if a.source else gen(a.seed, a.cases, a.corpus)
    runner = run_cli_case if a.corpus in ("cli", "place") else run_case
    with tempfile.TemporaryDirectory() as workdir:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda c: runner(c, workdir), cases))
    version = subprocess.run(["nano", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    json.dump({"nano": version, "corpus": a.corpus, "cases": results}, open(a.out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(results), "cases ->", a.out)

main()
