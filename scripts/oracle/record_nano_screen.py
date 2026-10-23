#!/usr/bin/env python3
"""Record whole-screen transcripts from a real GNU nano driven through tmux.

usage: record_nano_screen.py --corpus cells|scroll|resize|prompts|cli|place|layout|edit|wrap|tools|insert|open|undo|undo2|search|help|blocks|exec [--seed N] [--cases N] [--from cases.json] [--workdir DIR] out.json

A case with `"attrs": true` also records, for every row, one letter per cell: `.` default, `r` reverse, `b` bold, `a` bold white on red
(the error colour), `y` black on bright yellow (the spotlight), `R` red background alone and `?` anything else, read from `capture-pane -e -N`.

A case is a buffer, a pane size, nano's command-line flags and a list of steps; a step is a tmux
key token (`Left`, `C-a`, `M-n`, `PageDown`, ...), a run of literal text (`-l`) or `@ROWSxCOLS`,
which resizes the pane (a run of literal text is sent one character at a time, 40 ms apart, because nano
wraps a burst of typed characters once at its end).  The real nano runs inside a pane of the given size (started with `-I`, so
no rc file is read); the first record is the screen right after nano opened the file, then one
record per step: every row of the pane (title bar, edit window, status bar and the two shortcut
rows), the cursor cell and the pane size.  A case with `"disk": true` (every case of the edit
corpus) also records the files left in the directory after each step.
"""
import argparse, contextlib, itertools, json, os, random, re, shlex, shutil, subprocess, tempfile, time, unicodedata
from concurrent.futures import ThreadPoolExecutor

SESSION_NUMBERS = itertools.count()
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

SGR = re.compile(r"(\x1b\[[0-9;]*m)")

def cell_width(char):
    if unicodedata.combining(char) or unicodedata.category(char) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1

def style_letter(bold, reverse, fg, bg):
    if reverse and not bold and fg is None and bg is None:
        return "r"
    if bold and not reverse and fg is None and bg is None:
        return "b"
    if bold and not reverse and fg == 37 and bg == 41:
        return "a"
    if not bold and not reverse and fg == 30 and bg == 103:
        return "y"
    if not bold and not reverse and fg is None and bg == 41:
        return "R"
    if not bold and not reverse and fg is None and bg is None:
        return "."
    return "?"

def capture_attrs(name, width, height):
    raw = tmux("capture-pane", "-e", "-p", "-N", "-t", name).split("\n")
    state = {"bold": False, "reverse": False, "fg": None, "bg": None}
    rows = []
    for index in range(height):
        row = raw[index] if index < len(raw) else ""
        letters = []
        for token in SGR.split(row):
            if SGR.fullmatch(token):
                for code in [int(p) if p else 0 for p in token[2:-1].split(";")] or [0]:
                    if code == 0:
                        state.update(bold=False, reverse=False, fg=None, bg=None)
                    elif code == 1:
                        state["bold"] = True
                    elif code == 7:
                        state["reverse"] = True
                    elif code == 22:
                        state["bold"] = False
                    elif code == 27:
                        state["reverse"] = False
                    elif 30 <= code <= 37 or 90 <= code <= 97:
                        state["fg"] = code
                    elif code == 39:
                        state["fg"] = None
                    elif 40 <= code <= 47 or 100 <= code <= 107:
                        state["bg"] = code
                    elif code == 49:
                        state["bg"] = None
                continue
            for char in token:
                letters.extend(style_letter(state["bold"], state["reverse"], state["fg"], state["bg"]) * cell_width(char))
        rows.append("".join(letters)[:width].ljust(width, "."))
    return rows

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

LOCK_SIZE = 1024

def lock_fields(data):
    text = lambda a, b: data[a:b].split(b"\0")[0].decode("utf-8", "replace")
    return {"lock": {"program": text(2, 12), "pid": int.from_bytes(data[24:28], "little"), "user": text(28, 44),
                     "host": text(68, 100), "name": text(108, 876), "modified": data[1007] == 0x55}}

def lock_bytes(program, pid, user, host, name, modified):
    data = bytearray(LOCK_SIZE)
    data[0], data[1] = 0x62, 0x30
    data[2:2 + len(program)] = program.encode()
    data[24:28] = pid.to_bytes(4, "little")
    data[28:28 + len(user)] = user.encode()
    data[68:68 + len(host)] = host.encode()
    data[108:108 + len(name)] = name.encode()
    data[1007] = 0x55 if modified else 0
    return bytes(data)

