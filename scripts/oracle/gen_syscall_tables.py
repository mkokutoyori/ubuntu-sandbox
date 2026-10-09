#!/usr/bin/env python3
"""Generate AuditSyscallTables.ts from the lib/*_table.h headers of the audit 3.1.2 tarball.

usage: gen_syscall_tables.py AUDIT_SRC out.ts

Every header is a list of _S(number, "name") lines.  Numbers are kept as written and, when two lines give the same
number, the first one wins, as the i2s tables of gen_tables.c do.
"""
import re, sys

TABLES = [("X86_64", "x86_64"), ("AARCH64", "aarch64"), ("I386", "i386"), ("ARM", "arm"), ("PPC", "ppc"), ("S390", "s390"), ("S390X", "s390x"), ("URING", "uringop")]

def read(path):
    rows = {}
    for line in open(path):
        m = re.match(r'\s*_S\(\s*(\d+)\s*,\s*"([^"]+)"\s*\)', line)
        if m and int(m.group(1)) not in rows:
            rows[int(m.group(1))] = m.group(2)
    return rows

def main():
    src, out = sys.argv[1], sys.argv[2]
    lines = []
    keys = []
    for const, base in TABLES:
        rows = read("%s/lib/%s_table.h" % (src, base))
        body = ", ".join("%d: '%s'" % (n, name) for n, name in rows.items())
        lines.append("const %s: Readonly<Record<number, string>> = {\n  %s,\n};" % (const, body))
        keys.append("%s: %s" % (base, const))
    lines.append("export const SYSCALL_TABLES: Readonly<Record<string, Readonly<Record<number, string>>>> = { %s };" % ", ".join(keys))
    lines.append("""
const NUMBERS: Record<string, ReadonlyMap<string, number>> = {};

export function syscallNumber(table: string, name: string): number | null {
  let map = NUMBERS[table];
  if (map === undefined) {
    map = new Map(Object.entries(SYSCALL_TABLES[table] ?? {}).map(([n, sysName]) => [sysName, Number(n)] as const));
    NUMBERS[table] = map;
  }
  return map.get(name) ?? null;
}

export function x86SyscallNumber(name: string): number | null {
  return syscallNumber('x86_64', name);
}
""")
    open(out, "w").write("\n".join(lines))
    print("ok")

main()
