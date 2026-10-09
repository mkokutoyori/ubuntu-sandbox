#!/usr/bin/env python3
"""Pair what was sent to the real systemd-journald 255.4 with what it stored.

usage: record_journald_ingest.py corpus_dir out.json

corpus_dir comes from record_journal_corpus.py: sends.jsonl holds every datagram and stream written to the journald sockets, with
the credentials of the sending process and of its parent (read from /proc), and journal/ holds the files journald wrote.  The output
keeps the sends, the stored entries with their field order, and the header counters of each journal file.
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from journal_corpus_lib import build_entries

def headers(corpus):
    env = dict(os.environ, LC_ALL="C", TZ="UTC")
    out = subprocess.run(["journalctl", f"--directory={os.path.join(corpus, 'journal')}", "--no-pager", "--header"], capture_output=True, env=env, stdin=subprocess.DEVNULL).stdout.decode()
    result = []
    for block in out.split("\n\n"):
        if not block.strip():
            continue
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        result.append({
            "path": fields["File path"], "fileId": fields["File ID"], "seqnumId": fields["Sequential number ID"], "bootId": fields["Boot ID"],
            "headSeqnum": int(fields["Head sequential number"].split()[0]), "entries": int(fields["Entry objects"]), "data": int(fields["Data objects"]),
            "fields": int(fields["Field objects"]), "entryArrays": int(fields["Entry array objects"]), "objects": int(fields["Objects"]),
        })
    return result

def main():
    corpus, target = sys.argv[1], sys.argv[2]
    sends = [json.loads(line) for line in open(os.path.join(corpus, "sends.jsonl"))]
    json.dump({"machineId": "0d0af05ee8fd4dc29275718f2ce4dff1", "sends": sends, "entries": build_entries(corpus), "headers": headers(corpus)}, open(target, "w"))
    print(len(sends), "sends")

main()
