#!/usr/bin/env python3
"""Record search results of Vim patterns from a real vim.

usage: record_vim_patterns.py [--seed N] [--cases N] [--from cases.json] [--ex] out.json

Each case is a pattern, the lines of a buffer and the value of 'ignorecase'.  A headless
`vim -u NONE -N -es` walks the buffer with searchpos() from (1,1): first match accepted at the cursor,
then each next one, at most eight, and keeps for every match the start (line, byte column) and the
inclusive end (searchpos with the 'e' flag from the start).  A pattern vim refuses is recorded with its
error text.  The random corpus builds a small tree of atoms, quantifiers, groups and look-arounds and
renders the same tree in the four magic levels (`\\m`, `\\v`, `\\M`, `\\V`), so a syntax rule shows up
in every notation.
"""
import argparse, json, os, random, subprocess, sys, tempfile

SCRIPT = r"""
set nocompatible
set encoding=utf-8
let cases = json_decode(join(readfile($CASES), ''))
let out = []
for c in cases
  silent %delete _
  call setline(1, c.lines)
  let &ignorecase = c.ic
  set nosmartcase
  set nowrapscan
  let r = {'id': c.id, 'm': []}
  try
    call cursor(1, 1)
    let s = searchpos(c.pat, 'cW')
    while s != [0, 0] && len(r.m) < 8
      let e = searchpos(c.pat, 'cenW')
      call add(r.m, [s, e])
      let s = searchpos(c.pat, 'W')
    endwhile
  catch
    let r.err = v:exception
    let r.m = []
  endtry
  call add(out, r)
endfor
call writefile([json_encode(out)], $OUT)
qa!
"""

TEXTS = [
    ["foo", "bar", "", "foo", "", "", "bar baz", "end", "foo bar", "  ", "bar", "foo"],
    ["ÉCOLE école", "ÀÉÎ àéî", "Straße STRASSE", "İstanbul ıi", "ǅ ǆ Ǆ", "αβγ ΑΒΓ", "中文 日本語", "x\ty\tz", "\tindent", "a  b"],
    ["foo bar baz", "  indented line", "tab\there", "trailing   ", "", "Hello World 123", "a1b2c3", "x_y-z.w"],
    ["alpha beta gamma", "ALPHA Beta GAMMA", "one,two;three", "", "  ", "é à ü ñ", "café au lait", "end."],
    ["foobar foo bar", "bar foo foobar", "aaa bbb aaa", "abcabc abc", "a.b a+b a*b a?b", "(x) [y] {z}", "back\\slash", "~tilde"],
    ["12 345 6789", "0x1F 0b101 077", "3.14 2.71", "-5 +6", "a1 b22 c333", "", "x", "line with  two  spaces"],
]

WORD = list("abcfobarxyz")


class Node:
    pass


def lit(c):
    return ("lit", c)


def gen_atom(r, depth):
    kind = r.random()
    if kind < 0.28:
        return lit(r.choice(WORD + ["1", "2", " ", "_", "-", ","]))
    if kind < 0.36:
        return ("any",)
    if kind < 0.56:
        return ("class", r.choice("sSdDwWaAlLuUxXhHkKiIfFpPoO"), r.random() < 0.15)
    if kind < 0.62:
        return ("esc", r.choice("tren"))
    if kind < 0.72:
        return ("coll", r.random() < 0.3, r.sample(["a", "b", "c", "f", "o", "r", "1", "a-c", "x-z", "0-9", "[:alpha:]", "[:digit:]", "[:space:]", "[:upper:]", "[:lower:]", "[:alnum:]", "[:punct:]", "\\t", " ", "-", "_"], r.randint(1, 3)), r.random() < 0.1)
    if kind < 0.84 and depth < 2:
        return ("group", r.random() < 0.6, gen_alt(r, depth + 1))
    if kind < 0.90:
        return ("word", r.choice("<>"))
    if kind < 0.95 and depth < 2:
        return ("look", r.choice(["=", "!", "<=", "<!"]), gen_seq(r, depth + 1, 1, 2))
    return lit(r.choice(WORD))


