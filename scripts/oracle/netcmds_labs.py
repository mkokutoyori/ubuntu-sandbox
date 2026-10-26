def case(id, setup, steps, pids=(), addresses=(), settle=0.4):
    return {"id": id, "setup": list(setup), "steps": list(steps), "pids": list(pids), "addresses": list(addresses), "settle": settle}


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


def ps_cases():
    return []


FAMILIES = {"ss": ss_cases, "netstat": netstat_cases, "fuser": fuser_cases, "nc": nc_cases, "ps": ps_cases}
