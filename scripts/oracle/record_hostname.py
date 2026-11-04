#!/usr/bin/env python3
"""Record what the real hostname 3.23 (Debian/Ubuntu `hostname` package, also installed as domainname, dnsdomainname, ypdomainname and nisdomainname) prints, writes and refuses.

usage: record_hostname.py out.json

Each scenario runs in its own user-visible UTS, mount and network namespace (unshare -u -m -n, needs root): the host name and the NIS domain name are set with the real
binary's own system calls, /etc/hosts, /etc/nsswitch.conf and /etc/resolv.conf are bind-mounted from files of the scenario, and the interfaces are bridges (a kernel
without the dummy driver still accepts them) given the addresses of the scenario. Some scenarios also start a one-socket DNS responder on a loopback address, which is how
the `dns` source of nsswitch.conf is exercised without a name server package. A run is (program name, argv, uid) -> (stdout, stderr, status); runs are replayed in order, so
the ones that set a name come after the ones that read it. Needs root and the `hostname` package; python3 -I recommended.
"""
import json, os, socket, struct, subprocess, sys, tempfile, threading

PROGRAMS = {
    "hostname": "/usr/bin/hostname",
    "domainname": "/usr/bin/hostname",
    "dnsdomainname": "/usr/bin/hostname",
    "ypdomainname": "/usr/bin/hostname",
    "nisdomainname": "/usr/bin/hostname",
}

NOBODY = 65534

LOCALHOST_V4 = ["127.0.0.1 localhost"]
LOCALHOST_V6 = ["::1 localhost ip6-localhost ip6-loopback", "ff02::1 ip6-allnodes", "ff02::2 ip6-allrouters"]

SHOW_OPTIONS = [
    [], ["-s"], ["--short"], ["-f"], ["--fqdn"], ["--long"], ["-d"], ["--domain"], ["-a"], ["--alias"], ["-i"], ["--ip-address"],
    ["-I"], ["--all-ip-addresses"], ["-A"], ["--all-fqdns"], ["-y"], ["--yp"], ["--nis"],
]

USAGE_RUNS = [
    ["-V"], ["--version"], ["-h"], ["--help"], ["-?"], ["-x"], ["--bogus"], ["--s"], ["--a"], ["--f"], ["--l"], ["--lo"], ["--ver"],
    ["--version=1"], ["-F"], ["--file"], ["--fil"], ["-sf"], ["-fs"], ["-i", "-s"], ["-d", "-f"], ["--"], ["--", "-s"], ["-s", "--"],
    ["a", "b"], ["-s", "extra"], ["-f", "extra"], ["-F", "/nonexistent/hostname", "extra"], ["-bd"], ["-b"], ["-V", "-x"], ["-x", "-V"],
    ["-h", "-V"], ["-ab"],
]


def hostnames_files():
    return {
        "/tmp/hn/plain": "newhost\n",
        "/tmp/hn/commented": "# the name of this machine\n\n# another comment\nfrom-file.example\nignored\n",
        "/tmp/hn/blank-first": "\n\nafter-blank\n",
        "/tmp/hn/empty": "",
        "/tmp/hn/only-comments": "# nothing\n# here\n",
        "/tmp/hn/no-newline": "no-newline",
        "/tmp/hn/spaces": "  padded-name  \n",
        "/tmp/hn/invalid": "under_score\n",
        "/tmp/hn/domain": "nis.example\n",
        "/tmp/hn/crlf": "crlf-name\r\n",
    }


