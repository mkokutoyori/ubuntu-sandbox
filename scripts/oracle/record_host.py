#!/usr/bin/env python3
"""Record what the real host (bind9-host of BIND 9.18) prints against the resolver of the lab of record_bind_cache_dump.py.

usage: record_host.py out.json

The lab (root 198.51.100.1, com 198.51.100.2, the two name servers of banquehorizon.com 203.0.113.10 and .11, the resolver 10.20.20.53) is started, then host is run for each question twice:
with the resolver named on the command line (host prints the `Using domain server:` block) and through /etc/resolv.conf (a file bind-mounted over the real one, so host prints no block). Needs root,
bind9, bind9-host and dnsutils; run it in a network and mount namespace (unshare -n -m --propagation private) so that `lo` and /etc/resolv.conf are private.
"""
import json, os, socket, subprocess, sys, tempfile, time

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


OPTION_CASES = [
    ["-v", "web.banquehorizon.com"], ["-d", "web.banquehorizon.com"], ["-a", "web.banquehorizon.com"], ["-A", "banquehorizon.com"], ["-a", "banquehorizon.com"], ["-v", "-t", "MX", "banquehorizon.com"],
    ["-v", "nexiste.banquehorizon.com"], ["-v", "203.0.113.20"], ["-t", "ANY", "banquehorizon.com"], ["-v", "www.banquehorizon.com"], ["-v", "-t", "SOA", "banquehorizon.com"],
    ["-v", "-t", "NS", "banquehorizon.com"], ["-v", "-t", "TXT", "banquehorizon.com"], ["-v", "-t", "AAAA", "web.banquehorizon.com"], ["-v", "-t", "A", "banquehorizon.com"],
    ["-r", "web.banquehorizon.com"], ["-r", "-v", "web.banquehorizon.com"], ["-T", "web.banquehorizon.com"], ["-T", "-v", "web.banquehorizon.com"], ["-U", "web.banquehorizon.com"],
    ["-U", "-t", "ANY", "banquehorizon.com"], ["-4", "web.banquehorizon.com"], ["-6", "web.banquehorizon.com"], ["-4", "-6", "web.banquehorizon.com"], ["-6", "-4", "web.banquehorizon.com"],
    ["-s", "web.banquehorizon.com"], ["-w", "web.banquehorizon.com"], ["-W", "1", "web.banquehorizon.com"], ["-W", "0", "web.banquehorizon.com"], ["-W", "x", "web.banquehorizon.com"],
    ["-R", "3", "web.banquehorizon.com"], ["-R", "0", "web.banquehorizon.com"], ["-p", "53", "web.banquehorizon.com"], ["-p", "5353", "-W", "1", "web.banquehorizon.com"],
    ["-c", "IN", "web.banquehorizon.com"], ["-c", "CH", "-t", "TXT", "version.bind"], ["-c", "CH", "-t", "TXT", "version.bind", "10.20.20.53"], ["-c", "bogus", "web.banquehorizon.com"],
    ["-c", "ANY", "web.banquehorizon.com"], ["-c", "HS", "web.banquehorizon.com"], ["-N", "2", "web.banquehorizon.com"], ["-N", "0", "web.banquehorizon.com"], ["-N", "x", "web.banquehorizon.com"],
    ["-i", "web.banquehorizon.com"], ["-n", "web.banquehorizon.com"], ["-m", "usage", "web.banquehorizon.com"], ["-m", "bogus", "web.banquehorizon.com"], ["-D", "web.banquehorizon.com"],
    ["-V"], ["-V", "web.banquehorizon.com"], ["-x"], ["-h"], ["--help"], ["-t"], ["-c"], ["-W"], ["-t", "ixfr=1", "banquehorizon.com"], ["-t", "AXFR", "banquehorizon.com"],
    ["-t", "TYPE99", "banquehorizon.com"], ["-t", "type1", "web.banquehorizon.com"], ["-t", "a", "-t", "mx", "banquehorizon.com"], ["-t", "MX", "-t", "A", "banquehorizon.com"],
    ["-C", "banquehorizon.com"], ["-C", "com"], ["-C", "nexiste.banquehorizon.com"], ["-C", "-v", "banquehorizon.com"], ["-l", "banquehorizon.com"], ["-l", "-v", "banquehorizon.com"],
    ["-l", "-t", "NS", "banquehorizon.com"], ["-l", "-a", "banquehorizon.com"], ["-l", "113.0.203.in-addr.arpa"], ["-l", "nexiste.banquehorizon.com"], ["-l", "-A", "banquehorizon.com"],
    ["web.banquehorizon.com", "web.banquehorizon.com"], ["web.banquehorizon.com", "ns1.banquehorizon.com"], ["web.banquehorizon.com", "nosuchserver.invalid"], ["web.banquehorizon.com", "203.0.113.10"],
    ["web.banquehorizon.com", "203.0.113.11"], ["-v", "web.banquehorizon.com", "203.0.113.10"], ["web.banquehorizon.com", "10.20.20.53", "extra"], ["web.banquehorizon.com", "127.0.0.1"],
    ["", ], ["-t", "A", ""], ["."], ["-t", "NS", "."], ["-t", "SOA", "."], ["localhost"], ["web.banquehorizon.com."], ["WEB.BanqueHorizon.COM"], ["-t", "CNAME", "WWW.banquehorizon.com"],
    ["-s", "-v", "web.banquehorizon.com"], ["-a", "-v", "web.banquehorizon.com"], ["-A", "-A", "banquehorizon.com"], ["-v", "-v", "web.banquehorizon.com"], ["-d", "-d", "web.banquehorizon.com"],
    ["-vt", "MX", "banquehorizon.com"], ["-t", "MX", "-v", "banquehorizon.com"], ["-W1", "web.banquehorizon.com"], ["-tMX", "banquehorizon.com"], ["-cIN", "web.banquehorizon.com"],
    ["-v", "-t", "PTR", "20.113.0.203.in-addr.arpa"], ["-v", "2001:db8::1"], ["2001:db8::1"], ["1.2.3.4"], ["999.1.1.1"], ["203.0.113.20", "10.20.20.53"],
]

