#!/usr/bin/env python3
"""Record what the real host (bind9-host of BIND 9.18) prints against the resolver of the lab of record_bind_cache_dump.py.

usage: record_host.py out.json

The lab (root 198.51.100.1, com 198.51.100.2, the two name servers of banquehorizon.com 203.0.113.10 and .11, the resolver 10.20.20.53) is started, then host is run for each question twice:
with the resolver named on the command line (host prints the `Using domain server:` block) and through /etc/resolv.conf (a file bind-mounted over the real one, so host prints no block). Needs root,
bind9, bind9-host and dnsutils; run it in a network and mount namespace (unshare -n -m --propagation private) so that `lo` and /etc/resolv.conf are private.
"""
import json, os, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab

QUESTIONS = [
    ["web.banquehorizon.com"],
    ["www.banquehorizon.com"],
    ["banquehorizon.com"],
    ["mail.banquehorizon.com"],
    ["ns1.banquehorizon.com"],
    ["nexiste.banquehorizon.com"],
    ["203.0.113.20"],
    ["203.0.113.99"],
    ["nosuchtld"],
    ["-t", "A", "web.banquehorizon.com"],
    ["-t", "AAAA", "web.banquehorizon.com"],
    ["-t", "MX", "banquehorizon.com"],
    ["-t", "NS", "banquehorizon.com"],
    ["-t", "SOA", "banquehorizon.com"],
    ["-t", "TXT", "banquehorizon.com"],
    ["-t", "CNAME", "www.banquehorizon.com"],
    ["-t", "CNAME", "web.banquehorizon.com"],
    ["-t", "SRV", "_imaps._tcp.banquehorizon.com"],
    ["-t", "PTR", "20.113.0.203.in-addr.arpa"],
    ["-t", "MX", "nexiste.banquehorizon.com"],
    ["-t", "mx", "banquehorizon.com"],
    ["-t", "BOGUS", "banquehorizon.com"],
    ["-t", "ANY", "web.banquehorizon.com"],
    ["-t", "AAAA", "mail.banquehorizon.com"],
    ["-t", "A", "banquehorizon.com"],
    ["web.banquehorizon.com."],
    ["::1"],
    ["-t", "NS", "com"],
    ["_imaps._tcp.banquehorizon.com"],
    ["-t", "AAAA", "web.banquehorizon.com."],
    ["-t", "aaaa", "web.banquehorizon.com"],
    ["-t", "TXT", "web.banquehorizon.com"],
    ["-t", "NS", "web.banquehorizon.com"],
    ["2001:db8::1"],
    ["-t", "SOA", "nexiste.banquehorizon.com"],
    ["-t", "PTR", "203.0.113.20"],
    ["-t", "A", "203.0.113.20"],
    ["-t", "AAAA", "www.banquehorizon.com"],
    ["-t", "MX", "www.banquehorizon.com"],
    ["-t", "A", "www.banquehorizon.com"],
    ["-t", "ANY", "banquehorizon.com"],
    ["nexiste.banquehorizon.com."],
    ["-t", "TXT", "nexiste.banquehorizon.com."],
]


def run(arguments):
    result = subprocess.run(["host", *arguments], capture_output=True, text=True)
    return {"rc": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def main():
    out = sys.argv[1]
    base = tempfile.mkdtemp()
    os.chmod(base, 0o777)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=False)
    for address in lab.ADDRESSES:
        subprocess.run(["ip", "addr", "add", f"{address}/32", "dev", "lo"], check=True)
    resolv = os.path.join(base, "resolv.conf")
    with open(resolv, "w") as handle:
        handle.write("nameserver 10.20.20.53\n")
    subprocess.run(["mount", "--bind", resolv, "/etc/resolv.conf"], check=True)
    root = tempfile.mkdtemp(dir=base)
    os.chmod(root, 0o777)
    processes = []
    try:
        for name, address, control, zones in [
            ("root", "198.51.100.1", 9532, [(".", "db.root", lab.ROOT_ZONE)]),
            ("com", "198.51.100.2", 9533, [("com", "db.com", lab.COM_ZONE)]),
            ("ns1", "203.0.113.10", 9534, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
            ("ns2", "203.0.113.11", 9535, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
        ]:
            processes.append(lab.instance(root, name, address, control, False, zones)[1])
        _, resolver = lab.instance(root, "res", "10.20.20.53", 9531, True, [(".", "db.hints", lab.HINTS)], hints=True)
        processes.append(resolver)
        lab.write(root, "rndc.conf", lab.KEY + '\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9531; };\n')
        for _ in range(100):
            if subprocess.run(["rndc", "-c", os.path.join(root, "rndc.conf"), "status"], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        time.sleep(1)
        cases = []
        for question in QUESTIONS:
            cases.append({"question": question, "server": False, **run(question)})
            cases.append({"question": question, "server": True, **run([*question, "10.20.20.53"])})
        cases.append({"question": [], "server": False, **run([])})
        cases.append({"question": ["web.banquehorizon.com"], "server": "dead", **run(["-W", "1", "web.banquehorizon.com", "10.20.20.99"])})
        version = subprocess.run(["named", "-v"], capture_output=True, text=True).stdout.strip()
        with open(out, "w") as handle:
            json.dump({"named": version, "cases": cases}, handle)
        print(len(cases), "cases")
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait()
        subprocess.run(["umount", "/etc/resolv.conf"], capture_output=True)
        for address in lab.ADDRESSES:
            subprocess.run(["ip", "addr", "del", f"{address}/32", "dev", "lo"], capture_output=True)


if __name__ == "__main__":
    main()
