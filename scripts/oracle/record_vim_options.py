#!/usr/bin/env python3
"""Record `:set` transcripts from a real vim.

usage: record_vim_options.py out.json

Each case is a list of `:set` command lines run in one headless session (`vim -u DEFAULTS -es`
for the `vim` variant, the same binary invoked as `vi` for the `vi` variant).  For every command
the output (or the error text without its `Vim(set):` prefix) is saved, then the value of every
option of the table after the whole sequence.
"""
import json, os, subprocess, sys, tempfile

OPTIONS = [
    ("number", "nu", "bool"), ("relativenumber", "rnu", "bool"), ("numberwidth", "nuw", "number"),
    ("list", "list", "bool"), ("listchars", "lcs", "string"), ("showmatch", "sm", "bool"),
    ("matchtime", "mat", "number"), ("matchpairs", "mps", "string"),
    ("incsearch", "is", "bool"), ("hlsearch", "hls", "bool"), ("ignorecase", "ic", "bool"), ("smartcase", "scs", "bool"), ("iskeyword", "isk", "string"),
    ("autoindent", "ai", "bool"), ("colorcolumn", "cc", "string"), ("tabstop", "ts", "number"),
    ("shiftwidth", "sw", "number"), ("softtabstop", "sts", "number"), ("expandtab", "et", "bool"),
    ("wrap", "wrap", "bool"), ("scrolloff", "so", "number"), ("sidescroll", "ss", "number"),
    ("sidescrolloff", "siso", "number"), ("wrapscan", "ws", "bool"), ("display", "dy", "string"),
    ("ruler", "ru", "bool"), ("showcmd", "sc", "bool"), ("showmode", "smd", "bool"),
    ("scroll", "scr", "number"), ("filetype", "ft", "string"), ("fileformat", "ff", "string"), ("fileencoding", "fenc", "string"),
    ("mouse", "mouse", "string"),
]

def forms(name, short, kind):
    out = []
    for n in (name, short):
        out += [[f"set {n}"], [f"set {n}?"], [f"set {n}&"]]
    if kind == "bool":
        for n in (name, short):
            out += [[f"set no{n}"], [f"set inv{n}"], [f"set {n}!"], [f"set no{n}", f"set {n}?"],
                    [f"set {n}", f"set {n}?"], [f"set {n}!", f"set {n}?"], [f"set inv{n}", f"set {n}?"],
                    [f"set no{n}?"], [f"set inv{n}?"], [f"set {n}=1"], [f"set {n}:1"]]
        out += [[f"set {short}!", f"set {short}!", f"set {short}?"], [f"set no{short}", f"set {short}&", f"set {short}?"]]
    if kind == "number":
        for n in (name, short):
            out += [[f"set {n}=4"], [f"set {n}=4", f"set {n}?"], [f"set {n}:6", f"set {n}?"], [f"set {n}=0"], [f"set {n}=-1"],
                    [f"set {n}=9999"], [f"set {n}=10000"], [f"set {n}=abc"], [f"set {n}="], [f"set {n}=4x"], [f"set {n}=0x10"],
                    [f"set {n}+=2", f"set {n}?"], [f"set {n}-=2", f"set {n}?"], [f"set {n}^=2", f"set {n}?"],
                    [f"set no{n}"], [f"set inv{n}"], [f"set {n}!"], [f"set {n}=3", f"set {n}&", f"set {n}?"], [f"set {n}=21"], [f"set {n}=1"]]
    if kind == "string":
        for n in (name, short):
            out += [[f"set {n}="], [f"set no{n}"], [f"set {n}!"], [f"set {n}=ab", f"set {n}?"]]
    return out