SEARCH_CASES = [
    ["web"], ["www"], ["nexiste"], ["-N", "3", "web"], ["-N", "0", "web"], ["-N", "1", "web"], ["web.banquehorizon"], ["-v", "web"], ["-t", "MX", "banquehorizon"], ["web."], ["-t", "A", "web"],
    ["-a", "web"], ["web", "10.20.20.53"], ["-v", "web", "10.20.20.53"], ["localhost"], ["com"], ["-t", "NS", "com"],
]


SILENT = "10.20.20.99"
UNASSIGNED = "10.20.20.98"
ZONE_SERVER = "ns1.banquehorizon.com"

TRANSFER_CASES = [
    ["-l", "banquehorizon.com", "203.0.113.10"], ["-l", "-v", "banquehorizon.com", "203.0.113.10"], ["-l", "-a", "banquehorizon.com", "203.0.113.10"], ["-l", "-A", "banquehorizon.com", "203.0.113.10"],
    ["-l", "-t", "NS", "banquehorizon.com", "203.0.113.10"], ["-l", "-t", "A", "banquehorizon.com", "203.0.113.10"], ["-l", "-t", "MX", "banquehorizon.com", "203.0.113.10"],
    ["-l", "-t", "TXT", "banquehorizon.com", "203.0.113.10"], ["-l", "-t", "SOA", "banquehorizon.com", "203.0.113.10"], ["-l", "-t", "ANY", "banquehorizon.com", "203.0.113.10"],
    ["-l", "-t", "CNAME", "banquehorizon.com", "203.0.113.10"], ["-l", "banquehorizon.com", ZONE_SERVER], ["-l", "banquehorizon.com", "203.0.113.11"],
    ["-t", "AXFR", "banquehorizon.com", "203.0.113.10"], ["-t", "axfr", "-v", "banquehorizon.com", "203.0.113.10"], ["-t", "AXFR", "-l", "banquehorizon.com", "203.0.113.10"],
    ["-t", "ixfr=2026103100", "banquehorizon.com", "203.0.113.10"], ["-t", "ixfr=2026103101", "banquehorizon.com", "203.0.113.10"], ["-t", "ixfr=2026103100", "-v", "banquehorizon.com", "203.0.113.10"],
    ["-l", "113.0.203.in-addr.arpa", "203.0.113.10"], ["-l", "-v", "113.0.203.in-addr.arpa", "203.0.113.10"], ["-l", "113.0.203.in-addr.arpa", ZONE_SERVER],
    ["-l", "nexiste.banquehorizon.com", "203.0.113.10"], ["-l", "com", "203.0.113.10"], ["-l", "-T", "banquehorizon.com", "203.0.113.10"], ["-l", "-U", "banquehorizon.com", "203.0.113.10"],
    ["-l", "web.banquehorizon.com", "203.0.113.10"], ["-l", "banquehorizon.com", "10.20.20.99"], ["-W", "1", "-l", "banquehorizon.com", "10.20.20.99"],
    ["-C", "banquehorizon.com", "10.20.20.53"], ["-C", "113.0.203.in-addr.arpa"], ["-C", "-r", "banquehorizon.com"], ["-C", "-t", "MX", "banquehorizon.com"], ["-C", "web.banquehorizon.com"],
    ["-C", "banquehorizon.com", "203.0.113.10"], ["-C", "203.0.113.20"],
]

