#!/usr/bin/env python3
"""Record the real logger (util-linux 2.39.3) by listening on the sockets it writes to.

usage: record_logger.py out.json

For every invocation a listener of the requested kind is created (AF_UNIX datagram or stream socket, loopback UDP or TCP
port), the real binary runs with time, hostname, pid and uid pinned by scripts/oracle/last_shim.c, and what the
listener received (datagrams, or the bytes of the stream) is stored with stdout, stderr and the exit status.
"""
import base64, json, os, random, shutil, socket, subprocess, sys, tempfile, threading, time

NOW = 1700000000
ZONES = ["UTC", "Europe/Paris", "America/New_York"]
MESSAGES = [["hello world"], ["a", "b", "c"], [""], ["", "x"], ["x", ""], ["café ☃"], ["%s %d %n"], ["x" * 2000], ["y" * 1024], ["y" * 1023], ["z" * 600, "z" * 600], ["w" * 400, "w" * 400, "w" * 400], ["tab\there"], ["line1\nline2"], ["<14>not a prefix"]]
STDINS = [b"one\ntwo\n", b"", b"\n\n", b"no newline", b"<14>pri\n<x>bad\n<191>max\n<192>over\n<8>fac\n<0>zero\n", b"a" * 3000 + b"\nafter\n", b"x\0y\nz\n", b"<>\n<1\n<12", b"caf\xe9\n"]
BASE = [[], ["-t", "tag"], ["-p", "user.notice"], ["-p", "local3.err"], ["-p", "kern.crit"], ["-p", "3"], ["-p", "mail.7"], ["-p", "auth.bogus"], ["-p", "bogus.info"], ["-p", "authpriv.warning"], ["-p", "24"], ["-p", "10"],
        ["-i"], ["--id"], ["--id=77"], ["--id", "77"], ["--id=-5"], ["--id=abc"], ["--id=99999999999999999999"], ["-i", "-t", "t"], ["-s"], ["-S", "10"], ["-S", "2k"], ["-S", "1.5k"], ["-S", "abc"], ["-S", "1KiB"], ["-S", "2KB"], ["-S", "-1"],
        ["--rfc3164"], ["--rfc5424"], ["--rfc5424=notime"], ["--rfc5424=notq,nohost"], ["--rfc5424=bogus"], ["--rfc5424", "--msgid", "ID47"], ["--msgid", "a b"], ["--rfc5424", "--sd-id", "exa@32473", "--sd-param", 'iut="3"'], ["--sd-id", "bad"], ["--sd-param", 'x="1"'], ["--sd-id", "a@1", "--sd-param", "novalue"],
        ["--sd-id", "timeQuality", "--sd-param", 'tzKnown="0"', "--rfc5424"], ["--sd-id", "a@1", "--sd-id", "a@1"], ["--rfc5424", "-t", "t" * 49], ["--rfc3164", "-t", "t" * 250], ["--octet-count", "--rfc5424"], ["--octet-count"], ["--prio-prefix"], ["-e"], ["--no-act"], ["--no-act", "-s"],
        ["-V"], ["--version"], ["-h"], ["--help"], ["-Z"], ["--bogus"], ["--soc"], ["--socket-errors=on"], ["--socket-errors=off"], ["--socket-errors=maybe"], ["-d"], ["-T"], ["-t"], ["-p"], ["-f", "@FILE"], ["-f", "@NOFILE"], ["-f", "@FILE", "extra message"], ["--file=@FILE", "-e"],
        ["--journald=@NOFILE"]]

