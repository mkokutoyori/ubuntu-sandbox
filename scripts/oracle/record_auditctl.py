#!/usr/bin/env python3
"""Record the real auditctl 3.1.2 against the in-process fake kernel (audit_fake_kernel.c).

usage: record_auditctl.py AUDIT_ROOT out.json

The real binary and libaudit run unchanged; only the netlink socket is replaced by audit_fake_kernel.c, which
keeps the kernel state (status, features, the eight rule lists) in a file between invocations.  Every scenario
starts from a fresh state and runs a sequence of invocations; stdout, stderr and the exit status of each are stored.
The fixture also stores what the tool asks the host about: file kinds for the paths used, the rule files, and the
passwd/group databases of the lab host.
"""
import json, os, random, subprocess, sys, tempfile

PATHS = {"/": "directory", "/etc": "directory", "/etc/": "directory", "/etc//": "directory", "/etc/passwd": "file", "/tmp": "directory", "/var/log": "directory",
         "/usr/bin/id": "file", "/nonexistent/dir/file": "missing", "/etc/nosuch": "missing", "/etc/../etc/passwd": "file", "/etc/*": "missing", "relative/path": "missing",
         "/etc/ssh/sshd_config": "file", "/var/log/audit": "missing", "/home": "directory", "/usr/bin": "directory", "/etc/ssh": "directory", "/etc/../etc": "directory", "/nonexistent/dir": "missing", "/nonexistent": "missing"}
LONG = "/etc/" + "x" * 300
PATHS[LONG] = "missing"

ARCHS = ["", "-F arch=b64", "-F arch=b32", "-F arch=x86_64", "-F arch=i386", "-F arch=bogus", "-F arch=0xc000003e", "-F arch=0x40000003", "-F arch=aarch64", "-F arch=0", "-F arch!=b64", "-F arch>b64", "-F arch=ppc64", "-F arch=armv7l"]
SYSCALLS = ["open", "openat", "execve", "all", "bogus", "59", "open,close", "chmod,fchmod,fchmodat", "unlink,unlinkat,rename,renameat", "0", "-1", "999999", "open,,close", "mount,umount2", "kill", "socket,connect", "clone", "read"]
FIELDS = ["uid=0", "uid=root", "uid=1000", "uid=nosuchuser", "euid>=1000", "auid!=-1", "auid=unset", "auid>=1000", "gid=root", "gid=nosuchgroup", "success=1", "success=0", "exit=-EACCES", "exit=-13", "exit=5", "exit=BOGUS",
          "exit=EPERM", "path=/etc/passwd", "dir=/etc", "perm=wa", "perm=z", "perm=rwxaa", "perm!=r", "a0=0x1", "a1=3", "a2=-1", "a3=x", "pid=1", "ppid=2", "inode=5", "inode>5", "devmajor=8", "devminor=1", "filetype=file",
          "filetype=bogus", "msgtype=CWD", "msgtype=4", "msgtype=BOGUS", "exe=/usr/bin/id", "exe>/usr/bin/id", "subj_user=u", "subj_role=r", "subj_type=t", "subj_sen=s0", "obj_user=u", "obj_type=t", "obj_lev_low=s0", "session=3",
          "sessionid=3", "sessionid=unset", "saddr_fam=2", "saddr_fam=999", "fstype=ext4", "fstype=tracefs", "fstype=bogus", "bogus=1", "uid", "=1", "uid=", "uid==1", "arch=b64", "key=abc", "key=", "euid=root", "fsuid=0", "suid=1",
          "obj_uid=0", "obj_gid=0", "egid=0", "sgid=0", "fsgid=0", "ses=1", "auid&1", "uid&=1", "pers=0", "loginuid=1000", "uid=0x10", "uid=-5", "gid=-1", "exit=-0x10", "a0=1000000000000", "a0=-1", "success=x", "devmajor=x"]