SILENT_CASES = [
    ["-W", "1", "web.banquehorizon.com", SILENT], ["-W", "1", "-R", "0", "web.banquehorizon.com", SILENT], ["-W", "1", "-R", "3", "web.banquehorizon.com", SILENT],
    ["-W", "1", "-T", "web.banquehorizon.com", SILENT], ["-W", "1", "-t", "MX", "banquehorizon.com", SILENT], ["-W", "1", "-v", "web.banquehorizon.com", SILENT],
    ["-W", "1", "-t", "ANY", "banquehorizon.com", SILENT], ["-W", "1", "-U", "-t", "ANY", "banquehorizon.com", SILENT], ["-W", "1", "-C", "banquehorizon.com", SILENT],
    ["-W", "1", "203.0.113.20", SILENT], ["-W", "1", "-r", "web.banquehorizon.com", SILENT], ["-W", "1", "-s", "web.banquehorizon.com", SILENT], ["-W", "1", "-4", "web.banquehorizon.com", SILENT],
    ["-W", "1", "-p", "5353", "web.banquehorizon.com", SILENT], ["-W", "1", "-T", "-p", "5353", "web.banquehorizon.com", "10.20.20.53"], ["-T", "web.banquehorizon.com", "127.0.0.1"],
    ["-T", "-t", "MX", "banquehorizon.com", "10.20.20.53"], ["-T", "-v", "web.banquehorizon.com", "10.20.20.53"], ["-T", "203.0.113.20", "10.20.20.53"], ["-U", "-v", "web.banquehorizon.com", "10.20.20.53"],
    ["-W", "1", "web.banquehorizon.com", UNASSIGNED], ["-W", "1", "-v", "web.banquehorizon.com", UNASSIGNED],
]

OPTION_ORDER_CASES = [
    ["web.banquehorizon.com", "-t", "MX"], ["web.banquehorizon.com", "-v"], ["--", "web.banquehorizon.com"], ["-t", "MX", "--", "banquehorizon.com"], ["-t", "MX", "banquehorizon.com", "-v"],
    ["-v", "--", "-t", "MX"], ["-t", "99", "web.banquehorizon.com"], ["-t", "A", "-t", "bogus", "web.banquehorizon.com"], ["-t", "HINFO", "web.banquehorizon.com"], ["-t", "RRSIG", "banquehorizon.com"],
    ["-t", "DNSKEY", "banquehorizon.com"], ["-t", "SPF", "banquehorizon.com"], ["-t", "NSEC", "banquehorizon.com"], ["-t", "LOC", "web.banquehorizon.com"], ["-t", "WKS", "web.banquehorizon.com"],
    ["-t", "ANY", "-v", "banquehorizon.com"], ["-t", "any", "-U", "banquehorizon.com"], ["-t", "ANY", "-T", "banquehorizon.com"], ["-t", "SRV", "_imaps._tcp.banquehorizon.com"],
    ["-t", "SRV", "_nosuch._tcp.banquehorizon.com"], ["-t", "AAAA", "-v", "web.banquehorizon.com"], ["-t", "A", "nexiste.banquehorizon.com"], ["-t", "TXT", "-v", "nexiste.banquehorizon.com"],
    ["-c", "CH", "-t", "TXT", "-v", "version.bind"], ["-c", "CH", "-t", "TXT", "hostname.bind"], ["-c", "CH", "web.banquehorizon.com"], ["-c", "chaos", "-t", "TXT", "version.bind"], ["-c", "hs", "-t", "TXT", "version.bind"],
    ["-c", "CLASS3", "-t", "TXT", "version.bind"], ["-c", "CLASS1", "web.banquehorizon.com"], ["-c", "in", "-t", "a", "WEB.banquehorizon.com"], ["-c", "NONE", "web.banquehorizon.com"],
    ["-N", "5", "web.banquehorizon.com"], ["-N", "-1", "web.banquehorizon.com"], ["-W", "-3", "web.banquehorizon.com"], ["-R", "-1", "web.banquehorizon.com"], ["-p", "0", "web.banquehorizon.com"],
    ["-p", "x", "web.banquehorizon.com"], ["-p", "99999", "web.banquehorizon.com"], ["-vv", "web.banquehorizon.com"], ["-vd", "-t", "MX", "banquehorizon.com"], ["-aA", "banquehorizon.com"],
    ["-4v", "web.banquehorizon.com"], ["-46", "web.banquehorizon.com"], ["-64", "web.banquehorizon.com"], ["-ct", "MX", "banquehorizon.com"], ["-c", "IN", "-c", "CH", "-t", "TXT", "version.bind"],
    ["-V", "-v"], ["-v", "-V"], ["-h", "web.banquehorizon.com"], ["-?"], ["-Z"], ["-ax"], ["-t", "MX", "-x"], ["-C", "-h"], ["-N"], ["-p"], ["-R"], ["-m"], ["-c", "IN", "-W"],
    ["-w", "-v", "web.banquehorizon.com"], ["-D", "-D", "web.banquehorizon.com"], ["-n", "-i", "web.banquehorizon.com"], ["-m", "trace", "web.banquehorizon.com"], ["-m", "record", "web.banquehorizon.com"],
]

