#!/usr/bin/env python3
"""Record the real journalctl (systemd 255.4) over the corpus produced by record_journal_corpus.py.

usage: record_journalctl.py corpus_dir out.json

Every invocation reads the offline journal with --directory, with the realtime clock, the time zone and LC_ALL pinned
(scripts/oracle/last_shim.c), and stores stdout, stderr and the exit status next to the export of the whole corpus.
"""
import base64, hashlib, json, os, re, subprocess, sys

NOW = 1791510700
CURSOR_FILE = "/tmp/jcorpus.cursorfile"
ZONES = ["UTC", "Europe/Paris", "America/New_York"]
BOOTS = ["11111111222243338444555555555551", "11111111222243338444555555555552", "11111111222243338444555555555553"]
OUTPUTS = ["short", "short-full", "short-iso", "short-iso-precise", "short-precise", "short-monotonic", "short-unix", "short-delta", "verbose", "export", "json", "json-pretty", "json-sse", "json-seq", "cat", "with-unit"]

def cases(cursors):
    out = [[], ["-r"], ["-n", "5"], ["-n", "0"], ["-n", "all"], ["-n"], ["-n", "+3"], ["-n", "3", "-r"], ["--no-tail"], ["--no-tail", "-n", "4"], ["-n", "bogus"], ["-n", "-1"], ["-q"], ["-q", "-b", "9"],
           ["--utc"], ["--no-hostname"], ["-a"], ["-l"], ["--full"], ["--no-full"], ["--no-full", "-n", "30"], ["-x", "-n", "2"], ["--show-cursor", "-n", "2"], ["--show-cursor", "-n", "0"],
           ["--list-boots"], ["--list-boots", "-r"], ["--list-boots", "-n", "2"], ["--list-boots", "--utc"], ["-b", "0"], ["-b", "1"], ["-b", "2"], ["-b", "3"], ["-b", "-1"], ["-b", "-2"], ["-b", "-3"], ["-b", "-1", "-n", "3"], ["-b", "all"], ["-b", "bogus"], ["-b", "-0"],
           ["-b", BOOTS[0]], ["-b", BOOTS[1], "-n", "3"], ["-b", BOOTS[2] + "+1"], ["-b", BOOTS[2] + "-1"], ["-b", "11111111-2222-4333-8444-555555555551"], ["-b", BOOTS[0][:8]], ["-b", "11111111222243338444555555555599"],
           ["-u", "ssh.service"], ["-u", "ssh"], ["-u", "cron", "-u", "nginx"], ["-u", "myapp.service", "-r"], ["-u", "session-3.scope"], ["-u", "nope"], ["-u", ""], ["-u", "ssh*"], ["-u", "sshd.service"], ["--unit=ssh", "--unit=cron.service"],
           ["-p", "err"], ["-p", "3"], ["-p", "warning"], ["-p", "debug"], ["-p", "emerg"], ["-p", "notice..err"], ["-p", "err..warning"], ["-p", "0..3"], ["-p", "4..6"], ["-p", "..3"], ["-p", "3.."], ["-p", "bogus"], ["-p", "9"], ["-p", "info", "-u", "ssh"], ["-p", "crit", "-b", "-1"],
           ["-t", "sshd"], ["-t", "sshd", "-t", "sudo"], ["-t", "nope"], ["-t", "myapp", "-n", "4"], ["-t", "logger"], ["--identifier=nginx"], ["-T", "sshd"], ["--exclude-identifier=myapp", "--exclude-identifier=systemd-journald"],
           ["--facility=auth"], ["--facility=4"], ["--facility=cron,authpriv"], ["--facility=help"], ["--facility=bogus"],
           ["-g", "port 22"], ["-g", "^Accepted"], ["-g", "ssh2$"], ["-g", "FAILED"], ["-g", "FAILED", "--case-sensitive=no"], ["-g", "failed", "--case-sensitive=yes"], ["-g", "failed", "--case-sensitive"], ["-g", "[unclosed"], ["-g", "x{300}"], ["-g", ""], ["-g", "nothing matches this"], ["-g", "unicode", "-o", "json"], ["-g", "\\d+", "-n", "3"],
           ["_PID=2209"], ["_COMM=sshd"], ["_COMM=sshd", "_COMM=cron"], ["_COMM=sshd", "+", "_COMM=cron"], ["_COMM=sshd", "PRIORITY=3"], ["PRIORITY=3", "+", "PRIORITY=4"], ["_SYSTEMD_UNIT=ssh.service", "PRIORITY=6", "+", "_SYSTEMD_UNIT=cron.service"], ["_UID=0", "_GID=0", "-n", "2"], ["NOPE=1"], ["bogus"], ["="], ["=x"], ["_PID="], ["+"], ["_COMM=sshd", "+"], ["+", "_COMM=sshd"],
           ["_TRANSPORT=syslog"], ["_TRANSPORT=journal", "-n", "3"], ["_TRANSPORT=stdout", "-n", "3"], ["_TRANSPORT=driver", "-n", "3"], ["SYSLOG_FACILITY=4", "-n", "2"], ["CUSTOM_FIELD=custom value"], ["MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1"], ["/usr/sbin/sshd"], ["/usr/bin/python3.11", "-n", "1"], ["/dev/null"], ["/absent-dir/path"],
           ["-F", "_SYSTEMD_UNIT"], ["-F", "PRIORITY"], ["-F", "_BOOT_ID"], ["-F", "SYSLOG_IDENTIFIER"], ["-F", "_COMM"], ["-F", "_TRANSPORT"], ["-F", "MESSAGE_ID"], ["-F", "NOPE"], ["-F", "lower"], ["-F", "_COMM", "-b", "-1"], ["-F", "_COMM", "-u", "ssh"], ["-F", "PRIORITY", "-p", "err"], ["-F"], ["--field=_UID"], ["-N"], ["--fields"],
           ["--since", "2024-03-02"], ["--since", "2024-03-02 17:20:07"], ["--until", "2024-03-02 17:20:07"], ["-S", "2024-03-02 17:20:00", "-U", "2024-03-02 17:20:30"], ["--since", "2023-11-14 21:56:41", "--until", "2023-11-14 21:56:43"], ["--since", "yesterday"], ["--since", "today"], ["--since", "now"], ["--since", "-1h"], ["--since", "-1day", "-n", "3"], ["--since", "1 hour ago", "-n", "2"],
           ["--since", "tomorrow"], ["--until", "yesterday", "-n", "2"], ["--until", "now", "-n", "2"], ["--since", "bogus"], ["--until", "bogus"], ["--since", "2024-07-25", "--until", "2024-03-02"], ["--since", "@1709400005"], ["--since", "2024-03-02T17:20:07Z"], ["--since", "2024-03-02 17:20:07 UTC"], ["--since", "17:20:07"], ["--since", "2024-03-02 17:20"], ["--until", "2024-03-02 17:20:06.5"], ["--since", "+1h"],
           ["-S", "2024-03-02 17:20:00", "-b", "-1"], ["-k"], ["-k", "-b", "all"], ["--dmesg"], ["--system"], ["--user"], ["-m"], ["--merge"], ["--no-pager"], ["--reverse"], ["--lines=2"], ["--lines=+2"], ["--lines=all"], ["--lines"],
           ["--output-fields=MESSAGE,PRIORITY", "-o", "json", "-n", "2"], ["--output-fields=MESSAGE", "-o", "verbose", "-n", "2"], ["--output-fields=_COMM", "-o", "export", "-n", "2"], ["--output-fields=", "-o", "json", "-n", "1"],
           ["--version"], ["--help"], ["-x", "-t", "systemd-journald"], ["-x", "-o", "verbose", "-t", "systemd-journald", "-n", "4"], ["-x", "-o", "json", "-t", "systemd-journald", "-n", "2"], ["-x", "-o", "cat", "-n", "3"], ["-x", "-o", "short-iso", "-t", "systemd-journald"], ["-x", "-u", "myapp", "-n", "2"], ["-x", "MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1"], ["-x", "MESSAGE_ID=d93fb3c9c24d451a97cea615ce59c00b", "-n", "1"], ["--dump-catalog"], ["--dump-catalog", "f77379a8490b408bbe5f6940505a777b"], ["--dump-catalog", "f77379a8490b408bbe5f6940505a777b", "ec387f577b844b8fa948f33cad9a75e6"], ["--dump-catalog", "bogus"], ["--dump-catalog", "00000000000000000000000000000000"], ["--dump-catalog", "f77379a8490b408bbe5f6940505a777b", "bogus", "0e4284a0caca4bfc81c0bb6786972673"], ["--list-catalog", "f77379a8490b408bbe5f6940505a777b"], ["--list-catalog", "bogus"], ["--dump-catalog", "-q"], ["--list-boots", "-o", "json"], ["--list-boots", "-o", "json-pretty"], ["--list-boots", "-q"], ["--list-boots", "-o", "cat"], ["--list-boots", "-o", "verbose"], ["--list-boots", "-b", "0"], ["-h"], ["--bogus"], ["-o"], ["-o", "bogus"], ["-o", "help"], ["--output=help"], ["-o", "short", "-o", "cat"], ["--output=verbose", "-n", "1"],
           ["--disk-usage"], ["--list-catalog"], ["--verify"], ["--header"], ["-D"], ["--directory"], ["--file=/nonexistent"], ["--machine=bogus"], ["--root=/nonexistent"], ["--namespace=bogus"],
           ["--boot", "-n", "1"], ["--catalog", "-n", "1"], ["-e", "-n", "1"], ["-c"], ["--cursor"], ["--cursor", "bogus"], ["--after-cursor", "bogus"], ["--after-cursor"]]
    out += [["--cursor-file=@CF@", "-n", "3"], ["--cursor-file=@CF@"], ["--cursor-file=@CF@", "-r", "-n", "2"], ["--cursor-file=@CF@", "--show-cursor", "-n", "2"], ["--cursor-file=@CF@", "-c", "x"], ["--cursor-file=@CF@", "--after-cursor=x"]]
    for cursor in cursors:
        out += [["--cursor", cursor], ["--after-cursor", cursor, "-n", "3"], ["-c", cursor, "-r", "-n", "2"], ["--cursor", cursor, "--show-cursor"], ["--until-cursor" if False else "--after-cursor", cursor, "-b", "0", "-n", "2"]]
    for mode in OUTPUTS:
        out += [["-o", mode, "-n", "12"]] if mode.startswith("short") else []
        out += [["-o", mode], ["-o", mode, "-r", "-n", "9"], ["-o", mode, "-b", "-1", "-n", "6"], ["-o", mode, "-t", "myapp"], ["-o", mode, "-t", "nginx", "-n", "4"], ["-o", mode, "-t", "sudo"], ["-o", mode, "-p", "err", "-n", "5"], ["-o", mode, "--no-hostname", "-n", "3"], ["-o", mode, "-a", "-t", "myapp"], ["-o", mode, "-t", "myapp", "--no-full"], ["-o", mode, "-t", "myapp", "-l"], ["-o", mode, "-t", "myapp", "-q"], ["-o", mode, "--utc", "-n", "3"], ["-o", mode, "--show-cursor", "-n", "2"], ["-o", mode, "-t", "sshd", "-n", "2", "-x"], ["-o", mode, "-u", "cron", "--output-fields=PRIORITY"], ["-o", mode, "-n", "2", "--output-fields=_PID" if mode == "cat" else "--output-fields=_PID,MESSAGE"]]
    return out

