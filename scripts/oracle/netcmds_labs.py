def case(id, setup, steps, pids=(), addresses=(), settle=0.4, tty=False):
    return {"id": id, "setup": list(setup), "steps": list(steps), "pids": list(pids), "addresses": list(addresses), "settle": settle, "tty": tty}


ADDRESSES = ["10.0.0.1/24", "10.0.0.2/24"]

EMPTY = ([], [])
ONE_TCP = (["nc -l 8080 & P1=$!"], ["P1"])
TCP_AND_UDP = (["nc -l 8080 & P1=$!", "nc -lu 5353 & P2=$!"], ["P1", "P2"])
BOUND = (["nc -l 127.0.0.1 9000 & P1=$!", "nc -l 10.0.0.1 7000 & P2=$!", "nc -lu 127.0.0.1 5300 & P3=$!"], ["P1", "P2", "P3"])
CONNECTED = (
    ["nc -l 127.0.0.1 9000 & P1=$!", "sleep 0.3", "nc -p 40001 127.0.0.1 9000 & P2=$!"],
    ["P1", "P2"],
)
TWO_CONNECTIONS = (
    ["nc -k -l 127.0.0.1 9000 & P1=$!", "sleep 0.3", "nc -p 40001 127.0.0.1 9000 & P2=$!", "sleep 0.3", "nc -p 40002 127.0.0.1 9000 & P3=$!"],
    ["P1", "P2", "P3"],
)
UDP_CONNECTED = (
    ["nc -lu 127.0.0.1 5300 & P1=$!", "sleep 0.3", "nc -u -p 40003 127.0.0.1 5300 & P2=$!"],
    ["P1", "P2"],
)
UNIX = (
    ["nc -lU /tmp/lab/s1 & P1=$!", "sleep 0.3", "nc -U /tmp/lab/s1 & P2=$!"],
    ["P1", "P2"],
)
CLOSED = (
    ["nc -l 127.0.0.1 9000 & P1=$!", "sleep 0.3", "echo hello | nc -N -p 40004 127.0.0.1 9000"],
    ["P1"],
)

SOCKET_SCENARIOS = [
    ("empty", EMPTY),
    ("one-tcp", ONE_TCP),
    ("tcp-and-udp", TCP_AND_UDP),
    ("bound", BOUND),
    ("connected", CONNECTED),
    ("two-connections", TWO_CONNECTIONS),
    ("udp-connected", UDP_CONNECTED),
    ("unix", UNIX),
    ("closed", CLOSED),
]

SS_COMMANDS = [
    "ss", "ss -a", "ss -l", "ss -n", "ss -an", "ss -t", "ss -ta", "ss -tl", "ss -tln", "ss -tan", "ss -u", "ss -ua", "ss -ul", "ss -uln",
    "ss -x", "ss -xa", "ss -xl", "ss -w", "ss -wa", "ss -tulnp", "ss -tanp", "ss -tlnp", "ss -tulne", "ss -tanoe", "ss -tai", "ss -s",
    "ss -4 -a", "ss -6 -a", "ss -tlH", "ss -tlO", "ss -tlnr", "ss -tan state established", "ss -tan state listening",
    "ss -tan sport = :9000", "ss -tan dport = :9000", "ss -tlnp sport = :8080", "ss -tan src 127.0.0.1", "ss -tan dst 127.0.0.1",
    "ss -ltn 'sport = :8080 or sport = :9000'", "ss -ltn exclude listening", "ss -f inet -a", "ss -f inet6 -a", "ss -f unix -a",
    "ss -A tcp", "ss -A udp,tcp", "ss -A raw", "ss -tm", "ss --tos -t", "ss --cgroup -t",
    "ss --tos -ta", "ss --cgroup -ta", "ss -tam", "ss -uam", "ss -tlm", "ss -tanm", "ss -tmH", "ss -tamO", "ss -V", "ss -h", "ss -z", "ss --nope", "ss -tp",
]


def ss_cases():
    out = []
    for name, (setup, pids) in SOCKET_SCENARIOS:
        out.append(case("ss-" + name, setup, SS_COMMANDS, pids, ADDRESSES))
    return out


NETSTAT_COMMANDS = [
    "netstat", "netstat -a", "netstat -l", "netstat -n", "netstat -an", "netstat -t", "netstat -ta", "netstat -tl", "netstat -tan",
    "netstat -tuln", "netstat -tulnp", "netstat -tanp", "netstat -tanoe", "netstat -taneee", "netstat -tane", "netstat -u", "netstat -ua",
    "netstat -x", "netstat -xa", "netstat -w", "netstat -wa", "netstat -4 -a", "netstat -6 -a", "netstat -A inet -a", "netstat -A inet6 -a",
    "netstat --inet -a", "netstat --inet6 -a", "netstat --tcp -l --numeric", "netstat --wide -tan", "netstat -tanW", "netstat -V",
    "netstat -h", "netstat -z", "netstat --nope", "netstat -tp", "netstat -tlp", "netstat -tlnpe", "netstat -tuap", "netstat -taov",
    "netstat -tlnW", "netstat -ltn", "netstat -lntu", "netstat -tanl", "netstat -aunt", "netstat -tln --program", "netstat -tlnv",
    "netstat -tal --numeric-hosts", "netstat -tal --numeric-ports", "netstat -talN", "netstat -A unix", "netstat -A tcp,udp -l",
]


def netstat_cases():
    out = []
    for name, (setup, pids) in SOCKET_SCENARIOS:
        out.append(case("netstat-" + name, setup, NETSTAT_COMMANDS, pids, ADDRESSES))
    return out


FUSER_PORTS = [
    "fuser 9000/tcp 2>&1", "fuser -v 9000/tcp 2>&1", "fuser -n tcp 9000 2>&1", "fuser -vn tcp 9000 2>&1", "fuser 5300/udp 2>&1",
    "fuser -v 5300/udp 2>&1", "fuser -un udp 5300 2>&1", "fuser 9000/tcp 7000/tcp 2>&1", "fuser -v 9000/tcp 5300/udp 2>&1",
    "fuser 1234/tcp 2>&1; echo rc=$?", "fuser 9000/tcp; echo rc=$?", "fuser -s 9000/tcp; echo rc=$?", "fuser -s 1234/tcp; echo rc=$?",
    "fuser -4 9000/tcp 2>&1", "fuser -6 9000/tcp 2>&1", "fuser -l", "fuser -V 2>&1", "fuser 2>&1; echo rc=$?", "fuser -h 2>&1; echo rc=$?",
    "fuser -a 1234/tcp 2>&1", "fuser -v -a 1234/tcp 2>&1", "fuser -u 9000/tcp 2>&1", "fuser -vu 9000/tcp 2>&1", "fuser 9000/xyz 2>&1; echo rc=$?",
    "fuser abc/tcp 2>&1; echo rc=$?", "fuser -n foo 9000 2>&1; echo rc=$?", "fuser -n tcp abc 2>&1; echo rc=$?", "fuser -vm /tmp/lab 2>&1",
    "fuser /tmp/lab 2>&1", "fuser -m /tmp/lab 2>&1", "fuser -v 9000/tcp 7000/tcp 2>&1", "fuser -vn tcp 7000 2>&1", "fuser -nudp 5300 2>&1",
    "fuser -w 9000/tcp 2>&1", "fuser -vw 9000/tcp 2>&1", "fuser -M 9000/tcp 2>&1", "fuser -I 9000/tcp 2>&1", "fuser -vz 9000/tcp 2>&1",
    "fuser -k 9000/tcp 2>&1; echo rc=$?; sleep 0.3; fuser 9000/tcp 2>&1; echo rc=$?",
    "fuser -k -TERM 7000/tcp 2>&1; echo rc=$?; sleep 0.3; fuser 7000/tcp 2>&1; echo rc=$?",
    "fuser -k -HUP 5300/udp 2>&1; echo rc=$?", "fuser -k -INVALID 9000/tcp 2>&1; echo rc=$?", "fuser -k -l 2>&1 | head -2",
]

FUSER_FILES = [
    "fuser f1 2>&1", "fuser -v f1 2>&1", "fuser -m f1 2>&1", "fuser -vm /tmp/lab 2>&1", "fuser d 2>&1", "fuser -v d 2>&1", "fuser -mv d 2>&1",
    "fuser -a f1 nofile 2>&1; echo rc=$?", "fuser -v nofile 2>&1; echo rc=$?", "fuser -u f1 2>&1", "fuser -v f1 f2 2>&1", "fuser -vu f2 2>&1",
    "fuser f1 f2 d 2>&1", "fuser -v f1 f2 d 2>&1", "fuser -s f1; echo rc=$?", "fuser -s nofile; echo rc=$?", "fuser -vm / 2>&1 | head -3",
    "fuser -c f1 2>&1", "fuser -vc d 2>&1", "fuser -m -u f1 2>&1", "fuser -vam /tmp/lab 2>&1", "fuser -k f1 2>&1; echo rc=$?; sleep 0.3; fuser f1 2>&1; echo rc=$?",
    "fuser -k -KILL f2 2>&1; echo rc=$?", "fuser -vn file f2 2>&1", "fuser -n file f2 2>&1", "fuser -vn tcp f2 2>&1; echo rc=$?",
]