SET_RUNS = [
    ("hostname", ["newhost"], 0), ("hostname", [], 0), ("hostname", ["-s"], 0), ("hostname", ["-f"], 0),
    ("hostname", ["a1.B2-c3.example"], 0), ("hostname", [], 0),
    ("hostname", ["under_score"], 0), ("hostname", ["-leading"], 0), ("hostname", ["trailing-"], 0), ("hostname", ["a..b"], 0),
    ("hostname", ["a.-b"], 0), ("hostname", ["a-.b"], 0), ("hostname", [".lead"], 0), ("hostname", ["trail."], 0), ("hostname", [""], 0),
    ("hostname", ["   "], 0), ("hostname", ["  spaced  "], 0), ("hostname", ["has space"], 0), ("hostname", ["UPPER"], 0), ("hostname", ["3com"], 0),
    ("hostname", ["a" * 64], 0), ("hostname", ["a" * 65], 0), ("hostname", ["a" * 63 + "." + "b" * 63], 0), ("hostname", [], 0),
    ("hostname", ["-F", "/tmp/hn/plain"], 0), ("hostname", ["--file", "/tmp/hn/commented"], 0), ("hostname", ["-F", "/tmp/hn/blank-first"], 0),
    ("hostname", ["-F", "/tmp/hn/empty"], 0), ("hostname", ["-F", "/tmp/hn/only-comments"], 0), ("hostname", ["-F", "/tmp/hn/no-newline"], 0),
    ("hostname", ["-F", "/tmp/hn/spaces"], 0), ("hostname", ["-F", "/tmp/hn/invalid"], 0), ("hostname", ["-F", "/tmp/hn/crlf"], 0),
    ("hostname", ["-F", "/nonexistent/file"], 0), ("hostname", ["-b", "-F", "/nonexistent/file"], 0), ("hostname", ["-b", "-F", "/tmp/hn/empty"], 0),
    ("hostname", ["-b", "-F", "/tmp/hn/only-comments"], 0), ("hostname", ["-b", "-F", "/tmp/hn/plain"], 0), ("hostname", ["-F", "/tmp/hn"], 0),
    ("hostname", ["-b", "-F", "/tmp/hn"], 0), ("hostname", ["-F", "/tmp/hn/plain", "name"], 0), ("hostname", ["name", "-F", "/tmp/hn/plain"], 0),
    ("hostname", ["-b", "boot-name"], 0), ("hostname", ["-s", "name"], 0), ("hostname", ["-d", "name"], 0), ("hostname", ["-i", "name"], 0),
    ("hostname", ["-F", "/tmp/hn/plain", "-s"], 0), ("hostname", ["-s", "-F", "/tmp/hn/plain"], 0), ("hostname", [], 0),
    ("hostname", ["--", "dashdash"], 0), ("hostname", ["-F", "/tmp/hn/plain", "--", "extra"], 0), ("hostname", [], 0),
    ("hostname", ["newhost"], NOBODY), ("hostname", ["under_score"], NOBODY), ("hostname", ["-F", "/tmp/hn/plain"], NOBODY), ("hostname", ["a" * 65], NOBODY),
    ("hostname", [], NOBODY), ("hostname", ["-s"], NOBODY), ("hostname", ["-y", "nis.example"], NOBODY), ("hostname", ["-y"], NOBODY),
]