def record_disk(casedir, hidden=False):
    disk = {}
    sim_root = casedir.replace("/", "!")
    for here, _dirs, names in os.walk(casedir):
        for entry in sorted(names):
            relative = os.path.relpath(os.path.join(here, entry), casedir)
            if not hidden and any(part.startswith(".") for part in relative.split(os.sep)):
                continue
            raw = open(os.path.join(here, entry), "rb").read()
            key = relative.replace(sim_root, "!tmp")
            if len(raw) == LOCK_SIZE and raw[0] == 0x62 and raw[1] == 0x30:
                disk[key] = lock_fields(raw)
            else:
                disk[key] = raw.decode("utf-8", "replace")
    return disk

def record_screen(name, casedir=None, hidden=False, attrs=False):
    snap = settled(name)
    if snap is None:
        return None
    y, x, height, width, pane = snap
    record = {"y": y, "x": x, "height": height, "width": width, "rows": [r.rstrip() for r in pane[:height]]}
    if attrs:
        record["attrs"] = capture_attrs(name, width, height)
    if casedir is not None:
        record["disk"] = record_disk(casedir, hidden)
    return record

def run_case(case, workdir):
    name = "ns%d_%06d" % (os.getpid(), next(SESSION_NUMBERS))
    casedir = os.path.join(workdir, case["id"])
    os.makedirs(casedir, exist_ok=True)
    open(os.path.join(casedir, "t.txt"), "w", encoding="utf-8").write("\n".join(case["text"]) + "\n")
    tmux("kill-session", "-t", name)
    flags = " ".join(case.get("flags", []))
    tmux("new-session", "-d", "-x", str(case["cols"]), "-y", str(case["rows"]), "-s", name,
         "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color nano -I %s t.txt" % (casedir, flags))
    opened = record_screen(name, casedir if case.get("disk") else None, False, case.get("attrs", False))
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
        snap = record_screen(name, casedir if case.get("disk") else None, False, case.get("attrs", False))
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
        os.makedirs(os.path.dirname(os.path.join(casedir, extra_name)), exist_ok=True)
        open(os.path.join(casedir, extra_name), "w", encoding="utf-8").write("\n".join(extra_lines) + "\n")
    for raw_name, hexdata in case.get("raw", {}).items():
        open(os.path.join(casedir, raw_name), "wb").write(bytes.fromhex(hexdata))
    for mode_name, mode in case.get("modes", {}).items():
        os.chmod(os.path.join(casedir, mode_name), mode)
    for lock_name, fields in case.get("locks", {}).items():
        open(os.path.join(casedir, lock_name), "wb").write(lock_bytes(fields["program"], fields["pid"], fields["user"], fields["host"], fields["name"], fields.get("modified", False)))
    env = dict(os.environ, LANG="C.UTF-8", LC_ALL="C.UTF-8", TERM="xterm-256color")
    if case.get("force_open"):
        opens, done = True, None
    else:
        done = subprocess.run(["nano", "-I"] + case["args"], cwd=casedir, capture_output=True, text=True, stdin=subprocess.DEVNULL, env=env, timeout=10)
        opens = ANSI.sub("", done.stderr).rstrip("\n").endswith("Standard input is not a terminal")
    record = dict(case, status=0 if done is None else done.returncode, casedir=casedir)
    hidden = bool(case.get("hidden"))
    disk_dir = casedir if case.get("disk") else None
    if opens:
        record["opens"] = True
        name = "nc%d_%06d" % (os.getpid(), next(SESSION_NUMBERS))
        tmux("kill-session", "-t", name)
        tmux("new-session", "-d", "-x", str(case["cols"]), "-y", str(case["rows"]), "-s", name,
             "cd %s && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color nano -I %s" % (casedir, " ".join(shlex.quote(a) for a in case["args"])))
        record["opened"] = record_screen(name, disk_dir, hidden, case.get("attrs", False))
        record["after"] = []
        for step in case.get("steps", []):
            if step.startswith("@"):
                rows_, cols_ = step[1:].split("x")
                tmux("resize-window", "-t", name, "-x", cols_, "-y", rows_)
                time.sleep(0.2)
            else:
                send(name, step)
            snap = record_screen(name, disk_dir, hidden, case.get("attrs", False))
            if snap is None:
                record["exit_step"] = step
                if disk_dir is not None:
                    time.sleep(0.3)
                    record["final_disk"] = record_disk(casedir, hidden)
                break
            record["after"].append(snap)
        record["steps"] = case.get("steps", [])[:len(record["after"])]
        tmux("kill-session", "-t", name)
    else:
        record["opens"] = False
        record["stdout"] = ANSI.sub("", done.stdout).rstrip("\n")
        record["stderr"] = ANSI.sub("", done.stderr).rstrip("\n")
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

