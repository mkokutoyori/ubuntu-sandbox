#!/usr/bin/env python3
"""Record chronyc 4.5 against a real chronyd 4.5 (Ubuntu 24.04), in states that need no network.

usage: record_chronyc.py NTP_ROOT out.json

Each scenario is a chrony.conf; chronyd runs with -x (no clock control) on loopback command ports and every chronyc command is
executed non-interactively.  Values that depend on time (uptime-like fields, timestamps) are kept as printed; the replay test
compares structure (column headers, rules, wording, error messages, exit codes) and the state-independent numbers.
"""
import json, os, socket, subprocess, sys, tempfile, time

CMDS = [
    ["tracking"], ["tracking", "-c"], ["sources"], ["sources", "-v"], ["sources", "-a"], ["sources", "-n"], ["sources", "-c"],
    ["sourcestats"], ["sourcestats", "-v"], ["sourcestats", "-a"], ["sourcestats", "-c"],
    ["ntpdata"], ["ntpdata", "192.0.2.77"], ["ntpdata", "203.0.113.9"], ["activity"], ["activity", "-c"], ["serverstats"], ["serverstats", "-c"],
    ["clients"], ["clients", "-a"], ["clients", "-p", "0"], ["clients", "-c"], ["selectdata"], ["selectdata", "-v"], ["selectdata", "-a"], ["authdata"], ["authdata", "-a"],
    ["smoothing"], ["rtcdata"], ["manual", "list"], ["manual", "on"], ["manual", "off"], ["manual", "reset"], ["manual", "delete", "0"],
    ["sourcename", "192.0.2.77"], ["accheck", "1.2.3.4"], ["accheck", "10.1.1.1"], ["cmdaccheck", "127.0.0.1"], ["cmdaccheck", "10.0.0.1"],
    ["online"], ["offline"], ["online", "192.0.2.77"], ["offline", "192.0.2.77"], ["burst", "2/4"], ["burst", "2/4", "192.0.2.77"], ["burst", "x"],
    ["minpoll", "192.0.2.77", "4"], ["maxpoll", "192.0.2.77", "8"], ["maxdelay", "192.0.2.77", "0.5"], ["maxdelayratio", "192.0.2.77", "3"], ["maxdelaydevratio", "192.0.2.77", "10"],
    ["minstratum", "192.0.2.77", "3"], ["polltarget", "192.0.2.77", "8"], ["reselect"], ["reselectdistance", "0.001"], ["refresh"], ["reset", "sources"],
    ["add", "server", "198.51.100.5"], ["add", "server", "198.51.100.6", "iburst", "minpoll", "6"], ["add", "peer", "198.51.100.7"], ["add", "pool", "pool.example"],
    ["add", "server"], ["add"], ["delete", "198.51.100.5"], ["delete", "198.51.100.99"], ["delete"],
    ["allow", "10.0.0.0/8"], ["allow"], ["deny", "10.9.0.0/16"], ["cmdallow", "10.0.0.0/8"], ["cmddeny", "10.9.0.0/16"],
    ["makestep"], ["makestep", "1", "3"], ["makestep", "x"], ["local", "stratum", "5"], ["local", "off"], ["dump"], ["rekey"], ["cyclelogs"], ["dns", "-n"], ["dns", "-4"],
    ["waitsync", "1", "0", "0", "0.1"], ["waitsync", "x"], ["settime", "now"], ["trimrtc"], ["writertc"], ["reload", "sources"],
    ["smoothtime", "activate"], ["smoothtime", "reset"], ["maxupdateskew", "100"], ["maxchange", "1000", "1", "2"], ["ntpdata", "-c"],
    ["foo"], ["tracking", "extra"], ["sources", "-z"], ["help"], ["-v"], ["-h"],
]

def start(root, conf, run, port, ntp_port):
    path = os.path.join(run, "c.conf")
    open(path, "w").write(conf + "\nuser root\nport %d\ncmdport 0\nbindcmdaddress %s/chronyd.sock\nbindaddress 127.0.0.1\npidfile %s/c.pid\ndumpdir %s\nlogdir %s\n" % (ntp_port, run, run, run, run))
    p = subprocess.Popen([root + "/usr/sbin/chronyd", "-x", "-d", "-f", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu"))
    time.sleep(1.5)
    return p

def chronyc(root, run, args):
    env = dict(os.environ, LD_LIBRARY_PATH=root + "/usr/lib/x86_64-linux-gnu", LC_ALL="C", TZ="UTC")
    prefix = [] if args[0] in ("-v", "-h", "help") else ["-h", run + "/chronyd.sock"]
    try:
        r = subprocess.run([root + "/usr/bin/chronyc", *prefix, *args], capture_output=True, env=env, timeout=15, stdin=subprocess.DEVNULL)
        return {"args": args, "stdout": r.stdout.decode(errors="replace"), "stderr": r.stderr.decode(errors="replace"), "code": r.returncode}
    except subprocess.TimeoutExpired:
        return {"args": args, "stdout": "", "stderr": "TIMEOUT", "code": -1}

SCENARIOS = {
    "empty": "",
    "unreachable": "server 192.0.2.77 maxpoll 0\nlocal stratum 10\nallow\nratelimit\nrtcsync\nmakestep 1.0 3\ndriftfile %RUN%/drift\nlog tracking measurements statistics\nbindaddress 127.0.0.1\n",
    "local-only": "local stratum 7 orphan\nallow 10.0.0.0/8\nallow 192.168.0.0/16\ndeny 10.9.0.0/16\ncmdallow 127.0.0.1\n",
    "keys": "keyfile %RUN%/keys\nserver 192.0.2.77 key 1 maxpoll 0\npeer 192.0.2.78 key 2 maxpoll 0\n",
}

def main():
    root, target = sys.argv[1], sys.argv[2]
    out = []
    with tempfile.TemporaryDirectory() as run:
        open(os.path.join(run, "keys"), "w").write("1 MD5 secretsecret\n2 SHA1 HEX:0123456789abcdef0123456789abcdef01234567\n")
        for name, conf in SCENARIOS.items():
            p = start(root, conf.replace("%RUN%", run), run, 32301, 12301)
            try:
                for args in CMDS:
                    out.append({"scenario": name, "conf": conf, **chronyc(root, run, args)})
            finally:
                p.terminate(); p.wait()
    json.dump({"tool": "chrony 4.5", "cases": out}, open(target, "w"), separators=(",", ":"))
    print(len(out), "cases")

main()
