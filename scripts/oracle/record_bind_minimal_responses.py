#!/usr/bin/env python3
"""Record what a real BIND 9.18 puts in the authority and additional sections of a positive answer under each `minimal-responses` value.

usage: record_bind_minimal_responses.py out.json

One named plays the authoritative server of example.test on 127.0.0.1:5300 (zone below), restarted for every pair (recursion yes|no, minimal-responses
yes|no|no-auth|no-auth-recursive). Six questions (A of the apex, MX with its glue, NS, a CNAME, an NXDOMAIN, a NODATA) are asked with and without the RD flag and the
real dig prints only the three record sections. Needs root, bind9 and dnsutils; run it in a network namespace (unshare -n) so that `lo` is private.
"""
import json, os, shutil, subprocess, sys, tempfile, time

PORT = 5300
KEY = 'key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDE="; };'
ZONE = """$TTL 3600
@ IN SOA ns1.example.test. hostmaster.example.test. ( 2026103101 7200 900 1209600 3600 )
@ IN NS ns1.example.test.
@ IN NS ns2.example.test.
@ IN A 192.0.2.10
@ IN MX 10 mail.example.test.
@ IN MX 20 backup.example.test.
ns1 IN A 192.0.2.1
ns2 IN A 192.0.2.2
mail IN A 192.0.2.25
backup IN A 192.0.2.26
www IN CNAME @
"""
QUESTIONS = [
    ["example.test", "A"],
    ["example.test", "MX"],
    ["example.test", "NS"],
    ["www.example.test", "A"],
    ["missing.example.test", "A"],
    ["example.test", "AAAA"],
]
SETTINGS = ["no", "yes", "no-auth", "no-auth-recursive"]


def start(directory, recursion, setting):
    with open(os.path.join(directory, "db.example"), "w") as handle:
        handle.write(ZONE)
    config = (
        f'options {{ directory "{directory}"; listen-on port {PORT} {{ 127.0.0.1; }}; listen-on-v6 {{ none; }}; pid-file "{directory}/named.pid"; session-keyfile "{directory}/session.key";\n'
        f'  recursion {"yes" if recursion else "no"}; allow-query {{ any; }}; allow-recursion {{ any; }}; allow-transfer {{ none; }}; dnssec-validation no; empty-zones-enable no; minimal-responses {setting}; }};\n'
        f'controls {{ inet 127.0.0.1 port 9530 allow {{ 127.0.0.1; }} keys {{ "rndc-key"; }}; }};\n{KEY}\n'
        f'zone "example.test" {{ type primary; file "db.example"; }};\n'
    )
    with open(os.path.join(directory, "named.conf"), "w") as handle:
        handle.write(config)
    process = subprocess.Popen(["named", "-u", "root", "-g", "-c", os.path.join(directory, "named.conf")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(300):
        probe = subprocess.run(["dig", "-p", str(PORT), "@127.0.0.1", "example.test", "SOA", "+norecurse", "+noall", "+comments", "+time=1", "+tries=1"], capture_output=True, text=True)
        if "flags: qr aa" in probe.stdout:
            break
        time.sleep(0.1)
    return process


def ask(question, recurse):
    arguments = ["dig", "-p", str(PORT), "@127.0.0.1", *question, "+noall", "+comments", "+answer", "+authority", "+additional", "+recurse" if recurse else "+norecurse"]
    return subprocess.run(arguments, capture_output=True, text=True, check=True).stdout


def main():
    out = sys.argv[1]
    base = tempfile.mkdtemp()
    os.chmod(base, 0o777)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=False)
    cases = []
    try:
        for recursion in (True, False):
            for setting in SETTINGS:
                directory = tempfile.mkdtemp(dir=base)
                os.chmod(directory, 0o777)
                process = start(directory, recursion, setting)
                try:
                    for question in QUESTIONS:
                        for recurse in (True, False):
                            cases.append({"recursion": recursion, "setting": setting, "question": question, "recurse": recurse, "output": ask(question, recurse)})
                finally:
                    process.terminate()
                    process.wait()
        version = subprocess.run(["named", "-v"], capture_output=True, text=True).stdout.strip()
        with open(out, "w") as handle:
            json.dump({"named": version, "zone": ZONE, "cases": cases}, handle)
        print(len(cases), "cases")
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