ATTR_OPTIONS = [[], [], ["-D"], ["-q"], ["-J", "12"], ["-U"], ["-D", "-q"], ["-q", "-J", "20"], ["-D", "-J", "5", "-U"], ["-q", "-l"], ["-q", "-S"],
                ["-q", "-c"], ["-D", "-l"], ["-D", "-S", "-q"], ["-J", "9", "-l"], ["-J", "9", "-S"], ["-q", "-x"], ["-q", "-%"], ["-D", "-_"], ["-q", "-e"],
                ["-J", "1"], ["-J", "40"], ["-J", "80"], ["-U", "-c"], ["-D", "-0"], ["-q", "-0"], ["-q", "-_"], ["-l"], ["-S"], ["-c"], ["-%"]]
ATTR_SIZES = [(5, 40), (6, 40), (7, 40), (8, 9), (8, 10), (8, 12), (10, 30), (10, 40), (12, 50), (14, 60), (24, 80), (12, 100), (24, 40)]

def gen_attrs(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = rand_buffer(r, r.choice([1, 3, 8, 20, 40, 100]))
        rows, cols = r.choice(ATTR_SIZES)
        flags = r.choice(ATTR_OPTIONS)
        steps = [r.choice(MOVES + EDITS + ["M-a", "M-a", "PageDown", "PageDown", "C-v", "C-y"]) for _ in range(r.randint(2, 8))]
        if r.random() < 0.4:
            steps = steps + prompt_script(r)
        if r.random() < 0.25:
            steps.insert(r.randint(0, len(steps)), "@%dx%d" % (r.choice([5, 6, 8, 12, 20]), r.choice([9, 10, 30, 40, 60, 80])))
        if r.random() < 0.2:
            steps.insert(r.randint(0, len(steps)), r.choice(TOGGLES))
        if r.random() < 0.15:
            steps = steps + ["C-g", "Down", "PageDown", "C-x"]
        cases.append({"id": "atr%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "flags": flags, "attrs": True, "steps": steps})
    return cases

BAR_MOVES = ["PageDown", "PageDown", "PageUp", "Down", "Down", "Down", "Up", "C-v", "C-y", "M-\\", "M-/", "End", "Home"]

def gen_bar(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = rand_buffer(r, r.choice([1, 2, 5, 9, 12, 20, 30, 60, 120]))
        rows, cols = r.choice([(6, 30), (8, 30), (10, 40), (12, 40), (14, 60), (24, 80), (7, 20), (10, 10)])
        flags = r.choice([["-q"], ["-q", "-S"], ["-q", "-S"], ["-q", "-l"], ["-q", "-S", "-l"], ["-q", "-S", "-c"]])
        steps = [r.choice(BAR_MOVES) for _ in range(r.randint(2, 8))]
        if r.random() < 0.3:
            steps = steps + r.sample(EDITS, 2)
        if r.random() < 0.2:
            steps.insert(r.randint(0, len(steps)), "@%dx%d" % (r.choice([6, 8, 12, 20]), r.choice([10, 30, 60, 80])))
        cases.append({"id": "bar%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "flags": flags, "attrs": True, "steps": steps})
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
    "-d": ["BSpace", "DC", "BSpace", "DC", "Left", "Right", "End", "Home", "M-a"],
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
        others = r.sample(["-i", "-E", "-T2", "-T4", "-A", "-k", "-Z", "-L", "-y", "-W", "-l", "-S", "-d"], r.choice([0, 0, 1, 1, 2]))
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

TOOL_MODES = ["-t", "-n", "-R"]
TOOL_OTHERS = ["-B", "-L", "-l", "-x", "-%", "-k", "-E", "-S"]
TOOL_KEYS = ["x", "yz", "Enter", "Left", "Right", "Up", "Down", "Home", "End", "BSpace", "C-k", "C-u", "M-a", "M-6", "C-c"]
TOOL_FLOWS = [
    ["C-o"], ["C-o", "Enter"], ["C-o", "C-c"], ["C-o", "M-d", "Enter"], ["C-o", "M-m", "Enter"], ["C-o", "M-a", "Enter"],
    ["C-o", "M-p", "Enter"], ["C-o", "M-b", "Enter"], ["C-o", "C-q"], ["C-o", "BSpace"], ["C-o", "x"], ["C-o", "Home", "z"],
    ["C-o", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "u.txt", "Enter"], ["C-o", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "w.txt", "Enter"],
    ["C-r", "C-c"], ["C-t", "C-c"], ["C-r", "Enter"], ["C-x"], ["C-x", "n"], ["C-x", "C-c"], ["C-x", "y"], ["C-x", "y", "Enter"], ["C-x", "y", "C-c"],
]

def gen_tools(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 5]))]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50)])
        modes = r.sample(TOOL_MODES, r.choice([1, 1, 2]))
        flags = modes + r.sample(TOOL_OTHERS, r.choice([0, 0, 1, 2]))
        target = r.choice(["t.txt", "t.txt", "t.txt", "new.txt"])
        steps = []
        for _ in range(r.randint(3, 9)):
            if r.random() < 0.45:
                steps.extend(r.choice(TOOL_FLOWS))
            else:
                steps.append(r.choice(TOOL_KEYS))
        cases.append({"id": "tol%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + [target], "steps": steps,
                      "disk": True, "hidden": True, "files": {"u.txt": ["other"]}})
    return cases