FUSER_PARSING = [
    "fuser -ntcp 9000 2>&1", "fuser --namespace tcp 9000 2>&1", "fuser --namespace=tcp 9000 2>&1", "fuser -n=tcp 9000 2>&1", "fuser -vntcp 9000 2>&1",
    "fuser -n tcp,udp 9000 2>&1", "fuser -n tcp -n udp 5300 2>&1", "fuser -nfile 9000 2>&1", "fuser -n 2>&1; echo rc=$?", "fuser -n tcp 2>&1; echo rc=$?",
    "fuser 9000/tcp -v 2>&1", "fuser -sv 9000/tcp; echo rc=$?", "fuser -vsa 1234/tcp; echo rc=$?", "fuser -va 1234/tcp 9000/tcp 2>&1",
    "fuser --verbose --user 9000/tcp 2>&1", "fuser --all 1234/tcp 2>&1", "fuser --silent 9000/tcp; echo rc=$?", "fuser --quiet 9000/tcp; echo rc=$?",
    "fuser --ipv4 9000/tcp 2>&1", "fuser --ipv6 9000/tcp 2>&1", "fuser -46 9000/tcp 2>&1", "fuser -64 9000/tcp 2>&1", "fuser --version 2>&1 | head -1",
    "fuser --help 2>&1 | head -2", "fuser --list-signals | head -1", "fuser --bogus 9000/tcp 2>&1 | head -2", "fuser -x 9000/tcp 2>&1 | head -2",
    "fuser -d 9000/tcp 2>&1 | head -2", "fuser -T 9000/tcp 2>&1 | head -2", "fuser -f 9000/tcp 2>&1", "fuser -- 9000/tcp 2>&1; echo rc=$?",
    "fuser -- -v 2>&1 | head -2", "fuser '' 2>&1 | head -2", "fuser 9000/tcp/extra 2>&1; echo rc=$?", "fuser 0/tcp 2>&1; echo rc=$?",
    "fuser 65536/tcp 2>&1; echo rc=$?", "fuser 99999999999/tcp 2>&1; echo rc=$?", "fuser -1 9000/tcp 2>&1 | head -2", "fuser 9000/TCP 2>&1; echo rc=$?",
    "fuser ssh/tcp 2>&1; echo rc=$?", "fuser -n tcp ssh 2>&1; echo rc=$?", "fuser http/tcp 2>&1; echo rc=$?", "fuser 9000,127.0.0.1/tcp 2>&1",
    "fuser 9000,127.0.0.1,40001/tcp 2>&1", "fuser 9000,127.0.0.1,40002/tcp 2>&1", "fuser ,127.0.0.1,9000/tcp 2>&1", "fuser 40001,127.0.0.1,9000/tcp 2>&1",
    "fuser ,,40001/tcp 2>&1", "fuser ,,9000/tcp 2>&1", "fuser 9000,localhost,40001/tcp 2>&1", "fuser 9000,nosuchhost,40001/tcp 2>&1; echo rc=$?",
    "fuser 9000,127.0.0.1,abc/tcp 2>&1; echo rc=$?", "fuser 9000,10.0.0.1/tcp 2>&1", "fuser -v 40001,127.0.0.1,9000/tcp 2>&1",
    "fuser -k -s 9000/tcp 2>&1; echo rc=$?", "fuser -9 -k 7000/tcp 2>&1; echo rc=$?", "fuser -k -SIGTERM 5300/udp 2>&1; echo rc=$?",
    "fuser -kTERM 5300/udp 2>&1; echo rc=$?", "fuser -k -0 5300/udp 2>&1; echo rc=$?", "fuser -k -64 5300/udp 2>&1; echo rc=$?",
    "fuser -k -65 5300/udp 2>&1; echo rc=$?", "fuser -k -RTMIN 5300/udp 2>&1; echo rc=$?", "fuser -kv 5300/udp 2>&1; echo rc=$?",
    "fuser -kw 5300/udp 2>&1; echo rc=$?", "fuser -l -v 2>&1 | head -1", "fuser -V -v 2>&1 | head -1", "fuser -l 9000/tcp 2>&1 | head -1",
    "fuser -4 -V 2>&1 | head -1",
]


def fuser_cases():
    out = []
    ports = [
        ("fuser-listeners", ["nc -l 127.0.0.1 9000 & P1=$!", "nc -lu 127.0.0.1 5300 & P2=$!", "nc -l 10.0.0.1 7000 & P3=$!"], ["P1", "P2", "P3"]),
        ("fuser-connected", ["nc -l 127.0.0.1 9000 & P1=$!", "sleep 0.3", "nc -p 40001 127.0.0.1 9000 & P2=$!"], ["P1", "P2"]),
        ("fuser-none", [], []),
    ]
    for name, setup, pids in ports:
        out.append(case(name, setup, FUSER_PORTS, pids, ADDRESSES))
    files = [
        "echo data > /tmp/lab/f1", "echo data > /tmp/lab/f2", "mkdir -p /tmp/lab/d",
        "sleep 60 < /tmp/lab/f1 & P1=$!", "tail -f /tmp/lab/f2 > /dev/null & P2=$!", "(cd /tmp/lab/d; exec sleep 60) & P3=$!",
    ]
    out.append(case("fuser-files", files, FUSER_FILES, ["P1", "P2", "P3"], ADDRESSES))
    out.append(case("fuser-parsing", ["nc -l 127.0.0.1 9000 & P1=$!", "nc -lu 127.0.0.1 5300 & P2=$!", "nc -l 10.0.0.1 7000 & P3=$!", "sleep 0.3",
                                      "nc -p 40001 127.0.0.1 9000 & P4=$!"], FUSER_PARSING, ["P1", "P2", "P3", "P4"], ADDRESSES))
    out.append(case("fuser-files-none", ["echo data > /tmp/lab/f1", "echo data > /tmp/lab/f2", "mkdir -p /tmp/lab/d"], FUSER_FILES, [], ADDRESSES))
    return out


NC_CLI = [
    "nc", "nc -h", "nc -l", "nc -z", "nc 127.0.0.1", "nc -l -z 9000", "nc -k 9000", "nc -l -s 127.0.0.1 9000", "nc -u -z -l 9000",
    "nc -U", "nc -4 -6 127.0.0.1 9000", "nc -p abc 127.0.0.1 9000", "nc 127.0.0.1 abc", "nc 127.0.0.1 70000", "nc 127.0.0.1 0",
    "nc -w abc 127.0.0.1 9000", "nc -i abc 127.0.0.1 9000", "nc -W 0 127.0.0.1 9000", "nc -Y", "nc -v", "nc -N", "nc -lp 9000 -z",
"nc -n localhost 9000", "nc -z -v 127.0.0.1 1-3", "nc -z 127.0.0.1 3-1", "nc -x", "nc -X", "nc -T foo 127.0.0.1 9000", "nc -P user 127.0.0.1 9000", "nc -s 1.2.3.4 -z 127.0.0.1 9000",
    "nc -D -z 127.0.0.1 9000", "nc -C -z 127.0.0.1 9000", "nc -r -z 127.0.0.1 9000", "nc -t -z 127.0.0.1 9000", "nc -d -z 127.0.0.1 9000",
    "nc -M 3 -z 127.0.0.1 9000", "nc -m 3 -z 127.0.0.1 9000", "nc -I 100 -z 127.0.0.1 9000", "nc -O 100 -z 127.0.0.1 9000", "nc -e foo -z 127.0.0.1 9000",
    "nc -F -z 127.0.0.1 9000", "nc -S -z 127.0.0.1 9000", "nc -Z -z 127.0.0.1 9000", "nc -- -z 127.0.0.1 9000",
]

NC_SCAN = [
    "nc -z 127.0.0.1 9000", "nc -zv 127.0.0.1 9000", "nc -zv 127.0.0.1 9000 9001", "nc -zv 127.0.0.1 8999-9001", "nc -zvn 127.0.0.1 9000",
    "nc -zv localhost 9000", "nc -zv -w 1 127.0.0.1 9000-9001", "nc -zvu 127.0.0.1 5300", "nc -zu 127.0.0.1 5300", "nc -zv 10.0.0.1 7000",
    "nc -zv -s 10.0.0.2 127.0.0.1 9000", "nc -zv -p 40010 127.0.0.1 9000", "nc -zvv 127.0.0.1 9000", "nc -zv 127.0.0.1 ssh", "nc -zv 127.0.0.1 http",
    "nc -zv 127.0.0.1 echo", "nc -zv -4 localhost 9000",
]


NC_SESSION = [
    "nc -lv 127.0.0.1 9000 > got.txt 2> srv.err & S1=$!; sleep 0.3; cat srv.err",
    "echo hello | nc -v -N -p 40001 127.0.0.1 9000; echo rc=$?",
    "sleep 0.3; cat got.txt; cat srv.err",
    "nc -lv 127.0.0.1 9001 > got2.txt 2> srv2.err & sleep 0.3; cat srv2.err",
    "printf 'one\\ntwo\\n' | nc -N 127.0.0.1 9001; echo rc=$?",
    "sleep 0.3; cat got2.txt; cat srv2.err",
    "nc -zv 10.0.0.1 9001; echo rc=$?",
    "nc -l 10.0.0.1 9002 2> srv3.err & sleep 0.3; cat srv3.err",
    "nc -zv 127.0.0.1 9002; echo rc=$?",
    "nc -zv 10.0.0.1 9002; echo rc=$?",
    "nc -kl 9003 > got3.txt 2> srv4.err & sleep 0.3",
    "echo a | nc -N 127.0.0.1 9003; echo b | nc -N 127.0.0.1 9003; sleep 0.3; cat got3.txt",
    "nc -l 9004 > got4.txt & sleep 0.3; printf 'x%.0s' 1 2 3 | nc -N -v 127.0.0.1 9004; sleep 0.3; cat got4.txt; echo",
    "nc -l 9005 > got5.txt & sleep 0.3; nc -l 9005 2>&1 & sleep 0.3; echo rc=$?",
]

