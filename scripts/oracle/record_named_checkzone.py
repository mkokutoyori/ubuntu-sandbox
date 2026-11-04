#!/usr/bin/env python3
"""Record what the real named-checkzone (BIND 9.18) says about the zone file of banquehorizon.com and 27 variants of it.

usage: record_named_checkzone.py out.json

The base zone is the one of labs/dns-agence-bancaire (record_bind_cache_dump.BANK_ZONE). Each variant breaks it in one way (an unknown type, a bad IPv4 address, text after the
rdata, a CNAME next to other data, no NS, no SOA, a truncated SOA, a bad $TTL, an unterminated string...). The fixture keeps the zone text, the exit code and what the tool printed,
with the path of the temporary file replaced by <file>. Needs the bind9utils package.
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab
BASE = lab.BANK_ZONE
def mutate(old, new):
    assert old in BASE, old
    return BASE.replace(old, new, 1)
VARIANTS = {
  "valid": BASE,
  "unknown-type": mutate("web IN A 203.0.113.20", "web IN AA 203.0.113.20"),
  "bad-ipv4": mutate("web IN A 203.0.113.20", "web IN A 203.0.113.999"),
  "bad-ipv4-short": mutate("web IN A 203.0.113.20", "web IN A 203.0.113"),
  "not-an-address": mutate("web IN A 203.0.113.20", "web IN A not-an-address"),
  "missing-rdata": mutate("web IN A 203.0.113.20", "web IN A"),
  "extra-text-a": mutate("mail IN A 203.0.113.25", "mail IN A 203.0.113.25 oops"),
  "extra-text-cname": mutate("www IN CNAME web", "www IN CNAME web extra"),
  "extra-text-mx": mutate("@ IN MX 10 mail.banquehorizon.com.", "@ IN MX 10 mail.banquehorizon.com. 20"),
  "cname-and-other-data": BASE + "www IN A 203.0.113.21\n",
  "cname-at-apex": BASE + "@ IN CNAME web\n",
  "no-ns": BASE.replace("@ IN NS ns1.banquehorizon.com.\n", "").replace("@ IN NS ns2.banquehorizon.com.\n", ""),
  "no-soa": "\n".join(l for l in BASE.split("\n") if "SOA" not in l),
  "soa-too-short": mutate("( %d 7200 900 1209600 3600 )" % lab.SERIAL, "( %d 7200 900 1209600 )" % lab.SERIAL),
  "mx-missing-exchange": mutate("@ IN MX 20 mail2.banquehorizon.com.", "@ IN MX 20"),
  "mx-to-address": mutate("@ IN MX 10 mail.banquehorizon.com.", "@ IN MX 10 203.0.113.25"),
  "bad-ttl": mutate("$TTL 3600", "$TTL abc"),
  "srv-short": mutate("_imaps._tcp IN SRV 0 1 993 mail", "_imaps._tcp IN SRV 0 1 mail"),
  "out-of-zone-name": BASE + "intrus.example.org. IN A 192.0.2.1\n",
  "bad-aaaa": BASE + "v6 IN AAAA 2001:db8::zz\n",
  "ptr-missing-target": BASE + "p IN PTR\n",
  "txt-unterminated": BASE + 'bad IN TXT "unterminated\n',
  "several-errors": mutate("mail IN A 203.0.113.25", "mail IN A 203.0.113.256").replace("web IN A 203.0.113.20", "web IN AA 203.0.113.20").replace("mail2 IN A 203.0.113.26", "mail2 IN A 203.0.113.26 oops"),
  "multi-line-bad-a": BASE + "w2 IN A (\n   203.0.113.999 )\n",
  "multi-line-extra-text": BASE + "w2 IN A (\n 203.0.113.9\n oops )\n",
  "multi-line-mx-short": BASE + "w2 IN MX (\n 10\n\n )\n",
  "multi-line-soa-short": mutate("@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( %d 7200 900 1209600 3600 )" % lab.SERIAL, "@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. (\n    %d  ; serial\n    7200 ; refresh\n    900  ; retry\n    1209600 ; expire\n    )" % lab.SERIAL),
  "valid-multi-line-soa": mutate("@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( %d 7200 900 1209600 3600 )" % lab.SERIAL, "@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. (\n    %d  ; serial\n    2h ; refresh\n    15m  ; retry\n    2w ; expire\n    1h )" % lab.SERIAL),
}
out = {}
with tempfile.TemporaryDirectory() as d:
    for name, text in VARIANTS.items():
        path = os.path.join(d, "db.test")
        open(path, "w").write(text)
        r = subprocess.run(["named-checkzone", "banquehorizon.com", path], capture_output=True, text=True)
        out[name] = {"zone": text, "rc": r.returncode, "stdout": r.stdout.replace(path, "<file>"), "stderr": r.stderr.replace(path, "<file>")}
        print("==", name, r.returncode); print((r.stdout + r.stderr).replace(path, "<file>").strip())
json.dump({"named-checkzone": subprocess.run(["named-checkzone", "-v"], capture_output=True, text=True).stdout.strip(), "cases": out}, open(sys.argv[1], "w"))