NAME_CASES = [
    ["a..b"], [".."], ["-t", "A", "a..b"], ["a b"], ["_x.banquehorizon.com"], ["xn--caf-dma.banquehorizon.com"], ["café.banquehorizon.com"], ["web.banquehorizon.com\\"], ["web\\.banquehorizon.com"],
    ["web\\046banquehorizon.com"], ["WWW.BANQUEHORIZON.COM"], ["www.banquehorizon.com."], ["www.banquehorizon.com.."], ["*.banquehorizon.com"], ["1.2.3"], ["1.2.3.4.5"], ["0x7f.1"], ["01.02.03.04"],
    ["::ffff:1.2.3.4"], ["::"], ["fe80::1"], ["2001:db8:0:0:0:0:0:1"], ["2001:DB8::1"], ["fe80::1%eth0"], ["1::2::3"], ["-t", "PTR", "1.2.3.4"], ["-t", "MX", "203.0.113.20"], ["-v", "-t", "MX", "203.0.113.20"],
    ["-t", "NS", "113.0.203.in-addr.arpa"], ["-t", "SOA", "113.0.203.in-addr.arpa"], ["-t", "PTR", "20.113.0.203.in-addr.arpa."], ["20.113.0.203.in-addr.arpa"], ["-t", "ANY", "203.0.113.20"],
    ["a" * 64 + ".banquehorizon.com"], [".".join(["a" * 60] * 5)], ["-t", "MX", "web"],
]

RESOLV_VARIANTS = {
    "plain": "nameserver 10.20.20.53\n",
    "search": "nameserver 10.20.20.53\nsearch banquehorizon.com\noptions ndots:2\n",
    "domain": "nameserver 10.20.20.53\ndomain banquehorizon.com\n",
    "searches": "nameserver 10.20.20.53\nsearch a.invalid banquehorizon.com horizon.invalid\n",
    "silent-first": "nameserver 10.20.20.99\nnameserver 10.20.20.53\noptions timeout:1\n",
    "silent-only": "nameserver 10.20.20.99\noptions timeout:1\n",
    "two-good": "nameserver 10.20.20.53\nnameserver 10.20.20.99\n",
    "empty": "",
    "comment": "# nothing\nsearch\n",
    "attempts": "nameserver 10.20.20.99\noptions timeout:1 attempts:3\n",
    "port-refused": "nameserver 127.0.0.1\nnameserver 10.20.20.53\n",
}

