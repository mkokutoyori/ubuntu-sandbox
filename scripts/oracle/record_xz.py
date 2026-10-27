#!/usr/bin/env python3
"""Record what liblzma (python's lzma module) makes of xz streams: valid ones of every check type and preset over varied inputs, and damaged ones.

usage: record_xz.py vectors.json

Each vector keeps the stream and the verdict of liblzma (decoded bytes or failure).  Damaged streams are the valid ones with one byte flipped, a truncation, or an
appended byte, drawn with a fixed seed.
"""
import base64, json, lzma, random, sys

rng = random.Random(77)


def text(n):
    words = ["journal", "systemd", "MESSAGE", "kernel", "sshd", "session", "opened", "for", "user", "root", "by", "(uid=0)"]
    return " ".join(rng.choice(words) for _ in range(n)).encode()


INPUTS = {
    "empty": b"",
    "one": b"x",
    "zeros-70000": bytes(70000),
    "text-300": text(60),
    "text-5000": text(900),
    "text-120000": text(20000),
    "random-2000": bytes(rng.randrange(256) for _ in range(2000)),
    "random-70000": bytes(rng.randrange(256) for _ in range(70000)),
    "mixed": text(500) + bytes(rng.randrange(256) for _ in range(3000)) + b"A" * 9000 + text(300),
    "pattern": bytes(range(256)) * 300,
}
CHECKS = [lzma.CHECK_NONE, lzma.CHECK_CRC32, lzma.CHECK_CRC64, lzma.CHECK_SHA256]
PRESETS = [0, 1, 6, 9, 6 | lzma.PRESET_EXTREME]


def verdict(stream):
    try:
        decompressor = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
        out = decompressor.decompress(stream)
        if not decompressor.eof:
            return {"ok": False}
        return {"ok": True, "bytes": base64.b64encode(out).decode()}
    except lzma.LZMAError:
        return {"ok": False}


def main():
    vectors = []
    for name, data in INPUTS.items():
        for check in CHECKS:
            for preset in PRESETS:
                if len(data) > 20000 and (preset not in (0, 6) or check != lzma.CHECK_CRC64):
                    continue
                stream = lzma.compress(data, format=lzma.FORMAT_XZ, check=check, preset=preset)
                vectors.append({"label": "%s/check%d/preset%d" % (name, check, preset), "stream": base64.b64encode(stream).decode(), **verdict(stream)})
    valid = [v for v in vectors if len(base64.b64decode(v["stream"])) < 6000]
    for vector in rng.sample(valid, min(60, len(valid))):
        stream = bytearray(base64.b64decode(vector["stream"]))
        for index in range(25):
            mutated = bytearray(stream)
            at = rng.randrange(len(mutated))
            mutated[at] ^= 1 << rng.randrange(8)
            vectors.append({"label": "%s/flip@%d" % (vector["label"], at), "stream": base64.b64encode(bytes(mutated)).decode(), **verdict(bytes(mutated))})
        for cut in (len(stream) - 1, len(stream) - 12, len(stream) // 2, 20):
            vectors.append({"label": "%s/cut@%d" % (vector["label"], cut), "stream": base64.b64encode(bytes(stream[:cut])).decode(), **verdict(bytes(stream[:cut]))})
        vectors.append({"label": vector["label"] + "/extra", "stream": base64.b64encode(bytes(stream) + b"\0\0\0\0").decode(), **verdict(bytes(stream) + b"\0\0\0\0")})
    with open(sys.argv[1], "w") as handle:
        json.dump({"library": lzma.__name__, "vectors": vectors}, handle, separators=(",", ":"))
    print(len(vectors), sum(1 for v in vectors if v["ok"]))


main()
