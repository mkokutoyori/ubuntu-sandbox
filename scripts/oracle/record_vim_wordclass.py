#!/usr/bin/env python3
"""Record what vim 9.1 counts as a keyword character and which characters `w` treats as one word.

usage: record_vim_wordclass.py out.json

For each 'iskeyword' value of SPECS and every code point from U+0001 to U+10FFFF (surrogates apart), `\\k`
says whether the character is a keyword character; the result is stored as intervals.  Then, for every pair of
characters taken from the representatives (one per interval of vim's character class table, plus the Latin-1
ones the table does not reach; composing characters are left out, vim folds them into the character before), `w` on the line "<a><b> x" lands on the second character when the two have different
classes and on `x` when they share one: that is the class equality `cls()` computes, which the numeric class
values (hiragana, katakana, CJK, hangul, braille, superscripts, emoji) must reproduce.
"""
import json, os, subprocess, sys, tempfile

SPECS = ["@,48-57,_,192-255", "@", "@,48-57,_", "a-z", "@,^_", "@-@", "_,-,128-140,#-43", "^a-z", "@,48-57,_,192-255,-", "@,48-57,_,192-255,^é", "160,@", "1-255", "^1-255,a-c"]

SCRIPT = r"""
set nocompatible
set encoding=utf-8
let out = {'keyword': {}, 'pairs': []}
let specs = json_decode(join(readfile($SPECS), ''))
for spec in specs
  execute 'set iskeyword=' . spec
  let ranges = []
  let start = -1
  let last = -1
  let top = (spec == specs[0]) ? 0x10ffff : 0xff
  for c in range(1, top)
    if c >= 0xd800 && c <= 0xdfff
      let on = 0
    else
      let on = match(nr2char(c), '\k') == 0
    endif
    if on
      if start < 0
        let start = c
      endif
      let last = c
    elseif start >= 0
      call add(ranges, [start, last])
      let start = -1
    endif
  endfor
  if start >= 0
    call add(ranges, [start, last])
  endif
  let out.keyword[spec] = ranges
endfor
set iskeyword&
let reps = filter(json_decode(join(readfile($REPS), '')), 'v:val < 0x100 || strdisplaywidth("a" . nr2char(v:val)) > 1')
let out.representatives = reps
for a in reps
  for b in reps
    silent! %delete _
    call setline(1, nr2char(a) . nr2char(b) . ' x')
    call cursor(1, 1)
    silent! normal! w
    let col = col('.')
    let la = len(nr2char(a))
    call add(out.pairs, [a, b, col == la + 1 ? 1 : 0])
  endfor
endfor
call writefile([json_encode(out)], $OUT)
qa!
"""


def representatives():
    points = {0x21, 0x2d, 0x30, 0x41, 0x5f, 0x61, 0x7e, 0x7f, 0xa1, 0xa9, 0xae, 0xb5, 0xc0, 0xd7, 0xe9, 0xf7, 0xff}
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "network", "devices", "linux", "editors", "vim", "VimCharClassData.ts")
    text = open(path, encoding="utf-8").read()
    numbers = [int(n, 16) for n in __import__("re").findall(r"0x([0-9a-f]+)", text)]
    for n in numbers:
        for candidate in (n, n + 1, n - 1):
            if 0x100 <= candidate <= 0x10ffff and not 0xd800 <= candidate <= 0xdfff:
                points.add(candidate)
    return sorted(points)[::3] + [0x3042, 0x30a2, 0x4e2d, 0xac01, 0x2800, 0x2074, 0x2081, 0x1f600, 0x203c, 0x2014, 0x3001, 0xff01]


def main():
    out_path = sys.argv[1]
    reps = sorted(set(representatives()))
    with tempfile.TemporaryDirectory() as work:
        specs_path, reps_path, result_path, script_path = (os.path.join(work, n) for n in ("specs.json", "reps.json", "out.json", "w.vim"))
        json.dump(SPECS, open(specs_path, "w"))
        json.dump(reps, open(reps_path, "w"))
        open(script_path, "w").write(SCRIPT)
        env = dict(os.environ, SPECS=specs_path, REPS=reps_path, OUT=result_path, LANG="C.UTF-8", LC_ALL="C.UTF-8")
        subprocess.run(["vim", "-u", "NONE", "-i", "NONE", "-N", "-es", "-S", script_path], env=env, timeout=1200, check=False,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        recorded = json.load(open(result_path))
    version = subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    reps = recorded["representatives"]
    different = {(a, b): d for a, b, d in recorded["pairs"]}
    rows = ["".join(str(different[(a, b)]) for b in reps) for a in reps]
    json.dump({"vim": version, "specs": SPECS, "keyword": recorded["keyword"], "representatives": reps, "different": rows}, open(out_path, "w"), separators=(",", ":"))
    print(len(reps), "representatives,", len(recorded["pairs"]), "pairs ->", out_path)


if __name__ == "__main__":
    main()