NC_UDP_SESSION = [
    "nc -ulv 127.0.0.1 5300 > gotu.txt 2> srvu.err & sleep 0.3; cat srvu.err",
    "echo ping | nc -u -w1 127.0.0.1 5300; echo rc=$?",
    "sleep 0.3; cat gotu.txt",
    "echo ping | nc -uv -w1 127.0.0.1 5301; echo rc=$?",
    "nc -ul 127.0.0.1 5302 > gotu2.txt & sleep 0.3; echo hi | nc -u -w1 127.0.0.1 5302; sleep 0.3; cat gotu2.txt",
    "nc -zuv -w1 127.0.0.1 5303; echo rc=$?",
]


def up(pid):
    return "kill -0 %s 2>/dev/null && echo alive || echo gone" % pid


NC_READWRITE = [
    "nc -l 127.0.0.1 9001 > g1.txt & S=$!; sleep 0.3; echo hi | nc 127.0.0.1 9001 & C=$!; sleep 1.5; echo server $(" + up("$S") + "); echo client $(" + up("$C") + "); cat g1.txt; kill $C 2>/dev/null; kill $S 2>/dev/null; true",
    "nc -l 127.0.0.1 9002 > g2.txt & S=$!; sleep 0.3; echo hi | nc -N 127.0.0.1 9002; echo rc=$?; sleep 0.3; echo server $(" + up("$S") + "); cat g2.txt",
    "nc -l 127.0.0.1 9003 > g3.txt & S=$!; sleep 0.3; echo hi | nc -q 0 127.0.0.1 9003; echo rc=$?; sleep 0.3; echo server $(" + up("$S") + "); cat g3.txt",
    "nc -l 127.0.0.1 9004 > g4.txt & S=$!; sleep 0.3; echo hi | nc -q 1 127.0.0.1 9004 & C=$!; sleep 0.5; echo at0.5 client $(" + up("$C") + "); sleep 1; echo at1.5 client $(" + up("$C") + "); echo server $(" + up("$S") + "); cat g4.txt",
    "nc -l 127.0.0.1 9005 > g5.txt & S=$!; sleep 0.3; echo hi | nc -w 1 127.0.0.1 9005 & C=$!; sleep 0.5; echo at0.5 client $(" + up("$C") + "); sleep 1; echo at1.5 client $(" + up("$C") + "); echo server $(" + up("$S") + "); cat g5.txt",
    "nc -l 127.0.0.1 9006 > g6.txt & S=$!; sleep 0.3; nc 127.0.0.1 9006 < /dev/null & C=$!; sleep 1; echo server $(" + up("$S") + ") client $(" + up("$C") + "); kill $C; sleep 0.3; echo after-kill server $(" + up("$S") + ")",
    "nc -d -l 127.0.0.1 9007 > g7.txt & S=$!; sleep 0.3; nc -d 127.0.0.1 9007 & C=$!; sleep 1; echo server $(" + up("$S") + ") client $(" + up("$C") + "); kill $C; sleep 0.3; echo after-kill server $(" + up("$S") + ")",
    "nc -l 127.0.0.1 9008 > g8.txt & sleep 0.3; printf 'a\\nb\\n' | nc -C -N 127.0.0.1 9008; sleep 0.3; wc -c < g8.txt",
    "nc -l -w 1 127.0.0.1 9009 > g9.txt & S=$!; sleep 0.2; nc 127.0.0.1 9009 < /dev/null & C=$!; sleep 1.6; echo server $(" + up("$S") + ") client $(" + up("$C") + ")",
    "nc -lu 127.0.0.1 5400 > g10.txt & S=$!; sleep 0.3; echo ping | nc -u -w 1 127.0.0.1 5400; echo rc=$?; sleep 0.3; cat g10.txt; echo server $(" + up("$S") + "); kill $S",
]


def nc_cases():
    out = [case("nc-cli", [], NC_CLI, [], ADDRESSES)]
    out.append(case("nc-readwrite", [], NC_READWRITE, [], ADDRESSES))
    out.append(case("nc-scan-down", [], NC_SCAN, [], ADDRESSES))
    servers = [
        "nc -k -l 127.0.0.1 9000 >/dev/null & P1=$!",
        "nc -k -l 127.0.0.1 9001 >/dev/null & P2=$!",
        "nc -k -lu 127.0.0.1 5300 >/dev/null & P3=$!",
        "nc -k -l 10.0.0.1 7000 >/dev/null & P4=$!",
    ]
    dropped = ["iptables -A OUTPUT -p tcp --dport 22 -j DROP", "iptables -A OUTPUT -p tcp --dport 80:81 -j DROP"]
    out.append(case("nc-timeout", dropped, [
        "nc -zv -w 1 127.0.0.1 22; echo rc=$?", "nc -zv -w 2 127.0.0.1 22; echo rc=$?", "nc -z -w 1 127.0.0.1 22; echo rc=$?",
        "nc -zv -w 1 127.0.0.1 80-81; echo rc=$?", "nc -zv -w 1 127.0.0.1 21-23; echo rc=$?", "nc -zvn -w 1 10.0.0.1 22; echo rc=$?",
    ], [], ADDRESSES))
    out.append(case("nc-session", [], NC_SESSION, [], ADDRESSES))
    out.append(case("nc-udp-session", [], NC_UDP_SESSION, [], ADDRESSES))
    out.append(case("nc-scan-up", servers, NC_SCAN, ["P1", "P2", "P3", "P4"], ADDRESSES))
    return out


UNIX_SS_COMMANDS = [
    "ss -x", "ss -xa", "ss -xl", "ss -xn", "ss -xan", "ss -xp", "ss -xap", "ss -xlp", "ss -xe", "ss -xae", "ss -xle", "ss -xm", "ss -xi",
    "ss -xH", "ss -xaO", "ss -xa state listening", "ss -xa state connected", "ss -xa state established", "ss -xa state unconnected",
    "ss -xa src /tmp/lab/s1", "ss -xa 'src /tmp/lab/*'", "ss -xa 'src = /tmp/lab/s1'", "ss -xa 'src != /tmp/lab/s1'",
    "ss -A unix_stream -a", "ss -A unix_dgram -a", "ss -A unix_seqpacket -a", "ss -f unix", "ss --unix -a", "ss -xs", "ss -s", "ss -xar", "ss -xao",
    "ss -xp state established", "ss -xapn", "ss -xlpe", "ss -xam", "ss -xlm", "ss -xa sport = :1", "ss -xa dst /tmp/lab/s1", "ss -xa dst '*'",
    "ss -xa src unix:/tmp/lab/s1", "ss -xa 'src /tmp/lab/s1 or src /nothing'", "ss -xa 'not src /tmp/lab/s1'", "ss -xaH", "ss -xlH",
    "ss -xaO", "ss -xaOe", "ss -xtp", "ss -xua", "ss -a -x -t", "ss -xa 'src /tmp/lab/?1'", "ss -xa 'src /tmp/lab/[a-z]1'", "ss -xar",
    "ss -xaZ", "ss -xaT", "ss -xab", "ss -xaE | head -2", "ss -xa --tos", "ss -xa --cgroup",
]

UNIX_NETSTAT_COMMANDS = [
    "netstat -x", "netstat -xa", "netstat -xl", "netstat -xn", "netstat -xan", "netstat -xp", "netstat -xap", "netstat -xlp", "netstat -xe",
    "netstat -xae", "netstat -xv", "netstat -xW", "netstat --unix -a", "netstat -a -A unix", "netstat --protocol=unix -l", "netstat -xaep",
    "netstat -xo", "netstat -xlpn", "netstat -xlpe",
]

UNIX_SYSTEM_COMMANDS = [
    "cat /proc/net/unix", "grep -c . /proc/net/unix", "grep /tmp/lab /proc/net/unix",
    "ls -l /proc/$P1/fd | tail -n +2 | awk '{print $1,$3,$4,$9,$10,$11}'", "readlink /proc/$P1/fd/3",
    "ls -l /proc/$P2/fd 2>&1 | tail -n +2 | awk '{print $1,$3,$4,$9,$10,$11}'", "readlink /proc/$P2/fd/3 2>&1",
    "lsof -U", "lsof -U -a -p $P1", "lsof -p $P1", "lsof /tmp/lab/s1", "lsof -a -U -c nc", "lsof -nP -U",
    "fuser /tmp/lab/s1 2>&1", "fuser -v /tmp/lab/s1 2>&1", "fuser -vu /tmp/lab/s1 2>&1", "fuser -vm /tmp/lab/s1 2>&1", "fuser -s /tmp/lab/s1; echo rc=$?",
    "fuser -a /tmp/lab/s1 2>&1", "fuser -n file /tmp/lab/s1 2>&1",
    "ls -l /tmp/lab/s1 2>&1 | awk '{print $1,$3,$4,$5,$NF}'", "stat -c '%F %a %U' /tmp/lab/s1 2>&1", "test -S /tmp/lab/s1 && echo socket; echo rc=$?",
    "ls -l /tmp/lab | tail -n +2 | awk '{print $1,$3,$4,$5,$NF}'", "find /tmp/lab -type s", "cat /proc/net/sockstat",
    "nc -U /tmp/lab/nothing; echo rc=$?", "nc -zU /tmp/lab/s1; echo rc=$?", "nc -U /tmp/lab; echo rc=$?",
    "echo x > /tmp/lab/plain; nc -U /tmp/lab/plain; echo rc=$?", "timeout 1 nc -lU /tmp/lab/plain; echo rc=$?; ls -l /tmp/lab/plain | cut -c1-10",
    "timeout 1 nc -lU /tmp/lab/s1; echo rc=$?", "ss -xa", "netstat -xa", "ls -l /tmp/lab/s1 2>&1 | cut -c1-10",
]

UNIX_COMMANDS = UNIX_SS_COMMANDS + UNIX_NETSTAT_COMMANDS + UNIX_SYSTEM_COMMANDS

