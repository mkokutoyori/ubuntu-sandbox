#!/usr/bin/env python3
"""Record whole-screen transcripts from a real GNU nano driven through tmux.

usage: record_nano_screen.py --corpus cells|scroll|resize|prompts|cli|mouse|tab|state|rc|colors|syntax|package|place|layout|edit|wrap|tools|insert|open|undo|undo2|search|help|blocks|exec [--seed N] [--cases N] [--from cases.json] [--workdir DIR] out.json

A case with `"paint": true` records, for every row, one letter per cell from a legend kept for the whole case (`legend`: letter -> `FG/BG/FLAGS`,
FG and BG a 0-255 palette index or `-` for the default, FLAGS any of `biur` for bold, italic, underline, reverse), read from `capture-pane -e -N`.

A case with `"attrs": true` also records, for every row, one letter per cell: `.` default, `r` reverse, `b` bold, `a` bold white on red
(the error colour), `y` black on bright yellow (the spotlight), `R` red background alone and `?` anything else, read from `capture-pane -e -N`.

A case is a buffer, a pane size, nano's command-line flags and a list of steps; a step is a tmux
key token (`Left`, `C-a`, `M-n`, `PageDown`, ...), a mouse event (`click@ROW,COL`, `wheel-up@ROW,COL`,
`wheel-down@ROW,COL`, sent as xterm SGR reports), a run of literal text (`-l`) or `@ROWSxCOLS`,
which resizes the pane (a run of literal text is sent one character at a time, 40 ms apart, because nano
wraps a burst of typed characters once at its end).  The real nano runs inside a pane of the given size (started with `-I`, so
no rc file is read); the first record is the screen right after nano opened the file, then one
record per step: every row of the pane (title bar, edit window, status bar and the two shortcut
rows), the cursor cell and the pane size.  A case with `"disk": true` (every case of the edit
corpus) also records the files left in the directory after each step.
"""
import argparse, contextlib, glob, itertools, json, os, random, re, shlex, shutil, subprocess, tempfile, time, unicodedata
from concurrent.futures import ThreadPoolExecutor

