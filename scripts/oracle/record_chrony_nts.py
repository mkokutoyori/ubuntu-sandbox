#!/usr/bin/env python3
"""Record a real NTS exchange (RFC 8915) against chronyd 4.5.

usage: record_chrony_nts.py NTP_ROOT out.json

chronyd runs as an NTS-KE server (ntsservercert/ntsserverkey) with a local reference at stratum 5.  This script plays the client:
- an NTS-KE session over TLS 1.3 (ALPN ntske/1) whose plaintext request and response records are saved;
- the exporter keys (RFC 8915 section 5.1), derived here from the EXPORTER_SECRET of the SSLKEYLOGFILE with an independent HKDF;
- an authenticated NTP request (unique identifier, cookie, cookie placeholders, authenticator and encrypted extension fields; AES-SIV-CMAC-256
  by python-cryptography) whose reply is decrypted: it carries fresh cookies;
- a second request using one of those cookies, and a request with a corrupted cookie (the server answers an NTS NAK).
Everything is saved as hex so that the simulator's codecs can be compared byte for byte.
"""
import hashlib, hmac, json, os, socket, ssl, struct, subprocess, sys, tempfile, time
from cryptography.hazmat.primitives.ciphers.aead import AESSIV
from cryptography.hazmat.primitives.cmac import CMAC
from cryptography.hazmat.primitives.ciphers import algorithms, Cipher, modes

def cmac(key, data):
    c = CMAC(algorithms.AES(key)); c.update(data); return c.finalize()

def dbl(block):
    value = int.from_bytes(block, "big") << 1
    if value >> 128: value = (value & ((1 << 128) - 1)) ^ 0x87
    return value.to_bytes(16, "big")

def xor(a, b): return bytes(x ^ y for x, y in zip(a, b))

def siv(key, strings, plaintext):
    """AES-SIV (RFC 5297) written out because python-cryptography refuses an empty plaintext, which NTS requests use."""
    k1, k2 = key[:16], key[16:]
    d = cmac(k1, bytes(16))
    for item in strings: d = xor(dbl(d), cmac(k1, item))
    if len(plaintext) >= 16:
        t = plaintext[:-16] + xor(plaintext[-16:], d)
    else:
        t = xor(dbl(d), plaintext + b"\x80" + bytes(15 - len(plaintext)))
    tag = cmac(k1, t)
    q = bytearray(tag); q[8] &= 0x7f; q[12] &= 0x7f
    enc = Cipher(algorithms.AES(k2), modes.CTR(bytes(q))).encryptor()
    return tag + enc.update(plaintext) + enc.finalize()

assert siv(bytes(range(32)), [b"abc", b"xyz"], b"hello world, 20 bytes!") == AESSIV(bytes(range(32))).encrypt(b"hello world, 20 bytes!", [b"abc", b"xyz"])

NKE_PORT, NTP_PORT = 14460, 12311

def hkdf_expand_label(secret, label, context, length, algo):
    full = b"tls13 " + label
    info = struct.pack("!H", length) + bytes([len(full)]) + full + bytes([len(context)]) + context
    out, previous, counter = b"", b"", 1
    while len(out) < length:
        previous = hmac.new(secret, previous + info + bytes([counter]), algo).digest()
        out += previous; counter += 1
    return out[:length]

def exporter(secret_hex, label, context, length, algo=hashlib.sha256):
    secret = bytes.fromhex(secret_hex)
    derived = hkdf_expand_label(secret, label, algo(b"").digest(), algo().digest_size, algo)
    return hkdf_expand_label(derived, b"exporter", algo(context).digest(), length, algo)

def record(critical, kind, body):
    return struct.pack("!HH", (0x8000 if critical else 0) | kind, len(body)) + body

def ef(kind, body):
    pad = (-len(body)) % 4
    length = 4 + len(body) + pad
    return struct.pack("!HH", kind, length) + body + bytes(pad)

def parse_records(data):
    out, i = [], 0
    while i < len(data):
        word, length = struct.unpack_from("!HH", data, i)
        out.append({"critical": bool(word & 0x8000), "type": word & 0x7fff, "body": data[i + 4:i + 4 + length].hex()})
        i += 4 + length
    return out

def parse_efs(data, start):
    out, i = [], start
    while i < len(data):
        kind, length = struct.unpack_from("!HH", data, i)
        out.append((kind, i, data[i + 4:i + length]))
        i += length
    return out

def ntp_header(version=4, mode=3):
    header = bytearray(48)
    header[0] = (version << 3) | mode
    struct.pack_into("!Q", header, 40, int((time.time() + 2208988800) * (1 << 32)) & 0xffffffffffffffff)
    return bytes(header)

def authenticated_request(c2s, cookie, uid, nonce, placeholders):
    packet = ntp_header() + ef(0x0104, uid) + ef(0x0204, cookie) + b"".join(ef(0x0304, bytes(len(cookie))) for _ in range(placeholders))
    sealed = siv(c2s, [packet, nonce], b"")
    body = struct.pack("!HH", len(nonce), len(sealed)) + nonce + sealed
    body += bytes((-len(body)) % 4)
    body += bytes(max(0, 72 - 4 - len(body)))
    return packet + ef(0x0404, body)

def exchange(request):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    s.sendto(request, ("127.0.0.1", NTP_PORT))
    return s.recv(4096)

