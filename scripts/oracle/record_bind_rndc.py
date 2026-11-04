#!/usr/bin/env python3
"""Record what a real BIND 9.18 answers to the rndc commands that act on zones and on the cache, and to the CHAOS names that identify it.

usage: record_bind_rndc.py out.json

Two parts, in a network namespace (unshare -n) with the lab of record_bind_cache_dump.py:
- "primary": NS1-BANK alone. `rndc reload banquehorizon.com` with the file unchanged, then after a record was appended WITHOUT raising the serial (the record is served: named compares the file,
  not the serial), then again; `rndc reload` alone, an unknown zone, a file broken after it was loaded (the answer of rndc and what the server keeps serving) then repaired, `rndc zonestatus`, `rndc flushname` on an authoritative name, version.bind and hostname.bind.
- "cache": the resolver asked four questions (a CNAME, an A, an NXDOMAIN, a PTR), its cache dumped, then `rndc flushname www.banquehorizon.com`, a name that is not cached, `rndc flushtree
  banquehorizon.com` and `rndc flushname` without argument, the cache dumped after each. Needs root, bind9, dnsutils.
"""
import json, os, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab


def rndc_in(config):
    def run(*arguments):
        result = subprocess.run(["rndc", "-c", config, *arguments], capture_output=True, text=True)
        return (result.stdout + result.stderr).strip()
    return run


def primary(base):
    root = tempfile.mkdtemp(dir=base)
    os.chmod(root, 0o777)
    directory, process = lab.instance(root, "ns1", "203.0.113.10", 9534, False, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)])
    lab.write(root, "rndc.conf", lab.KEY + '\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9534; };\n')
    config = os.path.join(root, "rndc.conf")
    run = rndc_in(config)
    for _ in range(100):
        if subprocess.run(["rndc", "-c", config, "status"], capture_output=True).returncode == 0:
            break
        time.sleep(0.1)
    time.sleep(2)

    def dig(*arguments):
        return subprocess.run(["dig", "@203.0.113.10", *arguments, "+short"], capture_output=True, text=True).stdout.strip()

    out = {"reload-unchanged": run("reload", "banquehorizon.com")}
    with open(os.path.join(directory, "db.bank"), "a") as handle:
        handle.write("novelty IN A 203.0.113.77\n")
    time.sleep(1.2)
    out["reload-without-serial"] = run("reload", "banquehorizon.com")
    time.sleep(1)
    out["novelty-after-reload"] = dig("novelty.banquehorizon.com")
    out["reload-again"] = run("reload", "banquehorizon.com")
    out["reload-all"] = run("reload")
    out["reload-unknown-zone"] = run("reload", "nozone.example")
    good = open(os.path.join(directory, "db.bank")).read()
    with open(os.path.join(directory, "db.bank"), "w") as handle:
        handle.write(good.replace("mail IN A 203.0.113.25", "mail IN A 203.0.113.25 oops"))
    time.sleep(1.2)
    out["reload-broken"] = run("reload", "banquehorizon.com")
    time.sleep(1)
    out["served-after-broken-reload"] = dig("mail.banquehorizon.com")
    out["reload-broken-again"] = run("reload", "banquehorizon.com")
    with open(os.path.join(directory, "db.bank"), "w") as handle:
        handle.write(good)
    time.sleep(1.2)
    out["reload-fixed"] = run("reload", "banquehorizon.com")
    out["zonestatus"] = run("zonestatus", "banquehorizon.com")
    out["flushname-authoritative"] = run("flushname", "banquehorizon.com")
    out["version.bind"] = dig("version.bind", "CHAOS", "TXT")
    out["hostname.bind"] = dig("hostname.bind", "CHAOS", "TXT")
    out["status-first-line"] = run("status").split("\n")[0]
    process.terminate()
    process.wait()
    return out