LISTS = ["exit", "task", "user", "exclude", "filesystem", "entry", "bogus", "io_uring", "exit,exit", ""]
ACTIONS = ["always", "never", "possible", "bogus", ""]
KEYS = ["k1", "key two", "a" * 100, "x" * 300, ""]
COMPARES = ["uid=euid", "uid!=euid", "auid=uid", "euid=suid", "gid=egid", "uid=gid", "uid=bogus", "bogus=uid", "uid", "=uid", "uid=", "obj_uid=uid", "fsuid=obj_uid", "egid=obj_gid", "sgid=fsgid", "pid=ppid", "uid>euid"]
WATCH_PATHS = ["/etc/passwd", "/etc", "/etc/", "/tmp", "/nonexistent/dir/file", "/etc/nosuch", "relative/path", "/etc/*", "/etc/../etc/passwd", "/usr/bin/id", "/var/log/audit", LONG, ""]

VALID_ARCHS = ["", "", "-F arch=b64", "-F arch=b32", "-F arch=x86_64", "-F arch=i386", "-F arch=aarch64", "-F arch=0xc000003e"]
VALID_SYSCALLS = ["open", "openat", "execve", "all", "59", "open,close", "chmod,fchmod,fchmodat", "unlink,unlinkat,rename,renameat", "mount,umount2", "kill", "socket,connect", "clone", "setsockopt", "fcntl", "ptrace", "prctl", "mmap", "mprotect", "setuid", "chown", "ioctl", "accept4", "bpf"]
VALID_FIELDS = ["uid=0", "uid=root", "uid=1000", "euid>=1000", "auid!=-1", "auid=unset", "auid>=1000", "gid=root", "success=1", "success=0", "exit=-EACCES", "exit=-13", "exit=-EPERM", "path=/etc/passwd", "dir=/etc",
                "perm=wa", "perm=rwxa", "a0=0x1", "a1=3", "a2=0x1ed", "a3=-1", "pid=1", "ppid=2", "inode=5", "devmajor=8", "devminor=1", "filetype=file", "filetype=dir", "exe=/usr/bin/id", "subj_user=u", "subj_type=t",
                "obj_type=t", "sessionid=3", "saddr_fam=2", "key=abc", "msgtype=CWD", "euid=root", "fsuid=0", "suid=1", "egid=0", "loginuid=1000", "uid&=1", "uid>5", "uid<5"]
INTERPRET_RULES = [
    ["-a", "always,exit", "-F", "arch=b64", "-S", "openat", "-F", "a0=0xffffff9c", "-F", "a2=0x241"], ["-a", "always,exit", "-F", "arch=b64", "-S", "socket", "-F", "a0=2", "-F", "a1=1", "-F", "a2=6"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "chmod", "-F", "a1=0x1ed"], ["-a", "always,exit", "-F", "arch=b64", "-S", "kill", "-F", "a1=9"], ["-a", "always,exit", "-F", "arch=b64", "-S", "mmap", "-F", "a2=7", "-F", "a3=0x22"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "setuid", "-F", "a0=0"], ["-a", "always,exit", "-F", "arch=b64", "-S", "fcntl", "-F", "a1=2", "-F", "a2=1"], ["-a", "always,exit", "-F", "arch=b64", "-S", "ptrace", "-F", "a0=0x10"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "setsockopt", "-F", "a1=1", "-F", "a2=2"], ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-F", "a1=0x241", "-F", "a2=0x1b6"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "open,openat", "-F", "a0=0xffffff9c"], ["-a", "always,exit", "-S", "chown", "-F", "a1=0", "-F", "a2=0"], ["-a", "always,exit", "-F", "arch=b32", "-S", "chmod", "-F", "a1=0x1ed"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "mount", "-F", "a3=0x1001"], ["-a", "always,exit", "-F", "arch=b64", "-S", "clone", "-F", "a2=0x3d0f00"], ["-a", "always,exit", "-F", "arch=b64", "-S", "ioctl", "-F", "a1=0x5401"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "bpf", "-F", "a0=5"], ["-a", "always,exit", "-F", "auid=-1", "-F", "arch=b64", "-S", "execve", "-F", "sessionid=-1"],
]

def split(s):
    return s.split() if s else []