SESSION_NUMBERS = itertools.count()
LITERAL = re.compile(r"^[^A-Z][\s\S]*$")
KEYS = {"Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "Enter", "Tab", "BSpace", "DC", "Escape", "Space"}

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

MOUSE = re.compile(r"^(click|wheel-up|wheel-down)@(\d+),(\d+)$")

def mouse_bytes(kind, row, col):
    x, y = col + 1, row + 1
    if kind == "click":
        return "\x1b[<0;%d;%dM\x1b[<0;%d;%dm" % (x, y, x, y)
    return "\x1b[<%d;%d;%dM" % (64 if kind == "wheel-up" else 65, x, y)

def send(name, token):
    mouse = MOUSE.match(token)
    if mouse:
        tmux("send-keys", "-t", name, "-l", mouse_bytes(mouse.group(1), int(mouse.group(2)), int(mouse.group(3))))
        time.sleep(0.15)
        return
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

PAINT_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

def paint_apply(state, params):
    codes = [int(p) if p else 0 for p in params.split(";")] or [0]
    index = 0
    while index < len(codes):
        code = codes[index]
        if code == 0:
            state.update(bold=False, italic=False, underline=False, reverse=False, fg=None, bg=None)
        elif code == 1:
            state["bold"] = True
        elif code == 3:
            state["italic"] = True
        elif code == 4:
            state["underline"] = True
        elif code == 7:
            state["reverse"] = True
        elif code == 22:
            state["bold"] = False
        elif code == 23:
            state["italic"] = False
        elif code == 24:
            state["underline"] = False
        elif code == 27:
            state["reverse"] = False
        elif 30 <= code <= 37:
            state["fg"] = str(code - 30)
        elif 90 <= code <= 97:
            state["fg"] = str(code - 90 + 8)
        elif code == 39:
            state["fg"] = None
        elif 40 <= code <= 47:
            state["bg"] = str(code - 40)
        elif 100 <= code <= 107:
            state["bg"] = str(code - 100 + 8)
        elif code == 49:
            state["bg"] = None
        elif code in (38, 48):
            if index + 2 < len(codes) and codes[index + 1] == 5:
                value = str(codes[index + 2])
                index += 2
            elif index + 4 < len(codes) and codes[index + 1] == 2:
                value = "rgb:%d,%d,%d" % (codes[index + 2], codes[index + 3], codes[index + 4])
                index += 4
            else:
                value = "?"
            state["fg" if code == 38 else "bg"] = value
        index += 1

def paint_key(state):
    flags = "".join(letter for letter, name in (("b", "bold"), ("i", "italic"), ("u", "underline"), ("r", "reverse")) if state[name])
    return "%s/%s/%s" % (state["fg"] if state["fg"] is not None else "-", state["bg"] if state["bg"] is not None else "-", flags)

def capture_paint(name, width, height, legend):
    legend.setdefault(".", "-/-/")
    letters_of = {key: letter for letter, key in legend.items()}
    raw = tmux("capture-pane", "-e", "-p", "-N", "-t", name).split("\n")
    state = {"bold": False, "italic": False, "underline": False, "reverse": False, "fg": None, "bg": None}
    rows = []
    for index in range(height):
        row = raw[index] if index < len(raw) else ""
        letters = []
        for token in SGR.split(row):
            if SGR.fullmatch(token):
                paint_apply(state, token[2:-1])
                continue
            key = paint_key(state)
            if key not in letters_of:
                letters_of[key] = PAINT_LETTERS[len(legend) - 1] if len(legend) - 1 < len(PAINT_LETTERS) else "?"
                legend[letters_of[key]] = key
            for char in token:
                letters.extend(letters_of[key] * cell_width(char))
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

def record_screen(name, casedir=None, hidden=False, attrs=False, legend=None):
    snap = settled(name)
    if snap is None:
        return None
    y, x, height, width, pane = snap
    record = {"y": y, "x": x, "height": height, "width": width, "rows": [r.rstrip() for r in pane[:height]]}
    if attrs:
        record["attrs"] = capture_attrs(name, width, height)
    if legend is not None:
        record["paint"] = capture_paint(name, width, height, legend)
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
        steps_done = []
        cursor = (record["opened"]["y"], record["opened"]["x"]) if record["opened"] else (0, 0)
        for step in case.get("steps", []):
            if step == "click@cursor":
                step = "click@%d,%d" % cursor
            steps_done.append(step)
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
            cursor = (snap["y"], snap["x"])
        record["steps"] = steps_done[:len(record["after"])]
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

MOUSE_FLAG_SETS = [["-m"], ["-m"], ["-m", "-l"], ["-m", "-S"], ["-m", "-q"], ["-m", "-x"], ["-m", "-_"], ["-m", "-0"], ["-m", "-e"], ["-m", "-v"], ["-m", "-l", "-S"], ["-m", "-c"], ["-m", "-q", "-l"], ["-m", "-%"]]
MOUSE_KEYS = ["Down", "Down", "Up", "Right", "Left", "End", "Home", "PageDown", "PageUp", "x", "yz", "BSpace", "Enter", "C-k", "C-u", "M-a", "M-6", "C-w", "C-o", "C-r", "C-\\", "C-g", "C-x", "C-c", "M-u", "C-_", "foo", "Enter", "C-b", "C-f"]
MOUSE_SIZES = [(5, 40), (6, 40), (8, 30), (10, 40), (10, 50), (12, 40), (12, 60), (14, 60), (24, 80), (9, 20)]

def mouse_step(r, rows, cols):
    kind = r.random()
    if kind < 0.35:
        return "click@cursor"
    place = r.random()
    if place < 0.55:
        row, col = r.randint(1, max(1, rows - 4)), r.randint(0, cols - 1)
    elif place < 0.8:
        row, col = r.randint(max(0, rows - 3), rows - 1), r.randint(0, cols - 1)
    elif place < 0.9:
        row, col = 0, r.randint(0, cols - 1)
    else:
        row, col = r.randint(0, rows - 1), r.choice([0, 1, 2, 3, cols - 1])
    if kind < 0.85:
        return "click@%d,%d" % (row, col)
    return "%s@%d,%d" % (r.choice(["wheel-up", "wheel-down"]), row, col)

def gen_mouse(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = rand_buffer(r, r.choice([2, 4, 8, 14, 30]))
        rows, cols = r.choice(MOUSE_SIZES)
        steps = []
        for _ in range(r.randint(4, 14)):
            if r.random() < 0.6:
                steps.append(mouse_step(r, rows, cols))
            else:
                steps.append(r.choice(MOUSE_KEYS))
        cases.append({"id": "mou%d-%d" % (seed, i), "text": text, "rows": rows, "cols": cols, "args": r.choice(MOUSE_FLAG_SETS) + ["t.txt"], "steps": steps})
    return cases

TAB_NAMES = ["foo.txt", "foobar.txt", "foo", "bar.cfg", "baz", "sub/a.txt", "sub/b.txt", "sub/deep/x.txt", "sub2/y.txt", ".hidden", ".conf/z", "Zed.txt", "alpha", "alpine/1", "zzz.log", "\u00e9.txt", "\u4e2d\u6587.txt", "foo-1", "foo_2.bak", "a b.txt"]
TAB_FRAGMENTS = ["f", "fo", "foo", "foo.", "foob", "b", "ba", "s", "su", "sub", "sub/", "sub/d", "sub2", ".", ".h", ".c", "Z", "z", "a", "al", "alp", "\u00e9", "\u4e2d", "x", "item", "item1", "t", "t.", ""]
TAB_OPENERS = ["C-r", "C-r", "C-o", "C-o", "C-w", "C-\\", "C-t"]

def gen_tab(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        names = r.sample(TAB_NAMES, r.randint(3, 9))
        if r.random() < 0.15:
            names += ["item%02d" % n for n in range(1, r.randint(12, 40))]
        files = {name: ["x"] for name in names}
        rows, cols = r.choice([(10, 40), (12, 60), (24, 80), (8, 30), (6, 40), (14, 50), (12, 100)])
        steps = []
        for _ in range(r.randint(0, 3)):
            steps += [r.choice(["C-w", "C-w", "C-\\"]), r.choice(["foo", "foobar", "fab", "fx", "bar", "a"]), "Enter"]
            if steps[-3] == "C-\\":
                steps += [r.choice(["bar", "baz", "b"]), "Enter", "C-c"]
        for _ in range(r.randint(1, 3)):
            opener = r.choice(TAB_OPENERS)
            steps.append(opener)
            if opener == "C-o":
                steps.append("C-k")
            fragment = r.choice(TAB_FRAGMENTS)
            if fragment:
                steps.append(fragment)
            for _ in range(r.randint(1, 4)):
                steps.append("Tab")
                if r.random() < 0.25:
                    steps.append(r.choice(["x", "a", "BSpace", "Left", "Home", "End"]))
            steps.append(r.choice(["C-c", "C-c", "Enter"] if opener in ("C-w", "C-t") else ["C-c", "C-c", "Left", "Enter"]))
            if steps[-1] == "Left":
                steps[-1] = "C-c"
        cases.append({"id": "tab%d-%d" % (seed, i), "text": ["alpha", "beta"], "files": files, "rows": rows, "cols": cols, "args": ["t.txt"], "steps": steps})
    return cases


def snapshot_tree(root, mount_point):
    entries = {}
    for here, dirs, names in os.walk(root):
        relative_here = os.path.relpath(here, root)
        for entry in sorted(dirs):
            relative = entry if relative_here == "." else os.path.join(relative_here, entry)
            entries[mount_point + "/" + relative + "/"] = {"mode": os.stat(os.path.join(here, entry)).st_mode & 0o777}
        for entry in sorted(names):
            relative = entry if relative_here == "." else os.path.join(relative_here, entry)
            path = os.path.join(here, entry)
            entries[mount_point + "/" + relative] = {"mode": os.stat(path).st_mode & 0o777, "content": open(path, "rb").read().decode("utf-8", "replace")}
    return entries

def nano_running(name):
    pid = tmux("display", "-p", "-t", name, "#{pane_pid}").strip()
    return pid != "" and subprocess.run(["pgrep", "-P", pid, "-x", "nano"], capture_output=True).returncode == 0

def run_state_case(case, workdir):
    lab = os.path.join(workdir, case["id"])
    casedir = os.path.join(lab, "work")
    home = os.path.join(lab, "home")
    xdg = os.path.join(lab, "xdg")
    for directory in (casedir, home):
        os.makedirs(directory, exist_ok=True)
    tokens = lambda text: text.replace("@WORK@", casedir).replace("@LAB@", lab)
    open(os.path.join(casedir, "t.txt"), "w", encoding="utf-8").write("\n".join(case["text"]) + "\n")
    for extra_name, extra_lines in case.get("files", {}).items():
        os.makedirs(os.path.dirname(os.path.join(casedir, extra_name)), exist_ok=True)
        open(os.path.join(casedir, extra_name), "w", encoding="utf-8").write("\n".join(extra_lines) + "\n")
    for tree_name, tree_root in (("home", home), ("xdg", xdg)):
        for relative, content in case.get(tree_name, {}).items():
            target = os.path.join(tree_root, relative)
            if relative.endswith("/"):
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                open(target, "w", encoding="utf-8").write(tokens(content))
    environment = {key: tokens(value) for key, value in case.get("env", {}).items()}
    etc_binding = ""
    if case.get("rc") and not case.get("package"):
        etc_file = os.path.join(lab, "etc-nanorc")
        open(etc_file, "w", encoding="utf-8").write(tokens(case.get("etc_nanorc", "")))
        etc_binding = "mount --bind %s /etc/nanorc && " % shlex.quote(etc_file)
    ignore = "" if case.get("rc") or case.get("package") else "-I"
    legend = {} if case.get("paint") else None
    runs = []
    for run in case["runs"]:
        name = "nt%d_%06d" % (os.getpid(), next(SESSION_NUMBERS))
        tmux("kill-session", "-t", name)
        words = " ".join("%s=%s" % (key, shlex.quote(value)) for key, value in environment.items())
        arguments = " ".join(shlex.quote(tokens(a)) for a in run["args"])
        inner = "%smount --bind %s /root && env LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color %s nano %s %s; sleep 20" % (etc_binding, shlex.quote(home), words, ignore, arguments)
        tmux("new-session", "-d", "-x", str(case["cols"]), "-y", str(case["rows"]), "-s", name, "cd %s && unshare -m sh -c %s" % (shlex.quote(casedir), shlex.quote(inner)))
        time.sleep(0.4)
        opened = record_screen(name, None, True, False, legend)
        record = {"args": run["args"], "steps": [], "opened": opened, "after": []}
        for step in run["steps"] + STATE_FINISH:
            if not nano_running(name):
                break
            send(name, step)
            snap = record_screen(name, None, True, False, legend)
            if snap is None:
                break
            if not nano_running(name):
                record["exit_step"] = step
                record["exit_rows"] = snap["rows"]
                record["exit_disk"] = record_disk(casedir, True)
                break
            record["steps"].append(step)
            record["after"].append(snap)
        time.sleep(0.3)
        record["home"] = snapshot_tree(home, "/root")
        if os.path.isdir(xdg):
            record["xdg"] = snapshot_tree(xdg, xdg)
        tmux("kill-session", "-t", name)
        for leftover in glob.glob(os.path.join(casedir, "*.save")):
            os.remove(leftover)
        runs.append(record)
    return dict(case, casedir=casedir, lab=lab, runs=runs, **({"legend": legend} if legend is not None else {}))

STATE_FINISH = ["C-c", "C-x", "n"]
STATE_FLAGS = [["-H"], ["-P"], ["-H", "-P"], ["-HP"], ["-H", "-P", "-R"], ["--historylog"], ["--positionlog"], ["-H", "-P", "-l"], ["-H", "-P", "-S"], ["-H", "-P", "-w"], ["-P", "-x"], []]
STATE_MOVES = ["Down", "Down", "Up", "Right", "Right", "Left", "End", "Home", "PageDown", "PageUp", "M-/", "M-\\", "C-Right", "C-Left", "x", "yz", "BSpace", "Enter", "Tab", "DC"]
STATE_SEARCH_WORDS = ["foo", "bar", "baz", "alpha", "é", "中文", "tab", "x", "a b", "[1", "end."]
STATE_EXEC = ["echo hi", "seq 1 3", "true", "ls", "cat t.txt", "echo a b"]

def state_history_file(r):
    def entries(words, high):
        return [r.choice(words) + (str(r.randint(0, 9)) if r.random() < 0.3 else "") for _ in range(r.randint(0, high))]
    lists = [entries(STATE_SEARCH_WORDS, 6), entries(["Z", "XY", "new", "é", "a b"], 3), entries(STATE_EXEC, 3)]
    return "".join("".join(entry + "\n" for entry in lst) + "\n" for lst in lists)

def state_position_file(r, casedir_token, names):
    lines = []
    for _ in range(r.randint(0, 5)):
        lines.append("%s/%s %d %d\n" % (casedir_token, r.choice(names + ["other.txt", "gone.txt"]), r.randint(0, 80), r.randint(0, 60)))
    return "".join(lines)

def gen_state_run(r, text, target, flags, allow_edit=True):
    steps = []
    for _ in range(r.randint(0, 3)):
        kind = r.random()
        if kind < 0.35:
            steps.extend(r.choice(STATE_MOVES) for _ in range(r.randint(1, 6)))
        elif kind < 0.65:
            steps.extend(search_flow(r))
        elif kind < 0.8:
            steps.extend(["C-w", r.choice(STATE_SEARCH_WORDS), "Enter"])
        elif kind < 0.85:
            steps.extend(["C-t", r.choice(STATE_EXEC), "Enter"])
        elif kind < 0.9:
            steps.extend(["C-g", "C-w", r.choice(STATE_SEARCH_WORDS), "Enter", "C-x"])
        elif allow_edit:
            steps.extend(r.choice(["x", "yz", "Enter", "BSpace"]) for _ in range(r.randint(1, 3)))
    steps = without_stray_exec_keys(steps)
    ending = r.choice([["C-x", "n"], ["C-x", "n"], ["C-x", "y", "Enter"], ["C-x", "y", "Enter"], ["C-x"]])
    return steps + ending

def gen_state(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([3, 6, 12, 30, 60]))]
        text[r.randrange(len(text))] += " foo bar baz alpha tab end."
        rows, cols = r.choice([(10, 40), (12, 60), (24, 80), (14, 50), (8, 30), (24, 100)])
        files = {"u.txt": [edit_line(r) for _ in range(r.randint(2, 25))]} if r.random() < 0.4 else {}
        flags = r.choice(STATE_FLAGS)
        scenario = r.choices(["fresh", "history", "positions", "both", "legacy", "xdg", "xdg-missing", "local-file", "state-file"], [6, 3, 3, 3, 1, 2, 1, 1, 1])[0]
        home, xdg, env = {}, {}, {}
        names = ["t.txt"] + (["u.txt"] if files else [])
        if scenario in ("history", "both"):
            home[".local/share/nano/search_history"] = state_history_file(r)
        if scenario in ("positions", "both"):
            home[".local/share/nano/filepos_history"] = state_position_file(r, "@WORK@", names)
        if scenario == "legacy":
            home[".nano/search_history"] = state_history_file(r)
            home[".nano/filepos_history"] = state_position_file(r, "@WORK@", names)
        if scenario == "xdg":
            env["XDG_DATA_HOME"] = "@LAB@/xdg"
            xdg["nano/search_history"] = state_history_file(r)
            xdg["nano/filepos_history"] = state_position_file(r, "@WORK@", names)
        if scenario == "xdg-missing":
            env["XDG_DATA_HOME"] = "@LAB@/xdg"
        if scenario == "local-file":
            home[".local"] = "x"
        if scenario == "state-file":
            home[".local/share/nano"] = "x"
        runs = []
        for _ in range(r.choice([1, 2, 2, 3])):
            target = r.choice(names + ["./t.txt", "t.txt"])
            args = list(flags)
            if r.random() < 0.12:
                args.append("+%d%s" % (r.randint(1, len(text) + 3), r.choice(["", ",3", ",1"])))
            args.append(target)
            runs.append({"args": args, "steps": gen_state_run(r, text, target, flags)})
        case = {"id": "sta%d-%d" % (seed, i), "text": text, "files": files, "rows": rows, "cols": cols, "home": home, "xdg": xdg, "env": env, "runs": runs}
        cases.append(case)
    return cases


RC_FLAGS = ["linenumbers", "tabstospaces", "autoindent", "softwrap", "nohelp", "constantshow", "smarthome", "zero", "minibar", "indicator",
            "boldtext", "quickblank", "stateflags", "cutfromcursor", "atblanks", "jumpyscrolling", "emptyline", "nonewlines", "showcursor",
            "trimblanks", "wordbounds", "zap", "preserve", "rebinddelete", "locking", "casesensitive", "regexp", "breaklonglines", "nowrap",
            "afterends", "bookstyle", "noconvert", "unix", "backup", "historylog", "positionlog", "mouse", "allow_insecure_backup"]
RC_VALUED = [("tabsize", ["1", "2", "3", "4", "6", "8", "12"]), ("fill", ["10", "20", "30", "-4", "-12", "0", "60"]), ("guidestripe", ["5", "10", "20", "40"]),
             ("quotestr", ['"^> "', '"^[ \\t]*#"', '">"', "^>"]), ("punct", ['".,;"', '"!?"']), ("brackets", ['")]}"', '"\\"\')>]}"']), ("wordchars", ['"_-"', '"."']),
             ("matchbrackets", ['"(){}"', '"<>"']), ("whitespace", ['"»·"', '">."'])]
RC_ERRORS = ["set foo", "set tabsiz 4", "set", "unset", "unset tabsize", "set tabsize", "set tabsize 0", "set tabsize -3", "set tabsize abc", "set fill x", "set guidestripe 0",
             "set guidestripe x", "frob", "frob a b", "set quotestr", 'set quotestr "abc', 'set punct "a b"', 'set brackets "x y"', 'set matchbrackets "abc"', 'set matchbrackets "a b"',
             'set whitespace "abc"', 'set whitespace "a"', "unset speller", "set linenumbers extra words", "SET linenumbers", "set  linenumbers", "unset fill"]

def rc_line(r):
    kind = r.random()
    if kind < 0.45:
        return "%s %s" % (r.choice(["set", "set", "set", "unset"]), r.choice(RC_FLAGS))
    if kind < 0.75:
        name, values = r.choice(RC_VALUED)
        return "set %s %s" % (name, r.choice(values))
    if kind < 0.85:
        return r.choice(RC_ERRORS)
    if kind < 0.9:
        return r.choice(["# comment", "", "   ", "\t# indented comment", "#set linenumbers"])
    return r.choice(["\tset linenumbers", "  set tabsize 4", "set\tsoftwrap", "set tabsize\t4"])

def rc_text(r):
    lines = [rc_line(r) for _ in range(r.randint(1, 7))]
    text = "\n".join(lines) + ("\n" if r.random() < 0.9 else "")
    if r.random() < 0.1:
        text = text.replace("\n", "\r\n")
    return text

RC_TYPING = ["hello world", "x", "a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l", "\tindented"]

def gen_rc_steps(r, view):
    steps = []
    for _ in range(r.randint(1, 4)):
        kind = r.random()
        if kind < 0.3:
            steps.extend(r.choice(STATE_MOVES[:14]) for _ in range(r.randint(1, 5)))
        elif kind < 0.5 and not view:
            steps.append(r.choice(RC_TYPING))
        elif kind < 0.6 and not view:
            steps.extend(["Enter", r.choice(["x", "yz"])])
        elif kind < 0.7 and not view:
            steps.append(r.choice(["C-j", "M-j", "C-k", "C-u", "Tab"]))
        elif kind < 0.9:
            steps.extend(search_flow(r, view))
        else:
            steps.extend(r.choice([["C-c"], ["M-n"], ["M-s"], ["M-x"], ["M-z"], ["C-g", "C-x"]]))
    steps = without_stray_exec_keys(steps)
    return steps + r.choice([["C-x", "n"], ["C-x", "n"], ["C-x", "y", "Enter"], ["C-x"]])

def gen_rc(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([3, 6, 12, 30]))]
        text[r.randrange(len(text))] += " foo bar baz alpha tab end."
        rows, cols = r.choice([(10, 40), (12, 60), (24, 80), (14, 50), (8, 30), (24, 100)])
        files = {"sub/keep": ["k"]}
        home, xdg, env = {}, {}, {}
        where = r.choices(["home", "config", "xdg", "none", "dir"], [8, 2, 2, 1, 1])[0]
        if where == "home":
            home[".nanorc"] = rc_text(r)
        elif where == "config":
            home[".config/nano/nanorc"] = rc_text(r)
        elif where == "xdg":
            env["XDG_CONFIG_HOME"] = "@LAB@/xdg"
            xdg["nano/nanorc"] = rc_text(r)
            if r.random() < 0.3:
                home[".config/nano/nanorc"] = rc_text(r)
        elif where == "dir":
            home[".nanorc/"] = ""
            home[".config/nano/nanorc"] = rc_text(r)
        etc = rc_text(r) if r.random() < 0.4 else ""
        runs = []
        for _ in range(r.choice([1, 1, 2])):
            args = r.sample(["-l", "-S", "-i", "-E", "-w", "-b", "-x", "-c", "-A", "-e", "-j", "-k", "-a", "-q", "-L", "-%", "-_", "-0", "-O", "-y", "-W", "-Z", "-M", "-v"], r.choice([0, 0, 1, 2]))
            if r.random() < 0.2:
                args += [r.choice(["-T", "-r", "-J"]), r.choice(["2", "4", "10", "30"])]
            if r.random() < 0.15:
                args += ["-Q", r.choice(["^>", "^#"])]
            if r.random() < 0.1:
                args += ["-I"]
            if r.random() < 0.15:
                files["custom.rc"] = rc_text(r).split("\n")
                args += ["-f", r.choice(["custom.rc", "custom.rc", "@WORK@/custom.rc", "missing.rc"])]
            if r.random() < 0.08:
                args += ["+%d" % r.randint(1, len(text))]
            args.append("t.txt")
            runs.append({"args": args, "steps": gen_rc_steps(r, "-v" in args)})
        cases.append({"id": "rcf%d-%d" % (seed, i), "text": text, "files": files, "rows": rows, "cols": cols, "home": home, "xdg": xdg, "env": env, "rc": True, "etc_nanorc": etc, "runs": runs})
    return cases

COLOR_ELEMENTS = ["titlecolor", "numbercolor", "stripecolor", "scrollercolor", "selectedcolor", "spotlightcolor", "minicolor", "promptcolor", "statuscolor", "errorcolor", "keycolor", "functioncolor"]
COLOR_BASE = ["red", "green", "blue", "yellow", "cyan", "magenta", "white", "black"]
COLOR_EXTENDED = ["normal", "pink", "purple", "mauve", "lagoon", "mint", "lime", "peach", "orange", "latte", "rosy", "beet", "plum", "sea", "sky", "slate", "teal", "sage", "brown", "ocher", "sand", "tawny", "brick", "crimson", "grey", "gray"]
COLOR_BAD = ["pinkish", "#12", "#12345", "#xyz", "lightnormal", "brightpink", "lightgrey", "light#123", "bright", "light", "", "Red", "RED", "bold", "italic"]

def color_name(r):
    kind = r.random()
    if kind < 0.45:
        return r.choice(COLOR_BASE)
    if kind < 0.6:
        return r.choice(["light", "bright"]) + r.choice(COLOR_BASE)
    if kind < 0.8:
        return r.choice(COLOR_EXTENDED)
    if kind < 0.92:
        return "#" + "".join(r.choice("0123456789abcdefABCDEF") for _ in range(3))
    return r.choice(COLOR_BAD)

def color_spec(r):
    kind = r.random()
    prefix = ""
    if r.random() < 0.2:
        prefix = r.choice(["bold,", "italic,", "bold,italic,", "italic,bold,", "bold", "italic", "bold,bold,"])
    if kind < 0.45:
        return prefix + color_name(r)
    if kind < 0.85:
        return prefix + color_name(r) + "," + color_name(r)
    if kind < 0.95:
        return prefix + "," + color_name(r)
    return prefix + color_name(r) + ","

def colors_rc_text(r):
    lines = []
    for _ in range(r.randint(1, 6)):
        kind = r.random()
        if kind < 0.8:
            lines.append("set %s %s" % (r.choice(COLOR_ELEMENTS), r.choice(['"%s"', "%s"]) % color_spec(r)))
        elif kind < 0.9:
            lines.append(r.choice(["unset titlecolor", "set titlecolor", "unset statuscolor", "set keycolor"]))
        else:
            lines.append(rc_line(r))
    return "\n".join(lines) + "\n"

COLOR_STEPS = [["C-6"], ["C-6", "Right", "Right"], ["C-6", "Down"], ["C-w", "foo", "Enter"], ["C-w", "zzzz", "Enter"], ["M-w"], ["C-g", "C-x"], ["C-o"], ["C-r"], ["C-_"], ["C-c"], ["M-n"], ["C-t"], ["C-\\"], ["x", "C-x"], ["M-6"], ["C-u"], ["C-k"], ["C-j"]]

def gen_colors(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [edit_line(r) for _ in range(r.choice([3, 6, 12, 30, 60]))]
        text[r.randrange(len(text))] += " foo bar baz alpha tab end."
        rows, cols = r.choice([(10, 40), (12, 60), (24, 80), (14, 50), (8, 30), (24, 100)])
        home = {".nanorc": colors_rc_text(r)}
        env = {"NO_COLOR": "1"} if r.random() < 0.15 else {}
        etc = colors_rc_text(r) if r.random() < 0.2 else ""
        runs = []
        for _ in range(r.choice([1, 1, 2])):
            args = r.sample(["-l", "-S", "-q", "-c", "-x", "-0", "-_", "-D", "-%", "-v", "-E", "-A"], r.choice([0, 1, 2, 3]))
            if r.random() < 0.3:
                args += ["-J", r.choice(["2", "5", "10", "30"])]
            args.append("t.txt")
            steps = []
            for _ in range(r.randint(2, 6)):
                kind = r.random()
                if kind < 0.35:
                    steps.extend(r.choice(MOVES) for _ in range(r.randint(1, 4)))
                elif kind < 0.5 and "-v" not in args:
                    steps.append(r.choice(RC_TYPING))
                else:
                    steps.extend(r.choice(COLOR_STEPS))
            steps = without_stray_exec_keys(steps)
            runs.append({"args": args, "steps": steps + r.choice([["C-x", "n"], ["C-x", "n"], ["C-x"]])})
        cases.append({"id": "col%d-%d" % (seed, i), "text": text, "files": {"sub/keep": ["k"]}, "rows": rows, "cols": cols, "home": home, "xdg": {}, "env": env, "rc": True, "etc_nanorc": etc, "paint": True, "runs": runs})
    return cases

SYNTAX_EXTENSIONS = ['"\\.txt$"', '"\\.txt$"', '"t\\.txt"', '"t\\.txt"', '"\\.(txt|md)$"', '".*"', '"^[a-z]"', '"\\.c$"', '"\\<t"', '"(unclosed"', '"u\\.c$" "\\.txt$"', '"x" "(bad"', "\\.txt$", '""', '"[a-"']
SYNTAX_HEADERS = ['"^alpha"', '"^delta"', '"foo"', '"^#"', '"alpha" "^x"', '"(oops"', 'alpha', '""']
SYNTAX_REGEXES = ['alpha', 'beta', 'GAMMA', 'foo', 'bar', 'Hello', 'caf\u00e9', '\u4e2d\u6587', '\\<(alpha|beta)\\>', '[A-Z]+', '[[:digit:]]+', '^ +', ' +$', '\\t', 'a.', 'o*', 'x*', '\\(x\\)', '[[:space:]]+', 'end\\.', '^[a-z]', '\\<b', 'a$', '^', '$', 'e|a', '.', 'ab*c?', '[', 'a{2', '*a', '(', ')', 'a\\']
SYNTAX_LINES = ['"/\\*" end="\\*/"', '"//" end="$"', '"\\(" end="\\)"', '"\\"" end="\\""', '"^#" end="^$"', '"a" end="b"', '"x*" end="y*"', '"\\*/" end="\\*/"']

def syntax_color_spec(r):
    return r.choice(['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black', 'brightgreen,blue', 'bold,red', 'italic,green', 'bold,italic,yellow,blue', 'lightred', ',red', 'normal,cyan', '#f80', 'pink', 'nosuch', 'bold'])

def syntax_rule_line(r):
    keyword = r.choice(['color', 'color', 'color', 'icolor'])
    spec = syntax_color_spec(r)
    kind = r.random()
    if kind < 0.45:
        return '%s %s "%s"' % (keyword, spec, r.choice(SYNTAX_REGEXES))
    if kind < 0.6:
        return '%s %s "%s" "%s"' % (keyword, spec, r.choice(SYNTAX_REGEXES), r.choice(SYNTAX_REGEXES))
    if kind < 0.85:
        return '%s %s start=%s' % (keyword, spec, r.choice(SYNTAX_LINES))
    return r.choice(['%s %s' % (keyword, spec), keyword, '%s %s alpha' % (keyword, spec), '%s %s ""' % (keyword, spec), '%s %s "alpha' % (keyword, spec), '%s %s start="a" "b"' % (keyword, spec), '%s %s start="a" end=b' % (keyword, spec), '%s %s "a" start="b" end="c" "d"' % (keyword, spec)])

def syntax_block(r, name):
    lines = []
    head = r.random()
    if head < 0.1:
        lines.append(r.choice(['syntax', 'syntax ""', 'syntax "', 'syntax "a', 'syntax a"', 'syntax none', 'syntax "none" "x"', 'syntax "my lang" "\\.txt$"']))
    elif head < 0.2:
        lines.append('syntax "default"' + r.choice(['', '', ' "\\.txt$"']))
    elif head < 0.9:
        lines.append('syntax "%s" %s' % (name, r.choice(SYNTAX_EXTENSIONS)))
    else:
        lines.append('syntax %s %s' % (name, r.choice(SYNTAX_EXTENSIONS)))
    for _ in range(r.randint(0, 2)):
        lines.append('header %s' % r.choice(SYNTAX_HEADERS)) if r.random() < 0.6 else lines.append(r.choice(['magic "x"', 'header', 'magic']))
    for _ in range(r.randint(0, 6)):
        kind = r.random()
        if kind < 0.7:
            lines.append(syntax_rule_line(r))
        elif kind < 0.78:
            lines.append(r.choice(['comment "//"', 'comment //', 'comment', 'comment "', 'tabgives "  "', 'tabgives', 'linter xx', 'formatter yy', 'linter "q', 'comment "<!--"']))
        elif kind < 0.84:
            lines.append(r.choice(['# a comment', '', '   ', '\tcolor red "a"']))
        elif kind < 0.9:
            lines.append(r.choice(['set linenumbers', 'unset softwrap', 'set tabsize 3', 'include "/nonexistent"', 'bind ^S savefile main']))
        elif kind < 0.95:
            lines.append(r.choice(['frobnicate', 'colour red "a"', 'Color red "a"']))
        else:
            lines.append('syntax "inner%d" "\\.zzz$"' % r.randint(1, 9))
    return lines

SYNTAX_INCLUDES = ['include "~/syn/*.nanorc"', 'include "/root/syn/a.nanorc"', 'include ~/syn/b.nanorc', 'include "/root/syn/*.nanorc" extra', 'include "/root/nothing/*.nanorc"', 'include "/root/syn"', 'include "/root/syn/"', 'include', 'include "/root/syn/a.nanorc', 'include "~/syn/[ab].nanorc"', 'include "/dev/null"', 'include "/root/syn/c.nanorc"']

def syntax_include_files(r):
    files = {}
    for name in r.sample(["a", "b", "c"], r.randint(0, 3)):
        lines = []
        for syntax_name in r.sample(['alpha', 'beta', 'gamma', 'c', 'text', 'markdown', 'default'], r.randint(1, 2)):
            lines.extend(syntax_block(r, syntax_name))
        if r.random() < 0.3:
            lines.insert(r.randint(0, len(lines)), r.choice(['set tabsize 4', 'include "/root/syn/a.nanorc"', 'bind ^S savefile main', 'unset softwrap', 'extendsyntax alpha color red "a"', 'frob']))
        files["syn/%s.nanorc" % name] = "\n".join(lines) + "\n"
    return files

def syntax_rc_text(r):
    lines = []
    if r.random() < 0.15:
        lines.append(r.choice(['set linenumbers', 'set softwrap', 'set tabsize 4', 'set foo']))
    names = r.sample(['alpha', 'beta', 'gamma', 'c', 'text', 'markdown', 'default'], r.randint(1, 3))
    for name in names:
        lines.extend(syntax_block(r, name))
        if r.random() < 0.2:
            lines.append(r.choice(SYNTAX_INCLUDES))
    for _ in range(r.randint(0, 2)):
        if r.random() < 0.5:
            lines.append('extendsyntax %s %s' % (r.choice(names + ['nothere']), r.choice(['color red "alpha"', 'icolor blue "BETA"', 'header "^x"', 'comment "//"', 'tabgives "  "', 'color red "("', 'frob', 'magic "z"', 'color nosuch "a"', ''])))
    return "\n".join(lines) + ("\n" if r.random() < 0.9 else "")

SYNTAX_WORDS = ["alpha", "beta", "GAMMA", "foo", "bar", "Hello", "world", "caf\u00e9", "\u4e2d\u6587", "123", "(x)", "[1,2]", "a_b", "end.", "\ttab", "x", "ab", "abc", "aab", "/*", "*/", "//", "# note", "\"q\""]

def syntax_line(r):
    return " ".join(r.choice(SYNTAX_WORDS) for _ in range(r.randint(0, 9)))

SYNTAX_STEPS = [["M-3"], ["M-3", "M-3"], ["M-o", "Tab"], ["C-6", "Down", "M-3"], ["Down"], ["Down", "Down"], ["Up"], ["End"], ["Home"], ["Right", "Right"], ["PageDown"], ["PageUp"], ["M-\\"], ["M-/"], ["M-y"], ["M-y", "M-y"], ["C-w", "alpha", "Enter"], ["C-w", "foo", "Enter"], ["C-6", "Down", "Right"], ["C-k"], ["C-u"], ["Enter"], ["BSpace"], ["DC"], ["/*"], ["*/"], ["x"], ["(", "x", ")"], ["Tab"], ["M-n"], ["M-s"], ["C-_", "3", "Enter"]]

def gen_syntax(seed, count):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        text = [syntax_line(r) for _ in range(r.choice([4, 8, 14, 30]))]
        rows, cols = r.choice([(10, 40), (12, 60), (24, 80), (14, 50), (8, 30), (24, 100)])
        home = {".nanorc": syntax_rc_text(r)}
        if r.random() < 0.35:
            home.update(syntax_include_files(r))
        etc = syntax_rc_text(r) if r.random() < 0.25 else ""
        files = {}
        runs = []
        for _ in range(r.choice([1, 1, 2])):
            args = r.sample(["-l", "-S", "-q", "-c", "-x", "-0", "-_", "-D", "-%", "-v", "-E", "-A", "-J"], r.choice([0, 0, 1, 2]))
            if "-J" in args:
                args += ["10"] if False else []
                args.remove("-J")
                args += ["-J", r.choice(["5", "20"])]
            if r.random() < 0.25:
                args += ["-Y", r.choice(["alpha", "beta", "gamma", "c", "text", "markdown", "default", "none", "nosuch", "x"])]
            steps = []
            for _ in range(r.randint(2, 7)):
                steps.extend(r.choice(SYNTAX_STEPS))
            if r.random() < 0.2:
                steps.extend(["C-o", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", r.choice(["u.c", "n.md", "z.txt", "q"]), "Enter"])
            steps = without_stray_exec_keys(steps)
            runs.append({"args": args + ["t.txt"], "steps": steps + r.choice([["C-x", "n"], ["C-x", "n"], ["C-x"]])})
        cases.append({"id": "syn%d-%d" % (seed, i), "text": text, "files": files, "rows": rows, "cols": cols, "home": home, "xdg": {}, "env": {}, "rc": True, "etc_nanorc": etc, "paint": True, "runs": runs})
    return cases

PACKAGE_REAL_EXTENSIONS = ["c", "h", "cc", "hpp", "py", "sh", "bash", "pl", "pm", "json", "yaml", "yml", "xml", "html", "css", "js", "go", "rb", "sql", "md", "s", "S", "1", "5", "cmake", "txt", "conf", "el", "tcl", "mk"]
PACKAGE_HAND_SAMPLES = {
    "java": ["package demo;", "import java.util.List;", "/** Doc comment. */", "public class Demo extends Base {", "    private static final int LIMIT = 42; // limit", "    @Override public String toString() { return \"Demo\"; }", "    void run() throws Exception { if (LIMIT > 1) throw new Exception(\"x\"); }", "}"],
    "rs": ["use std::collections::HashMap;", "// A comment", "#[derive(Debug)]", "pub struct Point { x: i32, y: i32 }", "impl Point {", "    pub fn new(x: i32, y: i32) -> Self { Point { x, y } }", "    fn show(&self) { println!(\"{} {}\", self.x, self.y); }", "}", "fn main() { let p = Point::new(1, 2); let n: u8 = 0x1f; p.show(); }"],
    "patch": ["diff --git a/f.c b/f.c", "index 83db48f..bf2a3c1 100644", "--- a/f.c", "+++ b/f.c", "@@ -1,4 +1,5 @@ int main(void)", " context line", "-removed line", "+added line", "+another added", " tail"],
    "scm": ["(define (square x) (* x x))", "; comment", "(let ((a 1) (b \"two\"))", "  (display (string-append \"a\" b)) #t)", "'(1 2 3)"],
    "hs": ["module Main where", "-- comment", "import Data.List (sort)", "data Shape = Circle Double | Square Double deriving (Show)", "area :: Shape -> Double", "area (Circle r) = pi * r * r", "main = print $ sort [3, 1, 2]", "{- block", "comment -}"],
    "ml": ["(* comment *)", "let rec fact n = if n <= 1 then 1 else n * fact (n - 1)", "type t = A | B of int", "let () = print_endline \"hi\"", "module M = struct let x = 0x10 end"],
    "ac": ["AC_INIT([demo], [1.0])", "dnl comment", "AM_INIT_AUTOMAKE([foreign])", "AC_PROG_CC", "AC_CONFIG_FILES([Makefile])", "AC_OUTPUT"],
    "nft": ["#!/usr/sbin/nft -f", "flush ruleset", "table inet filter {", "  chain input {", "    type filter hook input priority 0; policy drop;", "    ct state established,related accept", "    tcp dport { 22, 80 } accept", "  }", "}"],
    "tex": ["\\documentclass{article}", "% comment", "\\usepackage{amsmath}", "\\begin{document}", "\\section{Intro} Text with $x^2$ and \\emph{words}.", "\\end{document}"],
    "texi": ["\\input texinfo", "@c comment", "@setfilename demo.info", "@node Top", "@chapter Intro", "@code{foo} and @emph{bar}.", "@bye"],
    "php": ["<?php", "// comment", "namespace App;", "class Demo { public function run(array $a): int { return count($a) + 0x1; } }", "$x = \"text\" . 'single';", "echo $x; ?>"],
    "lua": ["-- comment", "local t = { a = 1, b = \"two\" }", "function t.run(x) if x > 1 then return x end end", "for i = 1, 10 do print(i) end", "--[[ block", "comment ]]"],
    "awk": ["#!/usr/bin/awk -f", "BEGIN { FS = \":\" }", "# comment", "/^root/ { print $1, NR }", "END { print \"done\" }"],
    "po": ["# translator comment", "msgid \"\"", "msgstr \"\"", "\"Content-Type: text/plain; charset=UTF-8\\n\"", "", "#: src/main.c:10", "msgid \"Hello\"", "msgstr \"Bonjour\""],
    "m": ["#import <Foundation/Foundation.h>", "// comment", "@interface Demo : NSObject", "- (void)run;", "@end", "@implementation Demo", "- (void)run { NSLog(@\"hi\"); }", "@end"],
    "eml": ["From: Ann <ann@example.org>", "To: Bob <bob@example.org>", "Subject: hello", "", "> quoted text", "plain text with https://example.org/page.html link"],
    "ChangeLog": ["2024-01-02  Ann <ann@example.org>", "", "\t* src/main.c (main): Fix the thing.", "\t* README: Update."],
    "spec": ["Name: demo", "Version: 1.0", "%description", "A demo package.", "%build", "make %{?_smp_mflags}", "%files", "%{_bindir}/demo"],
    "pov": ["#include \"colors.inc\"", "// comment", "camera { location <0, 2, -3> look_at <0, 1, 2> }", "sphere { <0, 1, 2>, 2 texture { pigment { color Yellow } } }"],
    "nanorc": ["## comment", "set linenumbers", "syntax demo \"\\.demo$\"", "color red \"alpha\"", "bind ^X exit main"],
    "ms": [".TH DEMO 1", ".SH NAME", "demo \\- do the thing", ".B bold text", "\\fIitalic\\fR and \\*(lq quoted \\*(rq", ".\\\" comment"],
    "list": ["deb http://archive.ubuntu.com/ubuntu noble main restricted", "# comment", "deb-src http://archive.ubuntu.com/ubuntu noble universe"],
}
PACKAGE_HEADER_FILES = [
    ("run", "#!/bin/sh", ["echo \"hi\" # trailing", "if [ -n \"$1\" ]; then", "  exit 0", "fi"]),
    ("tool", "#!/usr/bin/env python3", ["import os", "def main():", "    print('x', 0x10)  # note", "main()"]),
    ("doc", "<?xml version=\"1.0\"?>", ["<root a=\"1\">", "  <!-- comment -->", "  <item>text &amp; more</item>", "</root>"]),
    ("page", "<!DOCTYPE html>", ["<html><body class=\"x\">", "<a href=\"https://example.org\">link</a>", "</body></html>"]),
    ("scr", "#!/usr/bin/perl", ["my $x = 1;", "print \"hi\\n\" if $x; # c", "sub f { return @_ }"]),
    ("rubyscript", "#!/usr/bin/env ruby", ["class A", "  def b; :sym; end", "end", "puts \"x\" # c"]),
    ("luascript", "#!/usr/bin/lua", ["local x = 1 -- c", "print(x)"]),
    ("csrc", "/* -*- C -*- */", ["#include <stdio.h>", "int main(void) { return 0; }"]),
    ("mkfile", "# -*- Makefile -*-", ["all: a.o", "\tcc -o $@ $^", "CFLAGS = -O2"]),
    ("Makefile", "CC = gcc", ["all: main", "main: main.o", "\t$(CC) -o main main.o # link", ".PHONY: all", "include other.mk"]),
    ("CMakeLists.txt", "cmake_minimum_required(VERSION 3.10)", ["project(demo C)", "# comment", "add_executable(demo main.c)", "if(WIN32)", "endif()"]),
    ("ChangeLog.old", "Wed Jan  2 2024  Ann  <ann@example.org>", ["", "\t* file.c: change"]),
    ("sources.list", "deb http://archive.ubuntu.com/ubuntu noble main", ["# comment", "deb-src http://archive.ubuntu.com/ubuntu noble main"]),
    ("script.zsh", "#!/bin/zsh", ["export A=1", "for f in *; do echo $f; done"]),
    ("profile", "# shell profile", ["export PATH=\"$PATH:/opt/bin\"", "alias ll='ls -l'"]),
    ("plain", "Plain text mentioning https://example.org/a.html and ann@example.org", ["Date 2024.01.15 and GNU nano 7.2 \"Cool\"", "\t \tspace before tab", "# comment-like line", "[section]"]),
]
PACKAGE_SYNTAX_NAMES = ["c", "python", "sh", "default", "none", "makefile", "json", "html", "xml", "yaml", "perl", "ruby", "go", "css", "javascript", "man", "markdown", "nosuch", "patch", "sql", "tcl", "asm", "email", "cmake"]
PACKAGE_STEPS = SYNTAX_STEPS + [["\""], ["'"], ["#"], ["<!--"], ["-->"], ["\\"], ["{", "}"], ["["], ["]"], ["`"], ["$"], [" "], ["C-y"]]

def package_real_candidates(extension):
    found = subprocess.run("find / -xdev -type f -name '*.%s' -size -40k -size +200c 2>/dev/null | head -300" % extension, shell=True, capture_output=True, text=True).stdout.split()
    return sorted(found)

def package_window(r, path):
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except (UnicodeDecodeError, OSError):
        return None
    if lines and lines[-1] == "":
        lines.pop()
    lines = [line[:170] for line in lines if "\r" not in line and "\x00" not in line]
    if len(lines) < 3:
        return None
    start = r.randint(0, max(0, min(len(lines) - 3, 300)))
    return lines[start:start + r.choice([6, 12, 20, 40])]

def package_sample(r, candidates):
    kind = r.random()
    if kind < 0.55:
        extension = r.choice(PACKAGE_REAL_EXTENSIONS)
        for _ in range(20):
            files = candidates.setdefault(extension, package_real_candidates(extension))
            if not files:
                break
            window = package_window(r, r.choice(files))
            if window:
                return "sample.%s" % extension, window
    elif kind < 0.85:
        extension = r.choice(sorted(PACKAGE_HAND_SAMPLES))
        name = "ChangeLog" if extension == "ChangeLog" else "sample.%s" % extension
        return name, list(PACKAGE_HAND_SAMPLES[extension])
    name, first, rest = r.choice(PACKAGE_HEADER_FILES)
    return name, [first] + rest

def gen_package(seed, count):
    r = random.Random(seed)
    candidates = {}
    cases = []
    for i in range(count):
        name, text = package_sample(r, candidates)
        rows, cols = r.choice([(10, 40), (12, 60), (24, 80), (14, 50), (8, 30), (24, 100)])
        runs = []
        for _ in range(r.choice([1, 1, 2])):
            args = r.sample(["-l", "-S", "-q", "-c", "-x", "-0", "-_", "-D", "-%", "-v", "-E", "-A", "-J"], r.choice([0, 0, 1, 2]))
            if "-J" in args:
                args.remove("-J")
                args += ["-J", r.choice(["5", "20"])]
            if r.random() < 0.15:
                args += ["-Y", r.choice(PACKAGE_SYNTAX_NAMES)]
            steps = []
            for _ in range(r.randint(2, 8)):
                steps.extend(r.choice(PACKAGE_STEPS))
            if r.random() < 0.15:
                steps.extend(["C-o", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", r.choice(["u.c", "n.md", "z.txt", "q.py", "r.sh", "Makefile", "a.json"]), "Enter"])
            steps = without_stray_exec_keys(steps)
            runs.append({"args": args + [name], "steps": steps + r.choice([["C-x", "n"], ["C-x", "n"], ["C-x"]])})
        cases.append({"id": "pkg%d-%d" % (seed, i), "text": [""], "files": {name: text}, "rows": rows, "cols": cols, "home": {}, "xdg": {}, "env": {}, "rc": True, "package": True, "paint": True, "runs": runs})
    return cases


def gen(seed, count, corpus):
    if corpus == "state":
        return gen_state(seed, count)
    if corpus == "rc":
        return gen_rc(seed, count)
    if corpus == "colors":
        return gen_colors(seed, count)
    if corpus == "syntax":
        return gen_syntax(seed, count)
    if corpus == "package":
        return gen_package(seed, count)
    if corpus == "tab":
        return gen_tab(seed, count)
    if corpus == "mouse":
        return gen_mouse(seed, count)
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
    runner = run_state_case if a.corpus in ("state", "rc", "colors", "syntax", "package") else run_cli_case if a.corpus in ("cli", "mouse", "tab", "place", "tools", "insert", "open", "undo", "undo2", "search", "help", "blocks", "exec") else run_case
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
