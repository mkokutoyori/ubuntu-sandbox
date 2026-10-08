#!/usr/bin/env python3
"""Record cursor/buffer transcripts from a real GNU nano driven through tmux.

usage: record_nano_cursor.py [--seed N] [--cases N] [--steps N] out.json

Each case is a starting buffer and a list of key tokens (tmux key names or literal text).
After every token the pane is captured; the saved state is the screen rows holding the buffer,
the cursor screen row/column, and the nano version.  Buffers stay under 60 columns and 12 lines
so nothing scrolls and the screen is the buffer.
"""
import argparse, json, os, random, subprocess, tempfile, time

PARA_WORDS = ["foo", "bar.", "baz?", "Hello!", "(x).", "it's", "42", "end.)", "a_b,", "x", "world"]
WORDS = ["foo", "bar", "baz", "Hello", "world", "a_b", "foo-bar", "(x)", "end.", "it's", "42", "x"]
MOVES = ["Left", "Right", "Up", "Down", "Home", "End", "C-Left", "C-Right", "C-a", "C-e", "C-p", "C-n", "C-b", "C-f", "M-\\", "M-/", "C-y", "C-v", "PageUp", "PageDown"]
EDITS = ["BSpace", "DC", "C-k", "C-u", "Enter", "C-d", "C-h", "M-6", "Tab", "X", "yz", "C-j", "M-u", "M-e", "C-k", "C-k", "C-u", "M-6", "C-6"]

def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout

def make_buffer(r):
    lines = []
    for _ in range(r.randint(1, 8)):
        if r.random() < 0.12:
            lines.append("")
            continue
        text = ""
        for _ in range(r.randint(1, 5)):
            text += r.choice(WORDS) + r.choice([" ", " ", "  ", "\t", ", "])
        lines.append(text.rstrip(" ") if r.random() < 0.7 else text)
    return lines

def make_paragraph_buffer(r):
    lines = []
    for _ in range(r.randint(1, 4)):
        indent = r.choice(["", "", "  ", "\t", "    "])
        text = indent
        for _ in range(r.randint(2, 14)):
            text += r.choice(PARA_WORDS) + r.choice([" ", " ", "  ", "   ", "\t"])
        lines.append(text.rstrip() if r.random() < 0.5 else text)
        if r.random() < 0.25:
            lines.append("")
    return lines

def snapshot(session, rows):
    screen = tmux("capture-pane", "-p", "-t", session).split("\n")
    body = [row.rstrip() for row in screen[1:1 + rows]]
    position = tmux("display", "-p", "-t", session, "#{cursor_y},#{cursor_x}").strip()
    if "," not in position:
        return None
    y, x = position.split(",")
    return {"rows": body, "y": int(y) - 1, "x": int(x)}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--cases", type=int, default=100)
    ap.add_argument("--steps", type=int, default=6)
    ap.add_argument("--vocab", default="all")
    ap.add_argument("out")
    a = ap.parse_args()
    r = random.Random(a.seed)
    version = subprocess.run(["nano", "--version"], capture_output=True, text=True).stdout.split("\n")[0].strip()
    cases = []
    tmpdir = tempfile.mkdtemp()
    for n in range(a.cases):
        lines = make_paragraph_buffer(r) if a.vocab == "justify" else make_buffer(r)
        path = os.path.join(tmpdir, f"c{n}.txt")
        open(path, "w").write("\n".join(lines) + "\n")
        session = f"rec{a.seed}x{n}"
        tmux("kill-session", "-t", session)
        tmux("new-session", "-d", "-s", session, "-x", "80", "-y", "24", f"nano -I {path}")
        time.sleep(0.25)
        steps, after = [], []
        for _ in range(1 if a.vocab == "justify" else r.randint(2, a.steps)):
            token = "C-j" if a.vocab == "justify" else (r.choice(MOVES) if r.random() < 0.65 else r.choice(EDITS))
            steps.append(token)
            if len(token) > 1 and token[0:2] not in ("C-", "M-") and token not in ("Left", "Right", "Up", "Down", "Home", "End", "BSpace", "DC", "Enter", "Tab", "PageUp", "PageDown"):
                tmux("send-keys", "-t", session, "-l", token)
            else:
                tmux("send-keys", "-t", session, token)
            time.sleep(0.12)
            shot = snapshot(session, 20)
            if shot is None:
                steps.pop()
                break
            after.append(shot)
        tmux("kill-session", "-t", session)
        cases.append({"id": f"n{a.seed}-{n}", "text": lines, "steps": steps, "after": after})
    json.dump({"nano": version, "cases": cases}, open(a.out, "w"), separators=(",", ":"))
    print(len(cases), "cases ->", a.out)

main()
