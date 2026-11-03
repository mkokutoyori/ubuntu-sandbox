#!/usr/bin/env python3
"""Record what the real tcpdump (4.99.4, libpcap 1.10.4) prints for -A and -c, and what it writes for -r with -w, on a savefile of an HTTP exchange.

usage: record_tcpdump_ascii_count.py out.json

The savefile is built here (an HTTP GET and its answer with CRLF, a tab, control bytes and 8-bit bytes in the payload, a POST, an ICMP echo, a DNS query, a FIN pair;
the last two records carry a microsecond field of 1000000 and 1100000, which tcpdump prints and copies as it is). READS are run as `tcpdump <args>`: the whole answer, banner
and status included, is stored in program order (a pty keeps the interleaving of stdout and stderr). WRITES are run in a fresh directory holding the savefile as http.pcap and
the file they wrote (g.pcap) is stored byte for byte.
"""
import base64, json, os, shutil, struct, subprocess, sys, tempfile

def csum(b):
    if len(b)%2: b+=b'\0'
    s=sum(struct.unpack('!%dH'%(len(b)//2),b))
    while s>>16: s=(s&0xffff)+(s>>16)
    return (~s)&0xffff

def eth(dst,src,t,payload): return bytes.fromhex(dst.replace(':',''))+bytes.fromhex(src.replace(':',''))+struct.pack('!H',t)+payload
def ip4(src,dst,proto,payload,ident=1):
    h=struct.pack('!BBHHHBBH4s4s',0x45,0,20+len(payload),ident,0x4000,64,proto,0,bytes(map(int,src.split('.'))),bytes(map(int,dst.split('.'))))
    h=h[:10]+struct.pack('!H',csum(h))+h[12:]
    return h+payload
def pseudo(src,dst,proto,l): return bytes(map(int,src.split('.')))+bytes(map(int,dst.split('.')))+struct.pack('!BBH',0,proto,l)
def tcp(src,dst,sp,dp,seq,ack,flags,data=b'',win=502):
    h=struct.pack('!HHIIBBHHH',sp,dp,seq,ack,5<<4,flags,win,0,0)
    seg=h+data
    c=csum(pseudo(src,dst,6,len(seg))+seg)
    seg=seg[:16]+struct.pack('!H',c)+seg[18:]
    return ip4(src,dst,6,seg)
def udp(src,dst,sp,dp,data):
    seg=struct.pack('!HHHH',sp,dp,8+len(data),0)+data
    c=csum(pseudo(src,dst,17,len(seg))+seg)
    seg=seg[:6]+struct.pack('!H',c)+seg[8:]
    return ip4(src,dst,17,seg)
def icmp(src,dst,data):
    m=struct.pack('!BBHHH',8,0,0,7,1)+data
    m=m[:2]+struct.pack('!H',csum(m))+m[4:]
    return ip4(src,dst,1,m)
A='aa:bb:cc:00:00:01'; B='aa:bb:cc:00:00:02'
a='10.0.0.1'; b='10.0.0.2'
get=b"GET /index.html HTTP/1.1\r\nHost: example.com\r\nUser-Agent: curl/8.5.0\r\nAccept: */*\r\n\r\n"
resp=b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 24\r\n\r\n<html>\tHi\x01\x02 \xc3\xbc\x7f\x80\xff</html>\n"
post=b"POST /login HTTP/1.1\r\nHost: example.com\r\nContent-Length: 22\r\n\r\nuser=admin&pass=secret"
frames=[
 eth(B,A,0x0800,tcp(a,b,50000,80,1000,0,0x02)),
 eth(A,B,0x0800,tcp(b,a,80,50000,5000,1001,0x12)),
 eth(B,A,0x0800,tcp(a,b,50000,80,1001,5001,0x10)),
 eth(B,A,0x0800,tcp(a,b,50000,80,1001,5001,0x18,get)),
 eth(A,B,0x0800,tcp(b,a,80,50000,5001,1001+len(get),0x10)),
 eth(A,B,0x0800,tcp(b,a,80,50000,5001,1001+len(get),0x18,resp)),
 eth(B,A,0x0800,tcp(a,b,50000,80,1001+len(get),5001+len(resp),0x10)),
 eth(B,A,0x0800,tcp(a,b,50001,80,2000,0,0x18,post)),
 eth(B,A,0x0800,icmp(a,b,b"abcdefgh\x00\x01hello")),
 eth(B,A,0x0800,udp(a,b,40000,53,b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01")),
 eth(B,A,0x0800,tcp(a,b,50000,80,1001+len(get),5001+len(resp),0x11)),
 eth(A,B,0x0800,tcp(b,a,80,50000,5001+len(resp),1002+len(get),0x11)),
]
recs=b''
t=1700000000
for i,f in enumerate(frames):
    recs+=struct.pack('<IIII',t+i,100000*i,len(f),len(f))+f
pcap=struct.pack('<IHHiIII',0xa1b2c3d4,2,4,0,0,262144,1)+recs

READS = [
 "-A -r http.pcap", "-nn -A -r http.pcap", "-c 2 -nn -A -r http.pcap", "-c 1 -A -r http.pcap", "-A -c 3 -nn -r http.pcap 'tcp port 80'",
 "-A -c 0 -r http.pcap", "-c -1 -r http.pcap", "-c abc -r http.pcap", "-c", "-A -c", "-c 1000 -A -nn -r http.pcap",
 "-A -nn -s 0 -r http.pcap 'tcp port 80'", "-A -nn -s 80 -r http.pcap", "-A -nn -s 100 -c 6 -r http.pcap",
 "-AA -nn -r http.pcap", "-A -x -nn -r http.pcap", "-A -X -nn -r http.pcap", "-A -XX -nn -c 4 -r http.pcap", "-A -xx -nn -c 4 -r http.pcap", "-X -A -nn -c 4 -r http.pcap",
 "-A -v -nn -c 5 -r http.pcap", "-A -q -nn -r http.pcap", "-A -e -nn -c 4 -r http.pcap", "-A -tttt -nn -c 3 -r http.pcap", "-A -t -nn -r http.pcap", "-A -l -nn -c 3 -r http.pcap", "-A -S -nn -c 4 -r http.pcap",
 "-A -nn -c 1 -r http.pcap 'icmp'", "-A -nn -r http.pcap 'udp port 53'", "-A -nn -r http.pcap 'tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420'",
 "-A -nn -r http.pcap 'tcp dst port 80 and (tcp[tcpflags] & tcp-push != 0)'", "-A -nn -c 1 -r http.pcap 'tcp[tcpflags] & (tcp-fin|tcp-rst) != 0'",
 "-A -nn -c 2 -r http.pcap 'src host 10.0.0.2'", "-nnA -c 2 -r http.pcap", "-nAc 2 -r http.pcap", "-Anc2 -r http.pcap", "-c2 -A -n -r http.pcap", "-c 2 -c 3 -A -n -r http.pcap",
 "-A -nn -c 5 -r http.pcap 'port 99'", "-A -nn -c 5 -r http.pcap 'host 10.0.0.9'", "-A -n -r http.pcap -c 2 'tcp port 80'", "-r http.pcap -A -n -c 2",
 "-A -nn --count -r http.pcap", "-A -nn -c 3 --count -r http.pcap", "-nn --count -r http.pcap", "-A -nn -B 4096 -c 2 -r http.pcap", "-A -nn -c 2 -r http.pcap -Q in",
]

WRITES = [
 "-r http.pcap -w g.pcap",
 "-nn -c 3 -r http.pcap -w g.pcap",
 "-r http.pcap -w g.pcap 'tcp port 80 and host 10.0.0.2'",
 "-r http.pcap -w g.pcap --count",
 "-r http.pcap -w g.pcap --print -nn -c 2",
 "-r http.pcap -w g.pcap -s 60",
 "-r http.pcap -w g.pcap -v",
 "-r http.pcap -w /nonexistent/g.pcap",
 "-r http.pcap -w g.pcap --nano",
 "-r http.pcap -w g.pcap 'tcp[tcpflags] & (tcp-fin|tcp-rst) != 0'",
 "-r http.pcap -w g.pcap '((('",
 "-r nothere.pcap -w g.pcap",
 "-r http.pcap -w g.pcap 'host 1.2.3.4'",
 "-A -c 2 -nn -r http.pcap -w g.pcap",
 "-r http.pcap -w g.pcap -q",
 "-r http.pcap -w g.pcap -c 1 --count",
 "-r http.pcap -w g.pcap -e",
 "-r http.pcap -w g.pcap -U",
 "-r http.pcap -w g.pcap -F /nonexistent",
]

def run(command, directory):
    inner = "tcpdump " + command + "; echo STATUS:$?"
    process = subprocess.run(["script", "-qec", inner, "/dev/null"], capture_output=True, env=dict(os.environ, TZ="UTC"), cwd=directory)
    return (process.stdout + process.stderr).replace(b"\r\n", b"\n")


def fresh_directory():
    directory = tempfile.mkdtemp()
    with open(directory + "/http.pcap", "wb") as handle:
        handle.write(pcap)
    os.chmod(directory, 0o777)
    return directory


reads = {}
for command in READS:
    directory = fresh_directory()
    reads[command] = base64.b64encode(run(command, directory)).decode()
    shutil.rmtree(directory)

writes = {}
for command in WRITES:
    directory = fresh_directory()
    text = run(command, directory)
    written = None
    if os.path.exists(directory + "/g.pcap"):
        with open(directory + "/g.pcap", "rb") as handle:
            written = base64.b64encode(handle.read()).decode()
    writes[command] = {"out": base64.b64encode(text).decode(), "file": written}
    shutil.rmtree(directory)

probe = subprocess.run(["tcpdump", "--version"], capture_output=True)
version = (probe.stdout + probe.stderr).decode().splitlines()
with open(sys.argv[1], "w") as handle:
    json.dump({"tcpdump": version[0], "libpcap": version[1], "pcap": base64.b64encode(pcap).decode(), "reads": reads, "writes": writes}, handle)
print(len(reads), "reads", len(writes), "writes")
