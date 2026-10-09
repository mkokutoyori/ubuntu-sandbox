#!/usr/bin/env python3
"""Build a journal with the real systemd-journald 255.4 and keep it as a corpus (export format).

usage: record_journal_corpus.py WORKDIR

The real journald runs three times, each with its own boot id, machine id and clock offset (scripts/oracle/last_shim.c).
Senders (native protocol, syslog datagrams on /dev/log, stdout streams) run inside cgroups of the name=systemd hierarchy so
that _SYSTEMD_UNIT / _SYSTEMD_SLICE / _SYSTEMD_CGROUP are filled in by journald itself, and carry distinct comm names.
WORKDIR/journal receives the resulting journal files; WORKDIR/entries.export is `journalctl -o export` over them.
"""
import base64, ctypes, json, os, shutil, signal, socket, struct, subprocess, sys, time

SHIM = "/tmp/last_shim.so"
MACHINE_ID = "0d0af05ee8fd4dc29275718f2ce4dff1"
BOOTS = [
    ("11111111-2222-4333-8444-555555555551", 1699999000 - int(time.time())),
    ("11111111-2222-4333-8444-555555555552", 1709400000 - int(time.time())),
    ("11111111-2222-4333-8444-555555555553", 1721900000 - int(time.time())),
]
CGROUP = "/sys/fs/cgroup/unified"
SENDS_FILE = "/tmp/jcorpus.sends"
CURRENT_BOOT = [0]
libc = ctypes.CDLL(None, use_errno=True)

def sender(comm, unit, body):
    pid = os.fork()
    if pid:
        os.waitpid(pid, 0)
        return
    libc.prctl(15, comm.encode(), 0, 0, 0)
    if unit:
        path = os.path.join(CGROUP, unit.lstrip("/"))
        os.makedirs(path, exist_ok=True)
        open(os.path.join(path, "cgroup.procs"), "w").write(str(os.getpid()))
    body()
    time.sleep(0.4)
    os._exit(0)

def credentials():
    def read(path):
        try:
            return open(path, "rb").read()
        except OSError:
            return b""
    status = read("/proc/self/status").decode()
    capeff = [line.split(":")[1].strip() for line in status.splitlines() if line.startswith("CapEff:")]
    cgroup = [line[3:] for line in read("/proc/self/cgroup").decode().splitlines() if line.startswith("0::")]
    return {
        "pid": os.getpid(), "uid": os.getuid(), "gid": os.getgid(), "comm": read("/proc/self/comm").decode().rstrip("\n"), "exe": os.readlink("/proc/self/exe"),
        "cmdline": read("/proc/self/cmdline").decode().rstrip("\0").replace("\0", " "), "capeff": capeff[0] if capeff else "", "cgroup": cgroup[0] if cgroup else "",
        "loginuid": read("/proc/self/loginuid").decode().strip(), "sessionid": read("/proc/self/sessionid").decode().strip(),
    }

def log_send(kind, payload, extra=None):
    line = {"boot": CURRENT_BOOT[0], "kind": kind, "payload": base64.b64encode(payload).decode(), "credentials": credentials()}
    if extra:
        line.update(extra)
    with open(SENDS_FILE, "a") as handle:
        handle.write(json.dumps(line) + "\n")

def native(fields):
    out = b""
    for key, value in fields:
        value = value if isinstance(value, bytes) else value.encode()
        if b"\n" in value:
            out += key.encode() + b"\n" + struct.pack("<Q", len(value)) + value + b"\n"
        else:
            out += key.encode() + b"=" + value + b"\n"
    return out

def send_native(fields):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    s.connect("/run/systemd/journal/socket")
    data = fields if isinstance(fields, bytes) else native(fields)
    log_send("native", data)
    s.send(data)
    s.close()

def send_syslog(text):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    s.connect("/run/systemd/journal/dev-log")
    data = text if isinstance(text, bytes) else text.encode()
    log_send("syslog", data)
    s.send(data)
    s.close()

def send_stdout(identifier, unit_id, priority, lines, prefix=0):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect("/run/systemd/journal/stdout")
    data = f"{identifier}\n{unit_id}\n{priority}\n{prefix}\n0\n0\n0\n".encode() + b"".join(l if isinstance(l, bytes) else l.encode() for l in lines)
    log_send("stdout", data)
    s.send(data)
    time.sleep(0.05)
    s.close()