INSERT_FILES = {"r.txt": ["alpha", "beta gamma", "delta"], "w.txt": ["one"], "sub/x.txt": ["deep"], "big.txt": ["line %d of the big file" % n for n in range(1, 31)]}
INSERT_RAW = {"n.txt": "6e6f206e65776c696e65", "e.txt": "", "c.txt": "610d0a620d0a", "b.txt": "0a0a610a"}
INSERT_NAMES = ["r.txt", "big.txt", "big.txt", "w.txt", "n.txt", "e.txt", "c.txt", "b.txt", "nope.txt", "sub", "sub/x.txt", ".", "", "r.txt ", "../t.txt"]
INSERT_KEYS = ["x", "yz", "Enter", "Left", "Right", "Up", "Down", "Home", "End", "BSpace", "C-k", "C-u", "M-a", "M-6", "PageDown", "M-\\", "M-/", "C-Right"]

def gen_insert(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 5, 12]))]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50), (8, 40), (6, 30)])
        flags = r.sample(["-x", "-l", "-S", "-S", "-i", "-E", "-L", "-k", "-Z", "-A", "-y", "-N", "-u"], r.choice([0, 0, 1, 1, 2]))
        steps = []
        for _ in range(r.randint(2, 8)):
            kind = r.random()
            if kind < 0.45:
                steps.append(r.choice(INSERT_KEYS))
            elif kind < 0.85:
                name = r.choice(INSERT_NAMES)
                flow = ["C-r"]
                if r.random() < 0.15:
                    flow.append("M-n")
                if name:
                    flow.append(name)
                flow.append(r.choice(["Enter", "Enter", "Enter", "C-c"]))
                steps.extend(flow)
            else:
                steps.extend(["C-o", "Enter"])
        steps += ["C-o", "Enter"]
        cases.append({"id": "ins%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": steps,
                      "disk": True, "hidden": True, "files": INSERT_FILES, "raw": INSERT_RAW})
    return cases

OPEN_TARGETS = ["t.txt", "t.txt", "new.txt", "sub", "sub/", "sub/x.txt", "sub/new.txt", "nodir/new.txt", "nodir/", "nodir/a/b.txt", "t.txt/x", ".", "..", "/", "/dev/null", "./t.txt", "sub/../t.txt", "ro.txt", ""]
OPEN_STEPS = [[], [], ["x"], ["x", "C-o"], ["x", "C-o", "Enter"], ["C-x"], ["x", "C-x"], ["C-r"], ["C-w"], ["C-c"], ["x", "C-o", "BSpace", "Enter"]]

def gen_open(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 6]))]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50)])
        flags = r.sample(["-x", "-l", "-S", "-G", "-v", "-n", "-R", "-t", "-B", "-%", "-_", "-0", "-e"], r.choice([0, 0, 1, 1, 2]))
        target = r.choice(OPEN_TARGETS)
        args = flags + ([target] if target else [])
        cases.append({"id": "opn%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": args, "steps": r.choice(OPEN_STEPS),
                      "disk": True, "hidden": True, "files": {"sub/x.txt": ["deep"], "ro.txt": ["read only"]}, "modes": {"ro.txt": 292}, "force_open": True})
    return cases

