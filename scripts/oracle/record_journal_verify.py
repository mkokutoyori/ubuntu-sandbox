#!/usr/bin/env python3
"""Record what `journalctl --verify` (systemd 255) says about damaged journal files.

usage: record_journal_verify.py files.json cases.json

files.json is the output of record_journal_files.py (real files written by systemd-journald).  Every case is a base file plus a small edit - one or several
bytes replaced, a truncation, an extension - written to a scratch path and handed to the real `journalctl --file=PATH --verify`, with the verification key for the
sealed base.  The status and the text on stdout and stderr are kept, the scratch path replaced by {path}.  The mutations are not random only: every field of a
sample of objects of every type is damaged, every byte of the header, the hash table items, the entry arrays and the tags, plus a seeded scatter over the file and
structural damage (cut, extended, zeroed ranges).
"""
import json, os, random, struct, subprocess, sys, tempfile

PATH = "/tmp/claude-0/jv/system.journal"

HEADER_FIELDS = [
    (0, 8), (8, 4), (12, 4), (16, 1), (17, 7), (24, 16), (40, 16), (56, 16), (72, 16), (88, 8), (96, 8), (104, 8), (112, 8), (120, 8), (128, 8), (136, 8), (144, 8),
    (152, 8), (160, 8), (168, 8), (176, 8), (184, 8), (192, 8), (200, 8), (208, 8), (216, 8), (224, 8), (232, 8), (240, 8), (248, 8), (256, 4), (260, 4), (264, 8),
]

OBJECT_FIELDS = {
    1: [(16, 8), (24, 8), (32, 8), (40, 8), (48, 8), (56, 8), (64, 4), (68, 4)],
    2: [(16, 8), (24, 8), (32, 8)],
    3: [(16, 8), (24, 8), (32, 8), (40, 16), (56, 8)],
    4: [],
    5: [],
    6: [(16, 8)],
    7: [(16, 8), (24, 8), (32, 32)],
}


