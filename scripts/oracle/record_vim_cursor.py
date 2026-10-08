#!/usr/bin/env python3
"""Record cursor/buffer transcripts from a real vim.

usage: record_vim_cursor.py [--seed N] [--cases N] [--vocab cursor|edit|all] out.json

Every case is a starting buffer and a list of steps; a step is one complete Normal-mode
command (ending in <Esc> when it enters Insert mode).  The real vim runs the steps one by
one in a single headless session (errors abort only their own step, as in interactive use)
and the line, byte column, curswant, buffer and register-free state after each step are saved.
"""
import json, os, random, subprocess, sys, tempfile

WORDS = ["foo", "bar", "baz", "x", "Hello", "world", "a_b", "foo-bar", "(x)", "[1,2]", "{y}", "end.", "it's", "42", "--", "/*", "*/", "tab\there"]
SEPS = [" ", " ", " ", "  ", "\t", ", ", ". "]

def rand_line(r):
    kind = r.random()
    if kind < 0.1:
        return ""
    if kind < 0.15:
        return " " * r.randint(1, 4)
    words = [r.choice(WORDS) for _ in range(r.randint(1, 6))]
    out = ""
    for w in words:
        out += w + r.choice(SEPS)
    out = out.rstrip(" ") if r.random() < 0.7 else out
    if r.random() < 0.3:
        out = r.choice(["  ", "\t", "    "]) + out
    return out

def rand_text(r):
    return [rand_line(r) for _ in range(r.randint(1, 6))]

MOTIONS = ["h", "j", "k", "l", "w", "W", "b", "B", "e", "E", "ge", "gE", "0", "^", "$", "g_", "gg", "G",
           "{", "}", "%", "+", "-", "<CR>", "<Space>", "<BS>", "|", "_", "gj", "gk"]
CHARS = list("aexo .,-(")
PATTERNS = ["foo", "a", "42", "ba", "end", "x", "o.", "^foo", "\\<b", "r$", "[0-9]", "tab"]

def search_step(r):
    n = r.choice(["", "", "2", "3"])
    pat = r.choice(PATTERNS)
    pool = [
        [f"/{pat}<CR>"], [f"?{pat}<CR>"], ["n"], ["N"], [n + "n"], [n + "N"], ["*"], ["#"], [n + "*"], ["g*"], ["g#"],
        [f"d/{pat}<CR>"], [f"d?{pat}<CR>"], ["dn"], ["dN"], [f"c/{pat}<CR>Q<Esc>"], [f"y/{pat}<CR>"], [f"/{pat}<CR>", "n"], [f"/{pat}/e<CR>"],
        [f"/{pat}/+1<CR>"], [f"?{pat}?e<CR>"], [f"/{pat}<CR>", "N"], ["d*"], ["y#"], ["gn"], ["dgn"], ["cgnQ<Esc>"],
        ["("], [")"], [n + "("], [n + ")"], ["d)"], ["d("], ["y)"], ["c)Q<Esc>"], ["das"], ["dis"], ["yas"], ["vasd"], ["visd"],
        ["H"], ["M"], ["L"], [n + "H"], [n + "L"], ["dH"], ["dL"], ["dM"], ["yL"], ["vLd"],
    ]
    return r.choice(pool)