UNDO_KEYS = ["x", "yz", "hello world", "Enter", "Enter", "BSpace", "BSpace", "DC", "DC", "C-k", "C-k", "C-u", "Tab", "Left", "Right", "Up", "Down", "Home", "End",
             "M-a", "M-6", "M-}", "M-{", "C-j", "C-Right", "C-Left", "M-u", "M-u", "M-u", "M-e", "M-e", "C-o", "C-d", "M-t", "M-\\", "M-/", "M-3"]

def gen_undo(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 5, 8]))]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50)])
        flags = r.sample(["-x", "-l", "-S", "-i", "-E", "-L", "-k", "-Z", "-A", "-b", "-%"], r.choice([0, 0, 1, 1, 2]))
        steps = []
        for _ in range(r.randint(4, 16)):
            key = r.choice(UNDO_KEYS)
            if key == "C-o":
                steps.extend(["C-o", "Enter"])
            else:
                steps.append(key)
        cases.append({"id": "und%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": steps, "disk": True, "hidden": True})
    return cases

UNDO2_FLOWS = [
    ["C-\\", "a", "Enter", "Z", "Enter", "y"], ["C-\\", "e", "Enter", "E", "Enter", "a"], ["C-\\", "o", "Enter", "0", "Enter", "n", "y", "y"],
    ["C-\\", "zzz", "Enter", "q", "Enter"], ["C-\\", "t", "Enter", "T", "Enter", "y", "n", "C-c"],
    ["C-r", "r.txt", "Enter"], ["C-r", "w.txt", "Enter"], ["M-j"], ["C-j"], ["C-o", "Enter"], ["C-w", "a", "Enter"],
    ["the quick brown fox jumps over the lazy dog and keeps running far away"], ["M-}"], ["M-{"], ["M-3"], ["M-t"],
]

def gen_undo2(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 5, 8]))]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50), (10, 30)])
        flags = r.sample(["-x", "-l", "-S", "-i", "-E", "-L", "-k", "-Z", "-A", "-b", "-b", "-O", "-M", "-%"], r.choice([0, 1, 1, 2]))
        steps = []
        for _ in range(r.randint(4, 16)):
            if r.random() < 0.35:
                steps.extend(r.choice(UNDO2_FLOWS))
            else:
                key = r.choice([k for k in UNDO_KEYS if k != "M-a"])
                steps.extend(["C-o", "Enter"] if key == "C-o" else [key])
        cases.append({"id": "un2%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": steps,
                      "disk": True, "hidden": True, "files": {"r.txt": ["alpha", "beta gamma", "delta"], "w.txt": ["one"]}})
    return cases

SEARCH_TERMS = ["a", "e", "o", "ba", "x", "foo", "é", "中", "tab", "(x)", "[1", "end.", "world", "Hello", "zzz", "b", "r", "z", "  ", "here"]
SEARCH_REGEXES = ["a.b", "^t", "o$", "[aeiou]+", "[A-Z]", "w.r", "^$", "o*", "x|z", "\\w+$", "e.", "[0-9]", "(o)(o)", "(a|ab)(c|bcd)?", "\\<t", "r\\>", "[[:upper:]]", "x{2}", "(ba)+", ".*", "^.", "(", "[", "a{", "*a", "o+?", "é|e", "\\bb"]

def search_flow(r, view=False):
    kind = r.random()
    term = r.choice(SEARCH_TERMS)
    if kind < 0.25:
        return ["C-w", term, "Enter"]
    if kind < 0.33:
        return ["C-w", "Enter"]
    if kind < 0.38:
        return ["C-w", "C-c"]
    if kind < 0.45:
        return ["C-w", "M-c", term, "Enter"]
    if kind < 0.52:
        return ["C-w", "M-b", term, "Enter"]
    if kind < 0.62:
        return ["C-w", "M-r", r.choice(SEARCH_REGEXES), "Enter"]
    if kind < 0.68:
        return ["M-w"] if r.random() < 0.5 else ["M-q"]
    if kind < 0.70:
        return ["C-q", term, "Enter"] if view or r.random() < 0.5 else ["C-w", term, "C-r", "Enter", "Z", "Enter", "y"]
    if kind < 0.73:
        return ["C-w", "Up", "Enter"] if r.random() < 0.6 else ["C-w", term, "C-t", "Enter"]
    answers = [r.choice(["y", "n", "a", "C-c", "y", "n", "N", "x"]) for _ in range(r.randint(1, 4))]
    replacement = r.choice(["Z", "", "XY", "0", "é", "ab", "[\\1]", "\\1\\2", "<&>", "\\0", "\\"])
    head = ["C-\\"]
    if r.random() < 0.15:
        head.append("M-c")
    if r.random() < 0.15:
        head.append("M-b")
    if r.random() < 0.2:
        return head + ["M-r", r.choice(SEARCH_REGEXES), "Enter", replacement, "Enter"] + answers
    return head + [term, "Enter", replacement, "Enter"] + answers

