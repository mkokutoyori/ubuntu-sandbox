#!/usr/bin/env python3
"""Pair what userspace wrote to /dev/kmsg with what the real systemd-journald 255.4 stored for it.

usage: record_journald_kmsg.py out.json

journald runs with ReadKMsg=yes under scripts/oracle/last_shim.c. Each probe is written to the real kernel ring buffer, read back
in /dev/kmsg's own record format (that text is what the port is fed), and the journal entry journald made from it is exported with
its field order. Probes are told apart by a trailing marker "#ktNN" inside the message.
"""
import base64, json, os, re, shutil, signal, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from journal_corpus_lib import build_entries

SHIM = "/tmp/last_shim.so"
MACHINE_ID = "0d0af05ee8fd4dc29275718f2ce4dff1"
BOOT = "11111111-2222-4333-8444-555555555561"
CONF_DIR = "/etc/systemd/journald.conf.d"
CONF = CONF_DIR + "/zz-oracle.conf"

PROBES = [
    "<6>plain kernel text", "<14>app: hello", "<30>daemon[123]: with pid", "<38>auth: login", "<0>emergency line", "<7>debug line",
    "no prefix at all", "<191>highest facility", "<14>   leading spaces", "<14>ident: ", "<14>: bare colon", "<6>line1\nline2",
    "<6>café utf8", "<6>ctl\x01char", "<6>" + "x" * 900, "<14>my-app[7]: bracket pid", "<14>weird ident: and more: colons",
    "<14>no_colon_here", "<14>a b: space ident", "<22>mail[9]:nospace", "<3>err kern", "<kern>not a number", "<>empty prefix", "<14", "<6> ",
    "<6>tab\there", "<14>x[]: empty pid", "<14>x[abc]: bad pid", "<14>[5]: only pid", "<8>facility one level zero", "<64>facility eight",
]

def read_ring():
    descriptor = os.open("/dev/kmsg", os.O_RDONLY | os.O_NONBLOCK)
    records = []
    try:
        while True:
            try:
                records.append(os.read(descriptor, 8192))
            except BlockingIOError:
                break
    finally:
        os.close(descriptor)
    return records

def main():
    os.makedirs(CONF_DIR, exist_ok=True)
    open(CONF, "w").write("[Journal]\nReadKMsg=yes\nAudit=no\nRateLimitIntervalSec=0\nStorage=persistent\n")
    work = "/tmp/kmsg-corpus"
    try:
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work)
        run_dir = f"/var/log/journal/{MACHINE_ID}"
        shutil.rmtree(run_dir, ignore_errors=True)
        shutil.rmtree(f"/run/log/journal/{MACHINE_ID}", ignore_errors=True)
        for index, probe in enumerate(PROBES):
            text = probe + f" #kt{index:02d}"
            with open("/dev/kmsg", "wb", buffering=0) as handle:
                try:
                    handle.write(text.encode("utf-8"))
                except OSError:
                    pass
        everything = read_ring()
        ring = everything
        env = dict(os.environ, LD_PRELOAD=SHIM, LAST_BOOT_ID=BOOT, LAST_MACHINE_ID=MACHINE_ID, LAST_RT_OFFSET="0")
        shutil.rmtree("/run/systemd/journal", ignore_errors=True)
        os.makedirs("/run/systemd/journal", exist_ok=True)
        journald = subprocess.Popen(["/lib/systemd/systemd-journald"], env=env, stdout=subprocess.DEVNULL, stderr=open("/tmp/jd.err", "wb"))
        time.sleep(3.0)
        journald.send_signal(signal.SIGUSR1)
        time.sleep(0.5)
        journald.send_signal(signal.SIGTERM)
        journald.wait(timeout=20)
        shutil.copytree(run_dir, os.path.join(work, "journal", MACHINE_ID))
        exported = subprocess.run(["journalctl", f"--directory={os.path.join(work, 'journal')}", "-o", "export", "--no-pager"], capture_output=True, env=dict(os.environ, LC_ALL="C"))
        open(os.path.join(work, "entries.export"), "wb").write(exported.stdout)
        entries = build_entries(work)
        kernel = [entry for entry in entries if any(name == "_TRANSPORT" and base64.b64decode(value) == b"kernel" for name, value in entry["fields"])]
        extra = len(kernel) - len(ring)
        if extra > 0:
            last = kernel[len(ring)]["seqnum"]
            entries = [entry for entry in entries if entry["seqnum"] < last]
        json.dump({"machineId": MACHINE_ID, "bootId": BOOT.replace("-", ""), "ring": [base64.b64encode(record).decode() for record in ring], "entries": entries}, open(sys.argv[1], "w"))
        print(len(ring), "ring records", len(entries), "entries")
    finally:
        os.unlink(CONF)
        shutil.rmtree(f"/var/log/journal/{MACHINE_ID}", ignore_errors=True)

main()
