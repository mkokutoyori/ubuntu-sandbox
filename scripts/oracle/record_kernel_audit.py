#!/usr/bin/env python3
"""Record what the real kernel audit subsystem and auditd 3.1.2 write for canonical commands.

usage: record_kernel_audit.py AUDIT_ROOT out.json

Needs root on a host whose kernel has CONFIG_AUDIT.  auditd is started with a RAW-format configuration in a scratch
directory; every scenario flushes the rules, runs `setup`, installs `rules`, runs `command` under bash in the lab
directory, waits for the end-of-event timeout and keeps the records of the events the command produced (the
auditctl bookkeeping events are dropped).  The scenarios mirror the ones replayed against the simulator.
"""
import json, os, re, shutil, subprocess, sys, time

LAB = "/tmp/audit-lab"

SCENARIOS = [
    ("cat watched file", ["-w {lab}/f -p rwxa -k wf"], ["echo data > {lab}/f"], "cat {lab}/f"),
    ("redirect truncate", ["-w {lab}/f -p rwxa -k wf"], ["echo data > {lab}/f"], "echo x > {lab}/f"),
    ("redirect append", ["-w {lab}/f -p rwxa -k wf"], ["echo data > {lab}/f"], "echo x >> {lab}/f"),
    ("touch new in watched dir", ["-w {lab} -p wa -k wd"], [], "touch {lab}/new"),
    ("touch existing", ["-w {lab}/f -p rwxa -k wf"], ["echo data > {lab}/f"], "touch {lab}/f"),
    ("rm watched file", ["-w {lab}/f -p rwxa -k wf"], ["echo data > {lab}/f"], "rm {lab}/f"),
    ("rm in watched dir", ["-w {lab} -p wa -k wd"], ["echo data > {lab}/f"], "rm {lab}/f"),
    ("mkdir in watched dir", ["-w {lab} -p wa -k wd"], [], "mkdir {lab}/d2"),
    ("rmdir in watched dir", ["-w {lab} -p wa -k wd"], ["mkdir {lab}/d2"], "rmdir {lab}/d2"),
    ("mv watched file", ["-w {lab} -p wa -k wd"], ["echo data > {lab}/f"], "mv {lab}/f {lab}/g"),
    ("cp into watched dir", ["-w {lab} -p wa -k wd"], ["echo data > {lab}/f"], "cp {lab}/f {lab}/h"),
    ("chmod watched file", ["-w {lab}/f -p a -k wf"], ["echo data > {lab}/f"], "chmod 600 {lab}/f"),
    ("chown watched file", ["-w {lab}/f -p a -k wf"], ["echo data > {lab}/f"], "chown 1:1 {lab}/f"),
    ("symlink in watched dir", ["-w {lab} -p wa -k wd"], ["echo data > {lab}/f"], "ln -s {lab}/f {lab}/s"),
    ("hardlink in watched dir", ["-w {lab} -p wa -k wd"], ["echo data > {lab}/f"], "ln {lab}/f {lab}/hl"),
    ("truncate watched file", ["-w {lab}/f -p rwxa -k wf"], ["echo data > {lab}/f"], "truncate -s 0 {lab}/f"),
    ("sed -i watched file", ["-w {lab} -p wa -k wd"], ["echo data > {lab}/f"], "sed -i s/data/x/ {lab}/f"),
    ("ls watched dir", ["-w {lab} -p rwxa -k wd"], ["echo data > {lab}/f"], "ls {lab}"),
    ("exec watched binary", ["-w /usr/bin/id -p x -k wx"], [], "id"),
    ("read watched binary", ["-w /usr/bin/id -p r -k wx"], [], "cat /usr/bin/id > /dev/null"),
    ("syscall unlink rule", ["-a always,exit -F arch=b64 -S unlink,unlinkat,rename,renameat -k del"], ["echo data > {lab}/f"], "rm {lab}/f"),
    ("syscall rename rule", ["-a always,exit -F arch=b64 -S unlink,unlinkat,rename,renameat -k del"], ["echo data > {lab}/f"], "mv {lab}/f {lab}/g"),
    ("syscall execve rule", ["-a always,exit -F arch=b64 -S execve -k exec"], [], "id"),
    ("syscall chmod rule", ["-a always,exit -F arch=b64 -S chmod,fchmodat,fchmod -k perm"], ["echo data > {lab}/f"], "chmod 600 {lab}/f"),
    ("syscall failed open rule", ["-a always,exit -F arch=b64 -S open,openat -F success=0 -k fail"], [], "cat {lab}/nonexistent"),
    ("syscall mkdir rule", ["-a always,exit -F arch=b64 -S mkdir,mkdirat -k mk"], [], "mkdir {lab}/d3"),
    ("syscall kill rule", ["-a always,exit -F arch=b64 -S kill -k kl"], [], "kill -0 $$"),
    ("syscall path filter", ["-a always,exit -F arch=b64 -S openat -F path={lab}/f -k pf"], ["echo data > {lab}/f"], "cat {lab}/f"),
    ("syscall dir filter", ["-a always,exit -F arch=b64 -S openat -F dir={lab} -k df"], ["echo data > {lab}/f"], "cat {lab}/f"),
    ("useradd with passwd watch", ["-w /etc/passwd -p wa -k pw", "-w /etc/group -p wa -k gr", "-w /etc/shadow -p wa -k sh"], [], "useradd -m zzaudit"),
    ("userdel with passwd watch", ["-w /etc/passwd -p wa -k pw", "-w /etc/group -p wa -k gr", "-w /etc/shadow -p wa -k sh"], [], "userdel -r zzaudit"),
]