SEARCH_KEYS = ["x", "yz", "Left", "Right", "Up", "Down", "Home", "End", "M-/", "M-\\", "PageDown", "PageUp", "C-Right", "C-Left", "M-a", "M-a", "M-6", "C-k", "M-u", "M-e", "C-u", "Enter", "Tab"]

def gen_search(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 5, 8, 14]))]
        text[r.randrange(len(text))] += " foo bar tab here world"
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50), (8, 30)])
        flags = r.sample(["-x", "-l", "-S", "-i", "-E", "-L", "-k", "-A", "-%", "-_", "-j", "-e", "-v"], r.choice([0, 0, 1, 1, 2]))
        steps = []
        for _ in range(r.randint(3, 9)):
            if r.random() < 0.6:
                steps.extend(search_flow(r, "-v" in flags))
            else:
                steps.append(r.choice(SEARCH_KEYS))
        cases.append({"id": "sea%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": steps, "disk": True, "hidden": True})
    return cases

HELP_OPENERS = [["C-g"], ["C-g"], ["C-g"], ["C-w", "C-g"], ["C-\\", "C-g"], ["C-\\", "x", "Enter", "C-g"], ["C-o", "C-g"], ["C-r", "C-g"], ["C-x", "C-g"]]
HELP_KEYS = ["Up", "Down", "Up", "Down", "Down", "PageUp", "PageDown", "PageDown", "Home", "End", "Left", "Right", "Space", "Enter", "Tab", "BSpace", "C-p", "C-n", "C-y", "C-v", "C-v", "C-l",
             "M-\\", "M-/", "M-Up", "M-Down", "x", "q", "e", "b", "-", "?", "s", "n", "N", "w", "/", "z", "7", "C-a", "C-e", "C-b", "C-f", "C-k", "C-u", "C-j", "C-o", "C-d", "M-x", "M-c", "M-n", "M-z", "M-a", "M-u", "M-b", "M-f", "M-w", "M-q", "DC"]

def help_search(r):
    kind = r.random()
    term = r.choice(["he", "key", "the", "zzz", "Replace", "M-", "^", "file", "bar", "  ", "Enter"])
    if kind < 0.4:
        return [r.choice(["C-w", "w", "/", "C-f"]), term, "Enter"]
    if kind < 0.6:
        return ["C-q", term, "Enter"]
    if kind < 0.75:
        return [r.choice(["M-w", "M-q", "n", "N", "C-w"]), "Enter"] if r.random() < 0.5 else [r.choice(["M-w", "M-q", "n", "N"])]
    return [r.choice(["C-w", "C-q"]), "C-c"]