def tree_digest(root):
    digest = hashlib.sha256()
    for directory, _, names in sorted(os.walk(root)):
        for name in sorted(names):
            digest.update(name.encode() + open(os.path.join(directory, name), "rb").read())
    return digest.hexdigest()

def parse_export(data):
    entries, fields, pos = [], [], 0
    while pos < len(data):
        end = data.index(b"\n", pos)
        line = data[pos:end]
        if line == b"":
            if fields:
                entries.append(fields)
            fields, pos = [], end + 1
            continue
        if b"=" in line:
            name, _, value = line.partition(b"=")
            pos = end + 1
        else:
            name = line
            size = int.from_bytes(data[end + 1:end + 9], "little")
            value = data[end + 9:end + 9 + size]
            pos = end + 9 + size + 1
        fields.append((name.decode(), value))
    if fields:
        entries.append(fields)
    return entries

def verbose_orders(corpus, env):
    out = subprocess.run(["journalctl", f"--directory={os.path.join(corpus, 'journal')}", "--no-pager", "-o", "verbose", "-a"], capture_output=True, env=env, stdin=subprocess.DEVNULL).stdout
    orders, current = [], None
    for line in out.split(b"\n"):
        if line and not line.startswith(b" ") and not line.startswith(b"-- "):
            current = []
            orders.append(current)
        elif current is not None:
            match = re.match(rb"^ {4}([A-Za-z_][A-Za-z0-9_]*)=", line)
            if match:
                current.append(match.group(1).decode())
    return orders