def gen_quant(r, atom):
    kind = r.random()
    if kind < 0.55:
        return atom
    if atom[0] in ("word", "look", "bol", "eol"):
        return atom
    quant = r.choice(["*", "+", "?", "{2}", "{1,3}", "{-1,}", "{-}", "{,2}", "{2,}", "{-2,3}"])
    return ("quant", atom, quant)


def gen_seq(r, depth, low=1, high=4):
    items = [gen_quant(r, gen_atom(r, depth)) for _ in range(r.randint(low, high))]
    if depth == 0 and r.random() < 0.15:
        items.insert(0, ("bol",))
    if depth == 0 and r.random() < 0.15:
        items.append(("eol",))
    if depth == 0 and r.random() < 0.08 and len(items) > 1:
        items.insert(r.randint(1, len(items) - 1), ("zs",))
    if depth == 0 and r.random() < 0.06 and len(items) > 1:
        items.insert(r.randint(1, len(items) - 1), ("ze",))
    return ("seq", items)


def gen_alt(r, depth):
    branches = [gen_seq(r, depth, 1, 3) for _ in range(r.choice([1, 1, 2, 3]))]
    return ("alt", branches)


MODES = {
    "m": {"prefix": ""},
    "v": {"prefix": "\\v"},
    "M": {"prefix": "\\M"},
    "V": {"prefix": "\\V"},
}

COLL_ESC = {"\\t": "\\t"}


def special_magic(mode, symbol):
    table = {
        "m": set("^$.*[~"),
        "v": set("^$.*[~+?={|()&@<>%"),
        "M": set("^$"),
        "V": set(),
    }
    return symbol in table[mode]


def op(mode, symbol):
    if symbol == "*":
        return "*" if mode in ("m", "v") else "\\*"
    if symbol == ".":
        return "." if mode in ("m", "v") else "\\."
    if symbol == "[":
        return "[" if mode in ("m", "v") else "\\["
    if mode == "v":
        return symbol
    return "\\" + symbol


def render(node, mode, ctx):
    kind = node[0]
    if kind == "lit":
        c = node[1]
        if c in "\\":
            return "\\\\"
        if mode == "v" and not (c.isalnum() or c == "_" or ord(c) > 127 or c == " "):
            return "\\" + c
        if mode in ("m", "M", "V") and c in "^$":
            return "\\" + c
        if mode == "m" and c in ".*[~":
            return "\\" + c
        if mode == "M" and c in "":
            return c
        return c
    if kind == "any":
        return op(mode, ".")
    if kind == "class":
        return "\\" + ("_" if node[2] else "") + node[1]
    if kind == "esc":
        return "\\" + node[1]
    if kind == "coll":
        body = "".join(node[2])
        text = "[" + ("^" if node[1] else "") + body + "]"
        if node[3]:
            text = "\\_" + text
        return text if mode in ("m", "v") else "\\" + text
    if kind == "group":
        inner = render(node[2], mode, ctx)
        if node[1]:
            return op(mode, "(") + inner + (")" if mode == "v" else "\\)")
        return ("%(" if mode == "v" else "\\%(") + inner + (")" if mode == "v" else "\\)")
    if kind == "word":
        return op(mode, node[1])
    if kind == "look":
        return render_look(node, mode, ctx)
    if kind == "quant":
        inner = render(node[1], mode, ctx)
        q = node[2]
        if q == "*":
            return inner + op(mode, "*")
        if q == "+":
            return inner + op(mode, "+")
        if q == "?":
            return inner + ("?" if mode == "v" else "\\?")
        return inner + render_brace(q, mode)
    if kind == "bol":
        return "\\^" if mode == "V" else "^"
    if kind == "eol":
        return "\\$" if mode == "V" else "$"
    if kind == "zs":
        return "\\zs"
    if kind == "ze":
        return "\\ze"
    if kind == "seq":
        return "".join(render(item, mode, ctx) for item in node[1])
    if kind == "alt":
        sep = "|" if mode == "v" else "\\|"
        return sep.join(render(branch, mode, ctx) for branch in node[1])
    raise ValueError(kind)


def render_brace(q, mode):
    body = q[1:-1]
    return ("{" + body + "}") if mode == "v" else ("\\{" + body + "}")


