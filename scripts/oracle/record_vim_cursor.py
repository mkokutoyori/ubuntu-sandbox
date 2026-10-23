#!/usr/bin/env python3
"""Record cursor/buffer transcripts from a real vim.

usage: record_vim_cursor.py [--seed N] [--cases N] [--vocab cursor|edit|search|tabs|visual|insert|words|all] out.json

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

TAB_OPTIONS = [["tabstop=8"], ["tabstop=4"], ["tabstop=2"], ["tabstop=3"], ["shiftwidth=4"], ["shiftwidth=2"], ["shiftwidth=0", "tabstop=4"],
               ["softtabstop=4"], ["softtabstop=-1", "shiftwidth=4"], ["softtabstop=2"], ["softtabstop=8"], ["expandtab"], ["autoindent"]]

def tab_options(r):
    chosen = []
    for group in r.sample(TAB_OPTIONS, r.randint(0, 5)):
        chosen += group
    return chosen

def tabs_step(r):
    ins = r.choice(["x", "ab", " ", "  ", "x y", "   "])
    n = r.choice(["", "", "2", "3"])
    pool = [
        ["i<Tab><Esc>"], ["a<Tab><Esc>"], ["A<Tab><Esc>"], ["I<Tab><Esc>"], ["i<Tab><Tab><Esc>"], ["A<Tab><Tab><Tab><Esc>"],
        ["A" + ins + "<Tab>x<Esc>"], ["i<Tab><BS><Esc>"], ["A<Tab><Tab><BS><Esc>"], ["A<Tab><Tab><BS><BS><Esc>"], ["A<BS><Esc>"], ["A<BS><BS><Esc>"],
        ["A  <Tab><BS><Esc>"], ["A  <BS><Esc>"], ["A    <BS><Esc>"], ["I<BS><Esc>"], ["A" + ins + "<BS><Esc>"], ["I" + ins + "<Tab><BS><BS><Esc>"],
        ["o<Esc>"], ["Ox<Esc>"], ["ox<Esc>"], ["o<Tab>x<Esc>"], ["Ofoo<CR>bar<Esc>"], ["A<CR>x<Esc>"], ["i<CR><Esc>"], ["ccx<Esc>"], ["Sx<Esc>"], ["cc<Esc>"],
        ["ofoo<CR><Esc>"], ["A<CR><CR>x<Esc>"], ["o<Tab><CR>x<Esc>"], ["ox<CR><Esc>"],
        [n + ">>"], [n + "<<"], [">j"], ["<k"], ["Vj>"], ["Vj<"], ["V2>"], ["vj>"], ["Vj" + n + ">"], [">ip"],
        ["r<Tab>"], ["R<Tab><Esc>"], ["x"], ["~"], ["J"], ["3ix<Tab><Esc>"], ["3A<Tab><Esc>"], [">>", "j", "."], ["A<Tab>y<Esc>", "."], ["o<Tab>y<Esc>", "j", "."],
        ["l"], ["h"], ["j"], ["k"], ["$"], ["0"], ["^"], ["w"], ["b"], ["e"], ["gg"], ["G"], [n + "|"], [n + "j"], [n + "k"],
        ["dd"], ["yy", "p"], ["u"], ["<C-r>"], ["a" + ins + "<Esc>"], ["o" + ins + "<Esc>"],
    ]
    return r.choice(pool)

def visual_step(r):
    mode = r.choice(["v", "v", "V"])
    motion = r.choice(["$", "$", "$", "j$", "$j", "$k", "2$", "$h", "$l", "l", "h", "j", "k", "w", "e", "0", "^", "G", "gg", "}", "g_", "fa", "jj", "kk", "$o", "o$"])
    ins = r.choice(["ab", "X Y", "z"])
    op = r.choice(["d", "d", "y", "y", "c" + ins + "<Esc>", "~", "u", "U", "J", ">", "<", "x", "<Esc>", "gJ", "D", "X", "r-"])
    first = mode + motion + op
    if op == "y":
        return [first, r.choice(["p", "P", "$p", "0P"])]
    return [first]

def insert_step(r):
    enter = r.choice(["i", "a", "A", "I", "o", "O", "cc", "S", "C"])
    pre = r.choice(["", "", "x", " ", "  ", "ab", "\t", "x y", "ab "])
    key = r.choice(["<C-e>", "<C-y>", "<C-d>", "<C-t>", "<C-f>", "<C-w>", "<C-u>", "<C-h>", "<C-e><C-e>", "<C-y><C-y>", "<C-t><C-t>", "<C-t><C-d>", "<C-e><C-y>", "<C-d><C-d>"])
    post = r.choice(["", "", "z", "<C-e>", "<C-y>", "<C-t>", "<CR>x", "<Left>"])
    pre_step = r.choice([[], [], ["j"], ["k"], ["$"], ["0"], ["w"], ["G"], [">>"], ["l"]])
    return pre_step + [enter + pre + key + post + "<Esc>"]

WORD_TEXT = ["foo", "bar", "héllo", "wörld", "ça", "naïve", "日本語", "こんにちは", "ひらがな", "カタカナ", "한국어", "привет", "αβγ", "foo-bar", "foo_bar",
             "a.b", "x+y", "(é)", "«quote»", "—", "…", "×", "÷", "µ", "ª", "ß", "ÿ", "ĀĒ", "123", "42é", "!!", "@home", "#tag", "$var", "foo:bar", "a/b",
             "ünï", "x\u00a0y", "Ünï", "FOO", "Foo", "ÉCOLE", "école", "日本語text", "text日本語", "かな漢字", "ｱｲｳ", "⁰¹²", "₀₁", "⠁⠃", "x²"]
WORD_SEPS = [" ", " ", " ", "  ", "\t", ", ", ". ", "-", "", ""]

def rand_word_line(r):
    kind = r.random()
    if kind < 0.05:
        return ""
    words = [r.choice(WORD_TEXT) for _ in range(r.randint(1, 6))]
    out = ""
    for w in words:
        out += w + r.choice(WORD_SEPS)
    return out.rstrip(" ") if r.random() < 0.7 else out

ISKEYWORD_SETS = [["iskeyword+=-"], ["iskeyword+=."], ["iskeyword+=@-@"], ["iskeyword+=#", "iskeyword+=$"], ["iskeyword-=_"], ["iskeyword=a-z,A-Z,_"],
                  ["iskeyword=@,48-57,_,192-255,-,."], ["iskeyword+=^é"], ["iskeyword=@,^a-c"], ["iskeyword+=:"], ["iskeyword=@,48-57,_"], ["iskeyword=a-z"],
                  ["iskeyword+=<", "iskeyword+=>"], ["iskeyword="], ["iskeyword+=ª"], ["iskeyword+=×"], ["iskeyword+=160"], ["iskeyword=@,48-57,_,128-255"], ["iskeyword-=192-255"],
                  ["iskeyword+=/"], ["iskeyword+=+"], ["iskeyword+=45-47"]]

def word_options(r):
    chosen = []
    if r.random() < 0.7:
        chosen += r.choice(ISKEYWORD_SETS)
    mode = r.choice(["", "", "ignorecase", "ignorecase smartcase", "ignorecase smartcase", "smartcase"])
    if mode:
        chosen += mode.split()
    return chosen

def word_step(r):
    n = r.choice(["", "", "", "2", "3"])
    pat = r.choice(["foo", "Foo", "FOO", "wörld", "Wörld", "école", "École", "ÉCOLE", "\\<foo", "\\<Foo", "foo\\>", "\\kfoo", "\\Cfoo", "\\cFoo", "日本", "こ", "h.llo", "\\<日本語\\>", "x\\k\\+", "\\K", "\\Kx", "[[:keyword:]]\\+", "[[:lower:]]\\+", "\\v<\\k+>", "\\Vfoo", "f\\%[oo]"])
    pool = [
        [n + "w"], [n + "W"], [n + "b"], [n + "B"], [n + "e"], [n + "E"], [n + "ge"], [n + "gE"], [n + "w"], [n + "e"], [n + "b"],
        ["dw"], ["dW"], ["de"], ["dE"], ["db"], ["dB"], ["cwNEW<Esc>"], ["cWNEW<Esc>"], ["ceNEW<Esc>"], ["cbNEW<Esc>"], ["yw"], ["y" + n + "e"], ["d" + n + "w"], ["c" + n + "wNEW<Esc>"],
        ["diw"], ["daw"], ["diW"], ["daW"], ["ciwNEW<Esc>"], ["caw" + "NEW<Esc>"], ["yiw", "P"], ["yaw", "P"], ["viwd"], ["vawd"], ["viWd"], ["v" + n + "iwy", "P"], ["gUiw"], ["guiw"], ["g~iw"], ["gUaw"], ["g~aw"],
        ["*"], ["#"], ["g*"], ["g#"], [n + "*"], ["*", "n"], ["#", "n"], ["*", "N"], ["w", "*"], ["e", "#"], ["$", "*"], ["0", "#"], ["d*"], ["c*X<Esc>"],
        ["/" + pat + "<CR>"], ["?" + pat + "<CR>"], ["/" + pat + "<CR>", "n"], ["/" + pat + "<CR>", "N"], ["d/" + pat + "<CR>"], ["/" + pat + "<CR>", "gn"], ["/" + pat + "<CR>", "cgnX<Esc>"],
        [":s/" + pat + "/X/<CR>"], [":s/" + pat + "/X/g<CR>"], [":%s/" + pat + "/X/g<CR>"], [":g/" + pat + "/s/$/!/<CR>"], [":g!/" + pat + "/s/^/>/<CR>"],
        ["A foo<C-w>X<Esc>"], ["A foo bar<C-w><C-w>X<Esc>"], ["A héllo wörld<C-w>X<Esc>"], ["A 日本語こんにちは<C-w>X<Esc>"], ["I<C-w>X<Esc>"], ["A-<C-w>X<Esc>"], ["Afoo-bar<C-w>X<Esc>"], ["Afoo.bar<C-w>X<Esc>"],
        ["$a<C-w>X<Esc>"], ["wi<C-w>X<Esc>"], ["ea<C-w>X<Esc>"], ["Ofoo bar<C-w><C-w>X<Esc>"], ["A " + "x<C-u>X<Esc>"],
        ["f-"], ["fx"], ["l"], ["h"], ["$"], ["0"], ["j"], ["k"],
    ]
    return r.choice(pool)

def rand_step(r, vocab):
    if vocab == "words":
        return word_step(r)
    if vocab == "insert":
        return insert_step(r)
    if vocab == "visual":
        return visual_step(r)
    if vocab == "tabs":
        return tabs_step(r)
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
        case = {"id": f"c{seed}-{i}", "text": [rand_word_line(r) for _ in range(r.randint(1, 5))] if vocab == "words" else rand_text(r), "steps": steps}
        if vocab in ("tabs", "insert"):
            case["options"] = tab_options(r)
        if vocab == "words":
            case["options"] = word_options(r)
        cases.append(case)
    return cases

VIMSCRIPT = r'''
set nocompatible
set encoding=utf-8
set noswapfile nobackup nowritebackup viminfo= tabstop=8 shiftwidth=8 noexpandtab noautoindent
set nowrapscan
set wrapscan
set backspace=indent,eol,start
set lines=40 columns=200
let g:cases = json_decode(join(readfile($VCASES), "\n"))
let g:out = []
function! Keys(step) abort
  return substitute(a:step, '<\(CR\|Esc\|Space\|BS\|Tab\|Left\|Right\|C-r\|C-v\|C-e\|C-y\|C-d\|C-t\|C-f\|C-w\|C-u\|C-h\)>', '\=eval("\"\\" . submatch(0) . "\"")', 'g')
endfunction
for c in g:cases
  set tabstop=8 shiftwidth=8 softtabstop=0 noexpandtab noautoindent
  if has_key(c, 'options') && len(c.options) > 0
    execute 'set ' . join(c.options, ' ')
  endif
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
    env = dict(os.environ, VCASES=cf, VOUT=of, TERM="xterm", LANG="C.UTF-8", LC_ALL="C.UTF-8")
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
