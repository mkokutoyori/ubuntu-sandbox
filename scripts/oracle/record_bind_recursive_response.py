#!/usr/bin/env python3
"""Record what a real BIND 9.18 resolver puts in the authority and additional sections of the answers it gives to its own clients.

usage: record_bind_recursive_response.py out.json

The lab of record_bind_cache_dump.py (root 198.51.100.1, com 198.51.100.2, the two name servers of banquehorizon.com 203.0.113.10 and .11, the resolver 10.20.20.53) is started once per
resolver setting (minimal-responses no, yes, no-auth, no-auth-recursive). For each question the resolver cache is flushed, then the real dig asks it cold without recursion (empty cache), cold (the resolver walks the tree), warm (answered from the cache),
warm without recursion (+norecurse) and warm without EDNS (+noedns), printing the header comments and the three record sections. Needs root, bind9 and dnsutils; run it in a network namespace
(unshare -n) so that `lo` is private.
"""
import json, os, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab

QUESTIONS = [
    ["www.banquehorizon.com", "A"],
    ["banquehorizon.com", "MX"],
    ["banquehorizon.com", "NS"],
    ["banquehorizon.com", "SOA"],
    ["web.banquehorizon.com", "A"],
    ["nexiste.banquehorizon.com", "A"],
    ["web.banquehorizon.com", "AAAA"],
    ["-x", "203.0.113.20"],
    ["_imaps._tcp.banquehorizon.com", "SRV"],
    ["com", "NS"],
    ["a.nic.com", "A"],
    [".", "NS"],
    ["nosuchtld", "A"],
]
SETTINGS = ["no", "yes", "no-auth", "no-auth-recursive"]
MODES = [
    ("cold-norecurse", ["+norecurse"]),
    ("cold", ["+recurse"]),
    ("warm", ["+recurse"]),
    ("warm-norecurse", ["+norecurse"]),
    ("warm-noedns", ["+recurse", "+noedns"]),
]


def ask(question, flags):
    arguments = ["dig", "@10.20.20.53", *question, "+noall", "+comments", "+answer", "+authority", "+additional", *flags]
    return subprocess.run(arguments, capture_output=True, text=True, check=True).stdout


def record(base, setting):
    root = tempfile.mkdtemp(dir=base)
    os.chmod(root, 0o777)
    processes = []
    cases = []
    try:
        for name, address, control, zones in [
            ("root", "198.51.100.1", 9532, [(".", "db.root", lab.ROOT_ZONE)]),
            ("com", "198.51.100.2", 9533, [("com", "db.com", lab.COM_ZONE)]),
            ("ns1", "203.0.113.10", 9534, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
            ("ns2", "203.0.113.11", 9535, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
        ]:
            processes.append(lab.instance(root, name, address, control, False, zones)[1])
        _, resolver = lab.instance(root, "res", "10.20.20.53", 9531, True, [(".", "db.hints", lab.HINTS)], hints=True, minimal=setting)
        processes.append(resolver)
        lab.write(root, "rndc.conf", lab.KEY + '\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9531; };\n')
        for _ in range(100):
            if subprocess.run(["rndc", "-c", os.path.join(root, "rndc.conf"), "status"], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        time.sleep(1)
        for question in QUESTIONS:
            flushed = subprocess.run(["rndc", "-c", os.path.join(root, "rndc.conf"), "flush"], capture_output=True, text=True)
            if flushed.returncode != 0:
                raise RuntimeError(f"rndc flush failed before {question}: {flushed.stderr}")
            for mode, flags in MODES:
                cases.append({"setting": setting, "question": question, "mode": mode, "output": ask(question, flags)})
        return cases
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait()


def main():
    out = sys.argv[1]
    base = tempfile.mkdtemp()
    os.chmod(base, 0o777)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=False)
    for address in lab.ADDRESSES:
        subprocess.run(["ip", "addr", "add", f"{address}/32", "dev", "lo"], check=True)
    cases = []
    try:
        for setting in SETTINGS:
            cases.extend(record(base, setting))
        version = subprocess.run(["named", "-v"], capture_output=True, text=True).stdout.strip()
        with open(out, "w") as handle:
            json.dump({"named": version, "cases": cases}, handle)
        print(len(cases), "cases")
    finally:
        for address in lab.ADDRESSES:
            subprocess.run(["ip", "addr", "del", f"{address}/32", "dev", "lo"], capture_output=True)


if __name__ == "__main__":
    main()
