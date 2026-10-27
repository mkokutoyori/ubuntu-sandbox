#!/usr/bin/env python3
"""Record how the real systemd-journald 255.4 sizes, rotates, vacuums and rate-limits its journal.

usage: record_journald_space.py out.json

Each scenario starts /lib/systemd/systemd-journald with a drop-in in /etc/systemd/journald.conf.d, flushes it to /var/log/journal
(SIGUSR1), sends native-protocol datagrams from this process (credentials recorded with every send, as record_journal_corpus.py does),
then stops it.  The output keeps, per scenario, the configuration, the statvfs of the journal directory, the sends, the entries journald
stored (journalctl -o export, which includes its own driver messages), and for every file left on disk its name, its st_size and the
counters printed by `journalctl --header`.
"""
import base64, ctypes, json, os, shutil, signal, socket, subprocess, sys, time

MACHINE_ID = open("/etc/machine-id").read().strip()
JOURNAL_DIR = f"/var/log/journal/{MACHINE_ID}"
CONF_DIR = "/etc/systemd/journald.conf.d"
CONF = CONF_DIR + "/zz-oracle.conf"
CGROUP = "/sys/fs/cgroup/unified"
BASE = "ReadKMsg=no\nAudit=no\nStorage=persistent\nForwardToWall=no\n"
libc = ctypes.CDLL(None, use_errno=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from journal_corpus_lib import parse_export


def read(path):
    try:
        return open(path, "rb").read()
    except OSError:
        return b""


def credentials():
    status = read("/proc/self/status").decode()
    pick = lambda key: [line.split()[1] for line in status.splitlines() if line.startswith(key)]
    capeff = [line.split(":")[1].strip() for line in status.splitlines() if line.startswith("CapEff:")]
    cgroup = [line[3:] for line in read("/proc/self/cgroup").decode().splitlines() if line.startswith("0::")]
    return {
        "pid": os.getpid(), "uid": int(pick("Uid:")[0]), "gid": int(pick("Gid:")[0]), "comm": read("/proc/self/comm").decode().rstrip("\n"), "exe": os.readlink("/proc/self/exe"),
        "cmdline": read("/proc/self/cmdline").decode().rstrip("\0").replace("\0", " "), "capeff": capeff[0] if capeff else "", "cgroup": cgroup[0] if cgroup else "",
        "loginuid": read("/proc/self/loginuid").decode().strip(), "sessionid": read("/proc/self/sessionid").decode().strip(),
    }


def native(fields):
    out = b""
    for key, value in fields:
        value = value if isinstance(value, bytes) else value.encode()
        out += key.encode() + b"=" + value + b"\n"
    return out


class Run:
    def __init__(self, name, conf, unit=None):
        self.name, self.conf, self.unit = name, conf, unit
        self.sends = []
        self.extra = []
        self.texts = []
        self.generator = None

    def start(self):
        os.makedirs(CONF_DIR, exist_ok=True)
        open(CONF, "w").write("[Journal]\n" + BASE + self.conf)
        shutil.rmtree("/run/systemd/journal", ignore_errors=True)
        os.makedirs("/run/systemd/journal", exist_ok=True)
        shutil.rmtree(JOURNAL_DIR, ignore_errors=True)
        shutil.rmtree(f"/run/log/journal/{MACHINE_ID}", ignore_errors=True)
        self.log = f"/tmp/claude-0/scratch/jd/{self.name}.log"
        self.daemon = subprocess.Popen(["/lib/systemd/systemd-journald"], stdout=subprocess.DEVNULL, stderr=open(self.log, "wb"), env=dict(os.environ, SYSTEMD_LOG_LEVEL="debug", SYSTEMD_LOG_TARGET="console"))
        for _ in range(50):
            if os.path.exists("/run/systemd/journal/socket"):
                break
            time.sleep(0.1)
        time.sleep(0.3)
        self.daemon.send_signal(signal.SIGUSR1)
        time.sleep(0.8)
        if self.unit:
            path = os.path.join(CGROUP, self.unit.lstrip("/"))
            os.makedirs(path, exist_ok=True)
            open(os.path.join(path, "cgroup.procs"), "w").write(str(os.getpid()))
        self.credentials = credentials()
        self.statvfs = os.statvfs(JOURNAL_DIR)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.sock.connect("/run/systemd/journal/socket")
        self.sock.send(native([("MESSAGE", "sample"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "sample")]))
        time.sleep(0.5)
        self.startEntries = self.export(JOURNAL_DIR)

    def export(self, directory):
        env = dict(os.environ, LC_ALL="C", TZ="UTC")
        raw = subprocess.run(["journalctl", f"--directory={directory}", "-o", "export", "--no-pager"], capture_output=True, env=env).stdout
        rows = []
        for fields in parse_export(raw):
            meta = {name: value.decode() for name, value in fields[:6]}
            rows.append({
                "realtime": int(meta["__REALTIME_TIMESTAMP"]), "monotonic": int(meta["__MONOTONIC_TIMESTAMP"]), "seqnum": int(meta["__SEQNUM"]), "bootId": meta["_BOOT_ID"],
                "fields": [[name, base64.b64encode(value).decode()] for name, value in fields[6:]] + [["_BOOT_ID", base64.b64encode(meta["_BOOT_ID"].encode()).decode()]],
            })
        return rows

    def send(self, fields):
        data = native(fields)
        self.sends.append({"payload": base64.b64encode(data).decode(), "at": time.time_ns() // 1000})
        self.sock.send(data)
        time.sleep(0.002)

    def stop(self, rotate=False):
        time.sleep(0.8)
        if rotate:
            self.daemon.send_signal(signal.SIGUSR2)
            time.sleep(0.8)
        self.endedAt = time.time_ns() // 1000
        copy = f"/tmp/claude-0/scratch/jd/{self.name}"
        self.daemon.send_signal(signal.SIGTERM)
        self.daemon.wait(timeout=30)
        shutil.rmtree(copy, ignore_errors=True)
        shutil.copytree(JOURNAL_DIR, os.path.join(copy, "journal", MACHINE_ID))
        if self.unit:
            open(os.path.join(CGROUP, "cgroup.procs"), "w").write(str(os.getpid()))
        files = []
        env = dict(os.environ, LC_ALL="C", TZ="UTC")
        for entry in sorted(os.listdir(JOURNAL_DIR)):
            path = os.path.join(JOURNAL_DIR, entry)
            header = subprocess.run(["journalctl", "--no-pager", "--header", f"--file={path}"], capture_output=True, env=env).stdout.decode()
            fields = dict(line.split(": ", 1) for line in header.splitlines() if ": " in line)
            files.append({
                "name": entry, "size": os.stat(path).st_size, "blocks": os.stat(path).st_blocks, "state": fields["State"], "arena": int(fields["Arena size"]),
                "dataHashTable": int(fields["Data hash table size"]), "fieldHashTable": int(fields["Field hash table size"]),
                "headSeqnum": int(fields["Head sequential number"].split()[0]), "tailSeqnum": int(fields["Tail sequential number"].split()[0]),
                "headRealtime": int(fields["Head realtime timestamp"].split("(")[1].rstrip(")"), 16), "tailRealtime": int(fields["Tail realtime timestamp"].split("(")[1].rstrip(")"), 16),
                "objects": int(fields["Objects"]), "entries": int(fields["Entry objects"]), "data": int(fields["Data objects"]), "fields": int(fields["Field objects"]),
                "entryArrays": int(fields["Entry array objects"]), "rotateSuggested": fields["Rotate suggested"], "incompatible": fields["Incompatible flags"],
            })
        entries = self.export(os.path.join(copy, "journal"))
        last = max(row["seqnum"] for row in self.startEntries)
        drivers = [row for row in entries if row["seqnum"] > last and any(name == "_TRANSPORT" and base64.b64decode(value) == b"driver" for name, value in row["fields"])]
        os.unlink(CONF)
        notable = ("Compressed", "Fixed ", "Vacuuming", "Deleted", "rotat", "Rotat", "limit", "Reserving", "effective settings", "Suppress")
        log = [line for line in open(self.log, errors="replace").read().splitlines() if any(word in line for word in notable)]
        return {
            "log": log,
            "name": self.name, "conf": self.conf, "unit": self.unit, "credentials": self.credentials,
            "statvfs": {"bsize": self.statvfs.f_bsize, "frsize": self.statvfs.f_frsize, "blocks": self.statvfs.f_blocks, "bfree": self.statvfs.f_bfree, "bavail": self.statvfs.f_bavail},
            "endedAt": self.endedAt, "startEntries": self.startEntries, "drivers": drivers, "sends": self.sends if self.generator is None else [{"at": send["at"]} for send in self.sends], "generator": self.generator, "extraSenders": self.extra, "texts": self.texts, "files": files, "vacuums": vacuums(copy) if self.name == "fill" else [],
        }


def as_user(run, uid, cgroup, count, label):
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(reader)
        if cgroup:
            path = os.path.join(CGROUP, cgroup)
            os.makedirs(path, exist_ok=True)
            open(os.path.join(path, "cgroup.procs"), "w").write(str(os.getpid()))
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        libc.prctl(15, b"splitter", 0, 0, 0)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.connect("/run/systemd/journal/socket")
        sends = []
        for i in range(count):
            data = native([("MESSAGE", f"{label} {i}"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "splitter")])
            sends.append({"payload": base64.b64encode(data).decode(), "at": time.time_ns() // 1000})
            sock.send(data)
            time.sleep(0.01)
        os.write(writer, json.dumps({"credentials": credentials(), "sends": sends}).encode())
        os._exit(0)
    os.close(writer)
    os.waitpid(pid, 0)
    run.extra.append(json.loads(os.read(reader, 1 << 20).decode()))


def compressible(run):
    import random
    random.seed(7)
    words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split()
    texts = []
    for n in (600, 800, 1500, 3000, 9000):
        texts.append(" ".join(random.choice(words) for _ in range(n // 7))[:n])
    for n in (600, 1500, 5000):
        texts.append("".join(random.choice("0123456789abcdef") for _ in range(n)))
    texts += ["x" * 700, "ab" * 600, json.dumps({"k%d" % i: {"id": i, "name": "user%d" % i, "tags": ["a", "b", "c"]} for i in range(60)})[:2500]]
    texts.append("ERROR " + "stack frame at com.example.Service.handle(Service.java:42) " * 14)
    run.texts = texts
    for text in texts:
        run.send([("MESSAGE", text), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "comp")])


def vacuums(copy):
    results = []
    for args in (["--vacuum-files=1"], ["--vacuum-files=3"], ["--vacuum-size=1M"], ["--vacuum-size=1500K"], ["--vacuum-size=100M"], ["--vacuum-time=1s"]):
        work = copy + ".vacuum"
        shutil.rmtree(work, ignore_errors=True)
        shutil.copytree(copy, work)
        before = sorted(os.listdir(os.path.join(work, "journal", MACHINE_ID)))
        out = subprocess.run(["journalctl", f"--directory={os.path.join(work, 'journal')}"] + args, capture_output=True, env=dict(os.environ, LC_ALL="C")).stderr.decode()
        after = sorted(os.listdir(os.path.join(work, "journal", MACHINE_ID)))
        results.append({"args": args, "before": before, "after": after, "output": [line.replace(work, "DIR") for line in out.splitlines()]})
        shutil.rmtree(work, ignore_errors=True)
    return results


def body(i):
    words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]
    return f"message {i} " + " ".join(words[(i + k) % 8] for k in range(i % 11 + 1))


def flood(run, count, start=0, pause=0.0):
    if count >= 1000:
        run.generator = {"kind": "flood", "count": count}
    for i in range(start, start + count):
        run.send([("MESSAGE", body(i)), ("PRIORITY", str(i % 8)), ("SYSLOG_IDENTIFIER", f"probe{i % 5}"), ("SEQ", str(i))])
        if pause:
            time.sleep(pause)


def fat(run, count, start=0):
    if count >= 1000:
        run.generator = {"kind": "fat", "count": count}
    shared = [(f"F{k:03d}", f"shared value number {k}") for k in range(100)]
    for i in range(start, start + count):
        run.send([("MESSAGE", f"fat entry {i}"), ("PRIORITY", str(i % 8))] + shared)


def scenarios():
    out = []
    run = Run("fill", "SystemMaxFileSize=512K\nSystemMaxUse=100M\nSystemKeepFree=0\n")
    run.start(); flood(run, 2600); out.append(run.stop())
    run = Run("size", "SystemMaxFileSize=1M\nSystemMaxUse=100M\nSystemKeepFree=0\n")
    run.start(); fat(run, 2200); out.append(run.stop(rotate=True))
    run = Run("files", "SystemMaxFileSize=1M\nSystemMaxUse=100M\nSystemKeepFree=0\nSystemMaxFiles=2\n")
    run.start(); fat(run, 3300); out.append(run.stop())
    run = Run("use", "SystemMaxFileSize=1M\nSystemMaxUse=2500K\nSystemKeepFree=0\n")
    run.start(); fat(run, 3300); out.append(run.stop(rotate=True))
    run = Run("filesec", "MaxFileSec=2s\nSystemKeepFree=0\n")
    run.start(); flood(run, 5); time.sleep(3.3); flood(run, 5, 5); out.append(run.stop())
    run = Run("retention", "MaxFileSec=1s\nMaxRetentionSec=2s\nSystemKeepFree=0\n")
    run.start()
    for round_ in range(6):
        flood(run, 3, round_ * 3); time.sleep(1.4)
    out.append(run.stop())
    run = Run("ratelimit", "RateLimitIntervalSec=3s\nRateLimitBurst=5\n", unit="system.slice/oracle-flood.service")
    run.start()
    for i in range(30):
        run.send([("MESSAGE", f"flood {i}"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "flood")])
    for i in range(8):
        run.send([("MESSAGE", f"loud {i}"), ("PRIORITY", "3"), ("SYSLOG_IDENTIFIER", "flood")])
    time.sleep(3.6)
    run.send([("MESSAGE", "after the interval"), ("PRIORITY", "6"), ("SYSLOG_IDENTIFIER", "flood")])
    run.send([("MESSAGE", "second after"), ("PRIORITY", "3"), ("SYSLOG_IDENTIFIER", "flood")])
    out.append(run.stop())
    for mode in ("uid", "login", "none"):
        run = Run(f"split-{mode}", f"SplitMode={mode}\nSystemKeepFree=0\n")
        run.start()
        flood(run, 3)
        as_user(run, 1000, "user.slice/user-1000.slice/session-3.scope", 3, "alice")
        flood(run, 2, 3)
        as_user(run, 1001, "user.slice/user-1001.slice/session-4.scope", 2, "bob")
        out.append(run.stop())
    for name, conf in (("compress-yes", "Compress=yes\n"), ("compress-no", "Compress=no\n"), ("compress-2000", "Compress=2000\n")):
        run = Run(name, conf + "SystemKeepFree=0\n")
        run.start(); compressible(run); out.append(run.stop())
    run = Run("keepfree-low", "SystemMaxUse=100M\nSystemKeepFree=100G\n")
    run.start(); fat(run, 200); out.append(run.stop(rotate=True))
    return out


def ensure_tmpfs():
    os.makedirs("/run/log/journal", exist_ok=True)
    if subprocess.run(["findmnt", "-n", "/run/log/journal"], capture_output=True).returncode != 0:
        subprocess.run(["mount", "-t", "tmpfs", "tmpfs", "/run/log/journal"], check=True)


def main():
    ensure_tmpfs()
    os.makedirs("/tmp/claude-0/scratch/jd", exist_ok=True)
    json.dump({"machineId": MACHINE_ID, "scenarios": scenarios()}, open(sys.argv[1], "w"))


main()
