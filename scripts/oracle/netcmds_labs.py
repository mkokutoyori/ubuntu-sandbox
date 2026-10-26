def case(id, setup, steps, pids=(), addresses=(), settle=0.4):
    return {"id": id, "setup": list(setup), "steps": list(steps), "pids": list(pids), "addresses": list(addresses), "settle": settle}


ADDRESSES = ["10.0.0.1/24", "10.0.0.2/24"]

EMPTY = ([], [])
ONE_TCP = (["nc -l 8080 & P1=$!"], ["P1"])
TCP_AND_UDP = (["nc -l 8080 & P1=$!", "nc -lu 5353 & P2=$!"], ["P1", "P2"])
BOUND = (["nc -l 127.0.0.1 9000 & P1=$!", "nc -l 10.0.0.1 7000 & P2=$!", "nc -lu 127.0.0.1 5300 & P3=$!"], ["P1", "P2", "P3"])
IPV6 = (["nc -6 -l ::1 9001 & P1=$!", "nc -6 -l 9002 & P2=$!", "nc -6 -lu 5300 & P3=$!"], ["P1", "P2", "P3"])
CONNECTED = (
    ["nc -l 127.0.0.1 9000 & P1=$!", "sleep 0.3", "nc -p 40001 127.0.0.1 9000 & P2=$!"],
    ["P1", "P2"],
)
TWO_CONNECTIONS = (
    ["nc -k -l 127.0.0.1 9000 & P1=$!", "sleep 0.3", "nc -p 40001 127.0.0.1 9000 & P2=$!", "nc -p 40002 127.0.0.1 9000 & P3=$!"],
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
    ("ipv6", IPV6),
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
    "ss -A tcp", "ss -A udp,tcp", "ss -A raw", "ss -tm", "ss --tos -t", "ss --cgroup -t", "ss -V", "ss -h", "ss -z", "ss --nope", "ss -tp",
]


def ss_cases():
    out = []
    for name, (setup, pids) in SOCKET_SCENARIOS:
        out.append(case("ss-" + name, setup, SS_COMMANDS, pids, ADDRESSES))
    return out


def netstat_cases():
    return []


def fuser_cases():
    return []


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


def nc_cases():
    out = [case("nc-cli", [], NC_CLI, [], ADDRESSES)]
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
