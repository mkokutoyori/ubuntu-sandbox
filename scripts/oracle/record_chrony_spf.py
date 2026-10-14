#!/usr/bin/env python3
"""Record chrony 4.5's own samplefilt.c on synthetic measurement series.

usage: record_chrony_spf.py CHRONY_SRC out.json

CHRONY_SRC is the extracted chrony-4.5 source tree, configured once (./configure) so that config.h exists.  The harness
(chrony_spf_harness.c) links the real samplefilt.c, regress.c, util.c and memory.c and prints every filtered sample.
"""
import json, os, random, subprocess, sys, tempfile

def series(seed, count, noise, spike_rate, spike):
    rng = random.Random(seed)
    t = 1.79e9
    out = []
    for i in range(count):
        t += 1 + rng.gauss(0, 0.002)
        offset = 0.0125 + rng.gauss(0, noise) + (spike if rng.random() < spike_rate else 0)
        out.append([round(t, 9), offset, 0.0002 + abs(rng.gauss(0, 0.0001)), 2.3e-6 + abs(rng.gauss(0, 1e-6)), 0.0390625, 0.03125])
    return out

SERIES = {
    "quiet": (series(3, 64, 0.0006, 0.1, 0.004), [1, 2, 3, 4, 8, 16]),
    "spiky": (series(7, 96, 0.0002, 0.3, 0.02), [3, 5, 8]),
}

def main():
    src, target = sys.argv[1], sys.argv[2]
    with tempfile.TemporaryDirectory() as work:
        binary = os.path.join(work, "harness")
        here = os.path.dirname(os.path.abspath(__file__))
        subprocess.run(["gcc", "-O0", "-I" + src, "-o", binary, os.path.join(here, "chrony_spf_harness.c"), *[os.path.join(src, f) for f in ("samplefilt.c", "regress.c", "util.c", "memory.c")], "-lm"], check=True)
        cases = []
        for name, (rows, lengths) in SERIES.items():
            text = "\n".join(" ".join(("%.9f" if k == 0 else "%.12e") % v for k, v in enumerate(r)) for r in rows) + "\n"
            for length in lengths:
                result = subprocess.run([binary, str(length)], input=text, capture_output=True, text=True, check=True).stdout.strip().split("\n")
                cases.append({"series": name, "length": length, "samples": rows, "expected": [line.split() for line in result]})
    json.dump({"tool": "chrony 4.5 samplefilt.c", "columns": ["time", "offset", "peerDelay", "peerDispersion", "rootDelay", "rootDispersion"], "cases": cases}, open(target, "w"), separators=(",", ":"))
    print(len(cases), "runs")

main()