def listener(kind, work):
    state = {"packets": [], "stream": b""}
    if kind in ("unix-dgram", "unix-stream"):
        path = os.path.join(work, "log.sock")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM if kind == "unix-dgram" else socket.SOCK_STREAM)
        s.bind(path)
        target = path
    elif kind == "inet-udp":
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1", 0)); target = s.getsockname()[1]
    elif kind == "inet-tcp":
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.bind(("127.0.0.1", 0)); target = s.getsockname()[1]
    else:
        return None, None, state
    if kind.endswith("stream") or kind.endswith("tcp"):
        s.listen(5)
    stop = threading.Event()
    def run():
        s.settimeout(0.05)
        conns = []
        while not stop.is_set():
            try:
                if kind.endswith("stream") or kind.endswith("tcp"):
                    c, _ = s.accept(); c.settimeout(0.05); conns.append(c)
                else:
                    state["packets"].append(s.recv(65536))
            except (socket.timeout, BlockingIOError):
                pass
            except OSError:
                break
            for c in conns:
                try:
                    chunk = c.recv(65536)
                    if chunk: state["stream"] += chunk
                except (socket.timeout, BlockingIOError, OSError):
                    pass
        for c in conns:
            try:
                while True:
                    chunk = c.recv(65536)
                    if not chunk: break
                    state["stream"] += chunk
            except Exception:
                pass
    thread = threading.Thread(target=run); thread.start()
    def close():
        time.sleep(0.15); stop.set(); thread.join(); s.close()
    return target, close, state

def main():
    rnd = random.Random(20260617)
    scenarios = []
    for index in range(150):
        env = {"TZ": rnd.choice(ZONES), "now": NOW + rnd.randint(0, 40000000), "usec": rnd.choice([0, 5, 123456, 999999]), "hostname": rnd.choice(["vm", "host.example.org", "h" * 300, "srv-01"]),
               "pid": 4242, "uid": rnd.choice([0, 1000]), "users": {"root": 0, "alice": 1000}}
        runs = []
        for _ in range(5):
            args = list(rnd.choice(BASE)) + (list(rnd.choice(MESSAGES)) if rnd.random() < .65 else [])
            if rnd.random() < .25: args = list(rnd.choice(BASE)) + args
            stdin = rnd.choice(STDINS) if rnd.random() < .5 else b""
            file_data = rnd.choice(STDINS)
            kind = rnd.choice(["unix-dgram", "unix-dgram", "unix-stream", "inet-udp", "inet-tcp", "none"])
            work = tempfile.mkdtemp()
            target, close, state = listener(kind, work)
            fpath = os.path.join(work, "input.txt")
            open(fpath, "wb").write(file_data)
            real = []
            if kind.startswith("unix"):
                real += ["-u", target]
                if kind == "unix-stream": real.append("-T")
            elif kind == "inet-udp":
                real += ["-n", "127.0.0.1", "-P", str(target), "-d"]
            elif kind == "inet-tcp":
                real += ["-n", "127.0.0.1", "-P", str(target), "-T"]
            else:
                real += ["-u", os.path.join(work, "absent.sock")]
            sub = [a.replace("@FILE", fpath).replace("@NOFILE", os.path.join(work, "nofile")) for a in args]
            e = dict(os.environ, TZ=env["TZ"], LC_ALL="C", LD_PRELOAD="/tmp/last_shim.so", LAST_NOW=str(env["now"]), LAST_USEC=str(env["usec"]), LAST_HOSTNAME=env["hostname"],
                     LAST_PID=str(env["pid"]), LAST_UID=str(env["uid"]), LAST_USERS=",".join(f"{k}:{v}" for k, v in env["users"].items()))
            p = subprocess.run(["logger"] + real + sub, input=stdin, capture_output=True, env=e, timeout=6)
            if close: close()
            norm = lambda b: b.decode("latin-1").replace(work, "@W")
            runs.append({"kind": kind, "argv": [a.replace(work, "@W").replace(fpath, "@FILE") for a in real + sub], "stdin": base64.b64encode(stdin).decode(), "file": base64.b64encode(file_data).decode(),
                         "stdout": norm(p.stdout), "stderr": norm(p.stderr), "code": p.returncode,
                         "packets": [base64.b64encode(x).decode() for x in state["packets"]], "stream": base64.b64encode(state["stream"]).decode()})
            shutil.rmtree(work)
        scenarios.append({"env": env, "runs": runs})
    json.dump({"scenarios": scenarios}, open(sys.argv[1], "w"))

main()
