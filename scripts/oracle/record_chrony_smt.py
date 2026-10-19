#!/usr/bin/env python3
"""Record chrony 4.5's own smooth.c on scripted scenarios.

usage: record_chrony_smt.py CHRONY_SRC out.json

CHRONY_SRC is the extracted chrony-4.5 source tree, configured once (./configure) so that config.h exists.  The harness
(chrony_smt_harness.c) links the real smooth.c, util.c and memory.c with stubs for the configuration, the reference skew and the
parameter-change registration, and answers one line per query command.
"""
import json, os, subprocess, sys, tempfile

def queries(start, span, step):
    out = []
    t = start
    while t <= start + span:
        out.append("offset %.3f" % t)
        t += step
    return out

BASE = ["skew 1e-9", "adjust 1000 0.05 0", "report 1000", "adjust 1010 0.2 0", "report 1010", "report 1500", "report 3000"]

SCENARIOS = {
    "default": ({}, BASE + queries(1010, 3000, 100) + ["adjust 2000 -0.1 1e-6"] + queries(2000, 2000, 100) + ["reset 3000", "report 3001"]),
    "frequency-limited": ({"SMT_MAXFREQ": "10", "SMT_MAXWANDER": "1"}, ["skew 1e-9", "adjust 1000 0 0", "adjust 1010 1.0 0", "report 1020"] + queries(1010, 4000, 50) + ["report 2000", "report 6000"]),
    "negative": ({"SMT_MAXFREQ": "20", "SMT_MAXWANDER": "2"}, ["skew 1e-9", "adjust 1000 0 0", "adjust 1010 -0.3 5e-6"] + queries(1010, 2000, 50) + ["report 1500"]),
    "leap-only": ({"SMT_LEAPONLY": "1"}, ["skew 1e-9", "adjust 1000 0.5 0", "report 1001", "leap 1100 1", "report 1101"] + queries(1100, 3000, 100) + ["report 2000"]),
    "locked-by-skew": ({}, ["skew 0.5", "adjust 1000 0.05 0", "adjust 1010 0.2 0", "report 1020", "offset 1020", "activate 1030", "adjust 1040 0.2 0", "report 1041", "offset 1100"]),
}

def main():
    src, target = sys.argv[1], sys.argv[2]
    with tempfile.TemporaryDirectory() as work:
        binary = os.path.join(work, "harness")
        here = os.path.dirname(os.path.abspath(__file__))
        subprocess.run(["gcc", "-O0", "-I" + src, "-o", binary, os.path.join(here, "chrony_smt_harness.c"), *[os.path.join(src, f) for f in ("smooth.c", "util.c", "memory.c")], "-lm"], check=True)
        cases = []
        for name, (env, commands) in SCENARIOS.items():
            result = subprocess.run([binary], input="\n".join(commands) + "\n", capture_output=True, text=True, check=True, env={**os.environ, **env}).stdout.strip().split("\n")
            cases.append({"name": name, "env": env, "commands": commands, "outputs": [line.split() for line in result]})
    json.dump({"tool": "chrony 4.5 smooth.c", "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "scenarios")

main()