def boot_messages(index):
    day = f"boot{index + 1}"
    def ssh():
        for pri, msg in [(6, f"Server listening on 0.0.0.0 port 22. ({day})"), (6, "Accepted password for alice from 10.0.0.5 port 50022 ssh2"), (4, "Failed password for invalid user admin from 10.0.0.9 port 40022 ssh2"),
                         (3, "error: kex_exchange_identification: Connection closed by remote host"), (7, "debug1: userauth-request for user alice")]:
            send_native([("MESSAGE", msg), ("PRIORITY", str(pri)), ("SYSLOG_IDENTIFIER", "sshd"), ("SYSLOG_FACILITY", "4"), ("SYSLOG_PID", "811")])
    def cron():
        send_syslog(f"<78>Nov 14 22:13:20 cron[{900 + index}]: (root) CMD (run-parts /etc/cron.hourly)")
        send_syslog(b"<78>cron: (root) CMD (  cd / && run-parts --report /etc/cron.hourly)")
    def kernelish():
        send_native([("MESSAGE", "Out of memory: Killed process 4242 (java)"), ("PRIORITY", "2"), ("SYSLOG_IDENTIFIER", "kernel-sim"), ("SYSLOG_FACILITY", "0")])
    def app():
        send_native([("MESSAGE", "line one\nline two\nline three"), ("PRIORITY", "5"), ("SYSLOG_IDENTIFIER", "myapp"), ("CODE_FILE", "main.c"), ("CODE_LINE", "42"), ("CODE_FUNC", "run")])
        send_native([("MESSAGE", "tab\tseparated and \x1b[31mred\x1b[0m"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp")])
        send_native([("MESSAGE", "café ☃ unicode"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp")])
        send_native([("MESSAGE", b"binary \xff\xfe bytes"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp")])
        send_native([("MESSAGE", "x" * 300), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp")])
        send_native([("MESSAGE", ""), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp")])
        send_native([("MESSAGE", "with ids"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp"), ("MESSAGE_ID", "fc2e22bc6ee647b6b90729ab34a250b1"), ("ERRNO", "13"), ("TID", "99"), ("CUSTOM_FIELD", "custom value"), ("EMPTY_FIELD", "")])
        send_native([("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "myapp")])
        send_native([("MESSAGE", "no identifier"), ("PRIORITY", "6")])
        send_native(b"MESSAGE=first of two\nPRIORITY=4\n\nMESSAGE=second of two\nPRIORITY=5\nSYSLOG_IDENTIFIER=twin\n")
        send_native(b"MESSAGE=has trusted field\n_UID=4242\n_TRANSPORT=forged\nlower=ignored\n1DIGIT=ignored\nVALID_FIELD=kept\n" + b"F" * 65 + b"=toolong\n")
        send_native(b"# comment line\n.control command\nMESSAGE=after comments\nMESSAGE=duplicated message\nDUP=a\nDUP=b\nDUP=a\n")
        send_native(b"MESSAGE=priority and facility digits\nPRIORITY=9\nSYSLOG_FACILITY=7\nSYSLOG_IDENTIFIER=digits\n")
        send_native(b"MESSAGE=two digit facility\nPRIORITY=2\nSYSLOG_FACILITY=23\nSYSLOG_IDENTIFIER=fac23\n")
        send_native(b"MESSAGE=three digit facility\nPRIORITY=2\nSYSLOG_FACILITY=123\nSYSLOG_IDENTIFIER=fac123\n")
        send_native(b"MESSAGE=letter priority\nPRIORITY=x\nSYSLOG_IDENTIFIER=lp\n")
        send_native(b"MESSAGE=trailing noise without newline\nPRIORITY=6\nTRUNCATED")
        send_native(b"MESSAGE\n" + struct.pack("<Q", 11) + b"bin\nary\n\x00x\nTAIL=after binary\n")
        send_native(b"MESSAGE\n" + struct.pack("<Q", 50) + b"short\n")
        send_native(b"\n\nMESSAGE=after separators\n")
        send_native(b"")
        send_native([("MESSAGE", "object pid"), ("OBJECT_PID", str(os.getppid())), ("SYSLOG_IDENTIFIER", "objectlog")])
        send_native([("MESSAGE", "object pid bogus"), ("OBJECT_PID", "999999"), ("SYSLOG_IDENTIFIER", "objectlog")])
        send_native([("MESSAGE", "lower case id"), ("syslog_identifier", "ignored")])
        send_native([("SYSLOG_IDENTIFIER", "ident-only")])
    def web():
        send_stdout("nginx", "", 6, [f"GET / 200 {day}\n", "GET /missing 404\n", "POST /login 302\n"])
        send_stdout("nginx", "", 3, ["upstream timed out\n"])
        send_stdout("nginx", "", 6, ["<3>level prefixed error\n", "<7>level prefixed debug\n", "<30>facility and level\n", "<>not a prefix\n", "<9>nine\n", "<8>eight\n"], prefix=1)
        send_stdout("nginx", "", 30, ["priority line carries a facility\n"])
        send_stdout("", "", 6, ["no identifier\n"])
        send_stdout("nginx", "", 6, ["  padded line  \n", "\n", "trailing without newline"])
        send_stdout("nginx", "", 6, ["nul\0terminated\0", "next\n"])
        send_stdout("nginx", "web.service", 6, ["unit id from a privileged stream\n"])
        send_stdout("nginx", "bad unit", 6, ["unit id not valid\n"])
        send_stdout("long-ident-" + "i" * 40, "", 5, ["long identifier\n"])
        send_stdout("nginx", "", 999, ["priority 999\n"])
        send_stdout("nginx", "", 3, ["a" * 5000 + "\n"])
    def sudo():
        send_syslog("<85>Nov 14 22:13:20 sudo:    alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt update")
        send_syslog("<85>sudo[2210]: pam_unix(sudo:session): session opened for user root(uid=0) by alice(uid=1000)")
        send_syslog("<13>plain message without tag")
        send_syslog("<999>bad priority tagged: x")
        send_syslog("no priority at all")
        send_syslog("<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8")
        send_syslog("<14>Jan  1 00:00:00 host prog[123]: message with host and pid")
        send_syslog("<190>local7.info message")
        send_syslog("<7>")
        send_syslog("<>empty priority brackets")
        send_syslog("<1>")
        send_syslog("<0>emergency")
        send_syslog("   <13>leading whitespace before priority")
        send_syslog("<13>trailing whitespace   \n")
        send_syslog("<13>multi\nline\nmessage")
        send_syslog(b"<13>nul\x00byte inside")
        send_syslog("prog: no priority but tag")
        send_syslog("[123]: pid without ident")
        send_syslog("<13>Feb  3 04:05:06 prog:no space after colon")
        send_syslog("<13>Feb  3 04:05:06 prog[7]: spaced   message")
        send_syslog("<13>Feb  3 04:05 prog: truncated timestamp")
        send_syslog("<13>Xyz 31 99:99:99 prog: nonsense timestamp is skipped as a timestamp")
        send_syslog("<13>tag-with-dash[42]: dash and pid")
        send_syslog("<13>tag with spaces: not an identifier")
        send_syslog("<13>:")
        send_syslog("<13>x[unterminated: broken pid")
        send_syslog("<13>x[1][2]: two pids")
        send_syslog("<13>" + "m" * 3000)
        send_syslog("<13>caf\u00e9 \u2603: unicode tag")
        send_syslog(b"<13>invalid \xff\xfe utf8")
        send_syslog("\n\n<13>only leading newlines\n")
        send_syslog("   \t  ")
    sender("sshd", "system.slice/ssh.service", ssh)
    sender("cron", "system.slice/cron.service", cron)
    sender("systemd", "init.scope", kernelish)
    sender("myapp", "system.slice/myapp.service", app)
    sender("nginx", "system.slice/nginx.service", web)
    sender("sudo", "user.slice/user-1000.slice/session-3.scope", sudo)
    sender("shell", None, lambda: send_native([("MESSAGE", f"from a process outside any unit ({day})"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "logger")]))

CONF_DIR = "/etc/systemd/journald.conf.d"
CONF = CONF_DIR + "/zz-oracle.conf"

def main():
    os.makedirs(CONF_DIR, exist_ok=True)
    open(CONF, "w").write("[Journal]\nReadKMsg=no\nAudit=no\nRateLimitIntervalSec=0\nStorage=persistent\n")
    try:
        record(sys.argv[1])
    finally:
        os.unlink(CONF)

def record(work):
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    run_dir = f"/var/log/journal/{MACHINE_ID}"
    shutil.rmtree(run_dir, ignore_errors=True)
    shutil.rmtree(f"/run/log/journal/{MACHINE_ID}", ignore_errors=True)
    if os.path.exists(SENDS_FILE):
        os.unlink(SENDS_FILE)
    for index, (boot, offset) in enumerate(BOOTS):
        CURRENT_BOOT[0] = index
        env = dict(os.environ, LD_PRELOAD=SHIM, LAST_BOOT_ID=boot, LAST_MACHINE_ID=MACHINE_ID, LAST_RT_OFFSET=str(offset))
        shutil.rmtree("/run/systemd/journal", ignore_errors=True)
        os.makedirs("/run/systemd/journal", exist_ok=True)
        shutil.rmtree(f"/run/log/journal/{MACHINE_ID}", ignore_errors=True)
        journald = subprocess.Popen(["/lib/systemd/systemd-journald"], env=env, stdout=subprocess.DEVNULL, stderr=open("/tmp/jd.err","wb"))
        for _ in range(50):
            if os.path.exists("/run/systemd/journal/socket") and os.path.exists("/run/systemd/journal/stdout"): break
            time.sleep(0.1)
        time.sleep(0.5)
        boot_messages(index)
        time.sleep(1.0)
        journald.send_signal(signal.SIGUSR1)
        time.sleep(0.5)
        journald.send_signal(signal.SIGTERM)
        journald.wait(timeout=20)
    shutil.copytree(run_dir, os.path.join(work, "journal", MACHINE_ID))
    shutil.copy(SENDS_FILE, os.path.join(work, "sends.jsonl"))
    exported = subprocess.run(["journalctl", f"--directory={os.path.join(work, 'journal')}", "-o", "export", "--no-pager"], capture_output=True, env=dict(os.environ, LC_ALL="C"))
    open(os.path.join(work, "entries.export"), "wb").write(exported.stdout)
    print("entries bytes", len(exported.stdout), "stderr", exported.stderr[:200])

main()
