#!/usr/bin/env python3
"""Record how the real libgcrypt and OpenSSL answer the calls rsyslog's lmcry_gcry and lmcry_ossl make.

usage: record_rsyslog_crypto.py gcrypt.json openssl.json

libgcrypt is driven through ctypes in the order of libgcry.c: gcry_cipher_open(algo, mode), gcry_cipher_setkey, gcry_cipher_setiv with a
block-sized IV, then gcry_cipher_encrypt in place on successive buffers (rsyslog pads every buffer with NUL up to the block size, so the
chunks recorded here are already padded; the chaining state must survive from one chunk to the next).  Every algorithm is paired with
every mode, so the pairings libgcrypt refuses at open are recorded too, as are weak keys, which libgcrypt refuses at setkey, and the
failure of AESWRAP, whose in-place call is rejected and leaves the buffer filled with 0x42.  A ragged series (chunks that are not a
multiple of the block) is recorded for the three stream modes.  OpenSSL is driven through `openssl enc -nopad -K -iv` on the
concatenation of the chunks, which is what EVP_EncryptUpdate over several buffers produces.
"""
import ctypes, json, subprocess, sys

lib = ctypes.CDLL("libgcrypt.so.20")
lib.gcry_check_version.restype = ctypes.c_char_p
VERSION = lib.gcry_check_version(None).decode()
lib.gcry_strerror.restype = ctypes.c_char_p
ALGOS = {"3DES": 2, "CAST5": 3, "BLOWFISH": 4, "AES128": 7, "AES192": 8, "AES256": 9, "TWOFISH": 10, "ARCFOUR": 301, "DES": 302,
         "TWOFISH128": 303, "SERPENT128": 304, "SERPENT192": 305, "SERPENT256": 306, "RFC2268_40": 307, "SEED": 309,
         "CAMELLIA128": 310, "CAMELLIA192": 311, "CAMELLIA256": 312}
MODES = {"ECB": 1, "CFB": 2, "CBC": 3, "STREAM": 4, "OFB": 5, "CTR": 6, "AESWRAP": 7}


def pattern(length, seed):
    return bytes((seed + index * 37 + (index >> 3) * 11) & 0xFF for index in range(length))


def call(handle, function, data):
    buffer = ctypes.create_string_buffer(data, len(data))
    error = function(handle, buffer, len(data), None, 0)
    return error, buffer.raw


def series(sizes, seed):
    return [pattern(size, seed + index * 5) for index, size in enumerate(sizes)]


def gcrypt_case(algo, mode, key, iv, chunks, label):
    case = {"label": label, "algo": algo, "mode": mode, "key": key.hex(), "iv": iv.hex(), "chunks": [], "open": 0, "setkey": 0, "setiv": 0}
    handle = ctypes.c_void_p()
    case["open"] = lib.gcry_cipher_open(ctypes.byref(handle), ALGOS[algo], MODES[mode], 0)
    if case["open"]:
        case["openMessage"] = lib.gcry_strerror(case["open"]).decode()
        return case
    case["setkey"] = lib.gcry_cipher_setkey(handle, key, len(key))
    if case["setkey"]:
        case["setkeyMessage"] = lib.gcry_strerror(case["setkey"]).decode()
        lib.gcry_cipher_close(handle)
        return case
    case["setiv"] = lib.gcry_cipher_setiv(handle, iv, len(iv))
    encrypted = []
    for chunk in chunks:
        error, out = call(handle, lib.gcry_cipher_encrypt, chunk)
        encrypted.append(out)
        case["chunks"].append({"in": chunk.hex(), "out": out.hex(), "error": error})
    lib.gcry_cipher_close(handle)
    if not any(entry["error"] for entry in case["chunks"]):
        back = ctypes.c_void_p()
        lib.gcry_cipher_open(ctypes.byref(back), ALGOS[algo], MODES[mode], 0)
        lib.gcry_cipher_setkey(back, key, len(key))
        lib.gcry_cipher_setiv(back, iv, len(iv))
        for entry, ciphertext in zip(case["chunks"], encrypted):
            error, plain = call(back, lib.gcry_cipher_decrypt, ciphertext)
            entry["decrypted"] = plain.hex()
            entry["decryptError"] = error
        lib.gcry_cipher_close(back)
    return case


