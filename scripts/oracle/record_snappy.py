#!/usr/bin/env python3
"""Record what the installed libsnappy compresses and accepts.

usage: record_snappy.py vectors.json

Every input is compressed by snappy_compress (the C API rsyslog's prometheus_remote_write.c calls) and the exact bytes are kept, so the TypeScript compressor is
compared byte for byte.  Corrupted streams (truncations, flipped bytes, forged lengths and offsets) are handed to snappy_validate_compressed_buffer and
snappy_uncompressed_length, and the status is kept next to the stream.
"""
import ctypes, json, random, sys

lib = ctypes.CDLL("libsnappy.so.1")
lib.snappy_compress.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.POINTER(ctypes.c_size_t)]
lib.snappy_max_compressed_length.argtypes = [ctypes.c_size_t]
lib.snappy_max_compressed_length.restype = ctypes.c_size_t
lib.snappy_validate_compressed_buffer.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
lib.snappy_uncompressed_length.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
lib.snappy_uncompress.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.POINTER(ctypes.c_size_t)]


def compress(data):
    capacity = lib.snappy_max_compressed_length(len(data))
    out = ctypes.create_string_buffer(capacity)
    size = ctypes.c_size_t(capacity)
    status = lib.snappy_compress(data, len(data), out, ctypes.byref(size))
    assert status == 0
    return out.raw[: size.value]


def verdict(stream):
    valid = lib.snappy_validate_compressed_buffer(stream, len(stream))
    length = ctypes.c_size_t(0)
    got = lib.snappy_uncompressed_length(stream, len(stream), ctypes.byref(length))
    decoded = None
    if valid == 0 and got == 0 and length.value < (1 << 24):
        out = ctypes.create_string_buffer(max(1, length.value))
        size = ctypes.c_size_t(length.value)
        if lib.snappy_uncompress(stream, len(stream), out, ctypes.byref(size)) == 0:
            decoded = out.raw[: size.value].hex()
    return {"valid": valid == 0, "length": length.value if got == 0 else None, "decoded": decoded}


WORDS = ["rsyslog", "impstats", "queue", "size", "enqueued", "full", "discarded", "origin", "core", "action", "input", "imudp", "imtcp", "name", "main", "total", "instance", "job", "localhost", "__name__"]


def text(rng, count):
    return " ".join(rng.choice(WORDS) for _ in range(count)).encode()


def corpus():
    rng = random.Random(20260101)
    cases = []
    for size in list(range(0, 80)) + [100, 127, 128, 129, 255, 256, 257, 1000, 4095, 4096, 4097]:
        cases.append(("zeros-%d" % size, bytes(size)))
        cases.append(("counting-%d" % size, bytes(i & 0xFF for i in range(size))))
        cases.append(("random-%d" % size, bytes(rng.randrange(256) for _ in range(size))))
        cases.append(("text-%d" % size, text(rng, size)[:size]))
        cases.append(("pairs-%d" % size, bytes(rng.choice(b"ab") for _ in range(size))))
    for unit in (b"a", b"ab", b"abc", b"abcd", b"abcde", b"abcdefghijklmnopqrstuvwxyz", bytes(range(200))):
        for size in (59, 60, 61, 255, 256, 2047, 2048, 2049, 5000, 65535, 65536, 65537, 70000, 140000):
            cases.append(("repeat-%d-%d" % (len(unit), size), (unit * (size // len(unit) + 1))[:size], {"repeat": unit.hex(), "size": size}))
    for count in (3, 20, 100, 500, 3000, 12000):
        cases.append(("words-%d" % count, text(rng, count)))
    for size in (1000, 20000, 66000):
        cases.append(("random-large-%d" % size, bytes(rng.randrange(256) for _ in range(size))))
    mixed = b""
    for _ in range(300):
        mixed += rng.choice([text(rng, rng.randrange(1, 30)), bytes(rng.randrange(256) for _ in range(rng.randrange(1, 40))), bytes(rng.randrange(1, 300))])
    cases.append(("mixed", mixed))
    series = b"".join(b"\n\x0a\x08__name__\x12\x1brsyslog_imudp_ctr_%d_total" % i for i in range(800))
    cases.append(("series", series))
    return cases


def corruptions(rng, streams):
    out = []
    for stream in streams:
        out.append(stream)
        for cut in range(0, min(len(stream), 12)):
            out.append(stream[:cut])
        if len(stream) > 12:
            out.append(stream[:-1])
            out.append(stream[: len(stream) // 2])
        for _ in range(12):
            mutated = bytearray(stream)
            for _ in range(rng.randrange(1, 4)):
                if mutated:
                    mutated[rng.randrange(len(mutated))] = rng.randrange(256)
            out.append(bytes(mutated))
    forged = [
        b"", b"\x00", b"\x01", b"\x01\x00a", b"\x01\x04a", b"\x05\x10abcde", b"\x05\x0cabcde", b"\x80", b"\x80\x80\x80\x80\x80\x01", b"\xff\xff\xff\xff\x0f",
        b"\xff\xff\xff\xff\x10", b"\x04\x00a\x01\x00", b"\x08\x0ca\x05\x01", b"\x08\x0ca\x09\x00", b"\x08\x0ca\x0d\x01\x00", b"\x08\x0ca\x0e\x01\x00\x00\x00",
        b"\x04\xf0\x03abcd", b"\x04\xf4\x03\x00abcd", b"\x04\xf8\x03\x00\x00abcd", b"\x04\xfc\x03\x00\x00\x00abcd", b"\x04\xfc\x03\x00\x00\x00\x00abcd", b"\x04\x0cabcd", b"\x03\x08abc",
        b"\x40" + b"\x00" * 64, b"\x02\x01a\x01\x01\x00", b"\x03\x00a\x05\x01",
    ]
    return out + forged


def main():
    cases = []
    for entry in corpus():
        name, data = entry[0], entry[1]
        spec = entry[2] if len(entry) > 2 else data.hex()
        cases.append({"name": name, "input": spec, "compressed": compress(data).hex()})
    rng = random.Random(77)
    streams = [bytes.fromhex(c["compressed"]) for c in cases if len(c["compressed"]) < 4000][::7]
    probes = [dict(stream=s.hex(), **verdict(s)) for s in corruptions(rng, streams)]
    with open(sys.argv[1], "w") as handle:
        json.dump({"library": "libsnappy 1.1.10", "compress": cases, "probes": probes}, handle, separators=(",", ":"))
    print(len(cases), len(probes))


main()