EXTRA = [
    ["set scr=0", "set scr?"], ["set scr=100"], ["set scr=100", "set scr?"], ["set scr=23", "set scr?"], ["set scr=24", "set scr?"], ["set scr=5", "set scr?", "set scr=0", "set scr?"],
    ["set scr=-1"], ["set scr=5", "set scr&", "set scr?"], ["set scr+=1", "set scr?"], ["set scr-=20", "set scr?"],
    ["set ts=4 sw=4 et"], ["set ts=4 sw=4 et", "set ts?", "set sw?", "set et?"],
    ["set ts=4 foo sw=5", "set ts?", "set sw?"], ["set ts=4  sw=5", "set ts?", "set sw?"], ["set  ts?"],
    ["set ts? sw?"], ["set ts=4 sw? et?"], ["set nu rnu", "set nu?", "set rnu?"], ["set ts=4 nu=2"],
    ["set foo"], ["set foo=1"], ["set nofoo"], ["set invfoo"], ["set foo?"], ["set"], ["set "], ["setlocal ts=3", "set ts?"],
    ["setlocal ts=3", "setlocal ts?"], ["set ts=3", "setlocal ts?"], ["setglobal ts=3", "set ts?"], ["set so=5", "set so?"],
    ["set listchars=tab:>-,trail:-", "set lcs?"], ["set lcs=bad"], ["set lcs=tab:ab", "set lcs?"], ["set lcs=tab:a"],
    ["set lcs=eol:$,tab:>-,trail:~,nbsp:+,extends:>,precedes:<,space:.,lead:-", "set lcs?"],
    ["set lcs=tab:xyz", "set lcs?"], ["set lcs=multispace:ab", "set lcs?"], ["set lcs=conceal:x", "set lcs?"],
    ["set lcs=eol:$,eol:#", "set lcs?"], ["set lcs+=trail:-", "set lcs?"], ["set lcs-=eol:$", "set lcs?"], ["set lcs=", "set lcs?"],
    ["set cc=80,100", "set cc?"], ["set cc=+1,-1", "set cc?"], ["set cc=0"], ["set cc=abc"], ["set cc=80,", "set cc?"],
    ["set cc=80", "set cc+=100", "set cc?"], ["set cc=", "set cc?"], ["set cc=-3"], ["set tw=40 cc=+1", "set cc?"],
    ["set dy=lastline", "set dy?"], ["set dy=foo"], ["set dy=truncate,uhex", "set dy?"], ["set dy=", "set dy?"],
    ["set dy+=lastline", "set dy?"], ["set dy-=truncate", "set dy?"],
    ["set ft=python", "set ft?"], ["set ff=dos", "set ff?"], ["set ff=mac", "set ff?"], ["set ff=x"], ["set fenc=latin1", "set fenc?"],
    ["set nuw=2", "set nuw?"], ["set nuw=21"], ["set nuw=0"], ["set ss=1", "set ss?"], ["set siso=3", "set siso?"], ["set so=999", "set so?"],
    ["set ts=1", "set ts?"], ["set sw=0", "set sw?"], ["set sts=-1", "set sts?"], ["set sts=4 sw=2", "set sts?", "set sw?"],
    ["set ic noic", "set ic?"], ["set hls is ic", "set hls?", "set is?", "set ic?"], ["set ai!", "set ai?"],
    ["set ws", "set nows", "set ws?"], ["set ru", "set noru", "set ru?"], ["set sc nosc", "set sc?"], ["set smd nosmd", "set smd?"],
    ["set wrap!", "set wrap?"], ["set list!", "set list?"], ["set sm", "set sm?"],
    ["set ts=8 ts?"], ["set ts=4", "set ts&", "set ts?"], ["set ts=4 sw=4", "set all&", "set ts?", "set sw?"],
    ["set ts =4"], ["set ts= 4"], ["set ts=4,5"], ["set ts=4 "], ["set nowrap wrap?"], ["set wrap&"], ["set invwrap wrap?"],
    ["set ts=4|set sw=3", "set ts?", "set sw?"],
    ["set ts=3", "setglobal ts?"], ["setlocal ts=3", "setglobal ts?"], ["setlocal ts=3", "setlocal ts?"], ["setglobal ts=3", "setglobal ts?"],
    ["set ts=010"], ["set ts=0b11"], ["set ts=0o17"], ["set ts=+4"], ["set ts=-0"], ["set ts=0X10"], ["set ts=1 ts+=1 ts+=1", "set ts?"],
    ["set ts=4 ts?"], ["set nu ts?"], ["set ts? nu?"], ["set nu? ts=4"], ["set nonu nu&", "set nu?"],
    ["set cc=80 cc-=80", "set cc?"], ["set cc=80,100 cc-=80", "set cc?"], ["set cc=80,100 cc^=5", "set cc?"],
    ["set lcs=eol:$ lcs+=tab:>-", "set lcs?"], ["set lcs=tab:>-,eol:$ lcs-=tab:>-", "set lcs?"],
    ["set display=lastline display+=uhex", "set display?"], ["set display=lastline,uhex display-=lastline", "set display?"],
    ["set mouse=a", "set mouse?"], ["set mouse=nvi", "set mouse?"], ["set mouse=x"], ["set mouse=an", "set mouse?"], ["set mouse+=n", "set mouse?"],
    ["set mouse=a", "set mouse-=a", "set mouse?"], ["set mouse=nn", "set mouse?"], ["set mouse=hr", "set mouse?"], ["set mouse=c", "set mouse?"],
    ["set mouse=", "set mouse?"], ["set mouse=a", "set mouse&", "set mouse?"], ["set mouse=n,v"], ["set mouse=Na"], ["set mouse=ah", "set mouse?"],
    ["set isk+=-", "set isk?"], ["set isk-=_", "set isk?"], ["set isk=a-z", "set isk?"], ["set isk=300"], ["set isk=@,48-57", "set isk?"], ["set isk&", "set isk?"],
    ["set isk=a-", "set isk?"], ["set isk+=@-@", "set isk?"], ["set isk=", "set isk?"], ["set isk^=-", "set isk?"], ["set isk=^", "set isk?"], ["set isk=1-255", "set isk?"],
    ["set isk=b-a"], ["set isk=0"], ["set isk=abc"], ["set isk=a,b", "set isk?"], ["set isk=_,-,128-140,#-43", "set isk?"], ["set isk+=48-57", "set isk?"],
    ["set isk-=48-57", "set isk?"], ["set isk+=^é", "set isk?"], ["set isk=@,^a-c", "set isk?"], ["set isk+=", "set isk?"], ["set isk+=300", "set isk?"],
    ["set isk=@,48-57,_,192-255,-,.", "set isk-=.", "set isk?"], ["set isk+=a-z", "set isk?"], ["set isk=, ", "set isk?"], ["set isk=a,,b", "set isk?"],
    ["set isk=@ ,_", "set isk?"], ["set isk=a ,b", "set isk?"], ["setlocal isk+=-", "set isk?"], ["setlocal isk+=-", "setglobal isk?"], ["setglobal isk+=-", "set isk?"],
    ["set scs", "set scs?"], ["set noscs", "set scs?"], ["set scs!", "set scs?"], ["set ic scs", "set ic?", "set scs?"], ["set scs&", "set scs?"],
]