RESOLV_CASES = {
    "domain": [["web"], ["www"], ["nexiste"], ["-v", "nexiste"], ["web.banquehorizon"], ["-N", "0", "web"], ["-N", "1", "web"], ["-t", "MX", "banquehorizon"], ["-v", "web"], ["web", "10.20.20.53"]],
    "searches": [["web"], ["-v", "web"], ["nexiste"], ["-v", "nexiste"], ["web.banquehorizon"], ["-t", "MX", "banquehorizon"], ["-N", "3", "web.banquehorizon"], ["-N", "0", "web"], ["web."], ["web.banquehorizon.com"]],
    "search": [["-v", "nexiste"], ["-v", "web.banquehorizon"], ["-t", "MX", "nexiste"], ["-v", "-N", "0", "web"], ["-v", "-t", "MX", "banquehorizon"], ["-d", "nexiste"], ["nexiste", "10.20.20.53"], ["-v", "nexiste", "10.20.20.53"],
               ["web.banquehorizon.com"], ["-v", "web.banquehorizon.com"], ["1.2.3"], ["203.0.113.20"], ["-t", "A", "com"]],
    "silent-first": [["web.banquehorizon.com"], ["-W", "1", "web.banquehorizon.com"], ["-t", "MX", "banquehorizon.com"], ["-v", "web.banquehorizon.com"], ["203.0.113.20"], ["-T", "web.banquehorizon.com"], ["-R", "0", "web.banquehorizon.com"]],
    "silent-only": [["web.banquehorizon.com"], ["-W", "2", "web.banquehorizon.com"], ["-R", "1", "web.banquehorizon.com"], ["-v", "web.banquehorizon.com"]],
    "two-good": [["web.banquehorizon.com"], ["-v", "web.banquehorizon.com"], ["nexiste.banquehorizon.com"], ["-s", "web.banquehorizon.com"]],
    "empty": [["web.banquehorizon.com"], ["-W", "1", "web.banquehorizon.com"], ["-v", "web.banquehorizon.com"], ["-4", "web.banquehorizon.com"]],
    "comment": [["web.banquehorizon.com"], ["-4", "web.banquehorizon.com"]],
    "attempts": [["web.banquehorizon.com"], ["-R", "1", "web.banquehorizon.com"]],
    "port-refused": [["web.banquehorizon.com"], ["-v", "web.banquehorizon.com"], ["-T", "web.banquehorizon.com"], ["nexiste.banquehorizon.com"], ["-s", "web.banquehorizon.com"]],
}


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
            processes.append(lab.instance(root, name, address, control, False, zones, transfer="any")[1])
        _, resolver = lab.instance(root, "res", "10.20.20.53", 9531, True, [(".", "db.hints", lab.HINTS)], hints=True, transfer="any")
        processes.append(resolver)
        lab.write(root, "rndc.conf", lab.KEY + '\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9531; };\n')
        for _ in range(100):
            if subprocess.run(["rndc", "-c", os.path.join(root, "rndc.conf"), "status"], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        time.sleep(1)
        subprocess.run(["ip", "addr", "add", f"{SILENT}/32", "dev", "lo"], check=True)
        silent_udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        silent_udp.bind((SILENT, 53))
        silent_tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        silent_tcp.bind((SILENT, 53))
        silent_tcp.listen(64)
        cases = []
        for question in QUESTIONS:
            cases.append({"question": question, "server": False, **run(question)})
            cases.append({"question": question, "server": True, **run([*question, "10.20.20.53"])})
        cases.append({"question": [], "server": False, **run([])})
        for question in OPTION_CASES:
            cases.append({"question": question, "server": "options", "resolv": "plain", **run(question)})
        search_resolv = os.path.join(base, "resolv-search.conf")
        with open(search_resolv, "w") as handle:
            handle.write("nameserver 10.20.20.53\nsearch banquehorizon.com\noptions ndots:2\n")
        subprocess.run(["mount", "--bind", search_resolv, "/etc/resolv.conf"], check=True)
        for question in SEARCH_CASES:
            cases.append({"question": question, "server": "search", "resolv": "search", **run(question)})
        subprocess.run(["mount", "--bind", resolv, "/etc/resolv.conf"], check=True)
        cases.append({"question": ["web.banquehorizon.com"], "server": "dead", **run(["-W", "1", "web.banquehorizon.com", UNASSIGNED])})
        for question in TRANSFER_CASES:
            cases.append({"question": question, "server": "transfer", "resolv": "plain", **run(question)})
        for question in SILENT_CASES:
            cases.append({"question": question, "server": "silent", "resolv": "plain", **run(question)})
        for question in OPTION_ORDER_CASES:
            cases.append({"question": question, "server": "options", "resolv": "plain", **run(question)})
        for question in NAME_CASES:
            cases.append({"question": question, "server": "names", "resolv": "plain", **run(question)})
        for name, questions in RESOLV_CASES.items():
            variant = os.path.join(base, f"resolv-{name}.conf")
            with open(variant, "w") as handle:
                handle.write(RESOLV_VARIANTS[name])
            subprocess.run(["mount", "--bind", variant, "/etc/resolv.conf"], check=True)
            for question in questions:
                cases.append({"question": question, "server": "resolv", "resolv": name, **run(question)})
            subprocess.run(["mount", "--bind", resolv, "/etc/resolv.conf"], check=True)
        version = subprocess.run(["named", "-v"], capture_output=True, text=True).stdout.strip()
        with open(out, "w") as handle:
            json.dump({"named": version, "resolvs": RESOLV_VARIANTS, "cases": cases}, handle)
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