NIS_RUNS = [
    ("domainname", [], 0), ("hostname", ["-y"], 0), ("hostname", ["--yp"], 0), ("hostname", ["--nis"], 0), ("ypdomainname", [], 0), ("nisdomainname", [], 0),
    ("domainname", ["-d"], 0), ("domainname", ["-V"], 0), ("domainname", ["-h"], 0), ("domainname", ["-x"], 0), ("domainname", ["-f"], 0),
    ("domainname", ["-s"], 0), ("domainname", ["-i"], 0), ("domainname", ["-a"], 0), ("domainname", ["-I"], 0), ("domainname", ["-A"], 0),
    ("domainname", ["-y"], 0), ("ypdomainname", ["-y"], 0), ("nisdomainname", ["-d"], 0), ("ypdomainname", ["-s"], 0),
    ("domainname", ["nis.example"], 0), ("domainname", [], 0), ("hostname", ["-y"], 0), ("ypdomainname", [], 0), ("nisdomainname", [], 0),
    ("hostname", ["-s"], 0), ("hostname", ["-d"], 0), ("hostname", [], 0),
    ("domainname", ["under_score"], 0), ("domainname", [], 0), ("domainname", ["-leading"], 0), ("domainname", ["  spaced  "], 0), ("domainname", [], 0),
    ("domainname", ["a" * 64], 0), ("domainname", ["a" * 65], 0), ("domainname", ["a" * 63 + "." + "b" * 63], 0), ("domainname", [], 0),
    ("domainname", [""], 0), ("domainname", [], 0), ("domainname", ["(none)"], 0), ("domainname", [], 0), ("hostname", ["-y"], 0), ("ypdomainname", [], 0),
    ("domainname", ["-F", "/tmp/hn/domain"], 0), ("domainname", [], 0), ("ypdomainname", ["-F", "/tmp/hn/plain"], 0), ("nisdomainname", [], 0),
    ("domainname", ["-F", "/tmp/hn/empty"], 0), ("domainname", [], 0), ("domainname", ["-b", "-F", "/tmp/hn/empty"], 0), ("domainname", [], 0),
    ("domainname", ["-F", "/nonexistent/file"], 0), ("domainname", ["-b", "-F", "/nonexistent/file"], 0), ("domainname", [], 0),
    ("domainname", ["-F", "/tmp/hn/domain", "extra"], 0), ("domainname", ["one", "two"], 0), ("domainname", [], 0),
    ("hostname", ["-y", "another.example"], 0), ("hostname", ["--nis", "third.example"], 0), ("domainname", [], 0), ("hostname", ["-y", "-F", "/tmp/hn/plain"], 0),
    ("domainname", [], 0),
    ("domainname", ["x.example"], NOBODY), ("domainname", ["under_score"], NOBODY), ("domainname", [], NOBODY), ("ypdomainname", ["x.example"], NOBODY),
    ("domainname", ["a" * 65], NOBODY), ("domainname", ["-F", "/tmp/hn/domain"], NOBODY), ("domainname", [], NOBODY),
    ("dnsdomainname", [], 0), ("dnsdomainname", ["-f"], 0), ("dnsdomainname", ["-s"], 0), ("dnsdomainname", ["-y"], 0), ("dnsdomainname", ["-i"], 0),
    ("dnsdomainname", ["-a"], 0), ("dnsdomainname", ["-I"], 0), ("dnsdomainname", ["-A"], 0), ("dnsdomainname", ["-d"], 0), ("dnsdomainname", ["-V"], 0),
    ("dnsdomainname", ["-h"], 0), ("dnsdomainname", ["-x"], 0), ("dnsdomainname", ["name"], 0), ("dnsdomainname", ["-F", "/tmp/hn/plain"], 0),
    ("dnsdomainname", ["-b", "-F", "/tmp/hn/plain"], 0), ("dnsdomainname", ["a", "b"], 0),
]