UNIX_SESSION = [
    "nc -lU /tmp/lab/s2 > got.txt 2> srv.err & S1=$!; sleep 0.3; ls -l /tmp/lab/s2 | cut -c1-10; cat srv.err",
    "echo hello | nc -NU /tmp/lab/s2; echo rc=$?; sleep 0.3; cat got.txt; echo server $(" + up("$S1") + ")",
    "nc -lvU /tmp/lab/s3 > got3.txt 2> srv3.err & S3=$!; sleep 0.3; cat srv3.err",
    "echo hi | nc -vNU /tmp/lab/s3 2>&1; echo rc=$?; sleep 0.3; cat got3.txt; cat srv3.err",
    "nc -kU -l /tmp/lab/s4 > got4.txt & sleep 0.3; echo a | nc -NU /tmp/lab/s4; echo b | nc -NU /tmp/lab/s4; sleep 0.3; cat got4.txt",
    "rm -f /tmp/lab/s5; nc -lU /tmp/lab/s5 & S5=$!; sleep 0.3; kill $S5; sleep 0.3; ls /tmp/lab/s5; nc -U /tmp/lab/s5; echo rc=$?",
    "nc -lU /tmp/lab/s6 < /dev/null > got6.txt & sleep 0.3; printf 'x%.0s' 1 2 3 | nc -NU /tmp/lab/s6; sleep 0.3; cat got6.txt; echo",
    "nc -luU /tmp/lab/d1 > gotd.txt & D1=$!; sleep 0.3; ls -l /tmp/lab/d1 | cut -c1-10; echo ping | nc -uU -w1 /tmp/lab/d1; echo rc=$?; sleep 0.3; cat gotd.txt; echo server $(" + up("$D1") + ")",
    "nc -luU /tmp/lab/d2 > gotd2.txt & sleep 0.3; echo ping | nc -uU -s /tmp/lab/c2 -w1 /tmp/lab/d2; echo rc=$?; sleep 0.3; cat gotd2.txt; ls /tmp/lab | grep c2",
    "nc -uU /tmp/lab/nothing-here; echo rc=$?",
    "nc -luvU /tmp/lab/d3 > gotd3.txt 2> srvd3.err & sleep 0.3; cat srvd3.err; echo hi | nc -uvU -w1 /tmp/lab/d3 2>&1; echo rc=$?; sleep 0.3; cat srvd3.err; cat gotd3.txt",
    "nc -lU /tmp/nodir/s; echo rc=$?",
    "nc -lU; echo rc=$?",
    "nc -U; echo rc=$?",
    "nc -lU /tmp/lab/s7 /tmp/lab/extra; echo rc=$?",
    "nc -lU /tmp/lab/$(printf 'a%.0s' $(seq 1 120)); echo rc=$?",
    "nc -U /tmp/lab/$(printf 'a%.0s' $(seq 1 120)); echo rc=$?",
    "nc -lU /tmp/lab/s9 < /dev/null > got9.txt & sleep 0.3; nc -zvU /tmp/lab/s9; echo rc=$?",
    "nc -lvU /tmp/lab/s10 > got10.txt 2> srv10.err & sleep 0.3; echo q | nc -vU -q0 /tmp/lab/s10 2>&1; echo rc=$?; sleep 0.3; cat srv10.err",
    "nc -lU /tmp/lab/s11 < /dev/null > got11.txt & sleep 0.3; nc -w1 -U /tmp/lab/s11 < /dev/null; echo rc=$?; sleep 0.3; cat got11.txt",
    "printf 'greeting\\n' > hello.txt; nc -lU /tmp/lab/s12 < hello.txt & sleep 0.3; nc -U -w1 /tmp/lab/s12 < /dev/null; echo rc=$?",
    "nc -lU /tmp/lab/s13 & S13=$!; sleep 0.3; nc -U /tmp/lab/s13 & C13=$!; sleep 0.3; echo server $(" + up("$S13") + ") client $(" + up("$C13") + "); kill $C13; sleep 0.3; echo server $(" + up("$S13") + ")",
    "nc -lU /tmp/lab/s14 & S14=$!; sleep 0.3; nc -U /tmp/lab/s14 & C14=$!; sleep 0.3; kill $S14; sleep 0.3; echo client $(" + up("$C14") + ")",
]


UNIX_USER_COMMANDS = [
    "ss -xl", "ss -xlp", "ss -xlpe", "ss -xlne", "ss -xap", "ss -xape", "netstat -xlp", "netstat -xlpe", "netstat -xap", "cat /proc/net/unix",
    "ls -l /tmp/lab/s1 | awk '{print $1,$3,$4}'", "fuser -vu /tmp/lab/s1 2>&1", "fuser -v /tmp/lab/s1 2>&1", "stat -c '%U %a' /tmp/lab/s1",
    "sudo -u nobody ss -xlp", "sudo -u nobody ss -xlpe", "sudo -u nobody netstat -xlp", "sudo -u nobody nc -NU /tmp/lab/s1 < /dev/null; echo rc=$?",
    "sudo -u daemon nc -U /tmp/lab/s1 < /dev/null; echo rc=$?", "chmod 700 /tmp/lab/s1; sudo -u daemon nc -U /tmp/lab/s1 < /dev/null; echo rc=$?",
]


def unix_cases():
    stream = ["nc -lU /tmp/lab/s1 & P1=$!", "sleep 0.3", "nc -U /tmp/lab/s1 & P2=$!"]
    two = ["nc -kU -l /tmp/lab/s1 & P1=$!", "sleep 0.3", "nc -U /tmp/lab/s1 & P2=$!", "sleep 0.3", "nc -U /tmp/lab/s1 & P3=$!"]
    dgram = ["nc -luU /tmp/lab/s1 & P1=$!", "sleep 0.3", "nc -uU -s /tmp/lab/c1 /tmp/lab/s1 & P2=$!"]
    closed = ["nc -lU /tmp/lab/s1 & P1=$!", "sleep 0.3", "echo hi | nc -NU /tmp/lab/s1", "sleep 0.3"]
    return [
        case("unix-stream", stream, UNIX_COMMANDS, ["P1", "P2"], ADDRESSES),
        case("unix-listen", ["nc -lU /tmp/lab/s1 & P1=$!"], UNIX_COMMANDS, ["P1"], ADDRESSES),
        case("unix-two", two, UNIX_COMMANDS, ["P1", "P2", "P3"], ADDRESSES),
        case("unix-dgram", dgram, UNIX_COMMANDS, ["P1", "P2"], ADDRESSES),
        case("unix-dgram-listen", ["nc -luU /tmp/lab/s1 & P1=$!"], UNIX_COMMANDS, ["P1"], ADDRESSES),
        case("unix-closed", closed, UNIX_COMMANDS, [], ADDRESSES),
        case("unix-none", [], UNIX_COMMANDS, [], ADDRESSES),
        case("unix-user", ["chmod 777 /tmp/lab", "sudo -u nobody nc -lU /tmp/lab/s1 &", "sleep 0.3", "P1=$(pidof nc)"], UNIX_USER_COMMANDS, ["P1"], ADDRESSES),
        case("unix-session", [], UNIX_SESSION, [], ADDRESSES),
    ]


def ls_modes(*names):
    return "ls -ld %s | cut -c1-10" % " ".join(names)


UMASK_PARSING = [
    "umask", "umask -S", "umask -p", "umask -pS", "umask -Sp", "umask -p -S", "umask -S -p",
    "umask 077; umask; umask -S; umask -p; umask -pS", "umask 0; umask; umask -S", "umask 7; umask", "umask 0777; umask; umask -S",
    "umask 22; umask", "umask 022; umask", "umask 0022; umask", "umask 00022; umask", "umask 7777; echo rc=$?", "umask 1000; echo rc=$?",
    "umask 0778; echo rc=$?", "umask 8; echo rc=$?", "umask 09; echo rc=$?", "umask abc; echo rc=$?", "umask -x; echo rc=$?",
    "umask --; echo rc=$?; umask", "umask -- 022; echo rc=$?; umask", "umask -- -S; echo rc=$?", "umask 022 033; echo rc=$?; umask",
    "umask --help; echo rc=$?", "umask -S 077; echo rc=$?; umask", "umask -p 077; echo rc=$?; umask", "umask -pS 077; echo rc=$?; umask",
    "umask ''; echo rc=$?; umask", "umask ' 022'; echo rc=$?; umask", "umask 022 ; umask '0 22'; echo rc=$?", "umask +022; echo rc=$?",
    "umask -022; echo rc=$?", "umask 0x22; echo rc=$?", "umask 1e2; echo rc=$?", "umask 022; umask 0000; umask; umask 022",
]

