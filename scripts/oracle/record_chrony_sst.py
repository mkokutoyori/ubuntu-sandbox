#!/usr/bin/env python3
"""Record chrony 4.5's own sourcestats.c + regress.c on synthetic measurement series.

usage: record_chrony_sst.py CHRONY_SRC out.json

CHRONY_SRC is the extracted chrony-4.5 source tree, configured once (./configure) so that config.h exists.  The harness
(chrony_sst_harness.c) links the real sourcestats.c, regress.c, util.c and memory.c with stubs for logging and configuration, feeds
each series sample by sample and prints, after every sample, what `chronyc sourcestats` and the selection code would report.
"""
import json, os, random, subprocess, sys, tempfile

def series(seed, count, drift_ppb, noise, spike_rate, spike):
    rng = random.Random(seed)
    t = 1.79e9
    out = []
    for i in range(count):
        t += 1 + rng.gauss(0, 0.002)
        offset = 0.0125 + drift_ppb * 1e-9 * i + rng.gauss(0, noise) + (spike if rng.random() < spike_rate else 0)
        out.append([round(t, 9), offset, 0.0002 + abs(rng.gauss(0, 0.0001)), 2.3e-6, 0.0390625, 0.03125])
    return out

SERIES = {
    "quiet": series(3, 70, 20, 0.0006, 0.15, 0.004),
    "steady": series(5, 40, 0, 0.00002, 0.0, 0.0),
    "drifting": series(9, 90, 5000, 0.0001, 0.05, 0.002),
    "short": series(11, 6, 0, 0.0003, 0.0, 0.0),
}

def main():
    src, target = sys.argv[1], sys.argv[2]
    with tempfile.TemporaryDirectory() as work:
        binary = os.path.join(work, "harness")
        here = os.path.dirname(os.path.abspath(__file__))
        subprocess.run(["gcc", "-O0", "-I" + src, "-o", binary, os.path.join(here, "chrony_sst_harness.c"), *[os.path.join(src, f) for f in ("sourcestats.c", "regress.c", "util.c", "memory.c")], "-lm"], check=True)
        cases = []
        for name, rows in SERIES.items():
            text = "\n".join(" ".join(("%.9f" if k == 0 else "%.12e") % v for k, v in enumerate(r)) for r in rows) + "\n"
            result = subprocess.run([binary], input=text, capture_output=True, text=True, check=True).stdout.strip().split("\n")
            cases.append({"series": name, "samples": rows, "expected": [line.split() for line in result]})
    json.dump({"tool": "chrony 4.5 sourcestats.c", "columns": ["n", "runs", "span", "offset", "offsetError", "freqPpm", "skewPpm", "sd", "lo", "hi", "ok"], "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "series")

main()
