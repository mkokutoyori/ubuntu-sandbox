#!/usr/bin/env python3
"""Record the event stream, the marks and the error the real libyaml produces for a corpus of documents.

usage: record_yaml_events.py events.json

The corpus is hand-written (every production of the scanner and the parser, the rsyslog policy files, every error message
libyaml can raise) and then extended with a seeded fuzz: random concatenations of YAML fragments and single-character mutations of
well-formed documents, so that the invalid inputs are the ones nobody thought of.  Each document is handed to
scripts/oracle/yaml_events_harness.c, which reads it with yaml_parser_set_input_file exactly as rsyslog does and prints one JSON
object per event (value, anchor, tag, implicit flags, style, start and end marks) and, when libyaml refuses, the error with its
kind, problem, context and marks.
"""
import json, os, random, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

HANDWRITTEN = [
    "", "\n", "# comment only\n", "a", "a: b", "a: b\n", "a: b\nc: d\n", "- a\n- b\n", "-\n", "- \n- b\n", "a:\n- 1\n- 2\n",
    "a:\n  - 1\n  - 2\nb: 3\n", "a:\n  b:\n    c: d\n  e: f\n", "[a, b, c]", "{a: 1, b: 2}", "[a: 1, b: 2]", "{a, b}", "{a: , b}",
    "[ ]", "{ }", "[a,\n b]", "[a, [b, c], {d: e}]", "{a: [1, 2], b: {c: d}}", "[a, b,]", "[,a]", "[a b]", "{a: 1 b: 2}",
    "&x a: b\n", "a: &x b\nc: *x\n", "a: &x [1, 2]\nb: *x\n", "a: &x\n  b: c\nd: *x\n", "*x\n", "&\n", "& a\n", "*\n",
    "&a !t b\n", "!t &a b\n", "!!str b\n", "!<tag:yaml.org,2002:str> b\n", "! b\n", "!t\n", "!!\n", "!e!x b\n",
    "%TAG !e! tag:e,2002:\n--- !e!x b\n", "%TAG !e! tag:e,2002:\n%TAG !e! tag:f,2002:\n--- b\n", "%YAML 1.1\n--- a\n",
    "%YAML 1.2\n--- a\n", "%YAML 1.0\n--- a\n", "%YAML 2.1\n--- a\n", "%YAML 1.1\n%YAML 1.1\n--- a\n", "%YAML\n--- a\n",
    "%YAML 1\n--- a\n", "%YAML 1.\n--- a\n", "%YAML 1.1234567890\n--- a\n", "%FOO bar\n--- a\n", "%\n--- a\n", "%TAG\n--- a\n",
    "%TAG !x\n--- a\n", "%TAG !x! \n--- a\n", "%TAG x y\n--- a\n", "%TAG !x! tag:\n", "%YAML 1.1 # c\n--- a\n", "%YAML 1.1 x\n--- a\n",
    "--- a\n--- b\n", "--- a\n...\n--- b\n...\n", "---\n", "--- \n...\n", "...\n", "... a\n", "--- |\n  x\n", "--- >\n  x\n",
    "a: |\n  x\n  y\nb: 1\n", "a: |-\n  x\n\n\nb: 1\n", "a: |+\n  x\n\n\nb: 1\n", "a: >\n  x\n  y\n\n  z\nb: 1\n",
    "a: >-\n  x\n   y\n  z\n", "a: |2\n    x\n", "a: |0\n x\n", "a: |-2\n  x\n", "a: |2-\n  x\n", "a: |+1\n x\n", "a: |x\n", "a: | # c\n  x\n",
    "a: |\n\tx\n", "a: |\n  x\n\ty\n", "a: >\n\n\n  x\n", "|\n x\n", "|", ">\n", "a: |\n", "a: |\nb: c\n", "- |\n  x\n- >\n  y\n",
    "'single'", "'it''s'", "'multi\n  line'", "'multi\n\n  line'", "'unterminated", "'a\n---\n'", "\"double\"", "\"esc \\n \\t \\\\ \\\" \\/ \\0 \\a \\b \\e \\f \\v \\r \\  \"",
    "\"\\x41\\u00e9\\U0001F600\"", "\"\\xZ\"", "\"\\u12\"", "\"\\uD800\"", "\"\\U00110000\"", "\"\\q\"", "\"\\N\\_\\L\\P\"", "\"line \\\n  cont\"",
    "\"a\n  b\"", "\"a  \n  b\"", "\"a\n\n  b\"", "\"unterminated", "\"a\n...\n\"", "\"\\", "'", "\"", "a: 'x'y", "a: \"x\"y", "a: 'x' # c\n",
    "a b c", "a  b   c", "a\n  b\n  c", "a: b\n  c\n", "a: b\n c: d\n", "a:  b  \n", "a: b: c", "a:b", "a :b", "a: b #c\n", "a: b# c\n",
    "- a: b\n  c: d\n- e\n", "- - a\n  - b\n- c\n", "- [a, b]\n- {c: d}\n", "? a\n: b\n", "? a\n", "? [a, b]\n: c\n", "? |\n  x\n: y\n", ": b\n", ":\n",
    "? a\n? b\n", "a: b\n? c\n: d\n", "[? a : b]", "{? a : b, ? c}", "[a]: b\n", "{a}: b\n", "a: [b\n", "a: {b\n", "a: ]\n", "a: }\n", "]\n", "}\n",
    "a: - b\n", "- a: b\n - c\n", "a:\n - b\n- c\n", "a: b\n- c\n", "- a\nb: c\n", "a: b\n\tc: d\n", "a:\n\t- b\n", "\ta: b\n", "a:\t b\n",
    "a: \tb\n", "a:\n  b: c\n\td: e\n", "key with spaces: value with spaces\n", "? complex\n  key\n: v\n", "a: @x\n", "a: `x\n", "@x", "`x", "%x", "a: %x\n",
    "a: #x\n", "a: !\n", "a: !!\n", "a: &\n", "a: *\n", "- &a\n- *a\n", "&a\n", "&a b: c\n", "&a [b]\n", "!t [b]\n", "!t\n  b\n",
    "a: !t\nb: c\n", "a: &x\nb: c\n", "&x : y\n", "!t : y\n", "*x : y\n", "? &x a\n: *x\n", "[&x a, *x]", "{&x a: *x}",
    "a: [b, c]: d\n", "a: {b: c}: d\n", "[a, b]: c\n", "- [a, b]: c\n", "{a: b}: c\n",
    "\ufeffa: b\n", "a: b\r\nc: d\r\n", "a: b\rc: d\r", "a:\u0085b\n", "a: b\u2028c: d\n", "a: b\u2029c: d\n", "a: \"x\u2028y\"\n", "a: |\r\n  x\r\n  y\r\n",
    "a: >\n  x\u2028  y\n", "é: ü\n", "a: 日本語\n", "a: \U0001F600\n", "a: \x01\n", "a: \x00\n", "\x7f", "a: \x1b[0m\n", "a: \ufffe\n", "a: \ufeff\n", "a: \ud7ff\n",
    "a: b\n" * 3, "a: b\n\n\n\nc: d\n", "\n\n\na: b\n", "   \na: b\n", "  a: b\n  c: d\n", "  a: b\n c: d\n", "  - a\n  - b\n", " - a\n- b\n",
    "a:\n- b\n- c\nd:\n- e\n", "a:\n  - b\n  -\n  - c\n", "a:\n  -\n    b: c\n", "-\n  - a\n  - b\n-\n  - c\n", "a: -\n", "a: - \n", "a: -b\n", "-a\n", "- -a\n",
    "? - a\n  - b\n: - c\n", "a: ? b\n", "a: ?\n", "a: ?b\n", "?a\n", "? \n", ":a\n", "a: :b\n", "[:a]", "[a:]", "[a :]", "{a:}", "{a :}", "{a: }", "{:a}", "{a:,}",
    "[a:b]", "{a:b}", "[a:,b]", "[\"a\":b]", "{\"a\":b}", "{\"a\": b}", "{'a':b}", "[a,\n\n b]", "[a #c\n, b]", "{a: b #c\n}", "{\na: b\n}", "[\n- a\n]", "{\n  a: b\n}\n",
    "a: [\n  b,\n  c\n]\n", "a: [\nb\n]\n", "a: {\nb: c\n}\n", "a:\n  [b, c]\n", "a:\n  {b: c}\n", "a:\n  'b'\n", "a:\n  b\n", "a:\n  b\n  c\n", "a:\n\n  b\n",
    "ratelimit(name=\"x\")\n", "interval: 5\nburst: 10\nmode: perSource\n", "perSource:\n  default:\n    max: 100\n    window: 60\n  overrides:\n    - key: a\n      max: 5\n      window: 1\n",
    "interval: 5 # trailing\nburst: 10\n", "mode: \"dynamic\"\nburst: '10'\n", "a: &anchor\n  b: 1\nc: *anchor\n", "defaults: &d\n  max: 1\nx:\n  <<: *d\n",
    "! a\n", "!<> a\n", "!<a b\n", "!<a> b\n", "!<a>b\n", "!<%41> b\n", "!<%> b\n", "!<%4> b\n", "!<%zz> b\n", "!<%80> b\n", "!<%C3%A9> b\n", "!<%C3%41> b\n", "!<%FF> b\n",
    "!a%41 b\n", "!!a%C3%A9 b\n", "!e!a b\n", "!e!a!b c\n", "!e! b\n", "!a,b c\n", "[!a,b]", "[!a , b]", "[!a]", "[!a b]", "!a!b!c d\n", "!ab-c_d b\n",
    "%TAG !e! tag:e,2002:\n---\n!e!x b\n", "%TAG !e! tag:e,2002:\n--- a\n--- !e!x b\n", "%TAG ! tag:bang:\n--- !x b\n", "%TAG !! tag:bang:\n--- !!x b\n",
    "%TAG !e! tag:a,b[c]\n--- !e!x b\n", "%TAG !e! %41\n--- a\n", "%TAG !e! !x\n--- !e!y b\n", "%TAG !e!x tag:\n--- a\n", "%TAG !e e\n--- a\n",
    "--- !t\n", "--- &a\n", "--- !t &a\n", "--- &a !t\n", "--- !t\n...\n", "--- &a\n...\n", "--- !!map\na: b\n", "--- !!seq\n- a\n", "!!map {a: b}\n", "!!seq [a]\n", "!!map\na: b\n",
    "- !!str\n- !!str a\n", "a: !!str\nb: !!str c\n", "- &a !!str\n- *a\n", "? !!str\n: !!str\n", "!!str : !!str\n", "[!!str , !!str]", "{!!str : !!str}",
    "a: 'b'\nc: \"d\"\n", "a: 'b\n  c'\nd: e\n", "'a': b\n", "\"a\": b\n", "'a' : b\n", "\"a\" : b\n", "'a':b\n", "\"a\":b\n", "'a\nb': c\n", "\"a\nb\": c\n",
    "a: \"b\"\n  c\n", "a: 'b'\n  c\n", "a: \"b\" c\n", "a: 'b' c\n", "a: \"b\"\nc: d\n", "- 'a'\n- \"b\"\n", "- 'a\n  b'\n- c\n", "- \"a\\\n  b\"\n- c\n",
    "a: |\n  x\n b: c\n", "a: |\n  x\nb: c\n", "a:\n  b: |\n    x\n  c: d\n", "a:\n  b: |\n    x\n\n  c: d\n", "- a: |\n    x\n  b: c\n", "- |\n x\n- b\n",
    "a: |\n    x\n  y\n", "a: |\n  x\n    y\n  z\n", "a: >\n  x\n    y\n  z\n", "a: >\n  x\n\n    y\n\n  z\n", "a: >+\n  x\n\n", "a: >-\n  x\n\n", "a: >\n  x\n\n\n",
    "a: |1\n x\n", "a: |9\n         x\n", "a: |10\n", "a: |1\n\n x\n", "a: |1\n  x\n", "a: >2\n  x\n", "a: >+2\n    x\n", "a: |+\n\n\n", "a: |-\n\n\n", "|-\n\n", "|+\n\n",
    "a: |\n  \n  x\n", "a: |\n \n  x\n", "a: |\n   \n  x\n", "a: |\n  x\n   \n", "a: |\n\n\n  x\n", "a: |\n  x\n\n\n\n", "a:\n  - |\n    x\n  - y\n", "a: |\n  x\n...\n", "a: |\n  x\n---\n",
]