UMASK_SYMBOLIC = [
    "umask 022; umask u=rwx,g=rx,o=rx; umask; umask -S", "umask u=rwx,g=,o=; umask; umask -S", "umask u=rwx,g=rx,o=; umask; umask -S",
    "umask a=rwx; umask; umask -S", "umask a=; umask; umask -S", "umask a=r; umask; umask -S", "umask =rwx; umask; umask -S", "umask =; umask; umask -S",
    "umask 022; umask u+w; umask; umask -S", "umask 022; umask g+w; umask; umask -S", "umask 022; umask o+w; umask; umask -S",
    "umask 022; umask a+w; umask; umask -S", "umask 022; umask +w; umask; umask -S", "umask 022; umask go-rx; umask; umask -S",
    "umask 022; umask g-r; umask; umask -S", "umask 022; umask o-rwx; umask; umask -S", "umask 022; umask -w; umask; umask -S",
    "umask 022; umask u=g; umask; umask -S", "umask 022; umask g=u; umask; umask -S", "umask 022; umask o=g; umask; umask -S",
    "umask 022; umask u+g; umask; umask -S", "umask 077; umask g=u; umask; umask -S", "umask 077; umask u=rwx,g=u; umask; umask -S",
    "umask 022; umask u=rw,g=r,o=r; umask; umask -S", "umask 022; umask ug=rwx; umask; umask -S", "umask 022; umask ugo=rwx; umask; umask -S",
    "umask 022; umask u=rwx g=rx; echo rc=$?; umask", "umask 022; umask u=rwx,g=rx,o=rx,; echo rc=$?; umask", "umask 022; umask ,u=rwx; echo rc=$?; umask",
    "umask 022; umask u; echo rc=$?; umask", "umask 022; umask u=q; echo rc=$?; umask", "umask 022; umask z=r; echo rc=$?; umask",
    "umask 022; umask u=rwxs; echo rc=$?; umask", "umask 022; umask u=rwxt; echo rc=$?; umask", "umask 022; umask u=X; echo rc=$?; umask",
    "umask 022; umask u==r; echo rc=$?; umask", "umask 022; umask u=r+w; echo rc=$?; umask -S", "umask 022; umask u+=w; echo rc=$?; umask",
    "umask 022; umask u=rwx,x; echo rc=$?; umask", "umask 022; umask a+rwx,u-w; umask -S", "umask 022; umask u+w,g+w,o+w; umask -S",
    "umask 0777; umask u+rwx; umask -S", "umask 0777; umask a+r; umask -S", "umask 0; umask a-rwx; umask -S", "umask 022; umask -S u=rwx; umask -S",
    "umask 022; umask A=r; echo rc=$?", "umask 022; umask u=R; echo rc=$?", "umask 022; umask ' u=rwx'; echo rc=$?; umask",
    "umask 022; umask 'u=rwx '; echo rc=$?; umask",
]

UMASK_SCOPES = [
    "umask 022; (umask 077; umask); umask", "umask 022; { umask 077; }; umask", "umask 022; umask 077 | cat; umask", "umask 022; umask 077 & wait; umask",
    "umask 022; echo 077 | umask; umask", "umask 022; echo $(umask 077; umask); umask", "umask 022; v=$(umask 077); umask", "umask 022; `umask 077`; umask",
    "umask 077; bash -c umask", "umask 077; sh -c umask", "umask 077; bash -c 'umask 027; umask'; umask", "umask 027; (bash -c umask)",
    "umask 022; bash -c 'umask 077; touch /tmp/lab/sc1'; umask; ls -l sc1 | cut -c1-10", "umask 077; env sh -c umask", "umask 077; nice bash -c umask",
    "umask 077; sudo bash -c umask", "umask 022; f() { umask 077; }; f; umask", "umask 022; f() { local x; umask 077; }; f; umask",
    "umask 022; trap 'umask' EXIT; umask 077", "umask 022; for i in 1; do umask 027; done; umask", "umask 022; if true; then umask 027; fi; umask",
    "umask 022; while false; do :; done; umask 027; umask", "umask 022; x=1 umask 077; umask", "umask 022; command umask 077; umask", "umask 022; builtin umask 077; umask",
    "umask 022; type umask", "command -V umask", "type -a umask", "type -t umask", "help umask | head -3", "enable -n umask; umask 077; echo rc=$?; enable umask; umask",
    "umask 022; alias umask='echo no'; umask; unalias umask; umask", "umask 022; umask=5; umask; echo $umask",
    "umask 022; /usr/bin/umask 2>&1 | head -1; echo rc=$?", "umask 022; which umask; echo rc=$?", "umask 022; exec 3>&1; umask -S >&3; umask >&3",
    "umask 022; umask -S > um.txt; cat um.txt", "umask 022; umask 2>/dev/null; echo rc=$?", "umask 077 2>&1; echo rc=$?; umask",
    "umask 022; umask 099 2>&1 >/dev/null; umask", "umask 022; umask 099 2>/dev/null; echo rc=$?",
    "umask 000; sudo bash -c umask", "umask 0277; sudo bash -c umask", "umask 077; sudo -u nobody bash -c umask", "umask 077; su -s /bin/sh nobody -c umask",
    "umask 077; su -c umask", "umask 077; su - -c umask", "umask 077; sudo sh -c 'umask; umask 027; umask'; umask",
]

UMASK_TOOLS = [
    "umask 022; mkdir -v v1; mkdir -pv v2/a/b; mkdir v1; echo rc=$?; mkdir -p v1; echo rc=$?", "mkdir -v -m 700 v3; ls -ld v3 | cut -c1-10",
    "touch tf; mkdir tf/x; echo rc=$?", "mkdir -m 999 x1; echo rc=$?", "mkdir -m; echo rc=$?", "mkdir; echo rc=$?", "mkdir -m u=rwx,g=,o= mm1 mm2; ls -ld mm1 mm2 | cut -c1-10",
    "mkdir -m 0 zero; ls -ld zero | cut -c1-10", "mkdir -m a+rwx all1; ls -ld all1 | cut -c1-10", "umask 077; mkdir -m o+r or1; ls -ld or1 | cut -c1-10",
    "umask 022; cp -v /etc/hostname v1c; cp /etc/hostname /etc/passwd noexist; echo rc=$?", "cp /etc/hostname; echo rc=$?", "cp; echo rc=$?", "cp nonexist x; echo rc=$?",
    "cp v1 x; echo rc=$?", "umask 022; cp /etc/hostname v1; ls v1", "cp -n /etc/passwd v1c; cmp -s v1c /etc/passwd; echo same=$?", "cp -n /etc/hostname fresh-n; echo rc=$?", "cp --no-clobber /etc/passwd v1c; echo rc=$?", "cp -r v2 v2c; ls -R v2c",
    "umask 077; cp -r v2 v2d; ls -ld v2d v2d/a v2d/a/b | cut -c1-10", "umask 077; cp -a v2 v2e; ls -ld v2e v2e/a v2e/a/b | cut -c1-10", "umask 022; chmod 4755 suid; touch suid; chmod 4755 suid; cp suid suid2; ls -l suid suid2 | cut -c1-10",
    "umask 022; cp -p suid suid3; ls -l suid3 | cut -c1-10", "umask 022; install -v /etc/hostname iv1; install -vd iv2/a; install -D /etc/hostname iv3/b/c; ls -R iv3 | head -3",
    "install; echo rc=$?", "install /etc/hostname; echo rc=$?", "install nonexist x; echo rc=$?", "install v1 x; echo rc=$?", "install -m 4755 /etc/hostname isuid; ls -l isuid | cut -c1-10",
    "install -m u=rw,go=r /etc/hostname isym; ls -l isym | cut -c1-10", "install -m 999 /etc/hostname ibad; echo rc=$?", "umask 077; install -d -m 700 idm; ls -ld idm | cut -c1-10",
    "umask 077; install -o nobody -g nogroup -m 640 /etc/hostname iown; ls -l iown | awk '{print $1,$3,$4}'",
    "umask 077; mktemp | cut -c1-9; mktemp -d | cut -c1-9; f=$(mktemp); ls -l $f | cut -c1-10; d=$(mktemp -d); ls -ld $d | cut -c1-10",
    "umask 000; f=$(mktemp); ls -l $f | cut -c1-10; d=$(mktemp -d); ls -ld $d | cut -c1-10", "mktemp fooXXXXXX | cut -c1-3; mktemp foo.XXX --suffix=.txt | cut -c1-4; mktemp XX; echo rc=$?",
    "mktemp -u | cut -c1-9; mktemp -p /tmp | cut -c1-9; mktemp -p /tmp/lab tmp.XXXX | cut -c1-13; mktemp -p /nonexistent; echo rc=$?; mktemp -q -p /nonexistent; echo rc=$?",
    "mktemp -p . mkt.XXXX | cut -c1-5; mktemp -d -p . mkd.XXXX | cut -c1-5; ls -d mkt.* mkd.* | cut -c1-3", "mktemp -t abcXXXX | cut -c1-8; mktemp --tmpdir | cut -c1-9; mktemp -h; echo rc=$?",
    "mktemp a b; echo rc=$?", "TMPDIR=/tmp/lab mktemp | cut -c1-13; TMPDIR=/tmp/lab mktemp -t zXXX | cut -c1-10",
    "umask 077; dd if=/dev/null of=ddx 2>/dev/null; ls -l ddx | cut -c1-10; dd if=/dev/null of=ddy 2>&1 | head -1; dd if=nonexist 2>&1 | head -1; dd if=nonexist 2>/dev/null; echo rc=$?",
    "umask 022; exec 5> ex1; exec 6>> ex2; ls -l ex1 ex2 | cut -c1-10; echo still-here",
    "umask 077; exec 7> ex3; ls -l ex3 | cut -c1-10", "umask 022; echo x | tee tz1 > /dev/null; ls -l tz1 | cut -c1-10", "ls -ld nonexist v1 v2 tf 2>&1 | cut -c1-10; echo rc=$?", "ls v1 v2 tf nonexist 2>&1; echo rc=$?",
    "ls -d v2 v1 tf | cat", "ls -1 tf v1 v2", "cd /tmp/lab; ls -ld ./v2 v1/ ../lab/tf | cut -c1-10",
]


