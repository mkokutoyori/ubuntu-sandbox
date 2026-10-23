#!/usr/bin/env python3
"""Record GNU coreutils stty on real pseudo-terminals.

usage: record_stty.py out.json

Each scenario opens a fresh pty, gives it a window size and `iutf8` (what a terminal emulator or sshd leaves
on a session's pty), then runs `stty ARGS` once per step with the slave as standard input.  Standard output
and standard error are pipes, so the line width of `stty` and `stty -a` is $COLUMNS, set to the pty width
before every step.  After each step the state is read back three ways: plain `stty`, `stty -a` and `stty -g`
(which `probe` selects), so a divergence in what a step changed shows even when the step printed nothing.

A step is {"args": [...], "stdin": "tty" | "null"}.  The pty path is written `{tty}` in arguments and in the
recorded text, and the `-g` string of the previous state is written `{saved}` and resolved here, so the
fixture holds the exact arguments the real stty received.
"""
import fcntl, json, os, pty, random, re, struct, subprocess, sys, termios

ENV_BASE = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}

CONTROL = "parenb parodd cmspar cs5 cs6 cs7 cs8 hupcl hup cstopb cread clocal crtscts".split()
INPUT = "ignbrk brkint ignpar parmrk inpck istrip inlcr igncr icrnl ixon ixoff tandem iuclc ixany imaxbel iutf8".split()
OUTPUT = ("opost olcuc ocrnl onlcr onocr onlret ofill ofdel nl1 nl0 cr3 cr2 cr1 cr0 tab3 tab2 tab1 tab0 bs1 bs0 "
          "vt1 vt0 ff1 ff0").split()
LOCAL = ("isig icanon iexten echo echoe crterase echok echonl noflsh xcase tostop echoprt prterase echoctl ctlecho "
         "echoke crtkill flusho extproc").split()
COMBINATION = "evenp parity oddp nl ek sane cooked raw pass8 litout cbreak decctlq tabs lcase LCASE crt dec".split()
MODES = CONTROL + INPUT + OUTPUT + LOCAL + COMBINATION
CHARACTERS = "intr quit erase kill eof eol eol2 swtch start stop susp rprnt werase lnext flush discard".split()
SPEEDS = ("0 50 75 110 134 134.5 150 200 300 600 1200 1800 2400 4800 9600 19200 38400 exta extb 57600 115200 230400 "
          "460800 500000 576000 921600 1000000 1152000 1500000 2000000 2500000 3000000 3500000 4000000").split()
CHARACTER_VALUES = ["^C", "^X", "^?", "^-", "undef", "a", "Z", "", "65", "0x41", "0101", "255", "256", "-1", "^", "^ab",
                    "^1", "^@", "^[", "^a", "^A", "é", "abc", "0", "127", "128", "1.5"]
INTEGER_VALUES = ["0", "1", "5", "10", "255", "256", "300", "-1", "abc", "0x10", "010", "1e3", " 5", "5 ", "99999999999", "1b", "1B", "0b",
                  "1bb", "b", "B", "+5", "08", "0x", "0x1B", "1.0", "", "-0", "2147483647", "2147483648", "4294967295", "4294967296",
                  "18446744073709551615", "18446744073709551616", "99999999999999999999999", "1k", "1K", "0X1f", "0b101", "007", "00", "\t5"]

DISPLAY_PROBE = ["plain", "a", "g"]
FAST_PROBE = ["plain", "g"]


def step(*args, stdin="tty"):
    return {"args": list(args), "stdin": stdin}


def scenario(name, steps, rows=24, cols=80, probe=DISPLAY_PROBE):
    return {"name": name, "rows": rows, "cols": cols, "probe": probe, "steps": steps}