def render_look(node, mode, ctx):
    inner = render(("group", False, ("alt", [node[2]])), mode, ctx)
    mark = "@" + node[1]
    return inner + (mark if mode == "v" else "\\" + mark)


def hand_patterns():
    pats = [
        "\\s\\+$", "^\\s*", "\\d\\+", "\\w\\+", "\\<foo\\>", "\\<\\w", "foo\\|bar", "\\(foo\\|bar\\)\\+", "\\v(foo|bar)+", "a\\{2}", "a\\{-1,}", "a\\{,2}", "a\\{}", "a\\{-}",
        "\\%(ab\\)\\+", "\\(a\\)\\1", "\\(.\\)\\1", "foo\\zsbar", "foo\\zebar", "\\zsfoo", "foo\\ze", "\\cFOO", "\\Cfoo", "\\cfoo\\C", "foo\\nbar", "o\\n", "\\n\\n", "^$", "^\\s*$",
        "[abc]", "[^abc]", "[a-c]\\+", "[[:alpha:]]\\+", "[[:digit:]]\\+", "[[:space:]]", "[[:upper:]]", "[]abc]", "[^]abc]", "[a\\]]", "[\\n]", "[\\t]", "\\_s\\+", "\\_.\\{3}", "\\_[a-c]\\+", "\\_^foo", "bar\\_$",
        "a*", "^*", "\\(^a\\)", "\\(a$\\)", "a^b", "a$b", "$a", "\\v^a|b$", "x\\=", "x\\?", "x\\+", "\\vx=", "\\vx?", "\\vx+", "\\v<foo>", "\\v\\d{2,3}", "\\v(a)(b)\\2\\1",
        "foo\\(bar\\)\\@=", "foo\\(bar\\)\\@!", "\\(foo\\)\\@<=bar", "\\(foo\\)\\@<!bar", "\\v(foo)@<=bar", "\\v(bar)@!", "\\(a\\|ab\\)\\(c\\|bcd\\)", "\\(foo\\|foobar\\)",
        "\\%[abc]", "ab\\%[cd]e", "\\e", "\\r", "\\t", "\\b", "\\%x41", "\\%d65", "\\%u00e9", "\\%o101", "\\%^", "\\%$", "\\%2l", "\\%>2l", "\\%<3l", "\\%3c", "\\%V", "\\%#",
        "\\k\\+", "\\i\\+", "\\f\\+", "\\p\\+", "\\h\\w*", "\\a\\+", "\\l\\+", "\\u\\+", "\\x\\+", "\\o\\+", "\\S\\+", "\\D\\+", "\\W\\+", "\\A\\+", "\\L\\+", "\\U\\+", "\\X\\+", "\\H\\+", "\\K\\+", "\\I\\+", "\\F\\+", "\\P\\+", "\\O\\+",
        ".", ".*", ".\\{-}", "\\.", "\\*", "\\[", "\\]", "\\/", "\\\\", "\\~", "~", "\\^", "\\$", "\\+", "\\?", "\\=", "\\{", "\\&", "foo\\&.*bar", ".*bar\\&foo", "\\%(foo\\)\\&.o",
        "\\vabc", "\\Vabc", "\\Va.c", "\\Va\\.c", "\\Va*", "\\Va\\*", "\\Ma.c", "\\Ma\\.c", "\\Ma*", "\\Ma\\*", "\\V^a", "\\Va$", "\\V\\^a", "\\Va\\$", "\\Mfoo$", "\\M^foo", "\\va.c", "\\va\\.c", "\\v[ab]", "\\V[ab]", "\\M[ab]", "\\M\\[ab]",
        "\\", "\\(", "\\)", "\\(a", "a\\)", "\\%(a", "[a", "a\\{2", "a\\{2,1}", "\\{2}", "*a", "\\+a", "\\@=", "\\1", "\\(a\\)\\2", "\\%[", "\\%[]", "\\%", "\\%z", "\\z", "\\zq", "\\_", "\\_q", "\\@", "a\\@q", "[[:foo:]]", "[b-a]", "\\v(", "\\v)", "\\v{2}", "\\vx{", "\\v@", "\\v<", "\\v%",
        "foo\\|", "\\|foo", "\\|", "\\(\\)", "\\(\\|a\\)", "\\%(\\)", "a\\{-2,1}", "a**", "a\\+\\+", "\\(a*\\)*", "\\(a*\\)\\+", "\\(\\)*", "x\\{0}", "x\\{0,0}",
    ]
    return pats