UMASK_FILES = [
    "umask 022; touch f1; mkdir d1; echo x > r1; " + ls_modes("f1", "d1", "r1"),
    "umask 077; touch f2; mkdir d2; echo x > r2; " + ls_modes("f2", "d2", "r2"),
    "umask 027; touch f3; mkdir d3; echo x > r3; " + ls_modes("f3", "d3", "r3"),
    "umask 000; touch f4; mkdir d4; echo x > r4; " + ls_modes("f4", "d4", "r4"),
    "umask 0777; touch f5; mkdir d5; echo x > r5 2>/dev/null; " + ls_modes("f5", "d5", "r5") + " 2>&1",
    "umask 022; : > t1; umask 077; touch t1; " + ls_modes("t1"),
    "umask 000; ln -s f4 l4; mkfifo p4; " + ls_modes("l4", "p4"),
    "umask 077; ln -s f4 l5; mkfifo p5; " + ls_modes("l5", "p5"),
    "umask 077; mkdir -p pa/pb/pc; " + ls_modes("pa", "pa/pb", "pa/pb/pc"),
    "umask 022; mkdir -p qa/qb/qc; " + ls_modes("qa", "qa/qb", "qa/qb/qc"),
    "umask 0277; mkdir -p ra/rb 2>&1; echo rc=$?; " + ls_modes("ra") + " 2>&1",
    "umask 0377; mkdir -p sa/sb 2>&1; echo rc=$?; " + ls_modes("sa") + " 2>&1",
    "umask 077; mkdir -m 755 m1; mkdir -m 700 m2; mkdir -m u=rwx,go=rx m3; mkdir -m +w m4; " + ls_modes("m1", "m2", "m3", "m4"),
    "umask 077; touch tt; chmod 644 tt; " + ls_modes("tt"),
    "umask 077; cp /etc/hostname c1; " + ls_modes("c1"),
    "umask 000; cp /etc/hostname c2; " + ls_modes("c2"),
    "umask 077; cp -p /etc/hostname c3; " + ls_modes("c3"),
    "umask 022; touch exec1; chmod 755 exec1; umask 077; cp exec1 exec2; " + ls_modes("exec1", "exec2"),
    "umask 077; install -m 644 /etc/hostname i1; install -d id1; install /etc/hostname i2; " + ls_modes("i1", "id1", "i2"),
    "umask 077; tee tee1 < /dev/null; echo x | tee tee2 > /dev/null; " + ls_modes("tee1", "tee2"),
    "umask 077; dd if=/dev/null of=dd1 2>/dev/null; " + ls_modes("dd1"),
    "umask 077; echo x >> ap1; " + ls_modes("ap1"),
    "umask 077; echo x &> both1; exec 4> fd1; exec 4>&-; " + ls_modes("both1", "fd1"),
    "umask 077; mv f1 f1.moved; " + ls_modes("f1.moved"),
    "umask 077; touch -t 200001010000 old1; " + ls_modes("old1"),
    "umask 077; mkdir new1; cd new1; touch inner; cd ..; " + ls_modes("new1", "new1/inner"),
    "umask 077; nc -lU sock1 & sleep 0.3; " + ls_modes("sock1"),
    "umask 022; nc -lU sock2 & sleep 0.3; " + ls_modes("sock2"),
    "umask 000; nc -lU sock3 & sleep 0.3; " + ls_modes("sock3"),
    "umask 027; nc -luU sock4 & sleep 0.3; " + ls_modes("sock4"),
    "umask 022; bash -c 'umask 077; touch bs1'; " + ls_modes("bs1"),
    "umask 077; sudo touch su1; " + ls_modes("su1"),
    "umask 077; (touch sh1); { touch sh2; }; " + ls_modes("sh1", "sh2"),
    "umask 022; umask 077 && touch and1; " + ls_modes("and1"),
    "umask 022; touch before; umask 077; touch after; " + ls_modes("before", "after"),
    "umask 022; mkdir sticky; chmod 1777 sticky; touch sticky/s1; " + ls_modes("sticky", "sticky/s1"),
    "umask 022; mkdir -m 2755 setgid1; " + ls_modes("setgid1"),
    "umask 077; ln f1.moved hard1; " + ls_modes("hard1"),
    "umask 077; ln -s /etc/hostname sym1; " + ls_modes("sym1"),
    "umask 077; cp -r d1 d1copy; " + ls_modes("d1copy"),
    "umask 077; cp -a d1 d1archive; " + ls_modes("d1archive"),
    "umask 077; tar -cf a.tar d1; mkdir x1; tar -xf a.tar -C x1; " + ls_modes("a.tar", "x1", "x1/d1"),
    "umask 077; tar -xf a.tar -p -C . 2>&1 | head -1; " + ls_modes("d1"),
    "umask 077; gzip -k a.tar; " + ls_modes("a.tar.gz"),
    "umask 077; printf 'x' | tee -a tee3 > /dev/null; " + ls_modes("tee3"),
    "umask 077; mktemp -p . mkt.XXXX | cut -c1-5; mktemp -d -p . mkd.XXXX | cut -c1-5; ls -ld mkt.* mkd.* | cut -c1-10",
]


def umask_cases():
    return [
        case("umask-parsing", [], UMASK_PARSING, [], []),
        case("umask-symbolic", [], UMASK_SYMBOLIC, [], []),
        case("umask-scopes", [], UMASK_SCOPES, [], []),
        case("umask-files", ["touch f1", "echo seed > f1"], UMASK_FILES, [], []),
        case("umask-tools", ["touch tf0"], UMASK_TOOLS, [], []),
    ]


PS_COMMON_SETUP = [
    "sleep 1000 & P1=$!",
    "sleep 0.2",
    "nice -n 5 sleep 1001 & P2=$!",
    "sleep 0.2",
    "bash -c 'sleep 1002 & wait' & P3=$!",
    "sleep 0.2",
    "sleep 1003 & P4=$!",
    "sleep 0.2",
    "kill -STOP $P4",
    "nc -l 8080 & P5=$!",
    "sleep 0.2",
    "bash -c 'bash -c \"sleep 1004 & wait\" & wait' & P6=$!",
    "sleep 0.3",
    "P3C=$(ps -o pid= --ppid $P3 | tr -d ' ')",
    "P6C=$(ps -o pid= --ppid $P6 | tr -d ' ')",
    "P6CC=$(ps -o pid= --ppid $P6C | tr -d ' ')",
]
PS_COMMON_PIDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P3C", "P6C", "P6CC"]

PS_SELECTION = [
    "ps", "ps; echo rc=$?", "ps -e", "ps -A", "ps -a", "ps -d", "ps -N", "ps -e -N; echo rc=$?", "ps -eN; echo rc=$?", "ps --deselect -C sleep",
    "ps a", "ps x", "ps ax", "ps r", "ps T", "ps -T", "ps g", "ps xr", "ps -x", "ps -ax", "ps -ae", "ps -Ae", "ps -ea",
    "ps -C sleep", "ps -C sleep,nc", "ps -C 'sleep nc'", "ps -C nosuch; echo rc=$?", "ps -C nc -o pid,comm", "ps -Csleep", "ps -C", "ps -C ''; echo rc=$?",
    "ps -C bash", "ps -C sleep -C nc", "ps -C slee", "ps -C sleeping",
    "ps -p $P1", "ps -p $P1,$P2", "ps -p \"$P1 $P2\"", "ps p $P1", "ps $P1 $P2", "ps -p $P1 -p $P2", "ps --pid $P1", "ps --pid=$P1", "ps --pid:$P1",
    "ps -p 99999; echo rc=$?", "ps -p $P1,99999; echo rc=$?", "ps -p abc; echo rc=$?", "ps -p 0; echo rc=$?", "ps -p -1; echo rc=$?", "ps -p; echo rc=$?",
    "ps -p ''; echo rc=$?", "ps -p $P1,; echo rc=$?", "ps -p ,$P1; echo rc=$?", "ps -p $P1,,$P2; echo rc=$?", "ps -p 4294967296; echo rc=$?", "ps -p 2147483648; echo rc=$?",
    "ps -q $P1", "ps -q $P1,$P2", "ps q $P1", "ps --quick-pid $P1", "ps -q $P1 -q $P2; echo rc=$?", "ps -q $P1 -u root; echo rc=$?", "ps -q $P1 --sort pid; echo rc=$?",
    "ps -q $P1 -N; echo rc=$?", "ps -q $P1 --forest; echo rc=$?", "ps -q 99999; echo rc=$?",
    "ps --ppid $$", "ps --ppid $P3", "ps --ppid=$P3 -o pid,ppid,comm", "ps --ppid 99999; echo rc=$?", "ps --ppid abc; echo rc=$?",
    "ps -s $$", "ps --sid $$", "ps --sid=$$", "ps -s 99999; echo rc=$?", "ps -g $$", "ps -g root", "ps -g nosuchgroup; echo rc=$?", "ps -G root", "ps --Group root", "ps --group root",
    "ps -G nosuchgroup; echo rc=$?", "ps -G 0", "ps -g 0",
    "T=$(ps -o tty= -p $$ | tr -d ' '); ps -t $T", "T=$(ps -o tty= -p $$ | tr -d ' '); ps t $T", "T=$(ps -o tty= -p $$ | tr -d ' '); ps --tty $T",
    "T=$(ps -o tty= -p $$ | tr -d ' '); ps -t /dev/$T", "ps t", "ps -t ?", "ps -t -", "ps t ?", "ps -t tty9; echo rc=$?", "ps -t nosuch; echo rc=$?", "ps -t /dev/null; echo rc=$?",
    "ps -u root", "ps -u 0", "ps -u root,nobody", "ps -u 'root nobody'", "ps -u nobody; echo rc=$?", "ps -u nosuchuser; echo rc=$?", "ps -u 99999999999; echo rc=$?", "ps -u -1; echo rc=$?",
    "ps -U root", "ps --user root", "ps --User root", "ps -U 0", "ps U root", "ps -u", "ps -U; echo rc=$?", "ps U; echo rc=$?", "ps -N -u root; echo rc=$?", "ps -N -u nobody",
    "ps -u root -C sleep", "ps -C sleep -p $P1", "ps -p $P1 -C nc", "ps -p $P1 -N", "ps -ef -u nobody; echo rc=$?", "ps -e -p $P1", "ps -ep $P1", "ps -a -p $P1", "ps -d -p $P1",
    "ps -A -C nosuch", "ps ax -p $P1", "ps -x -p $P1", "ps xp $P1", "ps -xp $P1",
]

