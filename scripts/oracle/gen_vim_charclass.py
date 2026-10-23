#!/usr/bin/env python3
"""Generate vim/VimCharClassData.ts from vim's own source, src/mbyte.c.

usage: gen_vim_charclass.py path/to/mbyte.c out.ts

`utf_class_buf` classifies every character above U+00FF with a table of intervals searched by bisection
(the table lists a few intervals twice, so the answer depends on the search path: the data is copied
verbatim and searched the same way), and `emoji_all` lists the emoji that are class 3.  The version the
data comes from is the one `vim --version` reports (9.1.0016, tag v9.1.0016 of github.com/vim/vim).
"""
import re, sys

def main():
    source = open(sys.argv[1], encoding="utf-8").read()
    emoji_start = source.index("static struct interval emoji_all[] =")
    emoji_body = source[emoji_start:source.index("};", emoji_start)]
    emoji = [(int(a, 16), int(b, 16)) for a, b in re.findall(r"\{0x([0-9a-f]+), 0x([0-9a-f]+)\}", emoji_body)]
    classes_start = source.index("} classes[] =")
    classes_body = source[classes_start:source.index("};", classes_start)]
    classes = [(int(a, 16), int(b, 16), int(c, 0)) for a, b, c in re.findall(r"\{0x([0-9a-f]+), 0x([0-9a-f]+), (0x[0-9a-f]+|\d+)\}", classes_body)]

    def rows(values):
        return ",\n".join("  " + ", ".join("0x%x" % v for v in chunk) for chunk in (values[i:i + 6] for i in range(0, len(values), 6))) + ","

    flat_classes = [v for entry in classes for v in entry]
    flat_emoji = [v for entry in emoji for v in entry]
    text = "export const WORD_CLASS_INTERVALS: readonly number[] = [\n" + rows(flat_classes) + "\n];\n\n"
    text += "export const EMOJI_INTERVALS: readonly number[] = [\n" + rows(flat_emoji) + "\n];\n"
    open(sys.argv[2], "w", encoding="utf-8").write(text)
    print(len(classes), "class intervals,", len(emoji), "emoji intervals ->", sys.argv[2])

main()