AUDITCTL_CASES = [
    ["-s"], ["-l"], ["-v"], ["-h"], ["-D"], ["-e", "1"], ["-e", "0"], ["-e", "2"], ["-e", "x"], ["-f", "1"], ["-f", "5"], ["-r", "100"], ["-b", "8192"],
    ["-w", "/etc/passwd", "-p", "wa", "-k", "k1"], ["-w", "/etc/passwd", "-p", "rwxa"], ["-w", "/etc/passwd", "-p", "z"], ["-w", "/etc/nosuch", "-p", "w"], ["-w", "relative", "-p", "w"],
    ["-w", "/etc/passwd"], ["-W", "/etc/passwd", "-p", "wa", "-k", "k1"], ["-W", "/etc/none"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-k", "k2"], ["-a", "always,exit", "-S", "open", "-k", "k2"], ["-a", "always,exit", "-F", "arch=b64", "-S", "open,openat", "-F", "success=0", "-k", "k3"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "bogus"], ["-a", "always,exit", "-F", "arch=b64", "-S", "all", "-F", "uid=1000"], ["-a", "never,exit", "-F", "arch=b64", "-S", "all", "-F", "dir=/var"],
    ["-a", "exit,always", "-F", "arch=b64", "-S", "execve", "-k", "e"], ["-a", "task,never"], ["-a", "always,bogus"], ["-a", "always,exit", "-F", "auid>=1000", "-F", "auid!=-1", "-F", "arch=b64", "-S", "execve"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "mount", "-F", "exe=/usr/bin/mount", "-k", "m"], ["-a", "always,exit", "-F", "arch=b32", "-S", "open"], ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-F", "a0=3"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-F", "path=/etc/passwd"], ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-F", "perm=wa"], ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-F", "bogus=1"],
    ["-A", "always,exit", "-F", "arch=b64", "-S", "chmod", "-k", "pre"], ["-d", "always,exit", "-F", "arch=b64", "-S", "chmod", "-k", "pre"], ["-d", "always,exit", "-F", "arch=b64", "-S", "nosuchrule"],
    ["-a", "always,exclude", "-F", "msgtype=CWD"], ["-a", "always,exclude", "-F", "msgtype=BOGUS"], ["-a", "always,user", "-F", "uid=0"], ["-a", "always,filesystem", "-F", "fstype=ext4"],
    ["-k", "orphan"], ["-q", "/etc/passwd,w,/etc/shadow,w"], ["-m", "hello"], ["-C", "uid=euid"], ["-z"], ["--reset-lost"], ["--loginuid-immutable"], ["-t"], ["-i"], ["-S", "open"],
]

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)

