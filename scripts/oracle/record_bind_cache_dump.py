#!/usr/bin/env python3
"""Record what a real BIND 9.18 resolver writes with `rndc dumpdb -cache` after the same questions the lab DNS-RES answers.

usage: record_bind_cache_dump.py out.json

Five named instances play the lab of labs/dns-agence-bancaire on loopback aliases that carry the lab's own addresses: the root (198.51.100.1), the zone com
(198.51.100.2), the two name servers of banquehorizon.com (203.0.113.10 and .11, same zone file) and the resolver (10.20.20.53) that is asked and dumped. The zone
files are the ones src/labs/dnsAgenceBancaire/dnsData.ts writes. After each checkpoint of STEPS the resolver's cache is dumped and the file is stored whole,
so the replay test compares what the cache holds after one question, after four, and after all of them. Needs root, bind9 and the iproute2 package.
"""
import json, os, shutil, subprocess, sys, tempfile, time

ADDRESSES = ["198.51.100.1", "198.51.100.2", "203.0.113.10", "203.0.113.11", "203.0.113.99", "10.20.20.53"]
KEY = 'key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDE="; };'
SERIAL = 2026103101

ROOT_ZONE = f"""$TTL 86400
. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( {SERIAL} 1800 900 604800 86400 )
. IN NS a.root-servers.net.
a.root-servers.net. IN A 198.51.100.1
com. IN NS a.nic.com.
a.nic.com. IN A 198.51.100.2
113.0.203.in-addr.arpa. IN NS ns1.banquehorizon.com.
"""
COM_ZONE = f"""$TTL 3600
com. IN SOA a.nic.com. hostmaster.nic.com. ( {SERIAL} 1800 900 604800 3600 )
com. IN NS a.nic.com.
a.nic.com. IN A 198.51.100.2
banquehorizon.com. IN NS ns1.banquehorizon.com.
banquehorizon.com. IN NS ns2.banquehorizon.com.
ns1.banquehorizon.com. IN A 203.0.113.10
ns2.banquehorizon.com. IN A 203.0.113.11
broken.com. IN NS ns.broken.com.
ns.broken.com. IN A 203.0.113.99
"""
BANK_ZONE = f"""$TTL 3600
$ORIGIN banquehorizon.com.
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( {SERIAL} 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
@ IN NS ns2.banquehorizon.com.
@ IN A 203.0.113.20
@ IN MX 10 mail.banquehorizon.com.
@ IN MX 20 mail2.banquehorizon.com.
@ IN TXT "v=spf1 mx -all"
ns1 IN A 203.0.113.10
ns2 IN A 203.0.113.11
web IN A 203.0.113.20
www IN CNAME web
ebanking IN CNAME web
agences IN CNAME web
api IN CNAME web
mail IN A 203.0.113.25
mail2 IN A 203.0.113.26
_dmarc IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc@banquehorizon.com"
_imaps._tcp IN SRV 0 1 993 mail
"""
REVERSE_ZONE = f"""$TTL 3600
$ORIGIN 113.0.203.in-addr.arpa.
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( {SERIAL} 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
@ IN NS ns2.banquehorizon.com.
10 IN PTR ns1.banquehorizon.com.
11 IN PTR ns2.banquehorizon.com.
20 IN PTR web.banquehorizon.com.
25 IN PTR mail.banquehorizon.com.
"""
HINTS = """. 3600000 IN NS a.root-servers.net.
a.root-servers.net. 3600000 IN A 198.51.100.1
"""

STEPS = [
    ("www", ["www.banquehorizon.com"]),
    ("nxdomain", ["nexiste.banquehorizon.com"]),
    ("nodata", ["web.banquehorizon.com", "AAAA"]),
    ("mx", ["banquehorizon.com", "MX"]),
    ("txt", ["banquehorizon.com", "TXT"]),
    ("soa", ["banquehorizon.com", "SOA"]),
    ("ptr", ["-x", "203.0.113.20"]),
    ("srv", ["_imaps._tcp.banquehorizon.com", "SRV"]),
    ("ebanking", ["ebanking.banquehorizon.com"]),
    ("nosuchtld", ["nosuchtld"]),
    ("broken", ["www.broken.com"]),
]
CHECKPOINTS = {"www", "mx", "ebanking", "broken"}
CAPS_OPTIONS = "max-cache-ttl 600; max-ncache-ttl 120;"
CAPS_STEPS = [
    ("www", ["www.banquehorizon.com"]),
    ("nxdomain", ["nexiste.banquehorizon.com"]),
    ("mx", ["banquehorizon.com", "MX"]),
]
SERVFAIL_OPTIONS = "servfail-ttl 30;"


