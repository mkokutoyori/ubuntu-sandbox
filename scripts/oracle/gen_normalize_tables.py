#!/usr/bin/env python3
"""Generate AuditNormalizeTables.ts from the audit 3.1.2 sources (auparse/normalize*.h, auparse/normalize.c).

usage: gen_normalize_tables.py AUDIT_SRC out.ts

The macro values are read by compiling a small C program against lib/libaudit.h, so ranges such as AUDIT_FIRST_ANOM_MSG are the real numbers.
"""
import json, os, re, subprocess, sys, tempfile

def main():
    src, target = sys.argv[1], sys.argv[2]
    auparse = os.path.join(src, "auparse")
    source = open(os.path.join(auparse, "normalize.c")).read()
    record_map = open(os.path.join(auparse, "normalize_record_map.h")).read()
    syscall_map = open(os.path.join(auparse, "normalize_syscall_map.h")).read()
    internal = open(os.path.join(auparse, "normalize-internal.h")).read()
    kind_map = open(os.path.join(auparse, "normalize_obj_kind_map.h")).read()
    event_map = open(os.path.join(auparse, "normalize_evtypetab.h")).read()
    names = sorted(set(re.findall(r"\bAUDIT_[A-Z0-9_]+\b", source + "\n" + "\n".join(l for l in record_map.splitlines() if not l.lstrip().startswith("//")))))
    probe = "#include <stdio.h>\n#include \"libaudit.h\"\nint main(void){\n" + "".join(f"#ifdef {n}\nprintf(\"{n} %ld\\n\", (long)({n}));\n#endif\n" for n in names) + "return 0;}\n"
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "p.c"), "w").write(probe)
        subprocess.run(["gcc", "-I", os.path.join(src, "lib"), "-I", src, "-o", os.path.join(d, "p"), os.path.join(d, "p.c")], check=True)
        values = dict(line.split() for line in subprocess.run([os.path.join(d, "p")], capture_output=True, text=True, check=True).stdout.splitlines())
    macros = {k[len("AUDIT_"):]: int(v) for k, v in values.items()}
    defines = {m[0]: int(m[1].rstrip("U")) for m in re.findall(r"#define\s+(NORM_\w+)\s+(\d+U?)", internal)}
    actions = [[macros[m.group(1)[len("AUDIT_"):]], m.group(2)] for m in re.finditer(r"^_S\((AUDIT_\w+),\s*\"([^\"]*)\"\)", record_map, re.M) if m.group(1)[len("AUDIT_"):] in macros]
    syscalls = {m.group(2): defines[m.group(1)] for m in re.finditer(r"^_S\((NORM_\w+),\s*\"([^\"]*)\"\)", syscall_map, re.M)}
    kinds = {defines[m.group(1)]: m.group(2) for m in re.finditer(r"^_S\((NORM_WHAT_\w+),\s*\"([^\"]*)\"\)", kind_map, re.M)}
    events = {defines[m.group(1)]: m.group(2) for m in re.finditer(r"^_S\((NORM_EVTYPE_\w+),\s*\"([^\"]*)\"\s*\)", event_map, re.M)}
    out = ["export const AUDIT_NUMBERS: Readonly<Record<string, number>> = " + json.dumps(macros, sort_keys=True) + ";",
           "export const RECORD_ACTIONS: ReadonlyArray<readonly [number, string]> = " + json.dumps(actions) + ";",
           "export const SYSCALL_OBJECT_KINDS: Readonly<Record<string, number>> = " + json.dumps(syscalls) + ";",
           "export const OBJECT_KIND_NAMES: Readonly<Record<number, string>> = " + json.dumps(kinds) + ";",
           "export const EVENT_KIND_NAMES: Readonly<Record<number, string>> = " + json.dumps(events) + ";",
           "export const NORM = " + json.dumps({k: v for k, v in defines.items()}, sort_keys=False) + " as const;", ""]
    open(target, "w").write("\n".join(out))

main()
