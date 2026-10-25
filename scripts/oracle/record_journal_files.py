#!/usr/bin/env python3
"""Record journal files written by the installed systemd-journald (255) and what journalctl says about them.

usage: unshare -m python3 record_journal_files.py files.json

It must run in a private mount namespace: tmpfs is mounted over the directories journald writes (/run/systemd/journal, /run/log, /var/log/journal and
/etc/systemd/journald.conf.d), so the host's own state is never touched.

For each scenario journald is started from scratch (no compression unless asked, no rate limit), fed entries over its native datagram socket, stopped with
SIGTERM so that the file is closed OFFLINE, and the file it wrote is kept up to its last object (the rest of the pre-allocated 8 MiB is zeros).  Next to the
bytes, the export format of every entry is kept (the field payloads in the order of the entry items, which is what the writer under test must be fed) and the
output of `journalctl --header` and `--verify`.
"""
import base64, glob, json, os, shutil, signal, socket, struct, subprocess, sys, time

RUN = "/run/systemd/journal"
LOG = "/run/log/journal"
PROCESS = None
PRIVATE_DIRECTORIES = ["/run/systemd/journal", "/run/log", "/var/log/journal", "/etc/systemd/journald.conf.d"]
BASE_CONFIG = "[Journal]\nStorage=volatile\nCompress=no\nRateLimitIntervalSec=0\nRateLimitBurst=0\nForwardToSyslog=no\nForwardToKMsg=no\nForwardToConsole=no\nForwardToWall=no\n"


def isolate():
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    for directory in PRIVATE_DIRECTORIES:
        os.makedirs(directory, exist_ok=True)
        subprocess.run(["mount", "-t", "tmpfs", "tmpfs", directory], check=True)


def stop_journald():
    global PROCESS
    if PROCESS is None:
        return
    PROCESS.send_signal(signal.SIGTERM)
    PROCESS.wait(timeout=10)
    PROCESS = None


def clear(directory):
    for entry in os.listdir(directory):
        path = os.path.join(directory, entry)
        shutil.rmtree(path) if os.path.isdir(path) else os.unlink(path)