def main():
    root, out = sys.argv[1], sys.argv[2]
    lib = root + "/usr/lib/x86_64-linux-gnu"
    env = dict(os.environ, LD_LIBRARY_PATH=lib, LC_ALL="C")
    env.pop("LANG", None)
    sbin = root + "/usr/sbin"
    scratch = "/tmp/audit-oracle"
    shutil.rmtree(scratch, ignore_errors=True)
    os.makedirs(scratch + "/log")
    os.makedirs("/etc/audit/plugins.d", exist_ok=True)
    conf = open("/etc/audit/auditd.conf", "w")
    if conf:
        conf.write("log_file = %s/log/audit.log\nlog_format = RAW\nflush = INCREMENTAL_ASYNC\nfreq = 1\nmax_log_file = 100\nnum_logs = 5\nend_of_event_timeout = 2\nspace_left = 75\nspace_left_action = SYSLOG\nadmin_space_left = 50\nadmin_space_left_action = SUSPEND\ndisk_full_action = SUSPEND\ndisk_error_action = SUSPEND\nlocal_events = yes\nwrite_logs = yes\nlog_group = root\nname_format = NONE\npriority_boost = 4\nmax_log_file_action = ROTATE\nplugin_dir = /etc/audit/plugins.d\n" % scratch)
        conf.close()
    ctl = lambda args: subprocess.run([sbin + "/auditctl", *args], capture_output=True, text=True, env=env)
    ctl(["-D"])
    daemon = subprocess.Popen([sbin + "/auditd", "-f"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    log = scratch + "/log/audit.log"
    result = {"scenarios": [], "auditctl": []}
    for name, rules, setup, command in SCENARIOS:
        ctl(["-D"]); ctl(["-e", "1"])
        shutil.rmtree(LAB, ignore_errors=True); os.makedirs(LAB)
        for s in setup:
            subprocess.run(s.format(lab=LAB), shell=True, cwd=LAB, capture_output=True, env=env)
        time.sleep(0.3)
        size = os.path.getsize(log) if os.path.exists(log) else 0
        for r in rules:
            res = ctl(r.format(lab=LAB).split())
            if res.returncode != 0:
                print("rule failed", name, r, res.stdout, res.stderr)
        tail_marker = os.path.getsize(log) if os.path.exists(log) else 0
        p = subprocess.run(["bash", "-c", command.format(lab=LAB)], cwd=LAB, capture_output=True, text=True, env=env)
        time.sleep(3.2)
        text = open(log).read()[tail_marker:] if os.path.exists(log) else ""
        records = [l for l in text.splitlines() if l and 'comm="auditctl"' not in l and 'comm="sleep"' not in l]
        ids = {re.search(r"audit\(\d+\.\d+:(\d+)\)", l).group(1) for l in records if 'comm="auditctl"' in l}
        keep = []
        drop = {re.search(r"audit\(\d+\.\d+:(\d+)\)", l).group(1) for l in text.splitlines() if 'comm="auditctl"' in l or 'type=CONFIG_CHANGE' in l}
        for l in text.splitlines():
            m = re.search(r"audit\(\d+\.\d+:(\d+)\)", l)
            if m and m.group(1) not in drop:
                keep.append(l)
        result["scenarios"].append({"name": name, "rules": [r.format(lab=LAB) for r in rules], "setup": [s.format(lab=LAB) for s in setup], "command": command.format(lab=LAB), "records": keep,
                                    "stdout": p.stdout, "stderr": p.stderr, "code": p.returncode})
        ctl(["-D"])
    for args in AUDITCTL_CASES:
        ctl(["-D"]); ctl(["-e", "1"]); ctl(["-b", "8192"]); ctl(["-f", "1"]); ctl(["-r", "0"])
        pre = []
        if args[:1] in (["-W"], ["-d"], ["-l"]):
            pass
        for prep in ([["-w", "/etc/passwd", "-p", "wa", "-k", "k1"], ["-a", "always,exit", "-F", "arch=b64", "-S", "chmod", "-k", "pre"]] if args[0] in ("-W", "-d", "-l") else []):
            ctl(prep)
        r = ctl(args)
        listing = ctl(["-l"]).stdout if args[0] not in ("-l", "-s") else ""
        status = ctl(["-s"]).stdout if args[0] in ("-e", "-f", "-r", "-b") else ""
        result["auditctl"].append({"args": args, "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode, "after": listing, "status": status})
    ctl(["-D"]); ctl(["-e", "0"])
    daemon.terminate()
    daemon.wait()
    json.dump(result, open(out, "w"), indent=1)
    print(len(result["scenarios"]), "scenarios", len(result["auditctl"]), "auditctl cases")

main()