def gen_rule_cmd(r):
    kind = r.choice(["a", "a", "a", "A", "d", "w", "w", "W"])
    args = []
    if kind in "aAd":
        lst = r.choice(LISTS[:6] + ["exit"] * 8)
        act = r.choice(ACTIONS[:2] * 6 + ACTIONS[2:])
        spec = ("%s,%s" % (act, lst)) if r.random() < 0.8 else ("%s,%s" % (lst, act))
        args += ["-" + kind, spec]
        if r.random() < 0.6:
            args += split(r.choice(ARCHS))
        for _ in range(r.choice([0, 1, 1, 1, 2, 3])):
            args += ["-S", r.choice(SYSCALLS)]
        for _ in range(r.choice([0, 0, 1, 1, 2, 3, 4])):
            args += ["-F", r.choice(FIELDS)]
        if r.random() < 0.15:
            args += ["-C", r.choice(COMPARES)]
        if r.random() < 0.1:
            args += ["-p", r.choice(["wa", "r", "z", "rwxa"])]
        for _ in range(r.choice([0, 0, 1, 1, 2])):
            args += ["-k", r.choice(KEYS)]
        if r.random() < 0.05:
            args += ["-F", "arch=b64"]
    else:
        args += ["-" + kind, r.choice(WATCH_PATHS)]
        if r.random() < 0.7:
            args += ["-p", r.choice(["wa", "r", "rwxa", "x", "w", "z", "rwxaa", "", "RWX"])]
        for _ in range(r.choice([0, 1, 1, 2])):
            args += ["-k", r.choice(KEYS)]
        if r.random() < 0.1:
            args += ["-F", r.choice(FIELDS)]
    if r.random() < 0.04:
        args.insert(r.randrange(len(args) + 1), "stray")
    return args

SINGLES = [
    ["-s"], ["-s", "-i"], ["-s", "x"], ["-s", "-s"], ["-l"], ["-l", "-i"], ["-l", "-k", "k1"], ["-l", "-k"], ["-l", "x"], ["-l", "-i", "-k", "x"], ["-v"], ["-h"], ["--help"], [], ["-D"], ["-D", "-k", "k1"], ["-D", "x"],
    ["-e", "1"], ["-e", "0"], ["-e", "2"], ["-e", "3"], ["-e", "x"], ["-e"], ["-f", "0"], ["-f", "2"], ["-f", "3"], ["-f", "x"], ["-r", "100"], ["-r", "x"], ["-r", "-1"], ["-r", "99999999999"], ["-b", "8192"], ["-b", "x"], ["-b", "0"],
    ["--backlog_wait_time", "100"], ["--backlog_wait_time", "999999"], ["--backlog_wait_time", "x"], ["--backlog_wait_time"], ["--backlog"], ["--reset-lost"], ["--reset_backlog_wait_time_actual"], ["--reset"], ["--loginuid-immutable"], ["--loginuid"],
    ["--signal", "term"], ["--signal", "hup"], ["--signal", "bogus"], ["--signal"], ["--signal=usr1"], ["-t"], ["-q", "/a,/b"], ["-q", "/a"], ["-q", "/a,/b,/c"], ["-q", "/a,"], ["-m", "hello world"], ["-m"], ["-m", "a\tb"], ["-m", "x", "y"],
    ["-R", "/tmp/none.rules"], ["-R", "/etc"], ["-R", "a", "b"], ["-z"], ["-x"], ["--bogus"], ["-"], ["--"], ["x"], ["-s", "--"], ["-ab"], ["-a"], ["-S", "open"], ["-F", "uid=0"], ["-k", "x"], ["-p", "wa"], ["-C", "uid=euid"], ["-w"], ["-W"],
    ["-i"], ["-c"], ["-i", "-s"], ["-c", "-l"], ["-a", "always,exit", "-A", "always,exit"], ["-a", "always,exit", "-d", "always,exit"], ["-w", "/etc/passwd", "-a", "always,exit"], ["-a", "always,exit", "-w", "/etc/passwd"],
    ["-a", "always,task", "-S", "open"], ["-a", "always,user", "-S", "open"], ["-a", "always,exclude", "-S", "open"], ["-a", "always,filesystem", "-S", "open"], ["-a", "always,exit", "-S", "open", "-a", "never,exit"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "open", "-F", "arch=b32"], ["-a", "always,exit", "-S", "open", "-F", "arch=b64"], ["-F", "arch=b64", "-t"], ["-a", "always,exit", "-F", "arch=b64"],
    ["-a", "always,exit", "-F", "arch=b64", "-S", "all"], ["-a", "exit,always", "-S", "all"], ["-a", "always"], ["-a", "always,"], ["-a", ",exit"], ["-a", "exit"], ["-a", "x,y"],
    ["-e", "1", "-s"], ["-s", "-e", "1"], ["-e1"], ["-e", "1", "-f", "2"], ["-b8192"], ["-ksomething"], ["-w/etc/passwd"], ["-w", "/etc/passwd", "-pwa", "-kk1"], ["-aalways,exit", "-S", "all"],
]

