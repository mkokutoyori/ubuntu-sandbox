#!/usr/bin/env python3
"""Record what the stub of a real systemd-resolved (255) answers, and what it keeps, for the questions a workstation of the lab labs/dns-agence-bancaire asks.

usage: record_resolved_stub.py out.json

Run as root inside `unshare -n -m`: the script puts a veth pair under the resolver (resolved refuses to resolve on a host without a routable link), lends the
addresses of the lab to the loopback (root 198.51.100.1, com .2, the two name servers of banquehorizon.com 203.0.113.10 and .11, the resolver 10.20.20.53), starts
the five named instances of record_bind_cache_dump.py and systemd-resolved with DNS=10.20.20.53, then asks the stub on 127.0.0.53 the questions of STEPS, waiting
DELAY seconds before the ones marked "again" so that the decay of the TTL of a cached answer is what is recorded. /etc/hosts is replaced by a bind mount.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab

DELAY = 5
HOSTS = "127.0.0.1 localhost\n10.20.20.99 printer.horizon.local printer\n"
RESOLVED_CONF = "[Resolve]\nDNS=10.20.20.53\nDomains=horizon.local\nCache=yes\nDNSStubListener=yes\nLLMNR=no\nMulticastDNS=no\nDNSSEC=no\n"

STEPS = [
    ("www", 0, ["www.banquehorizon.com"]),
    ("www-again", DELAY, ["www.banquehorizon.com"]),
    ("web-direct", 0, ["web.banquehorizon.com"]),
    ("nxdomain", 0, ["nexiste.banquehorizon.com"]),
    ("nxdomain-again", DELAY, ["nexiste.banquehorizon.com"]),
    ("nxdomain-other-type", 0, ["nexiste.banquehorizon.com", "MX"]),
    ("nodata", 0, ["web.banquehorizon.com", "AAAA"]),
    ("nodata-again", DELAY, ["web.banquehorizon.com", "AAAA"]),
    ("alias-nodata", 0, ["ebanking.banquehorizon.com", "AAAA"]),
    ("alias-nodata-again", DELAY, ["ebanking.banquehorizon.com", "AAAA"]),
    ("mx", 0, ["banquehorizon.com", "MX"]),
    ("mx-again", DELAY, ["banquehorizon.com", "MX"]),
    ("txt", 0, ["banquehorizon.com", "TXT"]),
    ("ns", 0, ["banquehorizon.com", "NS"]),
    ("soa", 0, ["banquehorizon.com", "SOA"]),
    ("srv", 0, ["_imaps._tcp.banquehorizon.com", "SRV"]),
    ("ptr", 0, ["-x", "203.0.113.20"]),
    ("ptr-again", DELAY, ["-x", "203.0.113.20"]),
    ("long-ttl", 0, ["a.root-servers.net"]),
    ("long-ttl-again", DELAY, ["a.root-servers.net"]),
    ("localhost", 0, ["localhost"]),
    ("hosts-name", 0, ["printer.horizon.local"]),
    ("hosts-name-other-family", 0, ["printer.horizon.local", "AAAA"]),
    ("hosts-name-mx", 0, ["printer.horizon.local", "MX"]),
]

ROW = re.compile(r"^(\S+)\s+(\d+)\s+IN\s+(\S+)\s+(.*)$")


def parse(output):
    result = {"status": None, "flags": [], "edns": None, "answer": [], "authority": [], "additional": []}
    section = None
    for line in output.splitlines():
        header = re.search(r"status: (\w+)", line)
        if header:
            result["status"] = header.group(1)
        flags = re.match(r";; flags: ([a-z ]*);", line)
        if flags:
            result["flags"] = flags.group(1).split()
        edns = re.match(r"; EDNS: version: (\d+), flags:([a-z ]*); udp: (\d+)", line)
        if edns:
            result["edns"] = {"version": int(edns.group(1)), "flags": edns.group(2).split(), "udp": int(edns.group(3))}
        marker = re.match(r";; (ANSWER|AUTHORITY|ADDITIONAL) SECTION:", line)
        if marker:
            section = marker.group(1).lower()
            continue
        if not line.strip() or line.startswith(";"):
            continue
        row = ROW.match(line)
        if row and section:
            result[section].append({"name": row.group(1), "ttl": int(row.group(2)), "type": row.group(3), "rdata": row.group(4).strip()})
    return result


def ask(arguments):
    run = subprocess.run(["dig", "@127.0.0.53", *arguments, "+time=5", "+tries=1"], capture_output=True, text=True)
    return parse(run.stdout)


def main():
    out = sys.argv[1]
    for command in (["ip", "link", "set", "lo", "up"], ["ip", "link", "add", "eth0", "type", "veth", "peer", "name", "eth1"],
                    ["ip", "addr", "add", "10.20.10.52/24", "dev", "eth0"], ["ip", "link", "set", "eth0", "up"], ["ip", "link", "set", "eth1", "up"]):
        subprocess.run(command, check=True)
    subprocess.run(["ip", "route", "add", "default", "via", "10.20.10.1", "dev", "eth0", "onlink"])
    root = tempfile.mkdtemp()
    os.chmod(root, 0o777)
    hosts = os.path.join(root, "hosts")
    with open(hosts, "w") as handle:
        handle.write(HOSTS)
    subprocess.run(["mount", "--bind", hosts, "/etc/hosts"], check=True)
    for address in lab.ADDRESSES:
        subprocess.run(["ip", "addr", "add", f"{address}/32", "dev", "lo"], check=True)
    processes = []
    resolved = None
    try:
        for name, address, control, zones in [
            ("root", "198.51.100.1", 9532, [(".", "db.root", lab.ROOT_ZONE)]),
            ("com", "198.51.100.2", 9533, [("com", "db.com", lab.COM_ZONE)]),
            ("ns1", "203.0.113.10", 9534, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
            ("ns2", "203.0.113.11", 9535, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
        ]:
            processes.append(lab.instance(root, name, address, control, False, zones)[1])
        processes.append(lab.instance(root, "res", "10.20.20.53", 9531, True, [(".", "db.hints", lab.HINTS)], hints=True)[1])
        time.sleep(2)
        os.makedirs("/etc/systemd/resolved.conf.d", exist_ok=True)
        os.makedirs("/run/systemd/resolve", exist_ok=True)
        with open("/etc/systemd/resolved.conf.d/lab.conf", "w") as handle:
            handle.write(RESOLVED_CONF)
        subprocess.run(["chown", "systemd-resolve:systemd-resolve", "/run/systemd/resolve"])
        resolved = subprocess.Popen(["/usr/lib/systemd/systemd-resolved"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)
        recorded = []
        for label, delay, arguments in STEPS:
            time.sleep(delay)
            recorded.append({"label": label, "delay": delay, "arguments": arguments, "reply": ask(arguments)})
        version = subprocess.run(["/usr/lib/systemd/systemd-resolved", "--version"], capture_output=True, text=True).stdout.strip() or "systemd-resolved 255"
        with open(out, "w") as handle:
            json.dump({"resolved": version, "delay": DELAY, "steps": recorded}, handle, indent=1)
        print(len(recorded), "steps")
    finally:
        if resolved is not None:
            resolved.terminate()
            resolved.wait()
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait()
        subprocess.run(["umount", "/etc/hosts"], capture_output=True)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
