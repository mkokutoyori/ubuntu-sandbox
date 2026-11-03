#!/usr/bin/env python3
"""Record what the real tcpdump (4.99.4, libpcap 1.10.4) matches for a corpus of filter expressions.

usage: record_tcpdump_filters.py OPTIONS_FIXTURE out.json

OPTIONS_FIXTURE is src/__tests__/support/oracle/tcpdump-options-4.99.4.json: its "base" and "dns" labs hold savefiles the simulator wrote.
Each expression is run as `tcpdump -nn -t -r <lab>.pcap <expression>` and the whole answer (status, text) is stored, so the replay test compares
what a filter matches AND what the tool says when it refuses one.
"""
import base64, json, os, subprocess, sys, tempfile

CORPUS = {
    "base": [
        "tcp[tcpflags] & tcp-syn != 0",
        "tcp[tcpflags] & (tcp-fin|tcp-rst) != 0",
        "tcp[tcpflags] & (tcp-fin | tcp-rst) != 0",
        "(tcp[tcpflags] & (tcp-fin|tcp-rst)) != 0",
        "tcp[tcpflags] & (tcp-syn|tcp-ack) = (tcp-syn|tcp-ack)",
        "tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack = 0",
        "tcp[tcpflags] & tcp-syn = tcp-syn",
        "tcp[tcpflags] == tcp-syn",
        "tcp[tcpflags] = tcp-syn|tcp-ack",
        "tcp[tcpflags] == (tcp-syn|tcp-ack)",
        "tcp[tcpflags] & tcp-rst != 0",
        "tcp[tcpflags] & (tcp-push|tcp-ack) = (tcp-push|tcp-ack)",
        "tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0",
        "tcp[13] & 2 != 0",
        "tcp[13] & 0x12 = 0x12",
        "tcp[13] | 1 = 17",
        "tcp[13] & 0x02 != 0 or tcp[13] & 0x01 != 0",
        "host 10.0.0.1 and host 10.0.0.2",
        "host 10.0.0.1 and host 10.0.0.99",
        "tcp port 9000",
        "tcp port 9000 and tcp[tcpflags] & tcp-syn != 0",
        "ip[2:2] > 100",
        "ip[2:2] - 20 > 100",
        "ip[2:2] + 4 < 60",
        "ip[2:2] * 2 > 300",
        "ip[2:2] / 2 > 50",
        "ip[2:2] % 2 = 0",
        "ip[8] < 64",
        "ip[8] = 64",
        "ip[0] & 0xf > 5",
        "ip[0] & 0xf = 5",
        "ip[0] >> 4 = 4",
        "ip[0] << 1 = 0x8a",
        "(ip[6:2] & 0x1fff) != 0",
        "ip[6] & 0x20 != 0",
        "ip[6:2] & 0x3fff != 0",
        "ip[9] = 6",
        "ip[9] != 6 and ip[9] != 1",
        "tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420",
        "tcp[((tcp[12] & 0xf0) >> 2):4] = 0x47455420",
        "tcp[(tcp[12] & 0xf0) >> 2:2] = 0x4745",
        "tcp[tcp[12] >> 4:1] > 0",
        "icmp[icmptype] = icmp-echo",
        "icmp[icmptype] = icmp-echoreply",
        "icmp[icmptype] != icmp-echo and icmp[icmptype] != icmp-echoreply",
        "icmp[icmptype] == icmp-unreach",
        "icmp[icmpcode] = 3",
        "icmp[0] = 8",
        "ether[0] & 1 = 1",
        "ether[12:2] = 0x0806",
        "ether[12:2] = 0x86dd",
        "ether[0:4] = 0xffffffff",
        "len > 100",
        "len <= 60",
        "len = 42",
        "len > 100 and tcp",
        "ip[2:2] = len - 14",
        "ip[2:2] < len",
        "len - 14 = ip[2:2]",
        "10 < len",
        "0x20 & ip[6] != 0",
        "2 + 2 = 4",
        "1 = 1",
        "1 = 2",
        "tcp[tcpflags] & tcp-syn != 0 or icmp",
        "not tcp[tcpflags] & tcp-syn != 0 and tcp",
        "!(tcp[tcpflags] & tcp-ack = 0) and tcp",
        "udp[0:2] = 53 or udp[2:2] = 53",
        "tcp[0:2] = 9000 or tcp[2:2] = 9000",
        "tcp[2:2] = 22",
        "tcp[8:4] > 0 and tcp[tcpflags] & tcp-ack != 0",
        "tcp[tcpflags]",
        "ip[8]",
        "ip[1] & 0xfc = 0",
        "ip[1] = 0",
        "ip[16:4] = 0x0a000002",
        "ip[12:4] = 0x0a000001",
        "ip[12:4] & 0xffffff00 = 0x0a000000",
        "arp[6:2] = 1",
        "arp[6:2] = 2",
        "ip6[6] = 6",
        "ip6[6] = 58",
        "tcp[tcpflags] &",
        "tcp[tcpflags] & ( != 0",
        "tcp[tcpflags] & (tcp-fin|tcp-rst != 0",
        "tcp[tcpflags] & tcp-nope != 0",
        "tcp[99999] = 1",
        "tcp[3:3] = 1",
        "tcp[0:8] = 1",
        "ip[] = 1",
        "ip[x] = 1",
        "tcp[tcpflags] & tcp-syn !=",
        "tcp[tcpflags] > > 0",
        "icmp[tcpflags] = 1",
        "udp[tcpflags] = 1",
    ],
    "dns": [
        "udp[0:2] = 53 or udp[2:2] = 53",
        "udp[8:2] > 0",
        "udp[10] & 0x80 != 0",
        "udp[10] & 0x80 = 0",
        "udp[10:2] & 0x8000 != 0",
        "udp[10:2] & 0x000f = 3",
        "udp[11] & 0xf = 3",
        "tcp[tcpflags] & tcp-syn != 0",
        "tcp[tcpflags] & (tcp-fin|tcp-rst) != 0",
        "host 10.0.0.1 and host 10.0.0.2",
        "len > 100",
        "ip[2:2] > 100",
        "udp port 53 and len > 100",
    ],
}


def main():
    fixture, target = sys.argv[1:3]
    labs = json.load(open(fixture))["labs"]
    recorded = {}
    with tempfile.TemporaryDirectory() as scratch:
        for lab, expressions in CORPUS.items():
            path = os.path.join(scratch, lab + ".pcap")
            open(path, "wb").write(base64.b64decode(labs[lab]["pcap"]))
            recorded[lab] = {"pcap": labs[lab]["pcap"], "answers": {}}
            for expression in expressions:
                done = subprocess.run(["tcpdump", "-nn", "-t", "-r", path, expression], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                text = done.stdout.decode("latin-1").replace(path, lab + ".pcap")
                recorded[lab]["answers"][expression] = {"status": done.returncode, "text": text}
    json.dump({"tcpdump": "4.99.4", "libpcap": "1.10.4", "labs": recorded}, open(target, "w"), separators=(",", ":"))


main()
