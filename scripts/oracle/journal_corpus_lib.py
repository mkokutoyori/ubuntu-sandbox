"""Helpers shared by the journald recorders: parse `journalctl -o export`, recover the field order from -o verbose, digest a corpus tree."""
import base64, hashlib, os, re, subprocess

def tree_digest(root):
    digest = hashlib.sha256()
    for directory, _, names in sorted(os.walk(root)):
        for name in sorted(names):
            digest.update(name.encode() + open(os.path.join(directory, name), "rb").read())
    return digest.hexdigest()

def parse_export(data):
    entries, fields, pos = [], [], 0
    while pos < len(data):
        end = data.index(b"\n", pos)
        line = data[pos:end]
        if line == b"":
            if fields:
                entries.append(fields)
            fields, pos = [], end + 1
            continue
        if b"=" in line:
            name, _, value = line.partition(b"=")
            pos = end + 1
        else:
            name = line
            size = int.from_bytes(data[end + 1:end + 9], "little")
            value = data[end + 9:end + 9 + size]
            pos = end + 9 + size + 1
        fields.append((name.decode(), value))
    if fields:
        entries.append(fields)
    return entries

def verbose_orders(corpus, env):
    out = subprocess.run(["journalctl", f"--directory={os.path.join(corpus, 'journal')}", "--no-pager", "-o", "verbose", "-a"], capture_output=True, env=env, stdin=subprocess.DEVNULL).stdout
    orders, current = [], None
    for line in out.split(b"\n"):
        if line and not line.startswith(b" ") and not line.startswith(b"-- "):
            current = []
            orders.append(current)
        elif current is not None:
            match = re.match(rb"^ {4}([A-Za-z_][A-Za-z0-9_]*)=", line)
            if match:
                current.append(match.group(1).decode())
    return orders

def build_entries(corpus):
    env = dict(os.environ, TZ="UTC", LC_ALL="C")
    export = open(os.path.join(corpus, "entries.export"), "rb").read()
    orders = verbose_orders(corpus, env)
    result = []
    for fields, order in zip(parse_export(export), verbose_orders(corpus, env)):
        header = dict(fields[:6])
        cursor = header["__CURSOR"].decode()
        rest = {}
        for name, value in fields[6:]:
            rest.setdefault(name, []).append(value)
        rest.setdefault("_BOOT_ID", []).append(header["_BOOT_ID"])
        ordered, seen = [], {}
        for name in order:
            index = seen.get(name, 0)
            seen[name] = index + 1
            ordered.append([name, base64.b64encode(rest[name][index]).decode()])
        result.append({"cursor": cursor, "realtime": int(header["__REALTIME_TIMESTAMP"]), "monotonic": int(header["__MONOTONIC_TIMESTAMP"]), "seqnum": int(header["__SEQNUM"]), "seqnumId": header["__SEQNUM_ID"].decode(), "bootId": header["_BOOT_ID"].decode(), "fields": ordered})
    return result