def fixed_scenarios():
    out = []
    for rows, cols in [(24, 80), (24, 40), (40, 132), (24, 20), (24, 0), (0, 0), (5, 200)]:
        out.append(scenario("display-%dx%d" % (rows, cols), [step(), step("-a"), step("-g"), step("size"), step("speed")], rows, cols))
    out.append(scenario("output-styles", [
        step("--all"), step("--save"), step("-a", "-a"), step("-g", "-g"), step("-a", "-g"), step("-ag"), step("-ga"),
        step("-a", "echo"), step("-g", "sane"), step("-a", "foo"), step("--al"), step("--a"), step("--sav"), step("--s"),
        step("--file"), step("--fi"), step("-a", "size"), step("size", "-a"), step("speed", "-g"),
    ]))
    out.append(scenario("drain", [
        step("drain"), step("-drain"), step("-drain", "-a"), step("drain", "-g"), step("-drain", "-echo"), step("drain", "echo"),
        step("-drain", "sane"), step("-drain", "cs7"), step("-drain", "-cread"),
    ]))
    out.append(scenario("errors", [
        step("foo"), step("-foo"), step("--foo"), step("--"), step("-"), step(""), step(" "), step("-", "-"), step("--", "-echo"),
        step("--", "foo"), step("sane", "foo"), step("-echo", "foo"), step("foo", "-echo"), step("rows"), step("cols"),
        step("columns"), step("intr"), step("min"), step("time"), step("ispeed"), step("ospeed"), step("line"),
        step("-F"), step("--file="), step("-evenp-"), step("-crt"), step("-dec"), step("-ek"), step("-sane"),
        step("-hup"), step("-tandem"), step("-cs8"), step("-nl1"), step("-tab0"), step("-intr"), step("-rows"),
        step("-ispeed"), step("-speed"), step("-size"), step("-9600"), step("-drain-"), step("-F", "{tty}", "-F", "{tty}"),
        step("-a", "-F", "{tty}", "-F", "{tty}"), step("--help", "foo"), step("foo", "--help"), step("--version", "foo"),
    ], probe=FAST_PROBE))
    out.append(scenario("options", [
        step("-aF", "{tty}"), step("-gF{tty}"), step("-F{tty}a"), step("-aa"), step("-ag"), step("-ge"), step("-ae"), step("-ea"),
        step("-a", "-e"), step("--all=x"), step("--save=x"), step("--file=", "-a"), step("--fil", "{tty}", "-a"), step("--f", "{tty}", "-g"),
        step("-F", "-a"), step("-F", "--help"), step("-F", "{tty}", "--help"), step("--he"), step("--h"), step("--v"), step("--ver"),
        step("---debug"), step("--debug"), step("---debug", "-a"), step("-a", "--"), step("--", "-a"), step("--", "--", "-a"),
        step("-a", "--", "echo"), step("-F", "{tty}", "--", "-echo"), step("-F", "{tty}", "-F"), step("-F", "-F", "-F"),
        step("-a", "-F", "{tty}"), step("-g", "-F", "{tty}", "-F", "{tty}"), step("-aaa"), step("-gg"), step("-agag"),
        step("-a", "-a", "-g"), step("-d"), step("-ad"), step("-x", "-a"), step("-a", "-x"), step("-a", "foo"), step("foo", "-a"),
        step("-drain"), step("--drain"), step("-drain", "-drain"), step("drain", "-drain", "-a"), step("-a", "-drain"), step("-a", "drain"),
        step("-g", "drain"), step("size", "-drain"), step("-drain", "size"), step("--", "drain"), step("--", "-drain"),
    ], probe=FAST_PROBE))
    out.append(scenario("quoting", [step("-F", name) for name in quoting_names()], probe=["g"]))
    out.append(scenario("information", [step("--help"), step("--version"), step("-a", "--help"), step("--help", "--version")], probe=["g"]))
    out.append(scenario("device", [
        step("-F", "{tty}"), step("-F", "{tty}", "-a"), step("--file={tty}", "-g"), step("-F{tty}", "size"),
        step("--file", "{tty}", "speed"), step("-F", "{tty}", "-echo"), step("-F", "{tty}", "echo"), step("--fi={tty}"),
        step("-F", "/dev/null"), step("-F", "/dev/null", "-a"), step("-F", "/dev/null", "-echo"), step("-F", "/dev/null", "foo"),
        step("-F", "/nonexistent"), step("-F", "/nonexistent", "-a"), step("-F", "/etc/passwd"), step("-F", "/tmp"),
        step("-F", ""), step("-F", "{tty}", "foo"), step("-F", "/dev/null", "rows", "abc"),
    ], probe=FAST_PROBE))
    out.append(scenario("no-tty", [
        step(stdin="null"), step("-a", stdin="null"), step("-g", stdin="null"), step("size", stdin="null"),
        step("speed", stdin="null"), step("sane", stdin="null"), step("-echo", stdin="null"), step("foo", stdin="null"),
        step("rows", "30", stdin="null"), step("cols", "abc", stdin="null"), step("-F", "{tty}", "-a", stdin="null"),
        step("-F", "{tty}", "-echo", stdin="null"), step("drain", stdin="null"), step("-a", "-g", stdin="null"),
    ]))
    for flag in MODES:
        out.append(scenario("mode-" + flag, [step(flag), step("-" + flag), step(flag), step("sane")], probe=DISPLAY_PROBE))
    out.append(scenario("combinations", [
        step("raw"), step("-raw"), step("cooked"), step("-cooked"), step("raw", "sane"), step("raw", "cooked"),
        step("cbreak"), step("-cbreak"), step("pass8"), step("-pass8"), step("litout"), step("-litout"),
        step("evenp"), step("-evenp"), step("parity"), step("-parity"), step("oddp"), step("-oddp"),
        step("nl"), step("-nl"), step("ek"), step("decctlq"), step("-decctlq"), step("tabs"), step("-tabs"),
        step("lcase"), step("-lcase"), step("LCASE"), step("-LCASE"), step("crt"), step("dec"), step("sane"),
        step("-echo", "-icanon", "min", "3", "time", "5"), step("raw"), step("sane"), step("raw", "-echo", "icanon"),
        step("cooked"), step("sane"), step("-isig", "intr", "^X"), step("sane"), step("dec"), step("sane"),
    ]))
    for name in CHARACTERS:
        out.append(scenario("character-" + name, [step(name, v) for v in CHARACTER_VALUES] + [step("sane")], probe=["plain", "g"]))
    for name in ["min", "time"]:
        out.append(scenario("integer-" + name, [step(name, v) for v in INTEGER_VALUES] + [step("-icanon"), step(name, "7"), step("sane")], probe=["plain", "g"]))
    out.append(scenario("speeds", [step(v) for v in SPEEDS] + [step("1234"), step("abc"), step("9600.5"), step("-9600"), step("speed")], probe=["plain", "g"]))
    out.append(scenario("speeds-split", [
        step("ispeed", "9600"), step("ospeed", "19200"), step("ispeed", "19200", "ospeed", "9600"), step("ispeed", "9600", "ospeed", "9600"),
        step("ospeed", "115200"), step("ispeed", "0"), step("ospeed", "0"), step("0"), step("ispeed", "bogus"), step("ospeed", "bogus"),
        step("ospeed", "50", "ispeed", "50"), step("9600", "ospeed", "19200"), step("ospeed", "19200", "9600"), step("speed", "9600"),
        step("ispeed", "134.5"), step("ospeed", "exta"), step("extb"), step("ispeed", "300", "-echo"), step("sane"),
    ], probe=["plain", "a", "g"]))
    out.append(scenario("window", [
        step("rows", "30"), step("cols", "100"), step("columns", "90"), step("rows", "0"), step("cols", "0"), step("rows", "30", "cols", "100", "size"),
        step("size", "rows", "10"), step("rows", "-1"), step("rows", "1x"), step("rows", "0x10"), step("rows", "010"), step("rows", "2147483647"),
        step("rows", "2147483648"), step("rows", "99999999999"), step("cols", "65535"), step("cols", "65536"), step("rows", "abc", "cols", "5"),
        step("cols", "5", "rows", "abc"), step("-echo", "rows", "abc"), step("rows", "12", "-echo", "size", "cols", "abc"), step("rows", "24", "cols", "80"),
        step("rows", "7", "rows", "8", "size"), step("cols", "33", "-a"),
    ], probe=["plain", "a", "g"]))
    out.append(scenario("window-wrap", [step("cols", "40"), step("-a"), step(), step("cols", "132"), step("-a"), step("cols", "10"), step("-a"), step(), step("cols", "1"), step("-a")], probe=["plain", "a", "g"]))
    out.append(scenario("line", [step("line", "0"), step("line", "1"), step("line", "2"), step("line", "255"), step("line", "256"), step("line", "abc"), step("line", "-1"), step("line", "4294967296"), step("line", "0"), step()], probe=["plain", "a", "g"]))
    out.append(scenario("recoverable", [
        step("-echo", "-icanon", "intr", "^X", "min", "4"), step("-g"), step("sane"), step("{saved}"), step("sane"),
        step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("abc"), step("1:2:3"), step("500:5:bf:8a3b"), step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0x"),
        step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:100"),
        step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:ff"),
        step("1ffffffff:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("-500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("0X500:5:bf:8A3B:3:1C:7F:15:4:0:1:0:11:13:1A:0:12:F:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step(" 500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("0:0:bf:0:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("500:5:b0:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
        step("500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0", "-echo"),
        step("-echo", "500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"),
    ], probe=["plain", "a", "g"]))
    out.append(scenario("pty-normalisation", [
        step("cs5"), step("cs6"), step("cs7"), step("cs8"), step("parenb"), step("-cread"), step("cs7", "-echo"), step("-echo", "cs7"),
        step("parenb", "-icanon"), step("evenp"), step("oddp"), step("pass8"), step("-pass8"), step("litout"), step("-litout"),
        step("-cread", "echo"), step("cread"), step("-drain", "cs7"), step("-drain", "cread"), step("-drain", "-cread"),
        step("-drain", "parenb"), step("-drain", "cs5"), step("-drain", "-hupcl"), step("-drain", "-echo"), step("drain", "-cread", "-echo"),
        step("cmspar"), step("parodd"), step("parenb", "parodd"), step("-parenb"), step("crtscts"), step("-crtscts"), step("clocal"), step("hupcl"),
        step("cs7", "intr", "^X"), step("cs7", "line", "3"), step("cs7", "min", "5"), step("parenb", "eof", "^A"), step("cs7", "-drain"),
        step("cs7", "ispeed", "300"), step("-cread", "time", "3"), step("-cread", "9600"), step("cs7", "line", "0"), step("cs7", "-parodd"),
        step("-cread", "tab3"), step("cs6", "-hupcl"), step("cs6", "extproc"), step("cs6", "-extproc"), step("-cread", "flusho"),
        step("-cread", "echoke"), step("sane", "cs7"), step("cs7", "sane"), step("cs5", "intr", "^C"), step("cs5", "intr", "^D"),
    ], probe=["plain", "a", "g"]))
    return out


def quoting_names():
    names = ["a b", "a'b", "a$b", "a*b", "~x", "a~", "#x", "a#b", "\u00e9", "a\tb", "a=b", "a\\b", "a\nb", "a\"b", "a!b", "a'b c",
             "'", "''", "a'", "'a", "a'b\"c", "a'b$c", "\x01", "x\x7fy", "x\x1b[0m", "\u65e5\u672c", "a:b", "a'b:c", "\u00e9'", "a'\tb",
             "'$", "a b'c d", "a%b", "a,b", "a@b", "a+b", "{", "}", "a{b", "a}b", "a]b", "a[b", "\\", "-a", " ", "\x07\x08\x0b\x0c\r"]
    rng = random.Random(7)
    alphabet = ["a", "b", " ", "'", '"', "$", "\\", "!", "\t", "\u00e9", "#", "~", "*", ":", "-", "\x01", "="]
    for _ in range(150):
        names.append("".join(rng.choice(alphabet) for _ in range(rng.randint(1, 7))))
    return names


def token_pool():
    tokens = []
    for mode in MODES:
        tokens.append([mode])
        tokens.append(["-" + mode])
    for name in CHARACTERS:
        for value in CHARACTER_VALUES[:14]:
            tokens.append([name, value])
    for name in ["min", "time"]:
        for value in ["0", "1", "5", "255"]:
            tokens.append([name, value])
    for speed in SPEEDS:
        tokens.append([speed])
    tokens += [["rows", "10"], ["cols", "50"], ["columns", "120"], ["size"], ["speed"], ["ispeed", "9600"], ["ospeed", "115200"],
               ["drain"], ["-drain"], ["foo"], ["rows", "x"], ["intr"], ["-g"], ["-a"], ["line", "3"], ["line", "300"], ["ispeed", "0"],
               ["ospeed", "0"], ["ispeed", "300", "ospeed", "300"], ["ospeed", "9600", "ispeed", "19200"], ["-F", "{tty}"], ["--"], ["-"],
               ["^x"], ["0x"], ["min", "x"], ["time", "300"], ["eof", "^-"], ["erase", "undef"], ["kill", "^?"], ["-ek"], ["-crt"],
               ["500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"],
               ["4500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"],
               ["0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"],
               ["ffffffff:ffffffff:ffffffff:ffffffff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff"]]
    return tokens


def random_scenarios(count, seed):
    rng = random.Random(seed)
    pool = token_pool()
    out = []
    for index in range(count):
        steps = []
        for _ in range(rng.randint(1, 6)):
            words = []
            for _ in range(rng.choice([1, 1, 2, 3, 4])):
                words += rng.choice(pool)
            steps.append(step(*words))
        rows, cols = rng.choice([(24, 80), (24, 80), (24, 80), (30, 100), (10, 132), (50, 40)])
        probe = DISPLAY_PROBE if index % 5 == 0 else FAST_PROBE
        out.append(scenario("random-%d-%d" % (seed, index), steps, rows, cols, probe))
    return out


def run_stty(slave, args, stdin, columns, tty_path):
    env = dict(ENV_BASE)
    env["COLUMNS"] = str(columns)
    resolved = [a.replace("{tty}", tty_path) for a in args]
    stdin_fd = slave if stdin == "tty" else subprocess.DEVNULL
    done = subprocess.run(["stty"] + resolved, stdin=stdin_fd, capture_output=True, env=env, timeout=10)
    return (done.stdout.decode("utf-8", "replace").replace(tty_path, "{tty}"),
            done.stderr.decode("utf-8", "replace").replace(tty_path, "{tty}"),
            done.returncode)


def window_columns(slave):
    packed = fcntl.ioctl(slave, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    return struct.unpack("HHHH", packed)[1]


def probe_state(slave, probes, columns, tty_path):
    state = {}
    for kind in probes:
        flag = {"plain": [], "a": ["-a"], "g": ["-g"]}[kind]
        out, err, code = run_stty(slave, flag, "tty", columns, tty_path)
        state[kind] = out if code == 0 else "ERR:" + err
    return state


def record_scenario(sc):
    master, slave = pty.openpty()
    tty_path = os.readlink("/proc/self/fd/%d" % slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", sc["rows"], sc["cols"], 0, 0))
    subprocess.run(["stty", "iutf8"], stdin=slave, env=ENV_BASE, check=True)
    entry = {"name": sc["name"], "rows": sc["rows"], "cols": sc["cols"], "probe": sc["probe"], "steps": [], "initial": None}
    entry["initial"] = probe_state(slave, sc["probe"], window_columns(slave), tty_path)
    saved = probe_state(slave, ["g"], window_columns(slave), tty_path)["g"].strip()
    for st in sc["steps"]:
        args = [a.replace("{saved}", saved) for a in st["args"]]
        columns = window_columns(slave)
        out, err, code = run_stty(slave, args, st["stdin"], columns, tty_path)
        state = probe_state(slave, sc["probe"], window_columns(slave), tty_path)
        saved = probe_state(slave, ["g"], window_columns(slave), tty_path)["g"].strip() if "g" not in state else state["g"].strip()
        entry["steps"].append({"args": [a.replace(tty_path, "{tty}") for a in args], "stdin": st["stdin"], "columns": columns,
                               "stdout": out, "stderr": err, "code": code, "state": state})
    os.close(slave)
    os.close(master)
    return entry


def main():
    target = sys.argv[1]
    scenarios = fixed_scenarios() + random_scenarios(260, 1) + random_scenarios(500, 2)
    version = subprocess.run(["stty", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    recorded = [record_scenario(sc) for sc in scenarios]
    json.dump({"stty": version, "scenarios": recorded}, open(target, "w"), indent=0, ensure_ascii=False)
    print(len(recorded), "scenarios,", sum(len(r["steps"]) for r in recorded), "steps")


main()
