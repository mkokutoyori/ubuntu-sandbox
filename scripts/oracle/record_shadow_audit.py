#!/usr/bin/env python3
"""Record the audit messages the real shadow tools send (useradd, usermod, userdel, groupadd, groupdel, chpasswd).

usage: record_shadow_audit.py out.json

audit_shim.c is preloaded and replaces libaudit's audit_open/audit_log_acct_message, so each call the tool makes
is printed to stderr as `AUDIT type=<n> op=[..] name=[..] id=<n> ... res=<0|1>`.  Run as root on a throwaway host:
the scenarios really create and delete the accounts zzuser and zzgrp.
"""
import json, os, re, subprocess, sys, tempfile

def main():
    out = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    with tempfile.TemporaryDirectory() as d:
        so = os.path.join(d, "shim.so")
        subprocess.run(["gcc", "-shared", "-fPIC", "-o", so, os.path.join(here, "audit_shim.c")], check=True)
        env = dict(os.environ, LD_PRELOAD=so, LC_ALL="C")
        def run(cmd, stdin=None):
            r = subprocess.run(cmd, capture_output=True, text=True, env=env, input=stdin)
            rows = []
            for line in r.stderr.splitlines():
                m = re.match(r"AUDIT type=(\d+) op=\[(.*)\] name=\[(.*)\] id=(-?\d+) .* res=(\d)$", line)
                if m:
                    rows.append({"type": int(m.group(1)), "op": m.group(2), "name": m.group(3), "id": int(m.group(4)), "res": int(m.group(5))})
            return rows
        scenarios = {}
        scenarios["useradd -m"] = run(["useradd", "-m", "zzuser"])
        scenarios["chpasswd"] = run(["chpasswd"], "zzuser:Xx9!abcdef\n")
        scenarios["usermod -s"] = run(["usermod", "-s", "/bin/bash", "zzuser"])
        scenarios["usermod -L"] = run(["usermod", "-L", "zzuser"])
        scenarios["usermod -U"] = run(["usermod", "-U", "zzuser"])
        scenarios["userdel -r"] = run(["userdel", "-r", "zzuser"])
        scenarios["groupadd"] = run(["groupadd", "zzgrp"])
        scenarios["groupdel"] = run(["groupdel", "zzgrp"])
        scenarios["useradd (no home)"] = run(["useradd", "-M", "zzuser"])
        scenarios["userdel"] = run(["userdel", "zzuser"])
        scenarios["useradd -m -G"] = run(["useradd", "-m", "-G", "sudo", "zzuser"])
        scenarios["userdel -r (member of a group)"] = run(["userdel", "-r", "zzuser"])
    json.dump(scenarios, open(out, "w"), indent=1)
    print({k: len(v) for k, v in scenarios.items()})

main()