def build_entries(corpus):
    env = dict(os.environ, TZ="UTC", LC_ALL="C")
    export = open(os.path.join(corpus, "entries.export"), "rb").read()
    orders = verbose_orders(corpus, env)
    result = []
    for fields, order in zip(parse_export(export), verbose_orders(corpus, env)):
        header = dict(fields[:6])
        cursor = header["__CURSOR"].decode()
        rest = {}
        for name, value in fields[6:]:
            rest.setdefault(name, []).append(value)
        rest.setdefault("_BOOT_ID", []).append(header["_BOOT_ID"])
        ordered, seen = [], {}
        for name in order:
            index = seen.get(name, 0)
            seen[name] = index + 1
            ordered.append([name, base64.b64encode(rest[name][index]).decode()])
        result.append({"cursor": cursor, "realtime": int(header["__REALTIME_TIMESTAMP"]), "monotonic": int(header["__MONOTONIC_TIMESTAMP"]), "seqnum": int(header["__SEQNUM"]), "seqnumId": header["__SEQNUM_ID"].decode(), "bootId": header["_BOOT_ID"].decode(), "fields": ordered})
    return result

def zone_case(args):
    if args[:1] == ["-o"] and len(args) > 1:
        return args[1].startswith("short") or args[1] in ("verbose", "with-unit")
    return args[:1] in (["--since"], ["--until"], ["--list-boots"], ["-S"], ["--utc"], ["--show-cursor"], ["-n"], ["-r"]) or args == []

