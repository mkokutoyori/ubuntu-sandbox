#!/usr/bin/env python3
"""Generate AuparseTables.ts from the auparse table headers of the audit 3.1.2 tarball.

usage: gen_auparse_tables.py AUDIT_SRC out.ts

Each table header (open-flagtab.h, captab.h, ...) is compiled with the project's own gen_tables.c, exactly as
auparse/Makefile.am does, and the generated transtab is read back: values keep the order of the header, so the
flag tables iterate the way auparse iterates them and i2s lookups find the first entry holding the value.
typetab.h is read as text: its entries map a field name to an AUPARSE_TYPE_* name.
"""
import json, os, re, subprocess, sys, tempfile

TABLES = [
    ("access", "accesstab.h"), ("cap", "captab.h"), ("clock", "clocktab.h"), ("clone_flag", "clone-flagtab.h"),
    ("epoll_ctl", "epoll_ctl.h"), ("fam", "famtab.h"), ("flag", "flagtab.h"), ("fcntl", "fcntl-cmdtab.h"),
    ("icmptype", "icmptypetab.h"), ("ioctlreq", "ioctlreqtab.h"), ("ipc", "ipctab.h"), ("ipccmd", "ipccmdtab.h"),
    ("ipoptname", "ipoptnametab.h"), ("ip6optname", "ip6optnametab.h"), ("mmap", "mmaptab.h"), ("mount", "mounttab.h"),
    ("nfproto", "nfprototab.h"), ("open_flag", "open-flagtab.h"), ("person", "persontab.h"), ("ptrace", "ptracetab.h"),
    ("prctl_opt", "prctl-opt-tab.h"), ("pktoptname", "pktoptnametab.h"), ("prot", "prottab.h"), ("recv", "recvtab.h"),
    ("rlimit", "rlimittab.h"), ("sched", "schedtab.h"), ("seccomp", "seccomptab.h"), ("seek", "seektab.h"),
    ("shm_mode", "shm_modetab.h"), ("signal", "signaltab.h"), ("socklevel", "sockleveltab.h"),
    ("sockoptname", "sockoptnametab.h"), ("sock", "socktab.h"), ("sock_type", "socktypetab.h"),
    ("tcpoptname", "tcpoptnametab.h"), ("umount", "umounttab.h"), ("inethook", "inethooktab.h"),
    ("netaction", "netactiontab.h"), ("bpf", "bpftab.h"), ("openat2_resolve", "openat2-resolvetab.h"),
    ("evtype", "normalize_evtypetab.h"),
    ("err", "../lib/errtab.h"), ("filter_list", "../lib/flagtab.h"), ("ftype", "../lib/ftypetab.h"), ("machine", "../lib/machinetab.h"),
    ("field", "../lib/fieldtab.h"), ("op", "../lib/optab.h"), ("action", "../lib/actiontab.h"), ("fstype", "../lib/fstypetab.h"),
]

def build(src, header, prefix, work):
    exe = os.path.join(work, "gen_" + prefix)
    table_h = "../auparse/flagtab.h" if header == "flagtab.h" else header
    subprocess.run(["gcc", "-I" + work, "-I" + src + "/lib", "-I" + src + "/auparse", "-I" + src, "-D_GNU_SOURCE", "-DWITH_APPARMOR", "-DWITH_ARM", "-DWITH_AARCH64", "-DWITH_IO_URING",
                    '-DTABLE_H="%s"' % table_h, "-o", exe, src + "/lib/gen_tables.c"], check=True, capture_output=True)
    text = subprocess.run([exe, "--i2s-transtab", prefix], check=True, capture_output=True, text=True).stdout
    strings_part = re.search(r"_strings\[\] = (.*?);\n", text, re.S).group(1)
    blob = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', strings_part)).replace("\\0", "\0")
    table_part = re.search(r"_table\[\] = \{(.*?)\};", text, re.S).group(1)
    rows = []
    for value, offset in re.findall(r"\{(-?\d+),(\d+)\}", table_part):
        end = blob.index("\0", int(offset)) if "\0" in blob[int(offset):] else len(blob)
        rows.append((int(value), blob[int(offset):end]))
    return rows

def types(src):
    out = []
    for line in open(src + "/auparse/typetab.h"):
        m = re.match(r'\s*_S\((AUPARSE_TYPE_\w+),\s*"([^"]+)"\s*\)', line)
        if m:
            out.append((m.group(2), m.group(1)[len("AUPARSE_TYPE_"):]))
    return out

def error_messages(src):
    text = open(src + "/lib/errormsg.h").read()
    numbers = {name: int(value) for name, value in re.findall(r"#define\s+(EAU_\w+)\s+(\d+)", text)}
    rows = []
    for key, position, message in re.findall(r'\{\s*(-[\w]+)\s*,\s*(\d)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}', text):
        number = -numbers[key[1:]] if key.startswith("-EAU_") else int(key)
        rows.append((number, int(position), message.replace('\\"', '"').replace("\\'", "'")))
    return rows

def main():
    src, out = sys.argv[1], sys.argv[2]
    work = tempfile.mkdtemp()
    open(work + "/config.h", "w").write("")
    lines = ["export type AuparseTable = ReadonlyArray<readonly [number, string]>;", "", "export const AUPARSE_TABLES: Readonly<Record<string, AuparseTable>> = {"]
    for prefix, header in TABLES:
        rows = build(src, header, prefix, work)
        body = ", ".join("[%d, %s]" % (v, repr(n).replace("'", '"')) for v, n in rows)
        lines.append("  %s: [%s]," % (prefix, body))
    lines.append("};")
    lines.append("")
    lines.append("export const FIELD_TYPES: ReadonlyArray<readonly [string, string]> = [")
    t = types(src)
    for i in range(0, len(t), 4):
        lines.append("  " + ", ".join("[%s, %s]" % ('"%s"' % n, '"%s"' % ty) for n, ty in t[i:i + 4]) + ",")
    lines.append("];")
    lines.append("")
    lines.append("export const ERROR_MESSAGE_TABLE: ReadonlyArray<readonly [number, number, string]> = [")
    for number, position, message in error_messages(src):
        lines.append("  [%d, %d, %s]," % (number, position, json.dumps(message)))
    lines.append("];")
    open(out, "w").write("\n".join(lines) + "\n")
    print(len(TABLES), "tables,", len(t), "field types")

main()