def decode_reply(reply, s2c, uid):
    efs = parse_efs(reply, 48)
    kinds = [k for k, _, _ in efs]
    out = {"kinds": kinds, "stratum": reply[1], "refid": reply[12:16].hex()}
    for kind, start, body in efs:
        if kind == 0x0404:
            nonce_len, ct_len = struct.unpack_from("!HH", body, 0)
            nonce = body[4:4 + nonce_len]
            ct = body[4 + ((nonce_len + 3) & ~3):][:ct_len]
            plain = AESSIV(s2c).decrypt(ct, [reply[:start], nonce])
            cookies = [b for k, _, b in parse_efs(plain, 0) if k == 0x0204]
            out.update({"nonce": nonce.hex(), "plaintextEfs": plain.hex(), "cookies": [c.hex() for c in cookies]})
        if kind == 0x0104:
            out["uidMatches"] = body == uid
    return out

def main():
    root, target = sys.argv[1], sys.argv[2]
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu")
    with tempfile.TemporaryDirectory() as run:
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", run + "/k.pem", "-out", run + "/c.pem", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "30"], capture_output=True, check=True)
        conf = "local stratum 5\nallow\nport %d\nntsport %d\ncmdport 0\nbindcmdaddress 127.0.0.1\nbindaddress 127.0.0.1\nntsservercert %s/c.pem\nntsserverkey %s/k.pem\nntsdumpdir %s\nntsprocesses 0\nuser root\npidfile %s/c.pid\ndumpdir %s\nlogdir %s\n" % (NTP_PORT, NKE_PORT, run, run, run, run, run, run)
        open(run + "/c.conf", "w").write(conf)
        daemon = subprocess.Popen([root + "/usr/sbin/chronyd", "-x", "-d", "-f", run + "/c.conf"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        try:
            time.sleep(3)
            keylog = run + "/keys.txt"
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
            context.minimum_version = ssl.TLSVersion.TLSv1_3
            context.set_alpn_protocols(["ntske/1"]); context.keylog_filename = keylog
            request = record(True, 1, struct.pack("!H", 0)) + record(True, 4, struct.pack("!H", 15)) + record(True, 0, b"")
            with socket.create_connection(("127.0.0.1", NKE_PORT)) as raw, context.wrap_socket(raw, server_hostname="127.0.0.1") as tls:
                tls.sendall(request)
                response = b""
                while True:
                    chunk = tls.recv(4096)
                    if not chunk: break
                    response += chunk
                    if parse_records(response) and parse_records(response)[-1]["type"] == 0: break
                alpn = tls.selected_alpn_protocol(); version = tls.version(); cipher = tls.cipher()[0]
            secret = [l.split()[2] for l in open(keylog) if l.startswith("EXPORTER_SECRET")][0]
            algo = hashlib.sha384 if "SHA384" in cipher else hashlib.sha256
            c2s = exporter(secret, b"EXPORTER-network-time-security", b"\x00\x00\x00\x0f\x00", 32, algo)
            s2c = exporter(secret, b"EXPORTER-network-time-security", b"\x00\x00\x00\x0f\x01", 32, algo)
            records = parse_records(response)
            cookies = [bytes.fromhex(r["body"]) for r in records if r["type"] == 5]
            uid, nonce = os.urandom(32), os.urandom(16)
            first_request = authenticated_request(c2s, cookies[0], uid, nonce, 7)
            first_reply = exchange(first_request)
            first = decode_reply(first_reply, s2c, uid)
            uid2, nonce2 = os.urandom(32), os.urandom(16)
            second_request = authenticated_request(c2s, bytes.fromhex(first["cookies"][0]), uid2, nonce2, 0)
            second_reply = exchange(second_request)
            second = decode_reply(second_reply, s2c, uid2)
            bad = bytearray(cookies[1]); bad[30] ^= 0xff
            uid3, nonce3 = os.urandom(32), os.urandom(16)
            nak_request = authenticated_request(c2s, bytes(bad), uid3, nonce3, 0)
            nak_reply = exchange(nak_request)
            nak = {"stratum": nak_reply[1], "refid": nak_reply[12:16].hex(), "kinds": [k for k, _, _ in parse_efs(nak_reply, 48)], "length": len(nak_reply)}
        finally:
            daemon.terminate(); daemon.wait()
    json.dump({
        "tool": "chrony 4.5 NTS server", "tls": {"version": version, "alpn": alpn, "cipher": cipher},
        "ke": {"request": request.hex(), "response": response.hex(), "records": records},
        "exporterSecret": secret, "hash": "sha384" if algo is hashlib.sha384 else "sha256", "c2s": c2s.hex(), "s2c": s2c.hex(),
        "first": {"uid": uid.hex(), "nonce": nonce.hex(), "cookie": cookies[0].hex(), "placeholders": 7, "request": first_request.hex(), "reply": first_reply.hex(), "decoded": first},
        "second": {"uid": uid2.hex(), "nonce": nonce2.hex(), "cookie": first["cookies"][0], "request": second_request.hex(), "reply": second_reply.hex(), "decoded": second},
        "nak": {"uid": uid3.hex(), "nonce": nonce3.hex(), "request": nak_request.hex(), "reply": nak_reply.hex(), "decoded": nak},
    }, open(target, "w"), indent=1)
    print("ok", len(cookies), "cookies;", len(first_request), "byte request")

main()
