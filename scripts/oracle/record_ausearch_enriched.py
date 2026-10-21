#!/usr/bin/env python3
"""Record ausearch (audit 3.1.2) on ENRICHED audit.log files (the format Ubuntu's auditd.conf ships).

usage: record_ausearch_enriched.py AUDIT_ROOT out.json

Same logs and the same option grid as record_ausearch.py, each record line carrying the 0x1d separator and the
interpreted fields that auditd's format_enrich() appends.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen
import record_ausearch as base

original = base.logs
base.logs = lambda: {name: gen.enrich(text) for name, text in original().items()}
if __name__ == "__main__":
    base.main()
