#!/usr/bin/env python3
"""Record aureport (audit 3.1.2) on ENRICHED audit.log files.

usage: record_aureport_enriched.py AUDIT_ROOT out.json
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import audit_log_gen as gen
import record_aureport as base

original = base.logs
base.logs = lambda: {name: gen.enrich(text) for name, text in original().items()}
if __name__ == "__main__":
    base.main()