def main():
    corpus, target = sys.argv[1], sys.argv[2]
    export = open(os.path.join(corpus, "entries.export"), "rb").read()
    cursors = re.findall(rb"^__CURSOR=(.*)$", export, re.M)[::37][:6]
    cursors[1] = re.findall(rb"^__CURSOR=(.*)$", export, re.M)[40]
    results = []
    before = tree_digest(os.path.join(corpus, "journal"))
    for zone in ZONES:
        for args in cases([c.decode() for c in cursors]):
            if zone != "UTC" and not zone_case(args):
                continue
            env = dict(os.environ, TZ=zone, LC_ALL="C", LD_PRELOAD="/tmp/last_shim.so", LAST_NOW=str(NOW), SYSTEMD_COLORS="0", SYSTEMD_PAGER="", SYSTEMD_LOG_LEVEL="info")
            uses_file = any("@CF@" in a for a in args)
            before_file = cursors[1].decode() if uses_file else None
            if uses_file:
                open(CURSOR_FILE, "w").write(before_file)
            real_args = [a.replace("@CF@", CURSOR_FILE) for a in args]
            run = subprocess.run(["journalctl", f"--directory={os.path.join(corpus, 'journal')}", "--no-pager"] + real_args, capture_output=True, env=env, timeout=60, stdin=subprocess.DEVNULL)
            record = {"zone": zone, "args": args, "stdout": base64.b64encode(run.stdout).decode(), "stderr": base64.b64encode(run.stderr).decode(), "exitCode": run.returncode}
            if uses_file:
                record["cursorFile"] = {"before": before_file, "after": open(CURSOR_FILE).read()}
                os.unlink(CURSOR_FILE)
            results.append(record)
    assert tree_digest(os.path.join(corpus, "journal")) == before, "a journalctl invocation modified the corpus"
    json.dump({"now": NOW, "entries": build_entries(corpus), "results": results}, open(target, "w"))
    print(len(results), "cases")

main()