def scenarios():
    both = LOCALHOST_V4 + LOCALHOST_V6
    return [
        {
            "name": "full-names", "hostname": "srv1.corp.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["127.0.1.1 srv1.corp.example srv1 alias1 alias2", "10.1.1.5 srv1-lan.corp.example", "192.168.7.9 srv1-mgmt.corp.example"] + LOCALHOST_V6,
            "interfaces": [
                {"name": "br0", "addrs": ["10.1.1.5/24"], "up": True},
                {"name": "br1", "addrs": ["192.168.7.9/24", "192.168.7.10/24"], "up": True},
                {"name": "br2", "addrs": ["172.16.0.1/16"], "up": False},
                {"name": "br3", "addrs": [], "up": True},
            ],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS] + [("hostname", a, 0) for a in USAGE_RUNS] + [("dnsdomainname", [], 0), ("domainname", [], 0), ("ypdomainname", [], 0)],
        },
        {
            "name": "no-domain", "hostname": "plain", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["127.0.1.1 plain"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.2.2.2/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS] + [("dnsdomainname", [], 0), ("domainname", [], 0)],
        },
        {
            "name": "unresolvable", "hostname": "ghost", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.3.3.3/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS] + [("dnsdomainname", [], 0), ("hostname", ["-F", "/tmp/hn/plain"], 0), ("hostname", [], 0)],
        },
        {
            "name": "several-addresses", "hostname": "multi.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["192.0.2.1 multi.example", "192.0.2.2 multi.example m2", "10.0.0.1 other.example multi.example m3"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["192.0.2.100/24", "10.0.0.100/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS],
        },
        {
            "name": "address-order", "hostname": "order.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["203.0.113.1 order.example", "10.5.5.1 order.example", "198.51.100.7 order.example", "10.5.5.200 order.example", "10.5.5.77 other.example"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.5.5.9/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS],
        },
        {
            "name": "address-order-default-route", "hostname": "order.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["203.0.113.1 order.example", "10.5.5.1 order.example", "198.51.100.7 order.example", "10.5.5.200 order.example", "172.16.9.9 order.example", "192.168.1.1 order.example"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.5.5.9/24", "172.16.9.1/16"], "up": True}],
            "routes": [["default", "via", "10.5.5.254", "dev", "br0", "onlink"]],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS],
        },
        {
            "name": "multi-off", "hostname": "dup.example", "nsswitch": "hosts: files", "host_conf": ["multi off"],
            "hosts": LOCALHOST_V4 + ["2001:db8::7 dup.example", "10.0.0.1 dup.example a1 a2", "10.0.0.2 other.example a3 dup.example", "10.0.0.3 third.example dup.example"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": [("hostname", a, 0) for a in ([], ["-f"], ["-d"], ["-a"], ["-i"])],
        },
        {
            "name": "no-host-conf", "hostname": "dup.example", "nsswitch": "hosts: files", "host_conf": None,
            "hosts": LOCALHOST_V4 + ["10.0.0.1 dup.example a1 a2", "10.0.0.2 other.example a3 dup.example", "10.0.0.3 third.example dup.example"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": [("hostname", a, 0) for a in ([], ["-f"], ["-d"], ["-a"], ["-i"])],
        },
        {
            "name": "multi-on-lines", "hostname": "dup.example", "nsswitch": "hosts: files", "host_conf": ["multi on"],
            "hosts": LOCALHOST_V4 + ["10.0.0.1 dup.example a1 a2", "10.0.0.2 other.example a3 dup.example", "10.0.0.3 third.example dup.example", "10.0.0.4 dup.example al", "10.0.0.5 dup.example al", "10.0.0.5 Dup.Example"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": [("hostname", a, 0) for a in ([], ["-f"], ["-d"], ["-a"], ["-i"])],
        },
        {
            "name": "hostname-is-an-alias", "hostname": "alias1", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["10.9.9.9 canon.example.org alias1 alias2 Alias3"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.9.9.9/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS] + [("dnsdomainname", [], 0)],
        },
        {
            "name": "upper-case-hostname", "hostname": "Srv.CORP.Example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["10.1.1.1 srv.corp.example SRV"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.1.1.1/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS],
        },
        {
            "name": "ipv6-only", "hostname": "v6host.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["2001:db8::7 v6host.example v6"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS if a not in (["-y"], ["--yp"], ["--nis"])],
        },
        {
            "name": "ipv6-and-ipv4", "hostname": "dual.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["2001:db8::7 dual.example d6", "10.0.0.1 dual.example d4"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS if a not in (["-y"], ["--yp"], ["--nis"])],
        },
        {
            "name": "dns-refused", "hostname": "short", "nsswitch": "hosts: files dns",
            "hosts": LOCALHOST_V4 + LOCALHOST_V6,
            "resolv": ["nameserver 10.77.77.77", "search corp.example", "options timeout:1 attempts:1"],
            "interfaces": [{"name": "br0", "addrs": ["10.1.1.5/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS if a not in (["-y"], ["--yp"], ["--nis"])],
        },
        {
            "name": "dns-no-route", "hostname": "short", "nsswitch": "hosts: files dns",
            "hosts": LOCALHOST_V4 + LOCALHOST_V6,
            "resolv": ["nameserver 192.0.2.77", "options timeout:1 attempts:1"],
            "interfaces": [{"name": "br0", "addrs": ["10.1.1.5/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS if a not in (["-y"], ["--yp"], ["--nis"])],
        },
        {
            "name": "loopback-line", "hostname": "lo.example", "nsswitch": "hosts: files",
            "hosts": ["127.0.0.1 localhost lo.example"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS],
        },
        {
            "name": "set-names", "hostname": "before.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["127.0.1.1 before.example"] + LOCALHOST_V6,
            "interfaces": [{"name": "br0", "addrs": ["10.4.4.4/24"], "up": True}],
            "runs": SET_RUNS,
        },
        {
            "name": "nis-domain", "hostname": "nis1.example", "nsswitch": "hosts: files",
            "hosts": LOCALHOST_V4 + ["127.0.1.1 nis1.example"] + LOCALHOST_V6,
            "interfaces": [],
            "runs": NIS_RUNS,
        },
        {
            "name": "dns", "hostname": "short", "nsswitch": "hosts: files dns",
            "hosts": both,
            "resolv": ["nameserver 10.53.53.53", "search corp.example"],
            "dns": {
                "A": {"short.corp.example": ["10.20.30.40"], "app.corp.example": ["10.20.30.41"], "real.corp.example": ["10.20.30.41"], "multi.corp.example": ["10.20.30.50", "10.20.30.51"]},
                "CNAME": {"app.corp.example": "real.corp.example"},
                "PTR": {"5.1.1.10.in-addr.arpa": "short-lan.corp.example", "9.7.168.192.in-addr.arpa": "short-mgmt.corp.example"},
            },
            "interfaces": [{"name": "br0", "addrs": ["10.1.1.5/24"], "up": True}, {"name": "br1", "addrs": ["192.168.7.9/24"], "up": True}],
            "runs": [("hostname", a, 0) for a in SHOW_OPTIONS] + [("hostname", ["app"], 0)] + [("hostname", a, 0) for a in SHOW_OPTIONS] + [("hostname", ["app.corp.example"], 0)] + [("hostname", a, 0) for a in SHOW_OPTIONS] + [("hostname", ["multi"], 0)] + [("hostname", a, 0) for a in SHOW_OPTIONS] + [("hostname", ["ghost"], 0)] + [("hostname", a, 0) for a in SHOW_OPTIONS] + [("dnsdomainname", [], 0)],
        },
    ]


def dns_server(table, stop):
    def encode(name):
        return b"".join(bytes([len(label)]) + label.encode() for label in name.rstrip(".").split(".")) + b"\0"

    def decode(data, offset):
        labels = []
        while data[offset]:
            labels.append(data[offset + 1: offset + 1 + data[offset]].decode())
            offset += 1 + data[offset]
        return ".".join(labels), offset + 1

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("10.53.53.53", 53))
    sock.settimeout(0.2)
    types = {1: "A", 28: "AAAA", 5: "CNAME", 12: "PTR"}

    def answer(qname, qtype):
        records, target = [], qname
        cname = table.get("CNAME", {}).get(target)
        if cname is not None and qtype != "CNAME":
            records.append((target, 5, encode(cname)))
            target = cname
        if qtype == "A":
            for address in table.get("A", {}).get(target, []):
                records.append((target, 1, socket.inet_aton(address)))
        elif qtype == "AAAA":
            for address in table.get("AAAA", {}).get(target, []):
                records.append((target, 28, socket.inet_pton(socket.AF_INET6, address)))
        elif qtype == "PTR" and target in table.get("PTR", {}):
            records.append((target, 12, encode(table["PTR"][target])))
        known = any(target in table.get(kind, {}) for kind in ("A", "AAAA", "PTR")) or cname is not None
        return records, known

    while not stop.is_set():
        try:
            data, peer = sock.recvfrom(512)
        except socket.timeout:
            continue
        ident, flags, qdcount = struct.unpack(">HHH", data[:6])
        qname, offset = decode(data, 12)
        qtype_number, qclass = struct.unpack(">HH", data[offset: offset + 4])
        qtype = types.get(qtype_number, "?")
        records, known = answer(qname.lower(), qtype)
        rcode = 0 if (records or known) else 3
        message = struct.pack(">HHHHHH", ident, 0x8180 | rcode, 1, len(records), 0, 0) + data[12: offset + 4]
        for owner, kind, rdata in records:
            message += encode(owner) + struct.pack(">HHIH", kind, 1, 60, len(rdata)) + rdata
        sock.sendto(message, peer)
    sock.close()


def run(prog, argv, uid):
    kwargs = {"user": uid} if uid else {}
    process = subprocess.Popen([prog, *argv], executable=PROGRAMS[prog], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, **kwargs)
    stdout, stderr = process.communicate(timeout=30)
    return {"prog": prog, "argv": argv, "uid": uid, "stdout": stdout.decode(), "stderr": stderr.decode(), "rc": process.returncode}


def child(scenario_json, out):
    scenario = json.loads(scenario_json)
    work = tempfile.mkdtemp()
    os.chmod(work, 0o755)
    subprocess.run(["hostname", scenario["hostname"]], check=True)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    for interface in scenario["interfaces"]:
        subprocess.run(["ip", "link", "add", interface["name"], "type", "bridge"], check=True)
        for address in interface["addrs"]:
            subprocess.run(["ip", "addr", "add", address, "dev", interface["name"]], check=True)
        if interface["up"]:
            subprocess.run(["ip", "link", "set", interface["name"], "up"], check=True)
    for route in scenario.get("routes", []):
        subprocess.run(["ip", "route", "add", *route], check=True)
    if "dns" in scenario:
        subprocess.run(["ip", "addr", "add", "10.53.53.53/32", "dev", "lo"], check=True)
    host_conf = scenario.get("host_conf", ["multi on"])
    files = [("/etc/hosts", scenario["hosts"]), ("/etc/nsswitch.conf", [scenario["nsswitch"]]), ("/etc/resolv.conf", scenario.get("resolv", ["options timeout:1 attempts:1"]))]
    files.append(("/etc/host.conf", host_conf if host_conf is not None else []))
    for target, lines in files:
        source = os.path.join(work, target.replace("/", "_"))
        with open(source, "w") as handle:
            handle.write("\n".join(lines) + ("\n" if lines else ""))
        os.chmod(source, 0o644)
        subprocess.run(["mount", "--bind", source, target], check=True)
    os.makedirs("/tmp/hn", exist_ok=True)
    os.chmod("/tmp/hn", 0o755)
    for path, content in hostnames_files().items():
        with open(path, "w") as handle:
            handle.write(content)
        os.chmod(path, 0o644)
    stop = threading.Event()
    server = None
    if "dns" in scenario:
        server = threading.Thread(target=dns_server, args=(scenario["dns"], stop), daemon=True)
        server.start()
    runs = [run(prog, argv, uid) for prog, argv, uid in scenario["runs"]]
    stop.set()
    if server:
        server.join()
    with open(out, "w") as handle:
        json.dump(runs, handle)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--child":
        child(sys.argv[2], sys.argv[3])
        return
    out = sys.argv[1]
    recorded = []
    here = os.path.abspath(__file__)
    for scenario in scenarios():
        scratch = tempfile.mkdtemp()
        os.chmod(scratch, 0o755)
        target = os.path.join(scratch, "runs.json")
        subprocess.run(["unshare", "-u", "-m", "-n", "--propagation", "private", sys.executable, "-I", here, "--child", json.dumps(scenario), target], check=True)
        with open(target) as handle:
            runs = json.load(handle)
        setup = {key: value for key, value in scenario.items() if key != "runs"}
        setup["files"] = hostnames_files()
        recorded.append({"setup": setup, "runs": runs})
    with open(out, "w") as handle:
        json.dump({"tool": "hostname 3.23+nmu2ubuntu2", "scenarios": recorded}, handle, indent=1, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
