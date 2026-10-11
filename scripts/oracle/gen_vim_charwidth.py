#!/usr/bin/env python3
"""Generate vim/VimCharWidth.ts from the display width table of the installed vim.

usage: gen_vim_charwidth.py out.ts

For every code point from U+0080 up, strdisplaywidth('a' . nr2char(c)) - 1 is the number of
cells vim spends on it in a utf-8 locale with the default 'ambiwidth' and 'emoji': 0 for a
composing character, 2 for a wide one, 4 or 6 for the <xx> / <xxxx> form of a character it
cannot print.  Only the intervals that differ from one cell are written.
"""
import os, subprocess, sys, tempfile

SCRIPT = """
set encoding=utf-8
let s:out = []
let s:prev = -1
let s:start = 0
for c in range(0x80, 0x10ffff)
  if c >= 0xd800 && c <= 0xdfff
    continue
  endif
  let w = strdisplaywidth('a' . nr2char(c)) - 1
  if w != s:prev
    if s:prev != -1 | call add(s:out, printf('%x %x %d', s:start, c - 1, s:prev)) | endif
    let s:start = c
    let s:prev = w
  endif
endfor
call add(s:out, printf('%x %x %d', s:start, 0x10ffff, s:prev))
call writefile(s:out, $OUT)
qa!
"""

def main():
    with tempfile.TemporaryDirectory() as d:
        script = os.path.join(d, "w.vim")
        out = os.path.join(d, "widths.txt")
        open(script, "w").write(SCRIPT)
        env = dict(os.environ, OUT=out, LANG="C.UTF-8")
        subprocess.run(["vim", "-u", "NONE", "-es", "-S", script], env=env, check=True, timeout=300)
        rows = [line.split() for line in open(out).read().split("\n") if line]
    entries = [(int(a, 16), int(b, 16), int(w)) for a, b, w in rows if int(w) != 1]
    lines = []
    for i in range(0, len(entries), 4):
        lines.append("  " + ", ".join("0x%x, 0x%x, %d" % e for e in entries[i:i + 4]) + ",")
    open(sys.argv[1], "w").write(
        "export const NON_SINGLE_CELL_RANGES: readonly number[] = [\n" + "\n".join(lines) + "\n];\n"
    )

main()
