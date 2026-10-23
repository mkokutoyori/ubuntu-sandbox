#!/usr/bin/env python3
"""Record the real vsftpd 3.0.5 answering the real curl 8.5.0 in active and passive mode.

usage: record_vsftpd_curl.py TOOLS_ROOT LIBS_ROOT out.json

TOOLS_ROOT holds the extracted vsftpd deb (usr/sbin/vsftpd), LIBS_ROOT the extracted libwrap0 deb. A throw-away vsftpd listens on
127.0.0.1:2121 with an anonymous root holding test.txt (10 bytes) and a world-writable up/ directory; every case restarts it with the
extra configuration lines of the case, runs curl -v and keeps the command and reply lines (the lines curl prints behind '>' and '<').
The simulator replays the same cases in vsftpd-curl-oracle.test.ts and compares the normalised transcripts.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

CLIENT = "127.0.0.1"
OTHER = "127.0.0.2"
WRITABLE = "write_enable=YES\nanon_upload_enable=YES"

CASES = [
    ("passive-download", "", [], "/test.txt"),
    ("passive-no-epsv", "", ["--disable-epsv"], "/test.txt"),
    ("passive-list", "", [], "/"),
    ("passive-missing-file", "", [], "/nosuch.txt"),
    ("active-eprt", "", ["-P", "-"], "/test.txt"),
    ("active-port", "", ["-P", "-", "--disable-eprt"], "/test.txt"),
    ("active-port-range", "", ["-P", CLIENT + ":50000-50010"], "/test.txt"),
    ("active-other-address", "", ["-P", OTHER], "/test.txt"),
    ("active-reserved-port", "", ["-P", CLIENT + ":500"], "/test.txt"),
    ("active-list", "", ["-P", "-"], "/"),
    ("active-nlst", "", ["-P", "-", "-l"], "/"),
    ("active-upload", WRITABLE, ["-P", "-", "-T", "UPLOAD"], "/up/active.txt"),
    ("passive-upload", WRITABLE, ["-T", "UPLOAD"], "/up/passive.txt"),
    ("port-disabled", "port_enable=NO", ["-P", "-"], "/test.txt"),
    ("pasv-disabled", "pasv_enable=NO", [], "/test.txt"),
    ("pasv-disabled-active", "pasv_enable=NO", ["-P", "-"], "/test.txt"),
    ("download-disabled", "download_enable=NO", [], "/test.txt"),
    ("dirlist-disabled", "dirlist_enable=NO", ["-l"], "/"),
    ("port-promiscuous", "port_promiscuous=YES", ["-P", CLIENT + ":500"], "/test.txt"),
]

LOGIN = ["USER anonymous", "PASS x"]

RAW_CASES = [
    ("pasv-address", "pasv_address=1.2.3.4", LOGIN + ["PASV"]),
    ("pasv-port-range", "pasv_min_port=40000\npasv_max_port=40010", LOGIN + ["EPSV", "EPSV", "EPSV"]),
    ("illegal-port-commands", "", LOGIN + ["PORT 1,2,3,4,5,6", "PORT 127,0,0,1,0,80", "PORT garbage", "EPRT |3|1.2.3.4|5|", "EPRT |1|bad|5|", "EPRT garbage",
                                             "EPRT |1|127.0.0.1|500|"]),
    ("port-before-login", "", ["PORT 127,0,0,1,200,1", "PASV"]),
    ("retr-without-channel", "", LOGIN + ["RETR test.txt", "RETR nosuch.txt", "LIST", "STOR x.txt"]),
    ("promiscuous-port-commands", "port_promiscuous=YES", LOGIN + ["PORT 1,2,3,4,5,6", "EPRT |1|1.2.3.4|5|"]),
    ("pasv-after-port-disabled", "port_enable=NO", LOGIN + ["PORT 127,0,0,1,200,1", "EPRT |1|127.0.0.1|50000|", "PASV"]),
]

def converse(commands):
    with socket.create_connection(("127.0.0.1", 2121), timeout=5) as connection:
        reader = connection.makefile("r", newline="\r\n")
        lines = []
        def read_reply():
            first = reader.readline().rstrip("\r\n")
            lines.append("< " + first)
            if first[3:4] == "-":
                while True:
                    more = reader.readline().rstrip("\r\n")
                    lines.append("< " + more)
                    if more.startswith(first[:3] + " "):
                        break
        read_reply()
        for command in commands:
            lines.append("> " + command)
            connection.sendall((command + "\r\n").encode())
            try:
                read_reply()
            except (socket.timeout, ConnectionError):
                break
        return lines

def main():
    tools, libs, target = sys.argv[1:4]
    work = tempfile.mkdtemp()
    anon = os.path.join(work, "anon")
    os.makedirs(os.path.join(anon, "up"))
    os.chmod(os.path.join(anon, "up"), 0o777)
    open(os.path.join(anon, "test.txt"), "w").write("HELLO_FTP\n")
    os.chmod(anon, 0o755)
    upload = os.path.join(work, "upload.txt")
    open(upload, "w").write("hi\n")
    empty = os.path.join(work, "empty")
    os.makedirs(empty)
    env = dict(os.environ, LD_LIBRARY_PATH=":".join([
        os.path.join(libs, "lib/x86_64-linux-gnu"), os.path.join(libs, "usr/lib/x86_64-linux-gnu")]))
    base = ["listen=YES", "listen_port=2121", "anonymous_enable=YES", "anon_root=" + anon, "secure_chroot_dir=" + empty,
            "seccomp_sandbox=NO", "background=YES", "connect_from_port_20=YES"]
    fixture = {"vsftpd": "3.0.5", "curl": "8.5.0", "client": CLIENT, "other": OTHER, "cases": {}}
    for name, extra, args, path in CASES:
        subprocess.run(["pkill", "vsftpd"], capture_output=True)
        time.sleep(0.3)
        conf = os.path.join(work, name + ".conf")
        open(conf, "w").write("\n".join(base + extra.split("\n")) + "\n")
        subprocess.run([os.path.join(tools, "usr/sbin/vsftpd"), conf], env=env, check=True)
        time.sleep(0.5)
        arguments = [upload if a == "UPLOAD" else a for a in args]
        run = subprocess.run(["curl", "-sv", "-m", "8"] + arguments + ["ftp://127.0.0.1:2121" + path],
                             capture_output=True, text=True)
        lines = [l for l in run.stderr.split("\n") if l.startswith("> ") or l.startswith("< ")]
        fixture["cases"][name] = {"conf": extra, "args": args, "path": path, "exit": run.returncode, "lines": lines}
    fixture["raw"] = {}
    for name, extra, commands in RAW_CASES:
        subprocess.run(["pkill", "vsftpd"], capture_output=True)
        time.sleep(0.3)
        conf = os.path.join(work, name + ".conf")
        open(conf, "w").write("\n".join(base + extra.split("\n")) + "\n")
        subprocess.run([os.path.join(tools, "usr/sbin/vsftpd"), conf], env=env, check=True)
        time.sleep(0.5)
        fixture["raw"][name] = {"conf": extra, "commands": commands, "lines": converse(commands)}
    subprocess.run(["pkill", "vsftpd"], capture_output=True)
    shutil.rmtree(work, ignore_errors=True)
    json.dump(fixture, open(target, "w"), indent=1)

if __name__ == "__main__":
    main()
