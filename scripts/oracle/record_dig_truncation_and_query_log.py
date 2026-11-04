#!/usr/bin/env python3
"""Record what the real dig 9.18 prints for a UDP answer cut at 512 bytes (default, +ignore, +short) and the flags the real named writes in its query log for dig options (+norecurse, +noedns, +tcp, +nocookie, +dnssec).

usage: record_dig_truncation_and_query_log.py   (prints the results; needs root, bind9, dnsutils; run it in unshare -n -m --propagation private)
"""
import os, subprocess, sys, tempfile, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_bind_cache_dump as lab

def main():
    base = tempfile.mkdtemp(); os.chmod(base, 0o777)
    subprocess.run(["ip","link","set","lo","up"], check=False)
    for a in lab.ADDRESSES:
        subprocess.run(["ip","addr","add",f"{a}/32","dev","lo"], check=True)
    root = tempfile.mkdtemp(dir=base); os.chmod(root, 0o777)
    zone = lab.BANK_ZONE + "".join(f"many IN A 198.51.100.{i}\n" for i in range(1,61))
    directory, proc = lab.instance(root,"ns1","203.0.113.10",9534,False,[("banquehorizon.com","db.bank",zone)])
    lab.write(root,"rndc.conf",lab.KEY+'\noptions { default-key "rndc-key"; default-server 127.0.0.1; default-port 9534; };\n')
    time.sleep(2)
    proc.terminate(); proc.wait(); time.sleep(1)
    conf=os.path.join(directory,"named.conf")
    with open(conf,"a") as h:
        h.write('logging { channel q { file "%s/query.log"; print-time yes; }; category queries { q; }; };\n'%directory)
    proc = subprocess.Popen(["named","-u","root","-f","-c",conf],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(2)
    subprocess.run(["rndc","-c",os.path.join(root,"rndc.conf"),"querylog","on"],check=True)
    time.sleep(1)
    try:
        def dig(*a):
            r=subprocess.run(["dig","@203.0.113.10",*a],capture_output=True,text=True)
            return (r.stdout+r.stderr)
        for label,args in [
          ("full-default",["many.banquehorizon.com","+noedns","+norecurse"]),
          ("full-ignore",["many.banquehorizon.com","+noedns","+norecurse","+ignore"]),
          ("short-default",["many.banquehorizon.com","+noedns","+norecurse","+short"]),
        ]:
            out=dig(*args)
            ls=out.splitlines()
            print("=====",label,"dig",*args, "lines=",len(ls)); print("\n".join(l for l in ls if not l.startswith("many.banquehorizon.com.\t"))[:1500])
        for a in (["mail.banquehorizon.com","+short"],["mail.banquehorizon.com","+noedns","+short"],["mail.banquehorizon.com","+norecurse","+short"],["mail.banquehorizon.com","+tcp","+short"],["mail.banquehorizon.com","+nocookie","+short"],["mail.banquehorizon.com","+dnssec","+short"]):
            dig(*a)
        time.sleep(1)
        subprocess.run(["rndc","-c",os.path.join(root,"rndc.conf"),"querylog","off"])
        subprocess.run(["rndc","-c",os.path.join(root,"rndc.conf"),"stop"])
        time.sleep(1)
        time.sleep(1)
        print("===== query.log", os.path.exists(os.path.join(directory,"query.log")), os.listdir(directory)); print(open(os.path.join(directory,"query.log")).read() if os.path.exists(os.path.join(directory,"query.log")) else "")
    finally:
        proc.terminate(); proc.wait()
        for a in lab.ADDRESSES:
            subprocess.run(["ip","addr","del",f"{a}/32","dev","lo"],capture_output=True)
main()
