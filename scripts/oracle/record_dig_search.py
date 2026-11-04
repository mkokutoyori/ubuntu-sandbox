#!/usr/bin/env python3
"""Record what the real dig 9.18 prints with +search against a resolv.conf holding a search list (bind-mounted over /etc/resolv.conf), for a name below ndots, at ndots, absolute, failing everywhere, and +nosearch.

usage: record_dig_search.py out.json   (prints the results; needs root, bind9, dnsutils; run it in unshare -n -m --propagation private)
"""

import json, os, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab

def main():
    base = tempfile.mkdtemp(); os.chmod(base, 0o777)
    subprocess.run(["ip","link","set","lo","up"], check=False)
    for a in lab.ADDRESSES:
        subprocess.run(["ip","addr","add",f"{a}/32","dev","lo"], check=True)
    resolv = os.path.join(base, "resolv.conf")
    open(resolv,"w").write("nameserver 10.20.20.53\nsearch banquehorizon.com\n")
    subprocess.run(["mount","--bind",resolv,"/etc/resolv.conf"],check=True)
    root = tempfile.mkdtemp(dir=base); os.chmod(root, 0o777)
    procs=[]
    try:
        for name,address,control,zones in [
            ("root","198.51.100.1",9532,[(".","db.root",lab.ROOT_ZONE)]),
            ("com","198.51.100.2",9533,[("com","db.com",lab.COM_ZONE)]),
            ("ns1","203.0.113.10",9534,[("banquehorizon.com","db.bank",lab.BANK_ZONE),("113.0.203.in-addr.arpa","db.rev",lab.REVERSE_ZONE)]),
            ("ns2","203.0.113.11",9535,[("banquehorizon.com","db.bank",lab.BANK_ZONE),("113.0.203.in-addr.arpa","db.rev",lab.REVERSE_ZONE)]),
        ]:
            procs.append(lab.instance(root,name,address,control,False,zones)[1])
        _,res = lab.instance(root,"res","10.20.20.53",9531,True,[(".","db.hints",lab.HINTS)],hints=True)
        procs.append(res)
        lab.write(root,"rndc.conf",lab.KEY+'\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9531; };\n')
        for _ in range(100):
            if subprocess.run(["rndc","-c",os.path.join(root,"rndc.conf"),"status"],capture_output=True).returncode==0: break
            time.sleep(0.1)
        time.sleep(1)
        out=[]
        for args in [["web","+search"],["web","+search","+short"],["web.banquehorizon","+search"],["nexiste","+search"],["web","+nosearch"],["web"],["www","+search","+noall","+answer"],["web.banquehorizon.com","+search","+short"],["web.","+search"],["web","+search","+noall","+comments","+question"],["@10.20.20.53","web","+search","+short"]]:
            r=subprocess.run(["dig",*args],capture_output=True,text=True)
            out.append({"args":args,"rc":r.returncode,"stdout":r.stdout,"stderr":r.stderr})
            print("=====","dig"," ".join(args),"rc",r.returncode); print("\n".join(l for l in (r.stdout+r.stderr).splitlines() if not l.startswith(";; WHEN") and not l.startswith(";; Query time") and "DiG" not in l and "->>HEADER" not in l))
        json.dump(out,open(sys.argv[1],"w"))
    finally:
        for p in procs: p.terminate()
        for p in procs: p.wait()
        subprocess.run(["umount","/etc/resolv.conf"],capture_output=True)
        for a in lab.ADDRESSES:
            subprocess.run(["ip","addr","del",f"{a}/32","dev","lo"],capture_output=True)
main()