FRAGMENTS = [
    "a", "b", "key", "1", "- ", "-", ": ", ":", "? ", "?", "[", "]", "{", "}", ",", ", ", "\n", "\n", "\n  ", "  ", " ", "\t", "&x ", "&x", "*x", "!t ", "!!str ", "!", "!<u>",
    "|", ">", "|-", ">+", "|2", "'q'", "'q", "\"d\\n\"", "\"d", "#c", "# c\n", "---", "--- ", "...", "%YAML 1.1\n", "%TAG !e! t:\n", "\\", "\"", "'", "%", "@", "`", "&", "*", "é", "\r\n",
]

BASES = [
    "a: b\nc:\n  - d\n  - e\nf: {g: h, i: [j, k]}\n",
    "- &x a\n- *x\n- !!str b\n- |\n  lit\n- >\n  fold\n- 'sq'\n- \"dq\\n\"\n",
    "%YAML 1.1\n%TAG !e! tag:e,2002:\n---\n!e!t &a {k: v}\n...\n--- [1, 2]\n",
    "? complex\n: value\n? [a, b]\n: {c: d}\nplain: multi\n  line\n",
    "perSource:\n  default:\n    max: 100\n    window: 60\n  overrides:\n    - key: a\n      max: 5\n",
]

ALPHABET = list("ab:-?[]{},#&*!|>'\"%@` \n\t\\.")