def rand_step(r, vocab):
    n = r.choice(["", "", "", "2", "3", "5"])
    roll = r.random()
    if vocab == "search" and roll < 0.6:
        return search_step(r)
    if vocab == "search":
        vocab = "all"
        roll = r.random()
    if vocab == "cursor" or roll < 0.62:
        k = r.random()
        if k < 0.18:
            return [n + r.choice(["f", "F", "t", "T"]) + r.choice(CHARS)]
        if k < 0.24:
            return [r.choice([";", ",", n + ";", n + ","])]
        if k < 0.30:
            return [n + "|"]
        if k < 0.34:
            return [n + "G"]
        m = r.choice(MOTIONS)
        return [(n if m != "0" else "") + m]
    ins = r.choice(["ab", "X Y", "", "z"])
    edits = [
        ["x"], ["X"], ["dd"], ["D"], ["dw"], ["db"], ["d$"], ["d0"], ["de"], ["dj"], ["dk"], ["dG"], ["dgg"], ["d}"], ["d{"], ["d%"], ["dfa"], ["dta"],
        ["cwNEW<Esc>"], ["ccNEW<Esc>"], ["C" + ins + "<Esc>"], ["s" + ins + "<Esc>"], ["S" + ins + "<Esc>"],
        ["yy"], ["yw"], ["y$"], ["p"], ["P"], ["yy", "p"], ["yy", "P"], ["dd", "p"], ["x", "p"],
        ["o" + ins + "<Esc>"], ["O" + ins + "<Esc>"], ["i" + ins + "<Esc>"], ["a" + ins + "<Esc>"],
        ["A" + ins + "<Esc>"], ["I" + ins + "<Esc>"], ["gI" + ins + "<Esc>"],
        ["r" + r.choice("xyz")], ["~"], ["J"], ["gJ"], ["u"], ["<C-r>"], [">>"], ["<<"], ["."], ["U"],
        ["guu"], ["gUU"], ["g~~"], ["guw"], ["gUiw"], ["g~$"], ["vjd"], ["vly"], ["Vjd"], ["vey"], ["viwd"], ["vawd"], ["Vp"], ["ciwNEW<Esc>"], ["diw"], ["daw"], ["di("], ["ci(NEW<Esc>"], ["da\""], ["yiw"], ["dip"], ["dap"],
        ["dd", "."], ["A" + ins + "<Esc>", "j", "."], ["3x"], ["2dd"], ["3J"], ["R" + ins + "<Esc>"], ["ix<Esc>", "u"], ["x", "u"], ["x", "u", "u"], ["dd", "u"],
        ["3ix<Esc>"], ["2ofoo<Esc>"], ["5r-"], ["3~"], ["2yy", "P"], [">j"], ["<k"], ["3>>"], ["d2w"], ["2d3w"], ["c2wNEW<Esc>"], ["yiw", "P"], ["yy", "3p"], ["x", "3p"],
    ]
    pick = r.choice(edits)
    if len(pick) == 1 and r.random() < 0.25 and not pick[0].startswith(("d", "c", "g", "y", "v", "V", ".", "u", "<", ">", "U", "R")):
        return [n + pick[0]]
    return pick

def gen_cases(seed, count, vocab):
    r = random.Random(seed)
    cases = []
    for i in range(count):
        steps = [t for _ in range(r.randint(2, 9)) for t in rand_step(r, vocab)]
        cases.append({"id": f"c{seed}-{i}", "text": rand_text(r), "steps": steps})
    return cases

VIMSCRIPT = r'''
set nocompatible
set noswapfile nobackup nowritebackup viminfo= tabstop=8 shiftwidth=8 noexpandtab noautoindent
set nowrapscan
set wrapscan
set lines=40 columns=200
let g:cases = json_decode(join(readfile($VCASES), "\n"))
let g:out = []
function! Keys(step) abort
  return substitute(a:step, '<\(CR\|Esc\|Space\|BS\|C-r\|C-v\)>', '\=eval("\"\\" . submatch(0) . "\"")', 'g')
endfunction
for c in g:cases
  set undolevels=-1
  silent! %delete _
  call setline(1, c.text)
  set undolevels=1000
  silent! normal! gg0
  redraw
  let rec = {'id': c.id, 'after': []}
  for s in c.steps
    try
      execute "silent! normal \<Esc>" . Keys(s)
    catch
    endtry
    if mode() !=# 'n'
      call feedkeys("\<Esc>", 'nx')
    endif
    redraw
    let &undolevels = &undolevels
    let p = getcurpos()
    call add(rec.after, {'line': p[1], 'col': p[2], 'off': p[3], 'want': p[4], 'text': getline(1, '$'), 'mode': mode()})
  endfor
  call add(g:out, rec)
endfor
call writefile([json_encode(g:out)], $VOUT)
qa!
'''

def run_one(case, d):
    cf = os.path.join(d, case["id"] + ".json")
    vf = os.path.join(d, "run.vim")
    of = os.path.join(d, case["id"] + ".out.json")
    json.dump([case], open(cf, "w"))
    env = dict(os.environ, VCASES=cf, VOUT=of, TERM="xterm")
    subprocess.run(["vim", "-u", "NONE", "-i", "NONE", "-N", "-es", "-S", vf], env=env, check=False,
                   stdin=subprocess.DEVNULL, timeout=60)
    return json.load(open(of))[0]

def main():
    from concurrent.futures import ThreadPoolExecutor
    args = sys.argv[1:]
    seed, count, vocab = 1, 300, "all"
    out = None
    i = 0
    while i < len(args):
        if args[i] == "--seed": seed = int(args[i+1]); i += 2
        elif args[i] == "--cases": count = int(args[i+1]); i += 2
        elif args[i] == "--vocab": vocab = args[i+1]; i += 2
        else: out = args[i]; i += 1
    cases = gen_cases(seed, count, vocab)
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "run.vim"), "w").write(VIMSCRIPT)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda c: run_one(c, d), cases))
    by_id = {r["id"]: r for r in results}
    merged = [dict(c, after=by_id[c["id"]]["after"]) for c in cases]
    json.dump({"vim": subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0],
               "cases": merged}, open(out, "w"), indent=0)
    print(len(merged), "cases ->", out)

main()