def gen_help(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        rows, cols = r.choice([(24, 80), (24, 80), (12, 50), (8, 30), (10, 40), (30, 100), (24, 120), (14, 60), (20, 39), (7, 80), (6, 70), (5, 60), (40, 74), (24, 41), (24, 38)])
        flags = r.sample(["-R", "-p", "-t", "-v", "-x", "-0", "-e", "-_", "-%", "-S", "-l", "-c", "-i"], r.choice([0, 0, 0, 1, 1, 2]))
        opener = r.choice(HELP_OPENERS)
        while "-v" in flags and "C-r" in opener:
            opener = r.choice(HELP_OPENERS)
        steps = list(opener)
        for _ in range(r.randint(1, 8)):
            steps.extend(help_search(r) if r.random() < 0.3 else [r.choice(HELP_KEYS)])
        cases.append({"id": "hlp%d-%d" % (seed, i), "text": ["alpha beta", "gamma"], "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": steps, "disk": True, "hidden": True})
    return cases

BLOCK_WORDS = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta", "iota", "kappa"]
BLOCK_PREFIXES = ["", "", "", "", "  ", "    ", "\t", "> ", "> > ", "# ", "// ", " > "]
BLOCK_KEYS = ["M-(", "M-)", "M-9", "M-0", "M-7", "M-8", "C-Up", "C-Down", "M-{", "M-}", "Up", "Down", "Down", "Left", "Right", "Home", "End", "PageDown", "PageUp", "M-\\", "M-/", "C-Right", "C-Left"]
GOTO_ANSWERS = ["3", "1", "9", "5,4", ",3", "0", "abc", "99", "2,99", "-1", "+2", "4,"]
GOTO_KEYS = ["C-y", "C-v", "C-w", "C-o", "C-t", "C-c", "Enter", "Left", "C-k", "C-u"]

def block_text(r):
    lines = []
    prefix = r.choice(BLOCK_PREFIXES)
    for _ in range(r.randint(2, 6)):
        if r.random() < 0.3:
            lines.extend([""] * r.choice([1, 1, 2, 3]))
            prefix = r.choice(BLOCK_PREFIXES)
        if r.random() < 0.08:
            lines.append(r.choice(["", " ", "  ", "\t"]))
            continue
        for _ in range(r.randint(1, 4)):
            if r.random() < 0.15:
                prefix = r.choice(BLOCK_PREFIXES)
            lines.append(prefix + " ".join(r.choice(BLOCK_WORDS) for _ in range(r.randint(1, 5))))
    if r.random() < 0.2:
        lines.insert(0, "")
    return lines

def goto_flow(r):
    kind = r.random()
    if kind < 0.3:
        return [r.choice(["C-_", "M-g"]), r.choice(GOTO_ANSWERS), "Enter"]
    if kind < 0.55:
        return [r.choice(["C-_", "M-g"]), r.choice(["C-y", "C-v", "C-w", "C-o"])]
    if kind < 0.7:
        return [r.choice(["C-_", "M-g"]), r.choice(GOTO_ANSWERS), r.choice(["C-y", "C-v", "C-w", "C-o"])]
    if kind < 0.85:
        return [r.choice(["C-_", "M-g"]), r.choice(["", "3", "x"]) or "C-t", "C-t"] + r.choice([[], ["C-t"], ["Enter"], ["foo", "Enter"]])
    return [r.choice(["C-_", "M-g"]), r.choice(GOTO_KEYS)]

PROMPT_JUMP_KEYS = ["C-y", "C-v", "C-w", "C-o", "C-t", "C-_", "M-g", "C-Left", "C-Right", "C-b", "C-f", "C-a", "C-e", "C-d", "C-h"]

def prompt_flow(r):
    opener = r.choice(["C-w", "C-w", "C-q"])
    typed = r.choice([[], [], ["ab cd"], ["x"], ["foo bar baz"]])
    return [opener] + typed + [r.choice(PROMPT_JUMP_KEYS) for _ in range(r.randint(1, 3))] + r.choice([[], ["Enter"], ["C-c"]])

def without_main_prompts(steps):
    kept = []
    prompt = None
    for step in steps:
        if prompt is None:
            if step in ("C-t", "C-o"):
                continue
            if step in ("C-_", "M-g"):
                prompt = "goto"
            elif step in ("C-w", "C-q"):
                prompt = "search"
        elif prompt == "goto":
            if step in ("C-t", "C-_"):
                prompt = "search"
            elif step in ("C-y", "C-v", "C-w", "C-o", "Enter", "C-c"):
                prompt = None
        else:
            if step in ("C-t", "C-_"):
                prompt = "goto"
            elif step in ("C-y", "C-v", "Enter", "C-c"):
                prompt = None
        kept.append(step)
    return kept

def gen_blocks(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = block_text(r)
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50), (8, 30), (6, 40)])
        flags = r.sample(["-x", "-l", "-S", "-i", "-O", "-e", "-%", "-_", "-v", "-R", "-0", "-j"], r.choice([0, 0, 1, 1, 2]))
        steps = []
        for _ in range(r.randint(3, 10)):
            roll = r.random()
            if roll < 0.3:
                steps.extend(goto_flow(r))
            elif roll < 0.4:
                steps.extend(prompt_flow(r))
            else:
                steps.append(r.choice(BLOCK_KEYS))
        cases.append({"id": "blo%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": without_main_prompts(steps), "disk": True, "hidden": True})
    return cases

EXEC_COMMANDS = ["echo hi", "echo a; echo b", "printf 'x\\ny\\n'", "seq 1 3", "seq 1 14", "cat t.txt", "ls", "wc -l < t.txt", "true", "false", "exit 2", "echo err >&2",
                 "cat missing.txt", "ls missing", "echo 'a: b'; false", "echo ''", "printf '\\n\\n'", "echo ABC | tr A-Z a-z", "zzz", "echo x > new.txt", "echo y >> t.txt", "rm -f new.txt"]
EXEC_FILTERS = ["wc -l", "wc -c", "true", "false"]
EXEC_KEYS = ["Up", "Down", "Left", "Right", "Home", "End", "PageDown", "PageUp", "M-\\", "M-/", "x", "M-a", "M-u", "M-e", "C-k", "C-u", "BSpace", "Enter", "M-(", "M-)"]