def fuzz_documents(count, seed):
    rng = random.Random(seed)
    documents = []
    while len(documents) < count:
        if rng.random() < 0.5:
            documents.append("".join(rng.choice(FRAGMENTS) for _ in range(rng.randint(1, 9))))
        else:
            base = rng.choice(BASES)
            text = list(base)
            for _ in range(rng.randint(1, 3)):
                position = rng.randrange(len(text) + 1)
                kind = rng.random()
                if kind < 0.4 and position < len(text):
                    del text[position]
                elif kind < 0.8:
                    text.insert(position, rng.choice(ALPHABET))
                elif position < len(text):
                    text[position] = rng.choice(ALPHABET)
            documents.append("".join(text))
    return documents


def large_documents():
    literal = "".join("line %04d\n" % index for index in range(1700))
    filler = "x: " + "y" * 16370
    return [
        "|\n" + "".join(" " + line for line in literal.splitlines(True)), "|\n" + "".join(" " + line for line in literal.splitlines(True)) + "\x01\n",
        filler + "\n\x01", filler + "\x01\n", filler[:-4] + "\x01\n", "x: " + "y" * 16380 + "\x01", "x: " + "y" * 16381 + "\x01", "x: " + "y" * 16382 + "\x01",
        "x: " + "y" * 16383 + "\x01", "x: " + "y" * 16384 + "\x01", "x: " + "y" * 40000 + "\n", "a: " + "é" * 8190 + "\n" + "b: \x02\n",
        "a: " + "é" * 8192 + "\x03\n", "a: " + "é" * 8191 + "\x03\n", "a: " + "日" * 5461 + "\x03", "a: " + "日" * 5460 + "\x03",
        ("a" * 1000) + ": b\n", ("a" * 1023) + ": b\n", ("a" * 1024) + ": b\n", ("a" * 1025) + ": b\n", "[" + ("a" * 1024) + ": b]", "[" + ("a" * 1025) + ": b]",
        ("a" * 1030) + ": b\n", "[" + ("a" * 1030) + ": b]", "? " + ("a" * 1030) + "\n: b\n", "a: [" + "x, " * 600 + "y]\n",
        "a b\n" * 4000 + "\x01",
    ]


def record(source, harness, directory):
    path = os.path.join(directory, "case.yaml")
    with open(path, "wb") as handle:
        handle.write(source.encode("utf-8", "surrogatepass"))
    output = subprocess.run([harness, path], capture_output=True, check=True).stdout.decode("utf-8", "replace")
    return [json.loads(line) for line in output.split("\n") if line]


def main():
    out = sys.argv[1]
    with tempfile.TemporaryDirectory() as work:
        harness = os.path.join(work, "harness")
        subprocess.run(["gcc", "-O1", "-o", harness, os.path.join(HERE, "yaml_events_harness.c"), "-lyaml"], check=True)
        version = subprocess.run(["dpkg-query", "-W", "-f=${Version}", "libyaml-0-2"], capture_output=True).stdout.decode() or "unknown"
        documents = list(dict.fromkeys(HANDWRITTEN)) + list(dict.fromkeys(fuzz_documents(900, 20260401))) + large_documents()
        cases = []
        for source in dict.fromkeys(documents):
            cases.append({"source": source, "events": record(source, harness, work)})
    with open(out, "w") as handle:
        json.dump({"libyaml": version, "cases": cases}, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    print(len(cases), "cases", os.path.getsize(out), "bytes")


main()