def hidden_version(base):
    out = {}
    for label, option in (("string", 'version "hidden";'), ("none", "version none;")):
        root = tempfile.mkdtemp(dir=base)
        os.chmod(root, 0o777)
        directory, process = lab.instance(root, "ns1", "203.0.113.10", 9534, False, [("banquehorizon.com", "db.bank", lab.BANK_ZONE)], extra=option)
        for _ in range(100):
            probe = subprocess.run(["dig", "@203.0.113.10", "banquehorizon.com", "SOA", "+norecurse", "+noall", "+comments", "+time=1", "+tries=1"], capture_output=True, text=True)
            if "flags: qr aa" in probe.stdout:
                break
            time.sleep(0.1)
        answer = subprocess.run(["dig", "@203.0.113.10", "version.bind", "CHAOS", "TXT", "+noall", "+comments", "+answer"], capture_output=True, text=True).stdout
        out[label] = [line for line in answer.split("\n") if line.startswith(";; ->>HEADER") is False and (line.startswith("version.bind") or "status:" in line or line.startswith(";; flags"))]
        status = subprocess.run(["dig", "@203.0.113.10", "version.bind", "CHAOS", "TXT", "+noall", "+comments"], capture_output=True, text=True).stdout
        out[label + "-status"] = [word.rstrip(",") for line in status.split("\n") if "status:" in line for word in line.split() if word.rstrip(",") in ("NOERROR", "REFUSED", "NXDOMAIN", "SERVFAIL")]
        process.terminate()
        process.wait()
    return out


def cache(base):
    root = tempfile.mkdtemp(dir=base)
    os.chmod(root, 0o777)
    processes = []
    for name, address, control, zones in [
        ("root", "198.51.100.1", 9532, [(".", "db.root", lab.ROOT_ZONE)]),
        ("com", "198.51.100.2", 9533, [("com", "db.com", lab.COM_ZONE)]),
        ("ns1", "203.0.113.10", 9534, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
        ("ns2", "203.0.113.11", 9535, [("banquehorizon.com", "db.bank", lab.BANK_ZONE), ("113.0.203.in-addr.arpa", "db.rev", lab.REVERSE_ZONE)]),
    ]:
        processes.append(lab.instance(root, name, address, control, False, zones)[1])
    directory, resolver = lab.instance(root, "res", "10.20.20.53", 9531, True, [(".", "db.hints", lab.HINTS)], hints=True)
    processes.append(resolver)
    lab.write(root, "rndc.conf", lab.KEY + '\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9531; };\n')
    config = os.path.join(root, "rndc.conf")
    run = rndc_in(config)
    for _ in range(100):
        if subprocess.run(["rndc", "-c", config, "status"], capture_output=True).returncode == 0:
            break
        time.sleep(0.1)
    time.sleep(2)
    dump_file = os.path.join(directory, "named_dump.db")

    def dump():
        if os.path.exists(dump_file):
            os.remove(dump_file)
        run("dumpdb", "-cache")
        time.sleep(0.5)
        with open(dump_file) as handle:
            return handle.read()

    for question in (["www.banquehorizon.com"], ["mail.banquehorizon.com"], ["nexiste.banquehorizon.com"], ["-x", "203.0.113.20"]):
        subprocess.run(["dig", "@10.20.20.53", *question], capture_output=True)
    out = {"questions": ["www.banquehorizon.com", "mail.banquehorizon.com", "nexiste.banquehorizon.com", "-x 203.0.113.20"], "dump-before": dump()}
    out["flushname-result"] = run("flushname", "www.banquehorizon.com")
    out["dump-after-flushname"] = dump()
    out["flushname-uncached-result"] = run("flushname", "absent.banquehorizon.com")
    out["flushtree-result"] = run("flushtree", "banquehorizon.com")
    out["dump-after-flushtree"] = dump()
    out["flushname-without-argument"] = run("flushname")
    out["flushtree-without-argument"] = run("flushtree")
    for process in processes:
        process.terminate()
    for process in processes:
        process.wait()
    return out


def main():
    destination = sys.argv[1]
    base = tempfile.mkdtemp()
    os.chmod(base, 0o777)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=False)
    for address in lab.ADDRESSES:
        subprocess.run(["ip", "addr", "add", f"{address}/32", "dev", "lo"], check=True)
    version = subprocess.run(["named", "-v"], capture_output=True, text=True).stdout.strip()
    with open(destination, "w") as handle:
        json.dump({"named": version, "primary": primary(base), "version-option": hidden_version(base), "cache": cache(base)}, handle)


if __name__ == "__main__":
    main()