def rebuild(scenario):
    data = bytearray(scenario["allocated"])
    for offset, hexdata in scenario["file"]["chunks"]:
        data[offset:offset + len(hexdata) // 2] = bytes.fromhex(hexdata)
    return bytes(data)


def u64(data, offset):
    return struct.unpack_from("<Q", data, offset)[0]


def walk(data):
    tail = u64(data, 136)
    objects = []
    offset = 272
    while offset <= tail:
        size = u64(data, offset + 8)
        objects.append((offset, data[offset], size))
        offset += (size + 7) // 8 * 8
    return objects


def run(data, key):
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    with open(PATH, "wb") as handle:
        handle.write(data)
    argv = ["journalctl", "--file=" + PATH, "--verify"] + (["--verify-key=" + key] if key else [])
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    return {"status": result.returncode, "stdout": result.stdout.replace(PATH, "{path}"), "stderr": result.stderr.replace(PATH, "{path}")}


def edit(data, edits, cut=None, extend=b""):
    mutable = bytearray(data)
    for offset, new in edits:
        mutable[offset:offset + len(new)] = new
    out = bytes(mutable)
    if cut is not None:
        out = out[:cut]
    return out + extend


def flipped(data, offset, length=1):
    return (offset, bytes(b ^ 0xFF for b in data[offset:offset + length]))


def cases_for(name, data, rng):
    cases = []

    def add(label, edits=(), cut=None, extend=b"", key="ok"):
        cases.append({"base": name, "label": label, "edits": [[o, b.hex()] for o, b in edits], "cut": cut, "extend": extend.hex(), "key": key})

    add("untouched")
    add("untouched-wrong-key", key="wrong")
    add("untouched-no-key", key="none")
    for start, length in HEADER_FIELDS:
        for index in sorted({0, length - 1}):
            add("header+%d.%d" % (start, index), [flipped(data, start + index)])
        add("header+%d.low" % start, [(start, bytes([data[start] ^ 1]))])
    objects = walk(data)
    by_type = {}
    for entry in objects:
        by_type.setdefault(entry[1], []).append(entry)
    for kind, listing in sorted(by_type.items()):
        sample = {0, len(listing) - 1} | {rng.randrange(len(listing)) for _ in range(10)}
        for position in sorted(sample):
            offset, _, size = listing[position]
            for index in range(16):
                add("object%d@%d.header%d" % (kind, offset, index), [flipped(data, offset + index)])
            for start, length in OBJECT_FIELDS.get(kind, []):
                if offset + start + length > len(data):
                    continue
                for index in sorted({0, length - 1}):
                    add("object%d@%d.field%d.%d" % (kind, offset, start, index), [flipped(data, offset + start + index)])
                add("object%d@%d.field%d.small" % (kind, offset, start), [(offset + start, struct.pack("<Q", 272)[:length])])
                add("object%d@%d.field%d.zero" % (kind, offset, start), [(offset + start, bytes(length))])
            if kind == 1:
                for value in range(8):
                    add("object1@%d.flags%d" % (offset, value), [(offset + 1, bytes([value]))])
            payload_start = {1: 72, 2: 40, 3: 64, 6: 24}.get(kind)
            if payload_start is not None and size > payload_start:
                for where in sorted({payload_start, payload_start + (size - payload_start) // 2, size - 1}):
                    add("object%d@%d.payload%d" % (kind, offset, where), [flipped(data, offset + where)])
    table_items = []
    for base_offset, size_offset in ((u64(data, 104), u64(data, 112)), (u64(data, 120), u64(data, 128))):
        for item in range(size_offset // 16):
            head = u64(data, base_offset + item * 16)
            tail = u64(data, base_offset + item * 16 + 8)
            if head or tail:
                table_items.append(base_offset + item * 16)
    for position in rng.sample(table_items, min(60, len(table_items))):
        add("table@%d.head" % position, [flipped(data, position)])
        add("table@%d.tail" % position, [flipped(data, position + 8)])
        add("table@%d.swap" % position, [(position, data[position + 8:position + 16]), (position + 8, data[position:position + 8])])
    used = u64(data, 136) + u64(data, u64(data, 136) + 8)
    for _ in range(450):
        offset = rng.randrange(0, used)
        add("scatter@%d" % offset, [flipped(data, offset)])
    for cut in (0, 8, 100, 271, 272, 273, 5000, used // 2, used - 8, used - 1, used, used + 8, len(data) - 1):
        add("cut@%d" % cut, cut=cut)
    add("extend-zeros", extend=bytes(4096))
    add("extend-garbage", extend=b"garbage after the arena")
    for _ in range(30):
        start = rng.randrange(272, used)
        length = rng.choice([8, 16, 64, 512])
        add("zero@%d+%d" % (start, length), [(start, bytes(length))])
    return cases


def main():
    files = json.load(open(sys.argv[1]))
    rng = random.Random(4242)
    out = {"library": files["library"], "path": PATH, "cases": []}
    for scenario in files["scenarios"]:
        if scenario["name"] == "sealed-first":
            continue
        data = rebuild(scenario)
        key = scenario["sealing"]["key"] if scenario.get("sealing") else None
        for case in cases_for(scenario["name"], data, rng):
            damaged = edit(data, [(o, bytes.fromhex(b)) for o, b in case["edits"]], case["cut"], bytes.fromhex(case["extend"]))
            chosen = None
            if case["key"] == "ok":
                chosen = key
            elif case["key"] == "wrong":
                chosen = "000000-000000-000000-000000/000000-000000" if key else None
            result = run(damaged, chosen)
            out["cases"].append({**case, "keyText": chosen, **result})
        print(scenario["name"], len(out["cases"]), flush=True)
    with open(sys.argv[2], "w") as handle:
        json.dump(out, handle, separators=(",", ":"))


main()