def more_hand_patterns():
    return [
        "foo\\nbar", "\\n\\n", "\\n\\s*\\n", "bar\\n.*foo", "^\\n", "a\\nb", "\\_.*\\n", "\\_s*\\n", "\\_[^a]\\{3}", "x\\_s\\+y",
        "\\(a\\|\\n\\)\\+", "end\\.\\n\\_.*", "foo\\_$\\_s*bar", "\\n\\zs.", ".\\ze\\n", "\\_^.", "\\n\\{2,}", "o\\n^", "o\\_$\\n",
        "\\(foo\\zsbar\\)", "x\\(a\\zsb\\)\\?c", "\\(a\\zs\\)b", "a\\zsb\\zsc", "a\\zeb\\zec", "\\zs\\zs", "\\(\\zsa\\|b\\)", "foo\\zs\\|bar",
        "\\~", "x\\{3}", "x\\{0,1}", "\\(ab\\)\\{2}", "\\(ab\\)\\{-2,3}", "a\\{1,3}b", "\\{-1,2}", "a\\{,}", "a\\{-,}", "a\\{ 2}", "a\\{2\\}", "a\\{2\\",
        "\\cÉ", "é", "É", "\\ccafé", "[é]", "[É]", "\\c[A-Z]\\+", "\\u\\+", "\\cfoo\\C", "\\CFoo\\c", "\\l\\+", "\\c\\l\\+", "\\c\\u\\+",
        "\\c[[:upper:]]\\+", "\\c[[:lower:]]\\+", "\\cx\\(a\\)\\1", "ß", "\\cß", "i", "\\ci", "ǆ", "\\cǆ", "σ", "\\cσ",
        "\\a\\+", "\\w\\+", "\\k\\+", "\\i\\+", "\\f\\+", "\\p\\+", "\\s\\+", "\\S\\+", "[[:alpha:]]\\+", "[[:lower:]]\\+", "[[:upper:]]\\+", "[[:print:]]\\+",
        "[[:graph:]]\\+", "[[:punct:]]\\+", "[[:alnum:]]\\+", "\\%u00e9", "\\%d233", "\\%x41", "\\%U0001F600", "\\%u4e2d", "中", "[中文]\\+", ".\\{2}", "\\<é", "é\\>",
        "\\(foo\\)\\@>bar", "\\(a*\\)\\@>a", "\\(.*\\)\\@<=x", "\\(foo\\)\\@3<=bar", "x\\@=", "\\v(foo)@<!bar", "\\%(a\\|b\\)\\@=.",
        "\\v<\\w+>", "\\v(\\w+)\\s+\\1", "\\v(foo|bar)@!\\w+", "\\v\\d{2}-\\d{2}", "\\v%(a|b)+", "\\v[a-c]+\\zs\\d", "\\v^(.)(.).?\\2\\1$", "\\v\\<", "\\v\\>",
        "\\v\\=", "\\v\\{", "\\v\\(", "\\v\\|", "\\v\\&", "\\v&", "\\va&b", "\\v#", "\\v-", "\\v,", "\\v:", "\\v;", "\\v/", "\\v\\/",
        "\\Ma*", "\\M\\(a\\)*", "\\M[a]", "\\V\\(a\\|b\\)\\+", "\\V.", "\\V\\.", "\\V\\zs", "\\V\\n", "\\Va\\|b", "\\V\\^", "\\V^", "\\V$", "\\V\\$",
        "\\%[ab]\\+", "fu\\%[nction]", "\\%d65\\+", "\\%o101", "\\%x41\\+", "\\%u0041", "\\%U00000041", "\\%C", "\\%23c", "\\%>1c.", "\\%<3c.", "\\%.l", "\\%.c", "\\%1l.", "\\%$", "\\%^",
        "\\%'a", "\\%v", "\\%5v", "\\%>5v", "\\%d", "\\%x", "\\%u", "\\%d1234567890", "\\%<2l.", "\\%>1l.", "\\%3l\\%2c", "\\%.l.",
        "[a\\-z]", "[\\]]", "[\\^]", "[\\\\]", "[\\e]", "[\\r]", "[\\b]", "[\\n]", "[\\t ]\\+", "[[.-.]]", "[[=a=]]", "[[:alpha:][:digit:]_]\\+", "[^[:alpha:]]\\+", "[a-c-e]", "[]", "[^]",
        "[a", "[]a]", "[^]a]", "\\[a]", "\\M[a]", "\\M\\[a]", "[ab][cd]", "\\_[ab]\\+", "\\_[^ab]\\+", "[é-ü]", "[[:alpha:]-]", "[α-ω]\\+", "[[:lower:]]\\{2}",
        "a|b", "a\\|b\\|c", "\\(a\\|b\\)\\(c\\|d\\)", "()", "\\(\\)\\1", "\\(a\\)\\(b\\)\\(c\\)\\(d\\)\\(e\\)\\(f\\)\\(g\\)\\(h\\)\\(i\\)\\9",
        "\\(a\\)\\(b\\)\\(c\\)\\(d\\)\\(e\\)\\(f\\)\\(g\\)\\(h\\)\\(i\\)\\(j\\)", "\\%(\\(a\\)\\)\\1", "\\(a\\)\\|\\1", "\\(\\(a\\)b\\)\\2", "\\(a\\1\\)",
        "\\z(a\\)", "\\z1", "\\%^foo", "bar\\%$", "\\(^foo\\)", "\\%(^foo\\)", "\\(foo$\\)", "a\\|^b", "^a\\|b$", "\\n^foo", "foo$\\n", "\\v^foo$", "\\v(^foo)", "\\v(foo$)",
    ]