def exec_flow(r, marked):
    kind = r.random()
    if kind < 0.45:
        return ["C-t", r.choice(EXEC_COMMANDS), "Enter"]
    if kind < 0.65:
        filters = EXEC_FILTERS + ([] if marked else ["cat"])
        return ["C-t", "M-\\", r.choice(filters), "Enter"]
    if kind < 0.75:
        return ["C-t", r.choice(["C-s", "C-y", "C-o", "C-j", "C-v", "C-c", "Enter"])]
    if kind < 0.85:
        return ["C-t", r.choice(["echo q", "ls", "x"]), r.choice(["C-x", "C-c"]), r.choice(["Enter", "C-c", "C-x"])]
    if kind < 0.95:
        return ["C-t"] + [r.choice(["Up", "Down", "Up"]) for _ in range(r.randint(1, 3))] + [r.choice(["Enter", "C-c"])]
    return ["C-t", "M-\\", r.choice(["M-\\", "C-c"]), r.choice(["Enter", "C-c"])]

def without_stray_exec_keys(steps):
    kept = []
    state = "main"
    for step in steps:
        if state == "main":
            if step in ("C-s", "C-x", "C-o"):
                continue
            if step == "C-t":
                state = "execute"
        elif state == "execute":
            if step in ("Enter", "C-c", "C-s", "C-t", "C-y", "C-o", "C-j", "C-v"):
                state = "main"
            elif step == "C-x":
                state = "insert"
        else:
            if step in ("Enter", "C-c"):
                state = "main"
            elif step == "C-x":
                state = "execute"
        kept.append(step)
    return kept

def gen_exec(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([1, 2, 3, 5, 8]))]
        rows, cols = r.choice([(10, 40), (14, 60), (24, 80), (12, 50), (8, 30)])
        flags = r.sample(["-x", "-l", "-S", "-i", "-E", "-L", "-k", "-A", "-%", "-_", "-e", "-0"], r.choice([0, 0, 0, 1, 1, 2]))
        steps = []
        marked = False
        for _ in range(r.randint(2, 7)):
            if r.random() < 0.6:
                steps.extend(exec_flow(r, marked))
            else:
                key = r.choice(EXEC_KEYS)
                if key == "M-a":
                    marked = not marked
                steps.append(key)
        cases.append({"id": "exe%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": flags + ["t.txt"], "steps": without_stray_exec_keys(steps), "disk": True, "hidden": True})
    return cases

def gen(seed, count, corpus):
    if corpus == "exec":
        return gen_exec(seed, count)
    if corpus == "blocks":
        return gen_blocks(seed, count)
    if corpus == "prompts":
        return gen_prompts(seed, count)
    if corpus == "cli":
        return gen_cli(seed, count)
    if corpus == "place":
        return gen_place(seed, count)
    if corpus == "layout":
        return gen_layout(seed, count)
    if corpus == "attrs":
        return gen_attrs(seed, count)
    if corpus == "bar":
        return gen_bar(seed, count)
    if corpus == "edit":
        return gen_edit(seed, count)
    if corpus == "wrap":
        return gen_wrap(seed, count)
    if corpus == "tools":
        return gen_tools(seed, count)
    if corpus == "insert":
        return gen_insert(seed, count)
    if corpus == "open":
        return gen_open(seed, count)
    if corpus == "undo":
        return gen_undo(seed, count)
    if corpus == "undo2":
        return gen_undo2(seed, count)
    if corpus == "search":
        return gen_search(seed, count)
    if corpus == "help":
        return gen_help(seed, count)
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
    ap.add_argument("--workdir")
    ap.add_argument("out")
    a = ap.parse_args()
    cases = json.load(open(a.source))["cases"] if a.source else gen(a.seed, a.cases, a.corpus)
    runner = run_cli_case if a.corpus in ("cli", "place", "tools", "insert", "open", "undo", "undo2", "search", "help", "blocks", "exec") else run_case
    if a.workdir:
        shutil.rmtree(a.workdir, ignore_errors=True)
        os.makedirs(a.workdir)
    with (contextlib.nullcontext(a.workdir) if a.workdir else tempfile.TemporaryDirectory()) as workdir:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda c: runner(c, workdir), cases))
    version = subprocess.run(["nano", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    json.dump({"nano": version, "corpus": a.corpus, "cases": results}, open(a.out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(results), "cases ->", a.out)

if __name__ == "__main__":
    main()