def gcrypt_cases():
    cases = []
    for algo, number in ALGOS.items():
        block = lib.gcry_cipher_get_algo_blklen(number)
        key_length = lib.gcry_cipher_get_algo_keylen(number)
        key = pattern(key_length, 3)
        iv = pattern(max(block, 1), 101)
        sizes = [block * 2, block * 3, block] if block > 1 else [5, 17, 1]
        for mode in MODES:
            cases.append(gcrypt_case(algo, mode, key, iv, series(sizes, 9), "aligned"))
            if mode in ("CFB", "OFB", "CTR", "STREAM"):
                cases.append(gcrypt_case(algo, mode, key, iv, series([5, 19, 3], 21), "ragged"))
    cases.append(gcrypt_case("DES", "CBC", bytes.fromhex("0101010101010101"), pattern(8, 1), series([16], 9), "weak-des"))
    cases.append(gcrypt_case("DES", "CBC", bytes.fromhex("fefefefefefefefe"), pattern(8, 1), series([16], 9), "weak-des-fe"))
    cases.append(gcrypt_case("3DES", "CBC", bytes.fromhex("0101010101010101") + pattern(16, 2), pattern(8, 1), series([16], 9), "weak-3des-first"))
    cases.append(gcrypt_case("3DES", "CBC", pattern(24, 2), pattern(8, 1), series([16], 9), "strong-3des"))
    key = pattern(8, 2)
    cases.append(gcrypt_case("3DES", "CBC", key * 3, pattern(8, 1), series([16], 9), "equal-subkeys-3des"))
    cases.append(gcrypt_case("AES128", "CBC", pattern(16, 3), pattern(8, 1), series([32], 9), "short-iv"))
    weak_probe = []
    base = [bytes.fromhex(h) for h in ("0101010101010101", "fefefefefefefefe", "1f1f1f1f0e0e0e0e", "e0e0e0e0f1f1f1f1", "011f011f010e010e", "1f011f010e010e01",
            "01e001e001f101f1", "e001e001f101f101", "01fe01fe01fe01fe", "fe01fe01fe01fe01", "1fe01fe00ef10ef1", "e01fe01ff10ef10e", "1ffe1ffe0efe0efe",
            "fe1ffe1ffe0efe0e", "e0fee0fef1fef1fe", "fee0fee0fef1fef1")]
    for key in base:
        for variant in range(8):
            mask = bytes(((variant >> (index % 3)) & 1) for index in range(8))
            weak_probe.append(bytes(byte ^ bit for byte, bit in zip(key, mask)))
    weak_probe += [pattern(8, seed) for seed in range(40)]
    weak_probe += [bytes([0x01] * 7 + [0x80]), bytes([0x80] + [0x01] * 7), bytes.fromhex("0000000000000000"), bytes.fromhex("ffffffffffffffff")]
    weak_results = []
    for key in weak_probe:
        handle = ctypes.c_void_p()
        lib.gcry_cipher_open(ctypes.byref(handle), ALGOS["DES"], MODES["CBC"], 0)
        weak_results.append({"key": key.hex(), "setkey": lib.gcry_cipher_setkey(handle, key, 8)})
        lib.gcry_cipher_close(handle)
    triple = []
    for position in range(3):
        for weak in ("0101010101010101", "1f1f1f1f0e0e0e0e", "011f011f010e010e"):
            parts = [pattern(8, 40 + index) for index in range(3)]
            parts[position] = bytes.fromhex(weak)
            key = b"".join(parts)
            handle = ctypes.c_void_p()
            lib.gcry_cipher_open(ctypes.byref(handle), ALGOS["3DES"], MODES["CBC"], 0)
            triple.append({"key": key.hex(), "setkey": lib.gcry_cipher_setkey(handle, key, 24)})
            lib.gcry_cipher_close(handle)
    return {"library": "libgcrypt " + VERSION, "desWeakKeys": weak_results, "tripleDesWeakKeys": triple, "algorithms": {name: {"block": lib.gcry_cipher_get_algo_blklen(n), "key": lib.gcry_cipher_get_algo_keylen(n)} for name, n in ALGOS.items()}, "cases": cases}


OPENSSL_NAMES = []
for bits in (128, 192, 256):
    for mode in ("cbc", "ecb", "ctr", "cfb", "ofb"):
        OPENSSL_NAMES.append(f"aes-{bits}-{mode}")
        OPENSSL_NAMES.append(f"camellia-{bits}-{mode}")
        OPENSSL_NAMES.append(f"aria-{bits}-{mode}")
OPENSSL_NAMES += ["des-ede3-cbc", "des-ede3-ecb", "des-ede3-cfb", "des-ede3-ofb", "des-ede-cbc", "des-ede-ecb", "sm4-cbc", "sm4-ecb", "sm4-ctr", "sm4-cfb", "sm4-ofb"]


def openssl_list():
    out = subprocess.run(["openssl", "enc", "-ciphers"], capture_output=True, text=True).stdout
    return {token.lstrip("-") for token in out.split()}


def openssl_case(name, sizes, seed):
    info = subprocess.run(["openssl", "enc", f"-{name}", "-P", "-k", "x", "-md", "sha256", "-nosalt"], capture_output=True, text=True).stdout
    values = {line.split("=", 1)[0].strip(): line.split("=", 1)[1].strip() for line in info.splitlines() if "=" in line}
    key_length = len(values["key"]) // 2
    iv_length = len(values.get("iv", "")) // 2
    key = pattern(key_length, 3)
    iv = pattern(iv_length, 101)
    chunks = series(sizes, seed)
    data = b"".join(chunks)
    args = ["openssl", "enc", f"-{name}", "-nopad", "-K", key.hex()] + (["-iv", iv.hex()] if iv_length else [])
    run = subprocess.run(args, input=data, capture_output=True)
    out = run.stdout
    result = {"name": name, "key": key.hex(), "iv": iv.hex(), "keyLength": key_length, "ivLength": iv_length, "returncode": run.returncode, "chunks": []}
    at = 0
    for chunk in chunks:
        result["chunks"].append({"in": chunk.hex(), "out": out[at:at + len(chunk)].hex()})
        at += len(chunk)
    return result


def openssl_cases():
    available = openssl_list()
    cases = []
    for name in OPENSSL_NAMES:
        if name not in available:
            continue
        block = 16 if not name.startswith("des") else 8
        cases.append(openssl_case(name, [block * 2, block * 3, block], 9))
        if name.endswith(("ctr", "cfb", "ofb")):
            cases.append(openssl_case(name, [5, 19, 3], 21))
    version = subprocess.run(["openssl", "version"], capture_output=True, text=True).stdout.strip()
    return {"library": version, "cases": cases}


if __name__ == "__main__":
    with open(sys.argv[1], "w") as handle:
        json.dump(gcrypt_cases(), handle, indent=1)
    with open(sys.argv[2], "w") as handle:
        json.dump(openssl_cases(), handle, indent=1)