PS_FORMATS = [
    "ps -f", "ps -F", "ps -l", "ps -fl", "ps -lf", "ps -Fl", "ps -y -l", "ps -yl", "ps -y; echo rc=$?", "ps -c", "ps -lc", "ps -fc", "ps -j", "ps -jf", "ps -jl", "ps -jfl",
    "ps -L", "ps -fL", "ps -lL", "ps -T", "ps -fT", "ps -m", "ps -fm", "ps -lm", "ps m", "ps H", "ps -H", "ps -fH", "ps -lH", "ps -jH", "ps -eH", "ps -ejH", "ps -efH", "ps -efL", "ps -eLf", "ps -eT",
    "ps l", "ps j", "ps s", "ps u", "ps v", "ps X", "ps f", "ps lf", "ps uf", "ps jf", "ps ax", "ps aux", "ps axu", "ps axl", "ps axj", "ps axjf", "ps axf", "ps axs", "ps axv", "ps axX", "ps auxf",
    "ps -M", "ps Z", "ps --context", "ps -Z; echo rc=$?", "ps -P", "ps -fP", "ps -FP", "ps -lP",
    "ps -ef", "ps -efl", "ps -eFl", "ps -ely", "ps -eF", "ps -ef --forest", "ps -ef -H", "ps -e f", "ps -ef f", "ps --forest", "ps --forest -e", "ps -eo pid,ppid,args --forest",
    "ps -eo pid,args f", "ps -eo pid,comm f", "ps ef", "ps -eH -o pid,args", "ps -H -o pid,comm", "ps -m -o pid,tid,comm", "ps -L -o pid,lwp,nlwp,comm", "ps -T -o pid,spid,comm",
    "ps -eo pid,ppid,comm", "ps -o pid", "ps -o pid,comm", "ps -o pid= -o comm=", "ps -o pid,comm=NAME", "ps -o pid=PID,comm=NAME", "ps -o 'pid comm'", "ps -o pid,,comm; echo rc=$?", "ps -o ,pid; echo rc=$?",
    "ps -o pid,; echo rc=$?", "ps -o pid, comm", "ps -o; echo rc=$?", "ps -o ''; echo rc=$?", "ps -o bogus; echo rc=$?", "ps -o pid,bogus; echo rc=$?", "ps -o pid:3,comm", "ps -o pid:12,comm", "ps -o comm:20,pid",
    "ps -o pid:0; echo rc=$?", "ps -o pid:x; echo rc=$?", "ps -o pid:-3; echo rc=$?", "ps -o args:10", "ps -o user:20,pid", "ps -o user:3,pid", "ps -o user=,pid", "ps -o user=USERNAME,pid",
    "ps -o pid=,comm= -p $P1", "ps -p $P1 -o comm=", "ps -p $P1 -o pid= -o comm=", "ps -p $P1 -o 'pid,comm,args'", "ps -p $P1 -o %cpu,%mem,pcpu,pmem,vsz,rss,sz,vsize,rsz",
    "ps -p $P1 -o uid,gid,euid,egid,ruid,rgid,suid,sgid,fuid,fgid", "ps -p $P1 -o user,euser,ruser,suser,fuser,group,egroup,rgroup,sgroup,fgroup",
    "ps -p $P1 -o pid,ppid,pgid,sid,session,sess,pgrp,tpgid,tgid,lwp,spid,tid,nlwp,thcount",
    "ps -p $P1 -o tty,tt,tname,tty4,tty8,longtname", "ps -p $P1 -o stat,state,s,f,flag,flags,class,cls,policy,sched,rtprio,ni,nice,pri,priority,opri,intpri",
    "ps -p $P1 -o c,cp,util,psr,cpuid,cputime,time,times,etime,etimes,bsdtime,atime", "ps -p $P1 -o comm,ucmd,ucomm,fname,args,cmd,command,cgroup,cgname,exe",
    "ps -p $P1 -o wchan,wchan:20,nwchan,wname,addr,eip,esp,stackp", "ps -p $P1 -o wchan:30", "ps -p $P1 -o maj_flt,min_flt,majflt,minflt,pagein,trs,drs,dsiz,tsiz,m_size,m_resident,m_share",
    "ps -p $P1 -o supgid,supgrp", "ps -p $P1 -o lstart,start,start_time,stime,bsdstart", "ps -p $P1 -o sig,sigmask,sigignore,sigcatch,pending,blocked,caught,ignored,sig_pend",
    "ps -p $P1 -o ouid,oom,oomadj,ag_id,ag_nice,luid,lsession,lxc,seat,slice,unit,uunit,machine", "ps -p $P1 -o cgroupns,ipcns,mntns,netns,pidns,timens,userns,utsns",
    "ps -p $P1 -o label,context,zone,zoneid", "ps -p $P1 -o acflag,alarm,argc,bnd,cpu,emul,environ,jid,jobc,sl,tdev,umask,uprocp,xstat", "ps -p $P1 -o rbytes,wbytes,rchars,wchars,rops,wops,wcbytes",
    "ps -p $P1 -o pss,uss,numa,vm_data,vm_exe,vm_lib,vm_lock,vm_stack", "ps -p $P1 -o cputimes,cuc,cuu,cutime,utime,systime,usertime", "ps -p $P1 -o share,start_code,end_code,start_stack,cmaj_flt,cmin_flt,cnswap,nswap",
    "ps -O pid", "ps -O pid,comm", "ps O pid", "ps O p", "ps O -pid", "ps -O bogus; echo rc=$?", "ps -Opid -p $P1", "ps -O rss -p $P1", "ps -fO rss -p $P1; echo rc=$?", "ps -O pid -f -p $P1; echo rc=$?",
    "ps --format pid,comm -p $P1", "ps --format=pid,comm -p $P1", "ps --format:pid,comm -p $P1", "ps --format; echo rc=$?", "ps -o pid -o comm -p $P1", "ps -o pid=X -o comm=Y -p $P1",
    "ps -fo pid; echo rc=$?", "ps -f -o pid; echo rc=$?", "ps -o pid -f; echo rc=$?", "ps -l -o pid; echo rc=$?", "ps u -o pid; echo rc=$?", "ps -o pid u; echo rc=$?", "ps -o pid -j; echo rc=$?", "ps -o pid -L; echo rc=$?",
    "ps -eo pid -L", "ps -eo pid,comm -T", "ps -o pid,comm -m", "ps -m -o pid", "ps -L -m; echo rc=$?", "ps -L -T; echo rc=$?", "ps -H -m; echo rc=$?", "ps m H; echo rc=$?", "ps -L --forest; echo rc=$?",
    "ps --no-headers", "ps --no-heading", "ps --noheaders", "ps --headers", "ps --heading", "ps h", "ps --no-headers -f", "ps --no-headers --headers; echo rc=$?", "ps h h; echo rc=$?", "ps -o pid= ",
    "ps -o comm=,args=", "ps -o pid=,comm=,args= --headers", "ps --headers -o pid", "ps --headers --rows 5", "ps --rows 5 --headers -e", "ps --lines 5 --headers -e",
    "ps -ww -ef", "ps -w -ef", "ps ww aux", "ps w aux", "ps -eo pid,args --cols 30", "ps -eo pid,args --width 30", "ps -eo pid,args --columns 30", "ps -eo pid,args --cols 5; echo rc=$?", "ps --cols abc; echo rc=$?", "ps --cols 0; echo rc=$?",
    "ps --cols; echo rc=$?", "ps --cols=40 -ef", "ps --cols:40 -ef", "ps --rows abc; echo rc=$?", "ps --rows 0; echo rc=$?",
    "COLUMNS=30 ps -ef", "COLUMNS=200 ps -ef", "COLUMNS=abc ps -ef", "COLUMNS=5 ps -ef", "COLUMNS=30 ps -o pid,args", "COLUMNS=30 ps aux", "COLUMNS=30 ps -ww -ef", "LINES=5 ps --headers -e",
    "ps -ef | cat", "ps aux | cat", "ps -efl | cat", "ps -o pid,args | cat", "ps l | cat", "ps -ef -w | cat", "COLUMNS=30 ps -ef | cat", "ps -ef --cols 30 | cat",
    "ps -p $P1 -o comm=,args= | cat", "ps -p $P3 -o args | cat", "ps --forest -e -o pid,args | cat",
    "ps c", "ps -c -o pid,comm", "ps ac", "ps ce", "ps e", "ps -e e", "ps ae", "ps n", "ps -n; echo rc=$?", "ps nl", "ps nu", "ps S", "ps -S; echo rc=$?", "ps -y -lc; echo rc=$?", "ps -yf; echo rc=$?",
    "ps k pid", "ps k -pid", "ps k +pid", "ps k pid,-comm", "ps k bogus; echo rc=$?", "ps k; echo rc=$?", "ps Opid", "ps -D '%H:%M' -o lstart -p $P1 | cut -c1-2 | wc -c", "ps -D; echo rc=$?", "ps --date-format '%Y' -o lstart -p $P1 | cut -c1-2",
    "ps L | head -5", "ps L | wc -l", "ps L | tail -3", "ps L | grep -c pcpu", "ps L extra; echo rc=$?", "ps -e L; echo rc=$?",
]