def write(directory, name, text):
    with open(os.path.join(directory, name), "w") as handle:
        handle.write(text)


def instance(root, name, address, control, recursion, zones, hints=False, extra=""):
    directory = os.path.join(root, name)
    os.makedirs(directory)
    config = [
        f'options {{ directory "{directory}"; listen-on {{ {address}; }}; listen-on-v6 {{ none; }}; pid-file "{directory}/named.pid"; session-keyfile "{directory}/session.key";',
        f'  dump-file "named_dump.db"; recursion {"yes" if recursion else "no"}; allow-query {{ any; }}; allow-recursion {{ any; }}; allow-transfer {{ none; }}; dnssec-validation no; minimal-responses no; empty-zones-enable no; {extra} }};',
        f'controls {{ inet 127.0.0.1 port {control} allow {{ 127.0.0.1; }} keys {{ "rndc-key"; }}; }};',
        KEY,
    ]
    for zone, file_name, text in zones:
        write(directory, file_name, text)
        config.append(f'zone "{zone}" {{ type {"hint" if hints else "primary"}; file "{file_name}"; }};')
    write(directory, "named.conf", "\n".join(config) + "\n")
    os.chmod(directory, 0o777)
    process = subprocess.Popen(["named", "-u", "root", "-g", "-c", os.path.join(directory, "named.conf")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return directory, process


def record(base, resolver_options, steps, checkpoints):
    root = tempfile.mkdtemp(dir=base)
    os.chmod(root, 0o777)
    processes = []
    try:
        for name, address, control, zones in [
            ("root", "198.51.100.1", 9532, [(".", "db.root", ROOT_ZONE)]),
            ("com", "198.51.100.2", 9533, [("com", "db.com", COM_ZONE)]),
            ("ns1", "203.0.113.10", 9534, [("banquehorizon.com", "db.bank", BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", REVERSE_ZONE)]),
            ("ns2", "203.0.113.11", 9535, [("banquehorizon.com", "db.bank", BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", REVERSE_ZONE)]),
        ]:
            processes.append(instance(root, name, address, control, False, zones)[1])
        resolver_directory, resolver = instance(root, "res", "10.20.20.53", 9531, True, [(".", "db.hints", HINTS)], hints=True, extra=resolver_options)
        processes.append(resolver)
        write(root, "rndc.conf", KEY + '\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9531; };\n')
        for _ in range(100):
            if subprocess.run(["rndc", "-c", os.path.join(root, "rndc.conf"), "status"], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        time.sleep(1)
        dumps = {}
        dump_file = os.path.join(resolver_directory, "named_dump.db")
        for label, arguments in steps:
            subprocess.run(["dig", "@10.20.20.53", *arguments], capture_output=True, check=True)
            if label in checkpoints:
                if os.path.exists(dump_file):
                    os.remove(dump_file)
                subprocess.run(["rndc", "-c", os.path.join(root, "rndc.conf"), "dumpdb", "-cache"], check=True)
                time.sleep(0.5)
                with open(dump_file) as handle:
                    dumps[label] = handle.read()
        return dumps
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
    for address in ADDRESSES:
        subprocess.run(["ip", "addr", "add", f"{address}/32", "dev", "lo"], check=True)
    try:
        dumps = record(base, SERVFAIL_OPTIONS, STEPS, CHECKPOINTS)
        caps = record(base, CAPS_OPTIONS, CAPS_STEPS, {CAPS_STEPS[-1][0]})
        version = subprocess.run(["named", "-v"], capture_output=True, text=True).stdout.strip()
        with open(out, "w") as handle:
            json.dump({
                "named": version,
                "steps": [{"label": label, "arguments": arguments} for label, arguments in STEPS],
                "dumps": dumps,
                "caps": {
                    "options": CAPS_OPTIONS,
                    "steps": [{"label": label, "arguments": arguments} for label, arguments in CAPS_STEPS],
                    "dump": caps[CAPS_STEPS[-1][0]],
                },
            }, handle)
        print(len(dumps), "dumps")
    finally:
        for address in ADDRESSES:
            subprocess.run(["ip", "addr", "del", f"{address}/32", "dev", "lo"], capture_output=True)
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
