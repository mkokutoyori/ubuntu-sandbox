#!/usr/bin/env python3
"""Record the real augenrules script (auditd 3.1.2) over a temporary rules tree.

usage: record_augenrules.py AUDIT_ROOT out.json

The local awk is mawk 1.3.4-20240123, the awk of Ubuntu 24.04, which reads the script's \\s as a literal s.

The script is the one shipped in the Ubuntu package; only its absolute paths are rewritten to a temporary
directory and /sbin/auditctl is replaced by a stub that prints its arguments and exits with the code in
STUB_RC, so that what is compared is the compiled /etc/audit/audit.rules, the .prev copy, stdout, stderr and
the exit status.
"""
import json, os, random, shutil, subprocess, sys, tempfile

LINES = ["-D", "-D", "-b 8192", "-b 320", "-f 1", "-f 2", "-e 1", "-e 2", "-e 2 ", "--backlog_wait_time 60000", "-w /etc/passwd -p wa -k identity", "-w /etc/shadow -p wa -k identity",
         "-a always,exit -F arch=b64 -S execve -k exec", "-a never,exit -F dir=/tmp", "-D -k nothing", "  -b 1024", "\t-f 0", "# comment", "   # indented comment", "", "  ", "-r 100",
         "-a always,exit -S all -F dir=/var/log -k logs", "-e 0", "-d always,exit -S open", "-D  ", "-D\r", "-w /etc/hosts -p r\r"]
NAMES = ["audit.rules", "10-base.rules", "20-custom.rules", "9-early.rules", "100-late.rules", "30-notrules.conf", "readme.txt", "40-x.rules.bak", "05-first.rules"]

def run(script, root, args, rc):
    env = dict(os.environ, STUB_RC=str(rc), LC_ALL="C")
    p = subprocess.run(["sh", script] + args, capture_output=True, env=env)
    return p.stdout.decode(), p.stderr.decode(), p.returncode

def main():
    audit_root, out = sys.argv[1], sys.argv[2]
    src = open(os.path.join(audit_root, "usr/sbin/augenrules")).read()
    rnd = random.Random(20260617)
    scenarios = []
    for index in range(400):
        work = tempfile.mkdtemp()
        etc = os.path.join(work, "etc/audit")
        os.makedirs(os.path.join(etc, "rules.d"))
        tmpdir = os.path.join(work, "tmp")
        os.makedirs(tmpdir)
        stub = os.path.join(work, "auditctl")
        open(stub, "w").write('#!/bin/sh\necho "auditctl $*"\nexit ${STUB_RC:-0}\n')
        os.chmod(stub, 0o755)
        text = (src.replace("/etc/audit/audit.rules", etc + "/audit.rules").replace("/etc/audit/rules.d", etc + "/rules.d")
                .replace("/sbin/auditctl", stub).replace("mktemp /tmp/aurules.XXXXXXXX", "mktemp " + tmpdir + "/aurules.XXXXXXXX"))
        script = os.path.join(work, "augenrules.sh")
        open(script, "w").write(text)
        files = {}
        if index % 25 != 0:
            for name in rnd.sample(NAMES, rnd.randint(0, 5)):
                files[name] = "\n".join(rnd.choice(LINES) for _ in range(rnd.randint(0, 8))) + rnd.choice(["\n", ""])
        else:
            shutil.rmtree(os.path.join(etc, "rules.d"))
        for name, body in files.items():
            open(os.path.join(etc, "rules.d", name), "w", newline="").write(body)
        existing = None
        mode = index % 4
        if mode == 1:
            existing = "old content\n"
        elif mode == 2:
            args0 = [] 
            run(script, work, args0, 0)
            existing = open(os.path.join(etc, "audit.rules"), newline='').read() if os.path.exists(os.path.join(etc, "audit.rules")) else None
        if existing is not None:
            open(os.path.join(etc, "audit.rules"), "w", newline="").write(existing)
        elif os.path.exists(os.path.join(etc, "audit.rules")):
            os.remove(os.path.join(etc, "audit.rules"))
        argv = rnd.choice([[], ["--check"], ["--load"], ["--check", "--load"], ["--bogus"], ["--load", "--load"], ["--load"]])
        rc = rnd.choice([0, 0, 0, 1, 255])
        stdout, stderr, code = run(script, work, argv, rc)
        norm = lambda text: text.replace(etc, "/etc/audit").replace(stub, "/sbin/auditctl").replace(script, "augenrules").replace(work, "")
        read = lambda name: norm(open(os.path.join(etc, name), newline='').read()) if os.path.exists(os.path.join(etc, name)) else None
        result = {"files": files, "rulesDirExists": os.path.isdir(os.path.join(etc, "rules.d")), "existing": norm(existing) if existing is not None else None, "args": argv, "stubRc": rc,
                  "stdout": norm(stdout), "stderr": norm(stderr), "code": code,
                  "rules": read("audit.rules"),
                  "prev": read("audit.rules.prev"),
                  "mode": oct(os.stat(os.path.join(etc, "audit.rules")).st_mode & 0o777) if os.path.exists(os.path.join(etc, "audit.rules")) else None}
        scenarios.append(result)
        shutil.rmtree(work)
    json.dump({"scenarios": scenarios}, open(out, "w"))

main()
