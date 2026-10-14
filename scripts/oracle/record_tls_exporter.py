#!/usr/bin/env python3
"""Record TLS 1.3 exporter output (RFC 8446 section 7.5) from OpenSSL 3.

usage: record_tls_exporter.py out.json

openssl s_server and s_client run a TLS 1.3 handshake on localhost; the client logs the EXPORTER_SECRET (the exporter_master_secret of
RFC 8446) and prints `-keymatexport` output for several labels and lengths (OpenSSL passes an empty context).
"""
import json, os, re, subprocess, sys, tempfile, time

CASES = [("TLS_AES_128_GCM_SHA256", "sha256"), ("TLS_AES_256_GCM_SHA384", "sha384")]
LABELS = [("EXPORTER-test label", 40), ("EXPORTER-network-time-security", 32), ("EXPORTER-x", 1), ("EXPORTER-long", 100)]

def main():
    out = []
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", d + "/k.pem", "-out", d + "/c.pem", "-subj", "/CN=localhost", "-days", "30"], capture_output=True, check=True)
        for suite, hash_name in CASES:
            server = subprocess.Popen(["openssl", "s_server", "-accept", "14433", "-cert", d + "/c.pem", "-key", d + "/k.pem", "-tls1_3", "-ciphersuites", suite, "-www", "-quiet"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(1)
            try:
                for label, length in LABELS:
                    log = d + "/log.txt"
                    if os.path.exists(log): os.remove(log)
                    r = subprocess.run(["openssl", "s_client", "-connect", "127.0.0.1:14433", "-tls1_3", "-ciphersuites", suite, "-keylogfile", log, "-keymatexport", label, "-keymatexportlen", str(length)], input=b"", capture_output=True, timeout=20)
                    material = re.search(r"Keying material: ([0-9A-Fa-f]+)", r.stdout.decode()).group(1).lower()
                    secret = [l.split()[2] for l in open(log) if l.startswith("EXPORTER_SECRET")][0]
                    out.append({"hash": hash_name, "exporterSecret": secret, "label": label, "length": length, "material": material})
            finally:
                server.terminate(); server.wait()
    json.dump({"tool": "openssl " + subprocess.run(["openssl", "version"], capture_output=True, text=True).stdout.strip(), "cases": out}, open(sys.argv[1], "w"), indent=1)
    print(len(out), "cases")

main()