def build(seed, count):
    r = random.Random(seed)
    cases = []
    patterns = []
    for i, pat in enumerate(hand_patterns()):
        patterns.append(("hand%d" % i, pat))
    for i in range(count):
        tree = gen_alt(r, 0)
        mode = r.choice("mmvvMV")
        text = MODES[mode]["prefix"] + render(tree, mode, {})
        if r.random() < 0.08:
            text = r.choice(["\\c", "\\C"]) + text
        patterns.append(("rnd%d-%d" % (seed, i), text))
    for index, (cid, pat) in enumerate(patterns):
        lines = TEXTS[index % len(TEXTS)]
        cases.append({"id": cid, "pat": pat, "lines": lines, "ic": 1 if (index // len(TEXTS)) % 4 == 3 else 0})
    for index, pat in enumerate(more_hand_patterns()):
        for text_index, lines in enumerate(TEXTS):
            for ic in (0, 1):
                cases.append({"id": "mh%d-%d-%d" % (index, text_index, ic), "pat": pat, "lines": lines, "ic": ic})
    return cases


def run_vim(cases):
    with tempfile.TemporaryDirectory() as work:
        cases_path = os.path.join(work, "cases.json")
        out_path = os.path.join(work, "out.json")
        script = os.path.join(work, "walk.vim")
        json.dump(cases, open(cases_path, "w"), ensure_ascii=False)
        open(script, "w").write(SCRIPT)
        env = dict(os.environ, CASES=cases_path, OUT=out_path, LANG="C.UTF-8", LC_ALL="C.UTF-8")
        subprocess.run(["vim", "-u", "NONE", "-i", "NONE", "-N", "-es", "-S", script], env=env, timeout=600, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return json.load(open(out_path))


def char_col(line, byte_col):
    return len(line.encode("utf-8")[: max(byte_col - 1, 0)].decode("utf-8", errors="ignore"))


def convert(cases, results):
    out = []
    for case, result in zip(cases, results):
        lines = case["lines"]

        def at(position):
            line = position[0]
            return [line - 1, char_col(lines[line - 1], position[1]) if line - 1 < len(lines) else 0]

        matches = [[at(start), at(end)] for start, end in result["m"]]
        record = dict(case, matches=matches)
        if "err" in result:
            record["error"] = result["err"].split("):", 1)[-1].strip() if "):" in result["err"] else result["err"]
        out.append(record)
    return out


EX_SCRIPT = r"""
set nocompatible
set encoding=utf-8
let cases = json_decode(join(readfile($CASES), ''))
let out = []
for c in cases
  silent %delete _
  call setline(1, c.lines)
  set noignorecase nosmartcase wrapscan
  for line in c.setup
    execute line
  endfor
  call cursor(1, 1)
  let v:errmsg = ''
  let r = {'id': c.id}
  try
    if has_key(c, 'keys')
      execute "normal! " . c.keys
    else
      let r.output = execute(c.cmd)
    endif
  catch
    let r.exception = v:exception
  endtry
  let r.lines = getline(1, '$')
  let r.pos = [line('.'), col('.')]
  let r.err = v:errmsg
  call add(out, r)
endfor
call writefile([json_encode(out)], $OUT)
qa!
"""

EX_LINES = [
    ["foobar foobar", "Foo BAR foo", "  indented  ", "a1b22c333", "end", "x\ty", "", "foo"],
    ["one two three", "ONE TWO THREE", "four five", "", "six  seven  eight", "foo.bar foo+bar"],
]

EX_COMMANDS = [
    "%s/foo\\zsbar/X/", "%s/foo\\zsbar/X/g", "%s/foo\\zebar/X/g", "%s/\\<foo\\>/X/g", "%s/\\vfoo|BAR/X/g", "%s/a\\{2}/X/g",
    "%s/\\(o\\)\\(b\\)/\\2\\1/g", "%s/\\s\\+$//", "%s/^\\s*//", "%s/\\d\\+/<&>/g", "%s/[[:upper:]]/_/g", "%s/\\cfoo/X/g",
    "%s/foo/X/", "%s/foo/X/I", "%s/foo/X/i", "%s/foo/X/gi", "%s/\\%2lfoo/X/", "%s/\\%>2l[a-z]/X/", "%s/\\%<3l[a-z]/X/", "%s/x*/-/g", "%s/o*/-/g",
    "%s/\\(/x/", "%s/\\)/x/", "%s/a\\{2/x/", "%s/\\1/x/", "%s/[b-a]/x/", "%s/\\%[fo]\\+/X/", "%s/\\v(o+)(b)@=/[\\1]/g",
    "%s/\\(foo\\)\\@<=bar/X/", "%s/\\Vfoo.bar/X/", "%s/\\V./X/", "%s/\\.\\*/X/", "%s/$/!/", "%s/^/> /", "%s/\\%$/E/", "%s/\\%^/S/",
    "%s/\\%3c./X/", "%s/\\%5v./X/", "%s/\\k\\+/<&>/g", "%s/\\w\\+/<&>/", "%s/.\\{-}o/X/", "%s/\\zs/-/g", "%s/\\ze$/!/", "%s/a\\|e/_/g",
    "%s/\\(a\\)\\|\\(b\\)/[\\1\\2]/g", "%s/[a-c]\\+/X/g", "%s/[^a-c ]\\+/X/g", "%s/\\t/TAB/", "%s/\\%d102/F/g", "%s/\\u/U/g", "%s/\\l\\+/l/", "%s/ \\+/ /g",
    "%s/foo\\nbar/X/", "%s/\\n//", "%s/$\\n^/+/",
    "g/foo/d", "g/\\(/d", "g/foo\\zsbar/s//X/", "g/o\\+/s//0/", "g!/foo/d", "v/foo/d", "g/\\cfoo/d", "g/\\<foo\\>/d", "g/^$/d", "g/\\%2l/d", "g/\\vo{2}/s//00/",
    "g/foo/s/o/0/g", "2,4s/o/0/g", "g/[/d", "g/a\\{2/d",
]

EX_SEARCHES = [
    "/foo\\zsbar\r", "/\\(\r", "/\\vbar|FOO\r", "/\\<foo\\>\rn", "/\\cFOO\r", "*", "#", "/o\\{2}\rn", "/\\%3l\\w\r", "/\\_.\\{3}\r", "/a1\\zsb\r",
    "/[b-a]\r", "?foo\r", "/\\n\r", "/e\\n\r", "/foo\\_s*bar\r", "/x\\ty\r", "/\\tz\r", "/\\%>1l\\%<3lo\r", "/\\v(one) (two)\rn", "/\\V.\r", "/\\.\r",
    "/\\%#o\r", "/foo\\ze.\rn", "/\\ze\\w\rnn", "/\\s\\+$\r", "/^\\s*\\zs\\S\r", "/\\v\\d+\rnn", "/E\r", "/e\\>\rn", "/\\<\\w\rnn", "/a\\|e\rnnn",
    "/\\1\r", "/\\%[fo]\\+b\r", "/\\(foo\\)\\@<!bar\r", "gg/o\\{2}\rN", "G?o\rn",
]


EX_TILDE = ["/~\r", "/\\V~\r", "/\\~\r", "/f~\r", "/\\v~\r", "/o~\r", "/~\\+\r", "/\\(~\\)\\1\r"]


def ex_cases():
    cases = []
    for text_index, lines in enumerate(EX_LINES):
        for index, command in enumerate(EX_COMMANDS):
            for ic in (0, 1):
                cases.append({"id": "ex%d-%d-%d" % (text_index, index, ic), "lines": lines, "setup": ["set ic"] if ic else [], "cmd": command})
        for index, keys in enumerate(EX_SEARCHES):
            for ic in (0, 1):
                cases.append({"id": "sr%d-%d-%d" % (text_index, index, ic), "lines": lines, "setup": ["set ic"] if ic else [], "keys": keys})
    for text_index, lines in enumerate(EX_LINES):
        for index, keys in enumerate(EX_TILDE):
            for setup in (["1s/o/0/"], ["1s/o/0/", "set ic"], ["1s/o/a.b/"], ["1s/o/"]):
                cases.append({"id": "tl%d-%d-%d" % (text_index, index, len(setup) * 10 + len(setup[-1])), "lines": lines, "setup": setup, "keys": keys})
        for index, command in enumerate(["%s/~/X/", "%s/x\\|~/_/g"]):
            cases.append({"id": "te%d-%d" % (text_index, index), "lines": lines, "setup": ["1s/o/0/"], "cmd": command})
    return cases


def record_ex(out_path):
    cases = ex_cases()
    with tempfile.TemporaryDirectory() as work:
        cases_path = os.path.join(work, "cases.json")
        result_path = os.path.join(work, "out.json")
        script = os.path.join(work, "ex.vim")
        json.dump(cases, open(cases_path, "w"), ensure_ascii=False)
        open(script, "w").write(EX_SCRIPT)
        env = dict(os.environ, CASES=cases_path, OUT=result_path, LANG="C.UTF-8", LC_ALL="C.UTF-8")
        subprocess.run(["vim", "-u", "NONE", "-i", "NONE", "-N", "-es", "-S", script], env=env, timeout=600, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        results = json.load(open(result_path))
    version = subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    recorded = []
    for case, result in zip(cases, results):
        lines = result["lines"]
        row = result["pos"][0] - 1
        col = char_col(lines[row], result["pos"][1]) if row < len(lines) else 0
        raised = result.get("exception", "")
        message = raised.split("):", 1)[-1].strip() if "):" in raised else raised or result["err"]
        recorded.append(dict(case, result={"lines": lines, "pos": [row, col], "err": message, "output": result.get("output", "").strip()}))
    json.dump({"vim": version, "cases": recorded}, open(out_path, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(cases), "cases ->", out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ex", action="store_true")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--cases", type=int, default=400)
    ap.add_argument("--from", dest="source")
    ap.add_argument("out")
    a = ap.parse_args()
    if a.ex:
        record_ex(a.out)
        return
    cases = json.load(open(a.source))["cases"] if a.source else build(a.seed, a.cases)
    results = run_vim(cases)
    backtracking = run_vim([dict(case, pat="\\%#=1" + case["pat"]) for case in cases])
    version = subprocess.run(["vim", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    recorded = convert(cases, results)
    for record, plain in zip(recorded, convert(cases, backtracking)):
        record["backtrackingAgrees"] = "error" in record or record["matches"] == plain["matches"]
    json.dump({"vim": version, "cases": recorded}, open(a.out, "w"), ensure_ascii=False, separators=(",", ":"))
    print(len(cases), "cases ->", a.out)


if __name__ == "__main__":
    main()
