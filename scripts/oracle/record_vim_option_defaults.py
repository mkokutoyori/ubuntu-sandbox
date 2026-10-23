"""
Records the value every vim 9.1 option has at start-up (`vim -u NONE -N`) and writes it as the
fallback table of the vim editor's `&option` reads.

The names and abbreviations come from vim's own `options.txt`; the values come from the running vim.
Options the engine models itself (the table of VimOptions.ts) are left out, and so are those whose value
depends on the machine or the terminal (paths, columns, lines, the shell...): reading them stays refused
rather than answering with this machine's value.

    python3 -I scripts/oracle/record_vim_option_defaults.py src/network/devices/linux/editors/vim/VimOptionDefaults.ts
"""
import json, os, re, subprocess, sys, tempfile

DOC = "/usr/share/vim/vim91/doc/options.txt"
MACHINE_DEPENDENT = {
    "columns", "lines", "term", "ttytype", "encoding", "termencoding", "helplang", "langmenu", "shell", "shellcmdflag", "shellpipe",
    "shellredir", "shellxquote", "shellxescape", "shellquote", "runtimepath", "packpath", "helpfile", "directory", "backupdir",
    "viewdir", "undodir", "viminfo", "viminfofile", "path", "cdpath", "tags", "makeprg", "fileencodings", "fileformats", "ttymouse",
    "ttyscroll", "ttybuiltin", "ttyfast", "termguicolors", "t_Co", "background", "mouse", "mousemodel", "keyprotocol", "scroll",
    "window", "lazyredraw", "cmdheight", "cmdwinheight", "winheight", "winminheight", "winwidth", "winminwidth", "winfixheight",
    "winfixwidth", "titlestring", "iconstring", "titleold", "verbosefile", "spellfile", "spelllang", "dictionary", "thesaurus",
    "backupskip", "wildcharm", "wildchar", "nrformats", "isfname", "isident", "isprint", "iskeyword", "isk", "viewoptions", "sessionoptions",
    "formatprg", "equalprg", "keywordprg", "grepprg", "grepformat", "errorformat", "printdevice", "printexpr", "printencoding", "printfont",
    "guifont", "guifontset", "guifontwide", "guioptions", "guicursor", "guiheadroom", "guitablabel", "guitabtooltip",
}

SCRIPT = r"""
set encoding=utf-8
let out = []
for name in json_decode(join(readfile($NAMES), ''))
  try
    execute 'let value = &' . name
    call add(out, [name, value])
  catch
  endtry
endfor
call writefile([json_encode(out)], $OUT)
qa!
"""


def quote(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def modelled_names():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "network", "devices", "linux", "editors", "vim", "VimOptions.ts")
    pairs = re.findall(r"\{ name: '([a-z0-9_]+)', short: '([a-z0-9_]+)'", open(path, encoding="utf-8").read())
    return {name for pair in pairs for name in pair}


def parse_doc():
    entries = []
    for line in open(DOC, encoding="utf-8"):
        match = re.match(r"^'([a-z0-9_]+)'(?:\s+'([a-z0-9_]+)')?\s+(boolean|number|string)\b", line)
        if match:
            entries.append((match.group(1), match.group(2) or match.group(1), match.group(3)))
    return entries


def main():
    out_path = sys.argv[1]
    entries = parse_doc()
    with tempfile.TemporaryDirectory() as work:
        names_path = os.path.join(work, "names.json")
        result_path = os.path.join(work, "out.json")
        script_path = os.path.join(work, "options.vim")
        json.dump([name for name, _, _ in entries], open(names_path, "w"))
        open(script_path, "w").write(SCRIPT)
        env = dict(os.environ, NAMES=names_path, OUT=result_path, LANG="C.UTF-8", LC_ALL="C.UTF-8")
        subprocess.run(["vim", "-u", "NONE", "-i", "NONE", "-N", "-es", "-S", script_path], env=env, timeout=120, check=False,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        values = {name: value for name, value in json.load(open(result_path))}
    rows = []
    modelled = modelled_names()
    for name, short, kind in sorted(entries):
        if name in MACHINE_DEPENDENT or short in MACHINE_DEPENDENT or name not in values or name in modelled:
            continue
        value = values[name]
        if isinstance(value, str) and re.search(r"/(root|usr|tmp|home|var|etc)\b", value):
            continue
        if kind == "boolean":
            literal = "true" if value else "false"
        elif kind == "number":
            literal = str(value)
        else:
            literal = quote(value)
        rows.append("  [%s, %s, %s]," % (quote(name), quote(short), literal))
    text = "export type DefaultOptionValue = boolean | number | string;\n\nexport const OPTION_DEFAULTS: ReadonlyArray<readonly [string, string, DefaultOptionValue]> = [\n"
    text += "\n".join(rows) + "\n];\n"
    open(out_path, "w", encoding="utf-8").write(text)
    print(len(rows), "options ->", out_path)


if __name__ == "__main__":
    main()