NAMES = [o[0] for o in OPTIONS]

SCRIPT = """
let s:names = %(names)s
let s:case = %(case)s
function! Cap(cmd)
  let l:r = ''
  redir => l:r
  try
    silent execute a:cmd
  catch
    redir END
    return 'ERR:' . substitute(v:exception, '^Vim\\((\\w\\+)\\)\\=:', '', '')
  endtry
  redir END
  return l:r
endfunction
let s:msgs = []
for s:c in s:case
  call add(s:msgs, Cap(s:c))
endfor
let s:state = {}
for s:n in s:names
  let s:state[s:n] = eval('&' . s:n)
endfor
call writefile([json_encode({'commands': s:case, 'messages': s:msgs, 'state': s:state})], %(out)s)
"""

def run_case(variant, case, workdir):
    out = os.path.join(workdir, "o.json")
    if os.path.exists(out):
        os.remove(out)
    script = os.path.join(workdir, "s.vim")
    names = "[" + ", ".join("'" + n + "'" for n in NAMES) + "]"
    open(script, "w").write(SCRIPT % {"names": names, "case": json.dumps(case), "out": json.dumps(out)})
    target = os.path.join(workdir, "f.txt")
    open(target, "w").write("x\n")
    exe = ["vim", "-u", "DEFAULTS"] if variant == "vim" else [os.path.join(workdir, "vi")]
    env = dict(os.environ, LANG="C.UTF-8")
    r = subprocess.run(exe + ["-es", "-S", script, "-c", "q!", target], capture_output=True, text=True, env=env, timeout=60)
    if not os.path.exists(out):
        sys.stderr.write(r.stdout + r.stderr)
        raise SystemExit("no output for %s %r" % (variant, case))
    return json.load(open(out))

def run(variant, cases):
    workdir = tempfile.mkdtemp()
    os.symlink(os.path.realpath("/usr/bin/vim"), os.path.join(workdir, "vi"))
    return [run_case(variant, case, workdir) for case in cases]

def main():
    cases = [[]]
    for name, short, kind in OPTIONS:
        cases += forms(name, short, kind)
    cases += EXTRA
    version = subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    result = {"vim": version, "options": [{"name": n, "short": s, "kind": k} for n, s, k in OPTIONS], "variants": {}}
    for variant in ("vim", "vi"):
        recorded = run(variant, cases)
        baseline = recorded[0]["state"]
        result["variants"][variant] = {
            "defaults": baseline,
            "cases": [
                {"commands": r["commands"], "messages": r["messages"],
                 "changed": {k: v for k, v in r["state"].items() if baseline[k] != v}}
                for r in recorded[1:]
            ],
        }
    json.dump(result, open(sys.argv[1], "w"), separators=(",", ":"))

main()