PS_SORTING = [
    "ps --sort=pid", "ps --sort=-pid", "ps --sort pid", "ps --sort +pid", "ps --sort -pid", "ps --sort=pid,-comm", "ps --sort=-comm,pid", "ps -e --sort=comm -o pid,comm", "ps -e --sort=-comm -o pid,comm",
    "ps -e --sort=ppid -o pid,ppid,comm", "ps -e --sort=-ppid -o pid,ppid,comm", "ps -e --sort=nice -o pid,ni,comm", "ps -e --sort=-nice -o pid,ni,comm", "ps -e --sort=state -o pid,s,comm", "ps -e --sort=stat -o pid,stat,comm",
    "ps -e --sort=sid -o pid,sid", "ps -e --sort=tty -o pid,tty", "ps -e --sort=user -o pid,user", "ps -e --sort=uid -o pid,uid", "ps -e --sort=cmd -o pid,cmd", "ps -e --sort=args -o pid,args", "ps -e --sort=time -o pid,time",
    "ps -e --sort=start_time -o pid,stime", "ps -e --sort=rss -o pid,rss", "ps -e --sort=vsz -o pid,vsz", "ps -e --sort=pcpu -o pid,pcpu", "ps -e --sort=pmem -o pid,pmem", "ps -e --sort=etime -o pid,etime",
    "ps --sort; echo rc=$?", "ps --sort=; echo rc=$?", "ps --sort=bogus; echo rc=$?", "ps --sort=pid,; echo rc=$?", "ps --sort=,pid; echo rc=$?", "ps --sort=pid,,comm; echo rc=$?", "ps --sort=pid --sort=comm; echo rc=$?",
    "ps --sort='pid comm'", "ps --sort=-; echo rc=$?", "ps --sort=+-pid; echo rc=$?", "ps --sort=--pid; echo rc=$?", "ps --forest --sort=-pid", "ps -e --forest --sort=comm", "ps -ef --sort=-pid --forest",
    "ps ax --sort=-pid", "ps aux --sort=-pid", "ps -efl --sort=-pid", "ps -L --sort=-pid", "ps -eH --sort=-pid", "ps -eH --sort=comm -o pid,comm",
    "ps -e O p", "ps -e Op", "ps O -p", "ps O +p", "ps O c", "ps O u", "ps O t", "ps O r", "ps O v", "ps O pp; echo rc=$?", "ps O pid,comm", "ps O bogus; echo rc=$?", "ps O P -f", "ps O Pf",
    "ps -e k pid", "ps -e k -pid", "ps ax k -pid", "ps ax k -c", "ps k comm -e -o pid,comm", "ps k '-pid' -e -o pid", "ps ax O -p", "ps ax Opp; echo rc=$?", "ps axO -P; echo rc=$?", "ps axfO P; echo rc=$?", "ps axf k comm",
]

PS_MISC = [
    "ps --help", "ps --help s", "ps --help l", "ps --help o", "ps --help t", "ps --help m", "ps --help a", "ps --help simple", "ps --help list", "ps --help output", "ps --help threads", "ps --help misc", "ps --help all",
    "ps --help bogus", "ps --help=s", "ps --help:s", "ps --help s extra", "ps --help; echo rc=$?", "ps --help s 2>&1 >/dev/null | wc -c", "ps --help -e", "ps -e --help", "ps --hel", "ps --he; echo rc=$?",
    "ps -V", "ps V", "ps --version", "ps -V -e; echo rc=$?", "ps -e -V; echo rc=$?", "ps --version -e; echo rc=$?", "ps -V -V; echo rc=$?", "ps V a; echo rc=$?", "ps -Vq; echo rc=$?", "ps --version 2>&1 >/dev/null | wc -c",
    "ps --info; echo rc=$?", "ps --info -e; echo rc=$?", "ps -e --info; echo rc=$?", "ps --info 2>&1 | head -12", "ps --info 2>&1 | tail -6",
    "ps --bogus; echo rc=$?", "ps --; echo rc=$?", "ps -- -e; echo rc=$?", "ps -; echo rc=$?", "ps ---e; echo rc=$?", "ps -e-; echo rc=$?", "ps -e -; echo rc=$?", "ps --Version; echo rc=$?", "ps --pidx 1; echo rc=$?",
    "ps -?; echo rc=$?", "ps -h; echo rc=$?", "ps -5; echo rc=$?", "ps 5; echo rc=$?", "ps +5; echo rc=$?", "ps -$P1; echo rc=$?", "ps +$P1; echo rc=$?", "ps $P1 -$P1 +$P1", "ps -$$ ; echo rc=$?", "ps +$$",
    "ps bogus; echo rc=$?", "ps aux bogus; echo rc=$?", "ps -ef bogus; echo rc=$?", "ps -ef xyz; echo rc=$?", "ps !; echo rc=$?", "ps '' ; echo rc=$?", "ps ' ' ; echo rc=$?", "ps -k; echo rc=$?", "ps -b; echo rc=$?", "ps -Y; echo rc=$?",
    "ps W; echo rc=$?", "ps y; echo rc=$?", "ps -z; echo rc=$?", "ps -X; echo rc=$?", "ps -B; echo rc=$?", "ps -E; echo rc=$?", "ps -I; echo rc=$?", "ps -J; echo rc=$?", "ps -K; echo rc=$?", "ps -O; echo rc=$?", "ps -R 1; echo rc=$?", "ps -r; echo rc=$?", "ps -i; echo rc=$?",
    "ps -ef -aux; echo rc=$?", "ps -aux; echo rc=$?", "ps -auxw; echo rc=$?", "ps -auxf; echo rc=$?", "ps -axu", "ps -el", "ps -eLf", "ps -ely", "ps -elf", "ps -C sleep -f", "ps -fp $P1", "ps -p $P1 -f", "ps -fC sleep", "ps -fu root",
    "ps -a -d; echo rc=$?", "ps -ad", "ps -ae -d", "ps -aN", "ps -dN", "ps ax a", "ps aa", "ps xx", "ps rr", "ps -rr; echo rc=$?", "ps -r -e; echo rc=$?", "ps rx", "ps ra", "ps xa -e", "ps -e x", "ps -e a", "ps T r", "ps Tr", "ps -eT r",
    "ps tx; echo rc=$?", "ps -tx; echo rc=$?", "ps -t; echo rc=$?", "ps -T -t ?", "ps t?; echo rc=$?",
    "PS_FORMAT=pid,comm ps", "PS_FORMAT='pid comm' ps -p $P1", "PS_FORMAT=bogus ps -p $P1; echo rc=$?", "PS_FORMAT=pid,comm ps -f -p $P1", "PS_FORMAT=pid,comm ps -o args -p $P1", "PS_FORMAT=pid,comm ps aux", "PS_FORMAT=pid,comm ps -L",
    "PS_FORMAT=pid,comm ps -m; echo rc=$?", "PS_FORMAT=pid,comm ps -H -p $P1", "PS_FORMAT=pid=X,comm=Y ps -p $P1", "PS_FORMAT= ps -p $P1", "PS_FORMAT=',' ps -p $P1; echo rc=$?",
    "PS_PERSONALITY=bsd ps", "PS_PERSONALITY=bsd ps -f", "PS_PERSONALITY=bsd ps u", "PS_PERSONALITY=bsd ps -l", "PS_PERSONALITY=old ps", "PS_PERSONALITY=old ps l", "PS_PERSONALITY=linux ps -f -p $P1", "PS_PERSONALITY=linux ps -l -p $P1",
    "PS_PERSONALITY=posix ps -f -p $P1", "PS_PERSONALITY=sysv ps -x; echo rc=$?", "PS_PERSONALITY=svr4 ps -x -p $P1; echo rc=$?", "PS_PERSONALITY=hp ps -x -p $P1; echo rc=$?", "PS_PERSONALITY=hpux ps -x -p $P1; echo rc=$?",
    "PS_PERSONALITY=gnu ps -f -p $P1", "PS_PERSONALITY=debian ps -l -p $P1", "PS_PERSONALITY=digital ps -f -p $P1", "PS_PERSONALITY=tru64 ps l -p $P1", "PS_PERSONALITY=sunos4 ps -p $P1", "PS_PERSONALITY=sunos4 ps u -p $P1",
    "PS_PERSONALITY=irix ps -l -p $P1", "PS_PERSONALITY=aix ps u -p $P1", "PS_PERSONALITY=bogus ps; echo rc=$?", "PS_PERSONALITY=default ps -p $P1", "PS_PERSONALITY=BSD ps -p $P1", "PS_PERSONALITY=Linux ps -p $P1 -f", "PS_PERSONALITY=s390 ps -j -p $P1",
    "PS_PERSONALITY=os390 ps -j -p $P1", "PS_PERSONALITY=sco ps -x -p $P1; echo rc=$?", "PS_PERSONALITY=compaq ps -j -p $P1", "PS_PERSONALITY=unix95 ps -p $P1", "PS_PERSONALITY=solaris2 ps -p $P1", "PS_PERSONALITY=sgi ps -l -p $P1",
    "CMD_ENV=bsd ps", "CMD_ENV=bsd PS_PERSONALITY=linux ps -f -p $P1", "I_WANT_A_BROKEN_PS=1 ps", "I_WANT_A_BROKEN_PS=1 ps l -p $P1", "I_WANT_A_BROKEN_PS=1 ps -f -p $P1",
]


def ps_cases():
    pids = PS_COMMON_PIDS
    return [
        case("ps-alone", [], ["ps", "ps -e", "ps -ef", "ps aux", "ps -l", "ps -p $$", "ps -p $$ -o pid,ppid,pgid,sid,tty,stat,comm", "ps -fp $$ | cat", "ps axjf", "ps --ppid $$; echo rc=$?", "ps -C nosuch; echo rc=$?"], [], [], 0.2, True),
        case("ps-selection", PS_COMMON_SETUP, PS_SELECTION, pids, [], 0.5, True),
        case("ps-formats", PS_COMMON_SETUP, PS_FORMATS, pids, [], 0.5, True),
        case("ps-sorting", PS_COMMON_SETUP, PS_SORTING, pids, [], 0.5, True),
        case("ps-misc", PS_COMMON_SETUP, PS_MISC, pids, [], 0.5, True),
    ]


FAMILIES = {"ss": ss_cases, "netstat": netstat_cases, "fuser": fuser_cases, "nc": nc_cases, "unix": unix_cases, "umask": umask_cases, "ps": ps_cases}
