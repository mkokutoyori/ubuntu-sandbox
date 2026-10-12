"""Synthetic audit.log generators for the aureport/ausearch oracle (uids 1100+ do not exist on the lab host)."""
import random, sys, json
def gen_typed(seed, n):
    r = random.Random(seed)
    t = 1760000000.0 + r.randint(0, 100000)
    serial = r.randint(10, 500)
    users = {0:"root",1100:"alice",1101:"bob",1102:"carol"}
    ips = ["10.0.0.5","192.168.1.20","172.16.4.9","?"]
    lines = []
    def ev(parts):
        nonlocal t, serial
        t += r.random()*40; serial += 1
        for p in parts:
            lines.append("type=%s msg=audit(%.3f:%d): %s" % (p[0], t, serial, p[1]))
    for i in range(n):
        k = r.choice(["login","fail","sudo","adduser","deluser","chauth","file","exec","svc","cfg","abend","group","logout","netf"])
        uid = r.choice([1100,1101,1102]); name = users[uid]; ses = r.randint(1,40); pid = r.randint(500,9000); ip = r.choice(ips)
        res = "success"
        if k == "login":
            ev([("USER_AUTH", "pid=%d uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='op=PAM:authentication grantors=pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,name,ip,ip)),
                ("USER_ACCT", "pid=%d uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='op=PAM:accounting grantors=pam_unix,pam_permit acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,name,ip,ip)),
                ("CRED_ACQ", "pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=PAM:setcred grantors=pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,uid,ses,name,ip,ip)),
                ("LOGIN", "pid=%d uid=0 subj=unconfined old-auid=4294967295 auid=%d tty=(none) old-ses=4294967295 ses=%d res=1" % (pid,uid,ses)),
                ("USER_START", "pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=PAM:session_open grantors=pam_selinux,pam_loginuid,pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,uid,ses,name,ip,ip)),
                ("USER_LOGIN", "pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=login id=%d exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=/dev/pts/%d res=success'" % (pid,uid,ses,uid,ip,ip,r.randint(0,5)))])
        elif k == "fail":
            ev([("USER_AUTH", "pid=%d uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='op=PAM:authentication grantors=pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=failed'" % (pid,r.choice([name,"admin","root"]),ip,ip)),
                ("USER_LOGIN", "pid=%d uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='op=login acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=failed'" % (pid,name,ip,ip))])
            if r.random()<0.4:
                ev([("ANOM_LOGIN_FAILURES","pid=%d uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='pam_tally2 uid=%d exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,uid,ip,ip))])
        elif k == "sudo":
            ev([("USER_CMD","pid=%d uid=%d auid=%d ses=%d subj=unconfined msg='cwd=\"/home/%s\" cmd=%s exe=\"/usr/bin/sudo\" terminal=pts/0 res=%s'" % (pid,uid,uid,ses,name,r.choice(["6C73202F726F6F74","73797374656D63746C2072657374617274207373683","696420"]) if False else "\"%s\"" % r.choice(["ls /root","systemctl restart ssh","id"]), r.choice(["success","success","failed"])))])
        elif k == "adduser":
            nm = r.choice(["dave","erin","frank"])
            ev([("ADD_USER","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=adding user id=%d exe=\"/usr/sbin/useradd\" hostname=? addr=? terminal=pts/0 res=success'" % (pid,uid,ses,r.randint(1103,1200))),
                ("ADD_GROUP","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=adding group acct=\"%s\" exe=\"/usr/sbin/useradd\" hostname=? addr=? terminal=pts/0 res=success'" % (pid,uid,ses,nm)),
                ("USER_MGMT","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=adding home directory id=%d exe=\"/usr/sbin/useradd\" hostname=? addr=? terminal=pts/0 res=success'" % (pid,uid,ses,r.randint(1103,1200)))])
        elif k == "deluser":
            ev([("DEL_USER","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=deleting user acct=\"%s\" exe=\"/usr/sbin/userdel\" hostname=? addr=? terminal=pts/0 res=success'" % (pid,uid,ses,r.choice(["dave","erin"])))])
        elif k == "chauth":
            ev([("USER_CHAUTHTOK","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=PAM:chauthtok grantors=pam_unix acct=\"%s\" exe=\"/usr/bin/passwd\" hostname=? addr=? terminal=pts/0 res=%s'" % (pid,uid,ses,name,r.choice(["success","success","failed"])))])
        elif k == "group":
            ev([("ADD_GROUP","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=adding group acct=\"ops%d\" exe=\"/usr/sbin/groupadd\" hostname=? addr=? terminal=pts/0 res=success'" % (pid,uid,ses,r.randint(1,3)))])
        elif k in ("file","exec"):
            key = r.choice(["pwd_changes","sshd_config","exec_log","identity"]); path = r.choice(["/etc/passwd","/etc/shadow","/etc/ssh/sshd_config","/usr/bin/curl"]); comm = r.choice(["vim","cat","cp","sed"]); exe="/usr/bin/"+comm
            sysc = r.choice(["openat","execve","unlink"]); sno={"openat":257,"execve":59,"unlink":87}[sysc]
            ok = r.choice(["yes","yes","no"])
            ev([("SYSCALL","arch=c000003e syscall=%d success=%s exit=%s a0=ffffff9c a1=7ffd1234 a2=241 a3=1b6 items=1 ppid=%d pid=%d auid=%d uid=%d gid=%d euid=%d suid=%d fsuid=%d egid=%d sgid=%d fsgid=%d tty=pts0 ses=%d comm=\"%s\" exe=\"%s\" subj=unconfined key=\"%s\"" % (sno,ok,"3" if ok=="yes" else "-13",pid-1,pid,uid,uid,uid,uid,uid,uid,uid,uid,uid,ses,comm,exe,key)),
                ("CWD","cwd=\"/home/%s\"" % name),
                ("PATH","item=0 name=\"%s\" inode=%d dev=08:01 mode=0100644 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0" % (path,r.randint(100,99999))),
                ("PROCTITLE","proctitle=%s" % (comm.encode().hex().upper()))])
        elif k == "svc":
            ev([("SERVICE_START" if r.random()<.5 else "SERVICE_STOP","pid=1 uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='unit=%s comm=\"systemd\" exe=\"/usr/lib/systemd/systemd\" hostname=? addr=? terminal=? res=success'" % r.choice(["ssh","cron","nginx","auditd"]))])
        elif k == "cfg":
            ev([("CONFIG_CHANGE","pid=%d uid=0 auid=%d ses=%d subj=unconfined op=add_rule key=\"%s\" list=4 res=1" % (pid,uid,ses,r.choice(["pwd_changes","exec_log"])))])
        elif k == "abend":
            ev([("ANOM_ABEND","auid=%d uid=%d gid=%d ses=%d subj=unconfined pid=%d comm=\"%s\" exe=\"/usr/bin/%s\" sig=11 res=1" % (uid,uid,uid,ses,pid,"curl","curl"))])
        elif k == "logout":
            ev([("USER_END","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=PAM:session_close grantors=pam_selinux,pam_loginuid,pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,uid,ses,name,ip,ip)),
                ("CRED_DISP","pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=PAM:setcred grantors=pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=%s terminal=ssh res=success'" % (pid,uid,ses,name,ip,ip))])
        elif k == "netf":
            ev([("NETFILTER_CFG","table=filter family=2 entries=%d op=nft_register_chain pid=%d subj=unconfined comm=\"nft\"" % (r.randint(1,9),pid))])
    return "\n".join(lines)+"\n"

TYPES = {
 "USER_AUTH":"op=PAM:authentication grantors=pam_unix acct=\"{n}\" exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res={r}",
 "USER_ACCT":"op=PAM:accounting grantors=pam_unix acct=\"{n}\" exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res={r}",
 "USER_ERR":"op=PAM:bad_ident grantors=? acct=\"?\" exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res=failed",
 "CRED_ACQ":"op=PAM:setcred grantors=pam_unix acct=\"{n}\" exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res={r}",
 "CRED_REFR":"op=PAM:setcred grantors=pam_unix acct=\"{n}\" exe=\"/usr/bin/sudo\" hostname=? addr=? terminal=/dev/pts/0 res={r}",
 "USER_LOGIN":"op=login id={u} exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=/dev/pts/1 res={r}",
 "USER_LOGOUT":"op=login id={u} exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=/dev/pts/1 res=success",
 "USER_START":"op=PAM:session_open grantors=pam_unix acct=\"{n}\" exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res={r}",
 "USER_END":"op=PAM:session_close grantors=pam_unix acct=\"{n}\" exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res={r}",
 "USER_CHAUTHTOK":"op=PAM:chauthtok grantors=pam_unix acct=\"{n}\" exe=\"/usr/bin/passwd\" hostname=? addr=? terminal=pts/0 res={r}",
 "USER_MGMT":"op=adding home directory id={u} exe=\"/usr/sbin/useradd\" hostname=? addr=? terminal=pts/0 res={r}",
 "ADD_USER":"op=adding user id={u} exe=\"/usr/sbin/useradd\" hostname=? addr=? terminal=pts/0 res={r}",
 "DEL_USER":"op=deleting user acct=\"{n}\" exe=\"/usr/sbin/userdel\" hostname=? addr=? terminal=pts/0 res={r}",
 "ADD_GROUP":"op=adding group acct=\"{n}\" exe=\"/usr/sbin/groupadd\" hostname=? addr=? terminal=pts/0 res={r}",
 "DEL_GROUP":"op=deleting group acct=\"{n}\" exe=\"/usr/sbin/groupdel\" hostname=? addr=? terminal=pts/0 res={r}",
 "GRP_MGMT":"op=modifying group acct=\"{n}\" exe=\"/usr/sbin/groupmod\" hostname=? addr=? terminal=pts/0 res={r}",
 "ACCT_LOCK":"pid={pid} uid=0 auid={u} ses={s} subj=unconfined msg='op=locked-password id={u} exe=\"/usr/sbin/usermod\" hostname=? addr=? terminal=pts/0 res={r}'",
 "USER_CMD":"cwd=\"/home/{n}\" cmd=\"ls\" exe=\"/usr/bin/sudo\" terminal=pts/0 res={r}",
 "SERVICE_START":"unit=ssh comm=\"systemd\" exe=\"/usr/lib/systemd/systemd\" hostname=? addr=? terminal=? res={r}",
 "SERVICE_STOP":"unit=cron comm=\"systemd\" exe=\"/usr/lib/systemd/systemd\" hostname=? addr=? terminal=? res={r}",
 "USER_AVC":"op=map_perm path=\"/etc\" exe=\"/usr/bin/dbus\" hostname=? addr=? terminal=? res={r}",
 "CRYPTO_KEY_USER":"op=destroy kind=server fp=ab:cd:ef direction=? spid={pid} suid=0 exe=\"/usr/sbin/sshd\" hostname=? addr={ip} terminal=? res={r}",
 "CRYPTO_SESSION":"op=start direction=from-server cipher=aes256-ctr ksize=256 mac=hmac-sha2-256 pfs=curve25519 spid={pid} suid=0 rport=4444 laddr=10.0.0.1 lport=22 exe=\"/usr/sbin/sshd\" hostname=? addr={ip} terminal=? res={r}",
 "USER_ROLE_CHANGE":"pid={pid} uid=0 auid={u} ses={s} msg='op=newrole acct=\"{n}\" exe=\"/usr/bin/newrole\" hostname=? addr=? terminal=? res={r}'",
 "INTEGRITY_DATA":"pid={pid} uid=0 auid={u} ses={s} op=appraise_data cause=IMA-signature-required comm=\"x\" name=\"/usr/bin/x\" dev=\"sda1\" ino=12 res=0",
 "APPARMOR_DENIED":"apparmor=\"DENIED\" operation=\"open\" profile=\"/usr/sbin/tcpdump\" name=\"/etc/shadow\" pid={pid} comm=\"tcpdump\" requested_mask=\"r\" denied_mask=\"r\" fsuid=0 ouid=0",
 "AVC":"avc:  denied  {{ read }} for  pid={pid} comm=\"httpd\" name=\"x\" dev=\"sda1\" ino=12 scontext=system_u:system_r:httpd_t:s0 tcontext=system_u:object_r:user_home_t:s0 tclass=file permissive=0",
 "MAC_STATUS":"enforcing=1 old_enforcing=0 auid={u} ses={s} enabled=1 old-enabled=1 lsm=selinux res=1",
 "ANOM_ABEND":"auid={u} uid={u} gid={u} ses={s} subj=unconfined pid={pid} comm=\"curl\" exe=\"/usr/bin/curl\" sig=11 res=1",
 "ANOM_PROMISCUOUS":"dev=eth0 prom=256 old_prom=0 auid={u} uid=0 gid=0 ses={s}",
 "ANOM_LOGIN_FAILURES":"pid={pid} uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='pam_tally2 uid={u} exe=\"/usr/sbin/sshd\" hostname={ip} addr={ip} terminal=ssh res=success'",
 "RESP_ANOMALY":"pid={pid} uid=0 auid={u} ses={s} op=ignore-all res=failed",
 "CONFIG_CHANGE":"auid={u} ses={s} subj=unconfined op=add_rule key=\"k1\" list=4 res=1",
 "NETFILTER_CFG":"table=filter family=2 entries=3 op=nft_register_chain pid={pid} subj=unconfined comm=\"nft\"",
 "DAEMON_START":"op=start ver=3.1.2 format=enriched kernel=6.8.0-45-generic auid=4294967295 pid={pid} uid=0 ses=4294967295 subj=unconfined res=success",
 "DAEMON_END":"op=terminate auid=4294967295 pid={pid} subj=unconfined res=success",
 "SYSTEM_BOOT":"pid={pid} uid=0 auid=4294967295 ses=4294967295 msg=' comm=\"systemd-update-utmp\" exe=\"/usr/lib/systemd/systemd-update-utmp\" hostname=? addr=? terminal=? res=success'",
 "SYSTEM_SHUTDOWN":"pid={pid} uid=0 auid=4294967295 ses=4294967295 msg=' comm=\"systemd-update-utmp\" exe=\"/usr/lib/systemd/systemd-update-utmp\" hostname=? addr=? terminal=? res=success'",
 "KERN_MODULE":"pid={pid} uid=0 auid={u} ses={s} subj=unconfined op=load name=\"nf_tables\" res=1",
 "LOGIN":"pid={pid} uid=0 subj=unconfined old-auid=4294967295 auid={u} tty=(none) old-ses=4294967295 ses={s} res=1",
 "TTY":"tty pid={pid} uid={u} auid={u} ses={s} major=136 minor=0 comm=\"bash\" data=6C730A",
}
def gen_mixed(seed, n):
    r = random.Random(seed); t = 1760000000.0 + r.randint(0, 100000); serial = r.randint(10, 500)
    users = {0:"root",1100:"alice",1101:"bob",1102:"carol",4294967295:"unset"}
    out=[]
    names=list(TYPES)
    for i in range(n):
        ty = r.choice(names)
        t += r.random()*30; serial += 1
        uid = r.choice([0,1100,1101,1102,4294967295]); nm = users[uid] if uid!=4294967295 else "?"
        pid=r.randint(200,9000); ses=r.randint(1,30); ip=r.choice(["10.0.0.5","192.168.1.20","?"]); res=r.choice(["success","success","failed"])
        body=TYPES[ty].format(n=nm if nm!="?" else "root",u=uid if uid!=4294967295 else 1100,pid=pid,s=ses,ip=ip,r=res)
        if ty in ("USER_AUTH","USER_ACCT","USER_ERR","CRED_ACQ","CRED_REFR","USER_LOGIN","USER_LOGOUT","USER_START","USER_END","USER_CHAUTHTOK","USER_MGMT","ADD_USER","DEL_USER","ADD_GROUP","DEL_GROUP","GRP_MGMT","USER_CMD","SERVICE_START","SERVICE_STOP","USER_AVC","CRYPTO_KEY_USER","CRYPTO_SESSION"):
            au=r.choice([1100,1101,4294967295])
            body="pid=%d uid=%d auid=%d ses=%d subj=unconfined msg='%s'"%(pid,uid if uid!=4294967295 else 0,au,ses if au!=4294967295 else 4294967295,body)
        out.append("type=%s msg=audit(%.3f:%d): %s"%(ty,t,serial,body))
        if ty=="LOGIN" and r.random()<.5:
            pass
    return "\n".join(out)+"\n"


def gen_rich(seed, n):
    import random
    r = random.Random(seed)
    t = 1760100000.0 + r.randint(0, 5000)
    serial = r.randint(100, 900)
    out = []
    hexes = ["6C730A", "1B5B41", "7375646F2069640A0D", "09", "2F6574632F706173737764", "03", "7F7F", "1B4F50", "1B5B313B3243"]
    for _ in range(n):
        t += r.random() * 20
        serial += 1
        k = r.choice(["tty", "usertty", "sock", "execve", "pathrel", "permavc", "abend", "mixedkeys", "node"])
        pid = r.randint(300, 9000)
        auid = r.choice([1100, 1101, 4294967295])
        stamp = "msg=audit(%.3f:%d):" % (t, serial)
        if k == "tty":
            out.append("type=TTY %s tty pid=%d uid=1100 auid=%d ses=%d major=136 minor=%d comm=\"bash\" data=%s" % (stamp, pid, auid, r.randint(1, 9), r.randint(0, 9), r.choice(hexes)))
        elif k == "usertty":
            out.append("type=USER_TTY %s pid=%d uid=1100 auid=%d ses=%d subj=unconfined msg='data=%s'" % (stamp, pid, auid, r.randint(1, 9), r.choice(hexes)))
        elif k == "sock":
            fam = r.choice(["0200", "0A00"])
            addr = "0050" + "0A000005" + "0000000000000000" if fam == "0200" else "0050" + "00000000" + "00000000000000000000000000000001" + "00000000"
            out.append("type=SYSCALL %s arch=c000003e syscall=42 success=yes exit=0 a0=3 a1=7ffc a2=10 a3=0 items=0 ppid=1 pid=%d auid=%d uid=1100 gid=1100 euid=1100 suid=1100 fsuid=1100 egid=1100 sgid=1100 fsgid=1100 tty=pts0 ses=2 comm=\"curl\" exe=\"/usr/bin/curl\" key=\"net\"" % (stamp, pid, auid))
            out.append("type=SOCKADDR %s saddr=%s%s" % (stamp, fam, addr))
        elif k == "execve":
            out.append("type=SYSCALL %s arch=c000003e syscall=59 success=yes exit=0 a0=55 a1=66 a2=77 a3=0 items=2 ppid=1 pid=%d auid=%d uid=1100 gid=1100 euid=1100 suid=1100 fsuid=1100 egid=1100 sgid=1100 fsgid=1100 tty=(none) ses=2 comm=\"ls\" exe=\"/usr/bin/ls\" key=\"exec\"" % (stamp, pid, auid))
            out.append("type=EXECVE %s argc=2 a0=\"ls\" a1=\"-la\"" % stamp)
            out.append("type=CWD %s cwd=\"/home/user dir\"" % stamp)
            out.append("type=PATH %s item=0 name=\"/usr/bin/ls\" inode=77 dev=08:01 mode=0100755 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL" % stamp)
            out.append("type=PROCTITLE %s proctitle=6C73002D6C61" % stamp)
        elif k == "pathrel":
            out.append("type=SYSCALL %s arch=c000003e syscall=2 success=no exit=-2 a0=55 a1=0 a2=0 a3=0 items=2 ppid=1 pid=%d auid=%d uid=1100 gid=1100 euid=1100 suid=1100 fsuid=1100 egid=1100 sgid=1100 fsgid=1100 tty=pts1 ses=2 comm=\"cat\" exe=\"/usr/bin/cat\" key=\"%s\"" % (stamp, pid, auid, r.choice(["a", "b"])))
            out.append("type=CWD %s cwd=\"/var/log\"" % stamp)
            out.append("type=PATH %s item=0 name=\"../etc/passwd\" nametype=PARENT" % stamp)
            out.append("type=PATH %s item=1 name=\"./x.txt\" nametype=CREATE" % stamp)
        elif k == "permavc":
            out.append("type=AVC %s avc:  granted  { read write } for  pid=%d comm=\"nginx\" path=\"/srv/x\" dev=\"sda1\" ino=9 scontext=system_u:system_r:httpd_t:s0 tcontext=system_u:object_r:httpd_sys_content_t:s0 tclass=file" % (stamp, pid))
            out.append("type=AVC %s avc:  denied  { write } for  pid=%d comm=\"nginx\" name=\"y\" dev=\"sda1\" ino=11 scontext=system_u:system_r:httpd_t:s0 tcontext=system_u:object_r:var_t:s0 tclass=dir permissive=1" % (stamp, pid))
            out.append("type=SYSCALL %s arch=c000003e syscall=2 success=yes exit=3 a0=1 a1=2 a2=3 a3=4 items=0 ppid=1 pid=%d auid=%d uid=33 gid=33 euid=33 suid=33 fsuid=33 egid=33 sgid=33 fsgid=33 tty=(none) ses=4294967295 comm=\"nginx\" exe=\"/usr/sbin/nginx\" subj=system_u:system_r:httpd_t:s0 key=(null)" % (stamp, pid, auid))
        elif k == "abend":
            out.append("type=ANOM_ABEND %s auid=%d uid=1100 gid=1100 ses=2 subj=unconfined pid=%d comm=\"x\" exe=\"/usr/bin/x\" sig=11 res=1" % (stamp, auid, pid))
        elif k == "mixedkeys":
            out.append("type=SYSCALL %s arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=7ff a2=0 a3=0 items=1 ppid=1 pid=%d auid=%d uid=1100 gid=1100 euid=1100 suid=1100 fsuid=1100 egid=1100 sgid=1100 fsgid=1100 tty=pts0 ses=2 comm=\"vim\" exe=\"/usr/bin/vim\" key=%s" % (stamp, pid, auid, r.choice(["\"k1\"", "\"k2\"", "6B310B6B32", "(null)"])))
            out.append("type=PATH %s item=0 name=\"/etc/hosts\" inode=5 dev=08:01 mode=0100644 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL" % stamp)
        else:
            out.append("node=host%d type=USER_LOGIN %s pid=%d uid=0 auid=%d ses=2 subj=unconfined msg='op=login id=1100 exe=\"/usr/sbin/sshd\" hostname=? addr=10.1.1.%d terminal=/dev/pts/0 res=success'" % (r.randint(1, 2), stamp, pid, auid, r.randint(1, 9)))
    return "\n".join(out) + "\n"


SYS64 = {
    "open": (2, lambda r: ["55a1b0", r.choice(["0", "1", "2", "41", "241", "441", "10002", "80000", "c2", "1000", "142", "8002", "20000", "ffff"]), r.choice(["0", "1b6", "1a4", "180", "0", "1ff", "fff"]), "0"]),
    "openat": (257, lambda r: [r.choice(["ffffff9c", "3", "5"]), "55d0", r.choice(["0", "241", "80000", "10000", "20002", "2", "40000"]), r.choice(["0", "1b6", "1ed"])]),
    "mmap": (9, lambda r: ["0", "1000", r.choice(["0", "1", "2", "3", "4", "5", "7"]), r.choice(["0", "1", "2", "22", "32", "21", "1", "4000", "8022", "10", "100", "40022"])]),
    "mprotect": (10, lambda r: ["7f00", "1000", r.choice(["0", "1", "3", "5", "7", "4"]), "0"]),
    "fcntl": (72, lambda r: [r.choice(["3", "4", "5"]), r.choice(["0", "1", "2", "3", "4", "8", "9", "a", "406", "400", "402", "401", "1030", "ff"]), r.choice(["0", "1", "1000", "2", "3"]), "0"]),
    "setsockopt": (54, lambda r: ["3", r.choice(["0", "1", "6", "11", "29", "107", "3", "10", "113", "fe"]), r.choice(["1", "2", "3", "4", "6", "7", "8", "9", "a", "b", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "1a", "20", "21", "ff", "64", "65", "0"]), "7ffc"]),
    "getsockopt": (55, lambda r: ["3", r.choice(["1", "0", "6"]), r.choice(["1", "2", "3", "4", "7"]), "7ffc"]),
    "socket": (41, lambda r: [r.choice(["1", "2", "a", "10", "11", "10000", "5", "ff"]), r.choice(["1", "2", "3", "5", "80001", "80802", "0", "ff", "803"]), r.choice(["0", "6", "11", "1", "3", "ff", "58", "2f"]), "0"]),
    "chmod": (90, lambda r: ["55a0", r.choice(["1ed", "1a4", "0", "fff", "800", "c00", "1ff", "e00"]), "0", "0"]),
    "fchmod": (91, lambda r: ["3", r.choice(["1ed", "180", "1b6", "400"]), "0", "0"]),
    "fchmodat": (268, lambda r: [r.choice(["ffffff9c", "3"]), "55a0", r.choice(["1ed", "1a4"]), "0"]),
    "chown": (92, lambda r: ["55a0", r.choice(["0", "44c", "ffffffff", "1", "21"]), r.choice(["0", "44c", "ffffffff", "21"]), "0"]),
    "fchownat": (260, lambda r: ["ffffff9c", "55a0", r.choice(["0", "44d"]), r.choice(["0", "44d", "ffffffff"])]),
    "setuid": (105, lambda r: [r.choice(["0", "44c", "21", "ffffffff", "270f"]), "0", "0", "0"]),
    "setreuid": (113, lambda r: [r.choice(["0", "44c", "ffffffff"]), r.choice(["0", "44c", "ffffffff"]), "0", "0"]),
    "setresuid": (117, lambda r: [r.choice(["0", "44c", "ffffffff"]), r.choice(["0", "44d", "ffffffff"]), r.choice(["0", "44c", "ffffffff"]), "0"]),
    "setgid": (106, lambda r: [r.choice(["0", "44c", "ffffffff"]), "0", "0", "0"]),
    "setresgid": (119, lambda r: [r.choice(["0", "44c", "ffffffff"]), r.choice(["0", "44d"]), r.choice(["0", "ffffffff"]), "0"]),
    "setfsuid": (122, lambda r: [r.choice(["0", "44c"]), "0", "0", "0"]),
    "clone": (56, lambda r: [r.choice(["3d0f00", "1200011", "4001000", "7d0f00", "11", "0", "20000000", "2000000", "10f00", "50f00011", "ffffffff"]), "0", "0", "0"]),
    "unshare": (272, lambda r: [r.choice(["40000000", "20000000", "10000", "6c020000", "0", "20000", "8000000"]), "0", "0", "0"]),
    "ptrace": (101, lambda r: [r.choice(["0", "10", "11", "12", "4206", "4207", "ffff", "1", "3"]), "400", "0", "0"]),
    "prctl": (157, lambda r: [r.choice(["1", "17", "18", "15", "16", "26", "27", "22", "ffff", "36", "7"]), r.choice(["0", "9", "a", "15", "1b", "1"]), "0", "0"]),
    "kill": (62, lambda r: ["400", r.choice(["0", "1", "9", "f", "11", "13", "1f", "20", "ff"]), "0", "0"]),
    "tkill": (200, lambda r: ["400", r.choice(["9", "f", "6"]), "0", "0"]),
    "tgkill": (234, lambda r: ["400", "401", r.choice(["9", "f", "6", "20"]), "0"]),
    "rt_sigaction": (13, lambda r: [r.choice(["2", "f", "11", "1f", "20", "7"]), "7ffd", "0", "8"]),
    "personality": (135, lambda r: [r.choice(["0", "8", "40000", "4000000", "20000", "ffffffff", "ff"]), "0", "0", "0"]),
    "mount": (165, lambda r: ["55a0", "55a1", "55a2", r.choice(["0", "1", "1001", "2000", "4000", "20", "40", "c0ed0000", "8000", "400000"])]),
    "umount2": (166, lambda r: ["55a0", r.choice(["0", "1", "2", "4", "8", "3", "ff"]), "0", "0"]),
    "ioctl": (16, lambda r: ["3", r.choice(["5401", "5413", "8912", "8913", "541b", "1", "c0189436", "80045430"]), "7ffc", "0"]),
    "access": (21, lambda r: ["55a0", r.choice(["0", "1", "2", "4", "6", "7", "f", "8"]), "0", "0"]),
    "faccessat": (269, lambda r: ["ffffff9c", "55a0", r.choice(["0", "4", "2", "6"]), "0"]),
    "lseek": (8, lambda r: ["3", "0", r.choice(["0", "1", "2", "3", "4", "5", "ff"]), "0"]),
    "epoll_ctl": (233, lambda r: ["4", r.choice(["1", "2", "3", "4"]), "5", "7ffc"]),
    "mkdir": (83, lambda r: ["55a0", r.choice(["1ed", "1ff", "1c0", "3ed", "7ff"]), "0", "0"]),
    "mkdirat": (258, lambda r: ["ffffff9c", "55a0", r.choice(["1ed", "1c0"]), "0"]),
    "mknod": (133, lambda r: ["55a0", r.choice(["81a4", "11b6", "61b0", "41ed", "11a4", "a1ff", "c1ff", "d1b6", "8800", "1000"]), "0", "0"]),
    "recvmsg": (47, lambda r: ["3", "7ffc", r.choice(["0", "40", "100", "2", "4000", "40000000", "20", "8000", "c0"]), "0"]),
    "sendto": (44, lambda r: ["3", "55a0", "40", r.choice(["0", "4000", "40", "8000", "20000", "4040", "80", "ff"])]),
    "sendmsg": (46, lambda r: ["3", "7ffc", r.choice(["0", "4000", "40", "8000"]), "0"]),
    "shmget": (29, lambda r: ["400", "1000", r.choice(["0", "380", "3b6", "800", "1000", "1c00", "2000", "380|", "0"]).replace("|", ""), "0"]),
    "getrlimit": (97, lambda r: [r.choice(["0", "1", "4", "7", "8", "10", "11", "12", "ff"]), "7ffc", "0", "0"]),
    "setrlimit": (160, lambda r: [r.choice(["0", "7", "8", "10"]), "7ffc", "0", "0"]),
    "exit_group": (231, lambda r: [r.choice(["0", "1", "2"]), "0", "0", "0"]),
    "bpf": (321, lambda r: [r.choice(["0", "1", "5", "9", "12", "30", "ff"]), "7ffc", "30", "0"]),
    "clock_settime": (227, lambda r: [r.choice(["0", "1", "2", "5", "7", "ff"]), "7ffc", "0", "0"]),
    "linkat": (265, lambda r: [r.choice(["ffffff9c", "5"]), "55a0", "ffffff9c", "55a1"]),
    "renameat": (264, lambda r: [r.choice(["ffffff9c", "5"]), "55a0", r.choice(["ffffff9c", "3"]), "55a1"]),
    "unlinkat": (263, lambda r: [r.choice(["ffffff9c", "4"]), "55a0", r.choice(["0", "200"]), "0"]),
    "newfstatat": (262, lambda r: [r.choice(["ffffff9c", "4"]), "55a0", "7ffc", "0"]),
    "execve": (59, lambda r: ["55a0", "55a1", "55a2", "0"]),
    "connect": (42, lambda r: ["3", "7ffc", "10", "0"]),
    "bind": (49, lambda r: ["3", "7ffc", "10", "0"]),
    "unknown_999": (999, lambda r: ["1", "2", "3", "4"]),
    "nosuch_5000": (5000, lambda r: ["1", "2", "3", "4"]),
}

def gen_syscalls(seed, n):
    r = random.Random(seed)
    t = 1760200000.0 + r.randint(0, 3000)
    serial = r.randint(1000, 5000)
    out = []
    names = sorted(SYS64)
    for _ in range(n):
        t += r.random() * 8
        serial += 1
        name = r.choice(names)
        num, argf = SYS64[name]
        args = argf(r)
        ok = r.choice(["yes", "yes", "no"])
        ex = r.choice(["0", "3", "-2", "-13", "-1", "-9999", "-110", "-17", "-22", "4096", "-133", "-200"]) if ok == "no" else r.choice(["0", "3", "1", "4096", "7"])
        arch = r.choice(["c000003e", "c000003e", "c000003e", "c000003e", "40000003", "c00000b7", "dead"])
        sysno = num
        if arch == "40000003":
            sysno = r.choice([5, 11, 102, 117, 3, 120, 4, 90, 66, 1, 1000, 295])
        stamp = "msg=audit(%.3f:%d):" % (t, serial)
        uid = r.choice([0, 1100, 33, 65534, 4294967295, 999, 1])
        tty = r.choice(["pts0", "(none)", "tty1", "ttyS0"])
        comm = r.choice(["bash", "curl", "my prog", "x"])
        exe = r.choice(["/usr/bin/bash", "/usr/bin/curl", "/opt/my prog/x", "(null)"])
        comm_s = '"%s"' % comm if comm != "my prog" else "6D792070726F67"
        exe_s = '"%s"' % exe
        out.append("type=SYSCALL %s arch=%s syscall=%d success=%s exit=%s a0=%s a1=%s a2=%s a3=%s items=0 ppid=%d pid=%d auid=%d uid=%d gid=%d euid=%d suid=%d fsuid=%d egid=%d sgid=%d fsgid=%d tty=%s ses=%d comm=%s exe=%s subj=unconfined key=%s" % (
            stamp, arch, sysno, ok, ex, args[0], args[1], args[2], args[3], r.randint(1, 500), r.randint(501, 9000),
            r.choice([1100, 4294967295, 0]), uid, uid, uid, uid, uid, r.choice([0, 33]), 0, 0, tty, r.choice([2, 4294967295, 9]),
            comm_s, exe_s, r.choice(['"k1"', "(null)", "6B310B6B32", '"a b"'])))
        if name in ("connect", "bind") and arch == "c000003e":
            sa = r.choice([
                "02001F900A00000500000000000000000", "0A001F90000000000000000000000000000000010000000000000000".upper(),
                "01002F746D702F736F636B00", "010000746D702F78", "0100", "100000000000000000000000", "0300414C4943450000", "0400", "0800", "0900", "FF00",
                "0200", "0A00", "1000"])
            out.append("type=SOCKADDR %s saddr=%s" % (stamp, sa))
        if r.random() < 0.5:
            mode = r.choice(["0100644", "040755", "0120777", "060660", "0104755", "01777", "0140000", "020620", "010600", "0102755", "0104000", "077", "0100000"])
            out.append("type=PATH %s item=0 name=%s inode=%d dev=08:01 mode=%s ouid=%d ogid=%d rdev=00:00 nametype=%s" % (
                stamp, r.choice(['"/etc/passwd"', '"relative/x"', "2F746D702F612062", '"/tmp/a b"', "(null)"]), r.randint(1, 99999), mode, r.choice([0, 1100, 4294967295]), r.choice([0, 1100]), r.choice(["NORMAL", "PARENT", "CREATE", "DELETE", "UNKNOWN"])))
        if r.random() < 0.3:
            out.append("type=PROCTITLE %s proctitle=%s" % (stamp, r.choice(["6C73002D6C61", '"ls -la"', "7368006100", "737368002D4C00", "C3A92D78", "7A7A", "00", "(null)", "6C7300"])))
        if r.random() < 0.15:
            out.append("type=EXECVE %s argc=3 a0=\"ls\" a1=2D6C61 a2=\"/tmp/x y\"" % stamp)
        if r.random() < 0.1:
            out.append("type=ANOM_PROMISCUOUS %s dev=eth0 prom=%d old_prom=%d auid=%d uid=0 gid=0 ses=1" % (stamp, r.choice([0, 256, 1]), r.choice([0, 256]), r.choice([1100, 4294967295])))
        if r.random() < 0.1:
            out.append("type=SECCOMP %s auid=%d uid=1100 gid=1100 ses=2 subj=unconfined pid=%d comm=\"x\" exe=\"/usr/bin/x\" sig=%d arch=c000003e syscall=%d compat=0 ip=0x7f code=%s" % (stamp, r.choice([1100, 4294967295]), r.randint(1, 9000), r.choice([0, 31, 9]), r.choice([59, 2, 257, 41]), r.choice(["0x7ffc0000", "0x80000000", "0x0", "0x7fff0000", "0x50001", "0x30000", "0xffff0000"])))
        if r.random() < 0.08:
            out.append("type=CAPSET %s pid=%d uid=1100 auid=1100 ses=2 cap_pi=%s cap_pp=%s cap_pe=%s cap_pa=%s" % (stamp, r.randint(1, 9000), r.choice(["0", "1ffffffffff", "ffffffff", "20", "4000000000", "1000000000"]), "1ffffffffff", "0", "0"))
        if r.random() < 0.08:
            out.append("type=NETFILTER_PKT %s mark=0x0 saddr=10.0.0.1 daddr=10.0.0.2 proto=%d hook=%d family=%d ipid=1 len=84 icmptype=%d icmpcode=0 action=%d macproto=%s" % (stamp, r.choice([1, 6, 17, 255, 47]), r.choice([0, 1, 2, 3, 4]), r.choice([1, 2, 3, 7, 10, 12, 99]), r.choice([0, 8, 3, 99]), r.choice([0, 1, 2]), r.choice(["0x0800", "0x0806", "0x86dd"])))
        if r.random() < 0.08:
            out.append("type=USER_AVC %s pid=%d uid=0 auid=1100 ses=2 subj=unconfined msg='avc:  denied  { read } for  scontext=a:b:c:s0,s1 tcontext=x:y:z:s0 tclass=file exe=\"/usr/bin/x\" sauid=1100 hostname=? addr=? terminal=?'" % (stamp, r.randint(1, 9000)))
        if r.random() < 0.08:
            out.append("type=TTY %s tty pid=%d uid=1100 auid=1100 ses=2 major=136 minor=0 comm=\"bash\" data=%s" % (stamp, r.randint(1, 9000), r.choice(["6C730A", "1B5B41", "7F", "7375646F20696420", "0D09", "1B5B313B3543", "C3A9", "FF00", "1B"])))
        if r.random() < 0.06:
            out.append("type=CONFIG_CHANGE %s auid=1100 ses=2 subj=unconfined op=add_rule key=\"k1\" list=%d res=1" % (stamp, r.choice([0, 1, 4, 5, 6, 7, 9])))
        if r.random() < 0.06:
            out.append("type=LOGIN %s pid=%d uid=0 subj=unconfined old-auid=4294967295 auid=1100 tty=(none) old-ses=4294967295 ses=%d res=%d" % (stamp, r.randint(1, 9000), r.randint(1, 9), r.choice([0, 1])))
        if r.random() < 0.06:
            out.append("type=APPARMOR_DENIED %s apparmor=\"DENIED\" operation=\"open\" class=\"file\" profile=\"/usr/sbin/tcpdump\" name=\"/etc/shadow\" pid=%d comm=\"tcpdump\" requested_mask=\"r\" denied_mask=\"r\" fsuid=0 ouid=0" % (stamp, r.randint(1, 9000)))
        if r.random() < 0.05:
            out.append("type=MAC_STATUS %s enforcing=1 old_enforcing=0 auid=1100 ses=2 enabled=1 old-enabled=1 lsm=selinux res=1" % stamp)
    return "\n".join(out) + "\n"

def gen_sessions(seed, n):
    r = random.Random(seed)
    t = 1760000000.0 + r.randint(0, 100000)
    serial = r.randint(10, 500)
    uids = [0, 1, 33, 1000, 1100, 1101, 65534]
    names = {0: "root", 1: "daemon", 33: "www-data", 1000: "ubuntu", 1100: "alice", 1101: "bob", 65534: "nobody"}
    hosts = ["10.0.0.5", "192.168.1.20", "?", "workstation.example.com", "172.16.4.9"]
    lines = []
    open_sessions = []
    def emit(kind, body):
        nonlocal t, serial
        lines.append("type=%s msg=audit(%.3f:%d): %s" % (kind, t, serial, body))
    def advance(low=1, high=300):
        nonlocal t, serial
        t += r.randint(low, high) + r.random()
        serial += r.randint(1, 4)
    for _ in range(n):
        advance()
        kind = r.choice(["full", "full", "full", "fail", "nologin", "nologout", "boot", "shutdown", "daemon", "dupe", "old", "partial", "end"])
        uid = r.choice(uids); pid = r.randint(500, 9000); ses = r.randint(1, 12); host = r.choice(hosts)
        term = r.choice(["/dev/pts/0", "/dev/pts/3", "ssh", "/dev/tty1", "pts/7"])
        def login(old=True):
            if old:
                emit("LOGIN", "pid=%d uid=0 subj=unconfined old-auid=4294967295 auid=%d tty=(none) old-ses=4294967295 ses=%d res=1" % (pid, uid, ses))
            else:
                emit("LOGIN", "pid=%d uid=0 old auid=4294967295 auid=%d tty=(none) old ses=4294967295 ses=%d res=1" % (pid, uid, ses))
        def user_login(res="success", with_uid=False):
            who = "uid=%d" % uid if with_uid else "id=%d" % uid
            if res == "success":
                emit("USER_LOGIN", "pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=login %s exe=\"/usr/sbin/sshd\" hostname=%s addr=10.9.8.7 terminal=%s res=success'" % (pid, uid, ses, who, host, term))
            else:
                emit("USER_LOGIN", "pid=%d uid=0 auid=4294967295 ses=4294967295 subj=unconfined msg='op=login acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=10.9.8.7 terminal=%s res=failed'" % (pid, r.choice(list(names.values()) + ["mallory"]), host, term))
        def logout():
            emit("USER_END", "pid=%d uid=0 auid=%d ses=%d subj=unconfined msg='op=PAM:session_close grantors=pam_unix acct=\"%s\" exe=\"/usr/sbin/sshd\" hostname=%s addr=10.9.8.7 terminal=ssh res=success'" % (pid, uid, ses, names[uid], host))
        if kind == "full":
            login(); advance(1, 5); user_login(with_uid=r.random() < 0.2); advance(10, 4000); logout()
        elif kind == "fail":
            user_login("failed")
        elif kind == "nologin":
            user_login()
        elif kind == "nologout":
            login(); advance(1, 5); user_login()
        elif kind == "boot":
            emit("SYSTEM_BOOT", "pid=%d uid=0 auid=4294967295 ses=4294967295 msg=' comm=\"systemd-update-utmp\" exe=\"/usr/lib/systemd/systemd-update-utmp\" hostname=? addr=? terminal=? res=success'" % pid)
        elif kind == "shutdown":
            emit("SYSTEM_SHUTDOWN", "pid=%d uid=0 auid=4294967295 ses=4294967295 msg=' comm=\"systemd-update-utmp\" exe=\"/usr/lib/systemd/systemd-update-utmp\" hostname=? addr=? terminal=? res=success'" % pid)
        elif kind == "daemon":
            emit("DAEMON_START", "op=start ver=3.1.2 format=enriched kernel=%s auid=4294967295 pid=%d uid=0 ses=4294967295 subj=unconfined res=success" % (r.choice(["6.8.0-45-generic", "5.15.0-100-generic"]), pid))
        elif kind == "dupe":
            login(); advance(1, 5); user_login(); advance(1, 9); login()
        elif kind == "old":
            login(old=False); advance(1, 5); user_login(); advance(10, 900); logout()
        elif kind == "partial":
            emit("LOGIN", "uid=0 subj=unconfined old-auid=4294967295 auid=%d tty=(none) old-ses=4294967295 ses=%d res=1" % (uid, ses))
        elif kind == "end":
            logout()
    return "\n".join(lines) + "\n"