def start_journald(config=BASE_CONFIG, prepare=None):
    global PROCESS
    stop_journald()
    for directory in PRIVATE_DIRECTORIES:
        clear(directory)
    with open("/etc/systemd/journald.conf.d/zz-oracle.conf", "w") as handle:
        handle.write(config)
    if prepare is not None:
        prepare()
    PROCESS = subprocess.Popen(["/lib/systemd/systemd-journald"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if os.path.exists(RUN + "/socket") and journal_files():
            time.sleep(0.2)
            return
        time.sleep(0.1)
    raise RuntimeError("journald did not start")


def native(fields):
    out = b""
    for name, value in fields:
        if b"\n" in value or any(b < 0x20 and b != 0x09 for b in value):
            out += name + b"\n" + struct.pack("<Q", len(value)) + value + b"\n"
        else:
            out += name + b"=" + value + b"\n"
    return out


def journal_files():
    return glob.glob(LOG + "/*/system.journal") + glob.glob("/var/log/journal/*/system.journal")


def journal_file():
    persistent = glob.glob("/var/log/journal/*/system.journal")
    return persistent[0] if persistent else journal_files()[0]


def last_object_end(data):
    tail_offset = struct.unpack_from("<Q", data, 136)[0]
    size = struct.unpack_from("<Q", data, tail_offset + 8)[0]
    return (tail_offset + size + 7) // 8 * 8


def sparse(data):
    chunks = []
    index = 0
    while index < len(data):
        if data[index] == 0:
            index += 1
            continue
        start = index
        zeros = 0
        while index < len(data) and zeros < 64:
            zeros = zeros + 1 if data[index] == 0 else 0
            index += 1
        end = index - zeros
        chunks.append([start, data[start:end].hex()])
        index = end
    return {"size": len(data), "chunks": chunks}


def capture(name, entries, config=BASE_CONFIG, sealed=False, archived=False):
    sealing = {}

    def prepare():
        machine = open("/etc/machine-id").read().strip()
        os.makedirs("/var/log/journal/" + machine, exist_ok=True)
        setup = subprocess.run(["journalctl", "--setup-keys", "--interval=10s"], capture_output=True, text=True)
        sealing["setup"] = setup.stdout + setup.stderr
        sealing["fss"] = open("/var/log/journal/%s/fss" % machine, "rb").read().hex()
        sealing["machine"] = machine

    start_journald(config, prepare if sealed else None)
    if sealed:
        subprocess.run(["journalctl", "--flush"], check=False, timeout=30)
        time.sleep(0.5)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    for fields in entries:
        if isinstance(fields, (int, float)):
            time.sleep(fields)
            continue
        if fields == "rotate":
            subprocess.run(["journalctl", "--rotate"], check=True, timeout=30)
            time.sleep(0.5)
            continue
        sock.sendto(native(fields), RUN + "/socket")
        time.sleep(0.01)
    time.sleep(0.5)
    stop_journald()
    path = journal_file() if not archived else sorted(glob.glob("/var/log/journal/*/system@*.journal"))[0]
    data = open(path, "rb").read()
    trimmed = data[: last_object_end(data)]
    export = subprocess.run(["journalctl", "--file=" + path, "-o", "export"], capture_output=True).stdout
    header = subprocess.run(["journalctl", "--file=" + path, "--header"], capture_output=True, text=True).stdout
    verify = subprocess.run(["journalctl", "--file=" + path, "--verify"], capture_output=True, text=True)
    sealed_report = None
    if sealed:
        key = [line for line in sealing["setup"].splitlines() if "/" in line and "-" in line and line.strip() and " " not in line.strip()]
        key = key[0].strip() if key else ""
        keyed = subprocess.run(["journalctl", "--file=" + path, "--verify", "--verify-key=" + key], capture_output=True, text=True)
        sealed_report = {"setup": sealing["setup"], "fss": sealing["fss"], "machine": sealing["machine"], "key": key, "status": keyed.returncode, "stdout": keyed.stdout, "stderr": keyed.stderr}
    return {
        "name": name, "allocated": len(data), "file": sparse(trimmed), "export": base64.b64encode(export).decode(), "header": header,
        "verify": {"status": verify.returncode, "stdout": verify.stdout, "stderr": verify.stderr}, "sealing": sealed_report,
    }


def basic():
    return [[(b"MESSAGE", b"hello number %d" % i), (b"PRIORITY", b"6"), (b"SYSLOG_IDENTIFIER", b"oracle"), (b"CUSTOM_FIELD", b"value %d" % i)] for i in range(5)]


def variety():
    entries = []
    for i in range(60):
        fields = [(b"MESSAGE", b"repeat" if i % 3 == 0 else b"line %d" % i), (b"PRIORITY", b"%d" % (i % 8)), (b"SYSLOG_IDENTIFIER", b"oracle")]
        if i % 5 == 0:
            fields.append((b"BINARY", bytes(range(i, i + 40))))
        if i % 7 == 0:
            fields.append((b"BIG", b"x" * 1500 + b"%d" % i))
        if i % 4 == 0:
            fields.append((b"DUP", b"one"))
            fields.append((b"DUP", b"two"))
        if i % 2 == 0:
            fields.append((b"FIELD_%d" % (i % 40), b"v%d" % (i % 9)))
        entries.append(fields)
    return entries


PERSISTENT_SEALED = BASE_CONFIG.replace("Storage=volatile", "Storage=persistent") + "Seal=yes\n"


def sealed_entries():
    entries = []
    for batch in range(3):
        entries += [[(b"MESSAGE", b"sealed batch %d line %d" % (batch, i)), (b"PRIORITY", b"6"), (b"SYSLOG_IDENTIFIER", b"oracle")] for i in range(4)]
        entries.append(11)
    return entries


def rotated_sealed_entries():
    entries = []
    for batch in range(2):
        entries += [[(b"MESSAGE", b"first file batch %d line %d" % (batch, i)), (b"PRIORITY", b"6"), (b"SYSLOG_IDENTIFIER", b"oracle")] for i in range(4)]
        entries.append(11)
    entries.append("rotate")
    for batch in range(4):
        entries += [[(b"MESSAGE", b"second file batch %d line %d" % (batch, i)), (b"PRIORITY", b"6"), (b"SYSLOG_IDENTIFIER", b"oracle")] for i in range(5)]
        entries.append(11)
    return entries


def main():
    isolate()
    out = {"library": subprocess.run(["journalctl", "--version"], capture_output=True, text=True).stdout.split("\n")[0], "scenarios": []}
    out["scenarios"].append(capture("basic", basic()))
    out["scenarios"].append(capture("variety", variety()))
    out["scenarios"].append(capture("sealed", sealed_entries(), PERSISTENT_SEALED, sealed=True))
    out["scenarios"].append(capture("zstd", variety(), BASE_CONFIG.replace("Compress=no", "Compress=yes")))
    out["scenarios"].append(capture("sealed-rotated", rotated_sealed_entries(), PERSISTENT_SEALED, sealed=True))
    out["scenarios"].append(capture("sealed-first", rotated_sealed_entries(), PERSISTENT_SEALED, sealed=True, archived=True))
    stop_journald()
    with open(sys.argv[1], "w") as handle:
        json.dump(out, handle, separators=(",", ":"))
    print([(s["name"], len(s["file"]) // 2, s["verify"]["status"]) for s in out["scenarios"]])


main()