def run(root, state, args, env):
    e = dict(env, FAKE_AUDIT_STATE=state)
    r = subprocess.run([root + "/usr/sbin/auditctl", *args], capture_output=True, text=True, env=e, errors="replace")
    return {"args": args, "stdout": r.stdout, "stderr": r.stderr, "code": r.returncode}

def main():
    root, out = sys.argv[1], sys.argv[2]
    shim = os.path.join(tempfile.gettempdir(), "audit_fakekernel_record.so")
    subprocess.run(["gcc", "-shared", "-fPIC", "-O1", "-w", "-o", shim, os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit_fake_kernel.c"), "-ldl"], check=True)
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", LD_PRELOAD=shim, LC_ALL="C")
    env.pop("LANG", None)
    r = random.Random(2024)
    rule_files = {}
    scenarios = []
    def scenario(name, steps, files=None):
        scenarios.append({"name": name, "steps": steps, "files": files or {}})
    for args in SINGLES:
        scenario("single", [["-D"], args, ["-l"], ["-s"]])
    for args in SINGLES[:60]:
        scenario("single-locked", [["-e", "2"], args, ["-l"], ["-s"]])
    prep = [["-w", "/etc/passwd", "-p", "wa", "-k", "k1"], ["-a", "always,exit", "-F", "arch=b64", "-S", "chmod", "-k", "pre"], ["-a", "never,user", "-F", "uid=0"], ["-a", "always,exclude", "-F", "msgtype=CWD"]]
    for args in SINGLES:
        scenario("single-prepared", prep + [args, ["-l"], ["-l", "-i"]])
    for i in range(1600):
        steps = []
        for _ in range(r.choice([1, 1, 2, 3])):
            steps.append(gen_rule_cmd(r))
        if r.random() < 0.4:
            steps.append(steps[0])
        steps.append(["-l"])
        if r.random() < 0.5:
            steps.append(["-l", "-i"])
        if r.random() < 0.3:
            steps.append(["-l", "-k", r.choice(["k1", "k", "zz"])])
        scenario("random", steps)
    for i in range(1300):
        steps = []
        for _ in range(r.choice([1, 2, 2, 3])):
            kind = r.choice(["a", "a", "a", "a", "A", "d"])
            lst = r.choice(["exit"] * 7 + ["user", "task", "exclude", "filesystem"])
            act = r.choice(["always", "always", "never"])
            cmd = ["-" + kind, "%s,%s" % (act, lst)]
            if lst in ("exit",):
                cmd += split(r.choice(VALID_ARCHS))
                for _ in range(r.choice([0, 1, 1, 2])):
                    cmd += ["-S", r.choice(VALID_SYSCALLS)]
                for _ in range(r.choice([0, 1, 2, 3])):
                    cmd += ["-F", r.choice(VALID_FIELDS)]
            elif lst == "user":
                for _ in range(r.choice([0, 1, 2])):
                    cmd += ["-F", r.choice(["uid=0", "uid=root", "auid>=1000", "msgtype=USER_AUTH", "pid=5", "gid=root", "subj_user=u"])]
            elif lst == "exclude":
                for _ in range(r.choice([1, 1, 2])):
                    cmd += ["-F", r.choice(["msgtype=CWD", "msgtype=PATH", "msgtype=1302", "uid=0", "pid=5", "exe=/usr/bin/id", "subj_type=t"])]
            elif lst == "filesystem":
                cmd += ["-F", r.choice(["fstype=tracefs", "fstype=debugfs", "fstype=1953653091", "fstype=bogus"])]
            if r.random() < 0.3:
                cmd += ["-C", r.choice(["uid=euid", "auid!=uid", "euid=suid", "gid=egid", "sgid!=fsgid", "uid=obj_uid", "egid=obj_gid"])]
            for _ in range(r.choice([0, 1, 1, 2])):
                cmd += ["-k", r.choice(["k1", "audit", "key two", "pw_changes"])]
            steps.append(cmd)
        if r.random() < 0.5:
            steps.append(steps[r.randrange(len(steps))])
        if r.random() < 0.3:
            d = list(steps[0])
            d[0] = "-d"
            steps.append(d)
        steps += [["-l"], ["-l", "-i"]]
        scenario("valid", steps)
    for rule in INTERPRET_RULES:
        scenario("interpret", [rule, ["-l"], ["-l", "-i"]])
    for i in range(500):
        steps = []
        for _ in range(r.choice([1, 2, 3])):
            kind = r.choice(["w", "w", "w", "W"])
            cmd = ["-" + kind, r.choice(["/etc/passwd", "/etc", "/tmp", "/etc/", "/usr/bin/id", "/etc/nosuch", "/var/log/audit"])]
            if r.random() < 0.8:
                cmd += ["-p", r.choice(["wa", "r", "rwxa", "x", "w", "a", "rw", "rx", "wx", "ra", "rwx", "wxa"])]
            for _ in range(r.choice([0, 1, 1, 2])):
                cmd += ["-k", r.choice(["k1", "audit", "key two", "pw_changes"])]
            steps.append(cmd)
        steps += [["-l"], ["-l", "-k", "k1"], ["-D", "-k", "k1"], ["-l"]]
        scenario("watches", steps)
    rule_texts = [
        "# comment\n-D\n-b 8192\n-f 1\n-w /etc/passwd -p wa -k identity\n-a always,exit -F arch=b64 -S execve -k exec\n",
        "-w /etc/passwd -p wa -k a\n-w /etc/passwd -p wa -k a\n-a always,exit -S bogus\n-w /etc/shadow -p wa\n",
        "\n   \n-a always,exit -F arch=b64 -S open \\\n-k broken\n",
        "-a always,exit -F arch=b64 -S open -k 'quoted key'\n-w /etc/passwd\\ x -p wa\n",
        "-D\n-e 1\n-a never,exit -F dir=/var -F arch=b64 -S all\n-a always,exit -F arch=b64 -S chmod -F auid>=1000 -F auid!=-1\n",
        "-R /tmp/nested.rules\n-s\n-l\n",
        "-k x\n-a always,exit -S all -k x -F bogus\n-v\n",
        "-a always,exit -F arch=b64 -S open -F exit=-EACCES -k ea\n-a always,exit -F arch=b64 -S open -F exit=-EACCES -k ea\n-e 2\n-a always,exit -S close\n",
        "-D\n-m hello\n-t\n-q /a,/b\n--loginuid-immutable\n--backlog_wait_time 10\n--reset-lost\n",
        "# only comments\n# another\n",
        "",
        "-a always,exit\n-a",
        "-w /etc/passwd -p wa -k identity",
        "-i\n-a always,exit -S bogus\n-w /etc/passwd -p wa -k after\n",
        "-c\n-a always,exit -S bogus\n-w /etc/passwd -p wa -k after\n",
        "   -w /etc/passwd -p wa -k indent\n\t-w /etc/shadow -p wa\n",
    ]
    for i, text in enumerate(rule_texts):
        path = "/tmp/auditctl-%d.rules" % i
        scenario("rules-file", [["-R", path], ["-l"], ["-s"]], {path: text})
    scenario("rules-file-missing", [["-R", "/tmp/auditctl-missing.rules"], ["-l"]])
    scenarios_out = []
    with tempfile.TemporaryDirectory() as d:
        for sc in scenarios:
            state = os.path.join(d, "state.bin")
            if os.path.exists(state):
                os.unlink(state)
            for path, text in sc["files"].items():
                open(path, "w").write(text)
            steps = [run(root, state, a, env) for a in sc["steps"]]
            for path in sc["files"]:
                os.unlink(path)
            scenarios_out.append({"name": sc["name"], "files": sc["files"], "steps": steps})
    def getent(db):
        return subprocess.run(["getent", db], capture_output=True, text=True).stdout
    json.dump({"tool": "auditctl 3.1.2 over audit_fake_kernel.c", "paths": PATHS, "scenarios": scenarios_out,
               "hostdb": {"passwd": getent("passwd"), "group": getent("group"), "protocols": open("/etc/protocols").read()}}, open(out, "w"), separators=(",", ":"))
    print(len(scenarios_out), "scenarios", sum(len(s["steps"]) for s in scenarios_out), "invocations")

main()
