#!/usr/bin/env python3
"""Record systemd 255.4 time parsing through systemd-analyze timestamp and systemd-analyze timespan.

usage: record_systemd_time.py out.json

parse_timestamp runs under scripts/oracle/last_shim.c with the clock and TZ pinned; parse_time (parse_sec) has no clock.
"""
import base64, json, os, subprocess, sys

NOW = 1791510700
ZONES = ["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]
STAMPS = [
    "now", "today", "yesterday", "tomorrow", "+5min", "-5min", "+1h 30min", "-2days", "5min ago", "2 days ago", "1h left", "+infinity", "-infinity", "infinity", "+", "-", "ago", " ago", "x ago", "left",
    "@0", "@1", "@1.5", "@1709400007", "@1709400007.123456", "@-5", "@", "@abc", "@1h", "@253402214399", "@253402214400", "@99999999999999999999",
    "2024-03-02", "24-03-02", "69-12-31", "70-01-01", "68-01-01", "2024-3-2", "2024-03-02 17:20", "2024-03-02 17:20:07", "2024-03-02 17:20:07.1", "2024-03-02 17:20:07.123456", "2024-03-02 17:20:07.1234567", "2024-03-02 17:20:07.9999995",
    "2024-03-02T17:20", "2024-03-02T17:20:07", "2024-03-02T17:20:07.5", "2024-03-02t17:20:07", "2024-03-02  17:20:07", "2024-03-02 17:20:07.", "2024-03-02 17:20:07.x", "2024-03-02 17:20:07 ", " 2024-03-02", "2024-03-02 ",
    "17:20", "17:20:07", "17:20:07.25", "7:5", "7:5:3", "24:00", "23:59:60", "23:59:61", "00:00", "12:61",
    "Mar 02 17:20:07", "Mar 2 17:20:07", "mar 02 17:20:07", "March 02 17:20:07", "Mar 02 17:20:07.123456", "Mar 32 17:20:07", "Foo 02 17:20:07",
    "Sat 2024-03-02", "Sat 2024-03-02 17:20:07", "sat 2024-03-02", "Saturday 2024-03-02 17:20", "Sun 2024-03-02", "Mon 2024-03-02 17:20:07", "Sat 17:20", "Sat", "Sat  2024-03-02",
    "2024-03-02 17:20:07 UTC", "2024-03-02 17:20:07 +01", "2024-03-02 17:20:07 +0100", "2024-03-02 17:20:07 +01:00", "2024-03-02 17:20:07 -05:30", "2024-03-02 17:20:07 -0800", "2024-03-02 17:20:07 +0160", "2024-03-02 17:20:07 +2500", "2024-03-02 17:20:07 +240", "2024-03-02 17:20:07 Z",
    "2024-03-02T17:20:07Z", "2024-03-02T17:20:07.5Z", "2024-03-02T17:20:07+01:00", "2024-03-02T17:20:07-08:00", "2024-03-02T17:20:07+0100", "2024-03-02T17:20Z", "2024-03-02Z", "Z", "xZ", "1969-12-31 23:00:00 -06", "1969-12-31 23:00:00 -06:00", "1969-12-31 23:00:00", "1970-01-01 00:00:00", "1970-01-01 00:00:00 +01", "1970-01-01 00:00:00 UTC", "1969-12-31T23:59:59Z",
    "2024-03-02 17:20:07 Europe/Paris", "2024-03-02 17:20:07 Asia/Tokyo", "2024-03-02 17:20:07 America/New_York", "2024-07-02 17:20:07 Europe/Paris", "2024-03-02 17:20:07 Nowhere/Land", "2024-03-02 17:20:07 CET", "2024-07-02 17:20:07 CEST", "2024-03-02 17:20:07 EST", "2024-03-02 17:20:07 IST", "2024-03-02 17:20:07 NZDT", "2024-03-02 17:20:07 JST", "2024-03-02 17:20:07 GMT",
    "Sat 2024-03-02 Europe/Paris", "2024-03-02 Europe/Paris", "17:20 Europe/Paris", "now UTC", "today UTC", "yesterday UTC", "yesterday Europe/Paris", "tomorrow Asia/Tokyo", "@5 UTC", "+5min UTC",
    "2024-02-29", "2023-02-29", "2024-02-30", "2024-04-31", "2024-13-01", "2024-00-10", "2024-12-32", "2024-12-00", "2024-03-10 02:30", "2024-03-31 02:30", "2024-10-27 02:30", "2024-11-03 01:30", "2024-09-29 02:30",
    "9999-12-30 23:59:59", "9999-12-31 00:00:00", "9999-12-31", "10000-01-01", "0001-01-01", "0000-01-01", "1900-01-01", "1969-12-31", "2038-01-19 03:14:08", "2106-02-07 06:28:16",
    "", " ", "bogus", "2024", "2024-03", "03-02", "2024/03/02", "02.03.2024", "17h20", "noon", "midnight", "12:00 PM", "1 hour ago", "1 hour", "3 weeks ago", "1y ago", "1M ago", "2 months ago", "0 ago", "1.5h ago", "1h 30m ago", "-1h", "+1.5h", "+ 5min", "- 5min", "+5 min", "+5min ", " +5min",
    "2024-03-02 17:20:07 +05:45", "2024-03-02 17:20:07 -00:00", "2024-03-02 17:20:07 +00:00", "2024-03-02 17:20:07 +1", "2024-03-02 17:20:07 +12345", "2024-03-02 17:20:07-01:00", "2024-03-02 17:20:07+01:00", "2024-03-02 17:20:07 +24:00", "2024-03-02 17:20:07 +23:59",
]
SPANS = ["1", "1s", "1.5s", "1h 30min", "1h30min", "1d 2h 3m 4s 5ms 6us", "infinity", "infinity ", " infinity", "infinityx", "-1", "-0", "0", "00", "1.", ".5", "1.5.5", "1.5 s", "1 s", "1 .5s", "1s.5", "1 min 30", "2 years 3 months", "1w", "1y", "1M", "1m", "1μs", "1µs", "1usec", "1ms", "1msec", "1 seconds", "1seconds", "1hour", "1 hr", "bogus", "1bogus", "", " ", "1 2", "1s 2s", "99999999999999999999", "9223372036854775807", "9223372036854775808", "18446744073709", "18446744073709551616s", "1e3", "+1", "1.123456789s", "0.000001s", "0.0000001s", "1.9999999s", "3.14159 min"]

def analyze(env, args):
    run = subprocess.run(["systemd-analyze"] + args, capture_output=True, env=env, timeout=30, stdin=subprocess.DEVNULL)
    return {"stdout": base64.b64encode(run.stdout).decode(), "stderr": base64.b64encode(run.stderr).decode(), "exitCode": run.returncode}

def main():
    target = sys.argv[1]
    stamps, spans = [], []
    for zone in ZONES:
        env = dict(os.environ, TZ=zone, LC_ALL="C", LD_PRELOAD="/tmp/last_shim.so", LAST_NOW=str(NOW))
        for text in STAMPS:
            stamps.append(dict(zone=zone, text=text, **analyze(env, ["timestamp", "--", text])))
    env = dict(os.environ, LC_ALL="C")
    for text in SPANS:
        spans.append(dict(text=text, **analyze(env, ["timespan", "--", text])))
    json.dump({"now": NOW, "timestamps": stamps, "timespans": spans}, open(target, "w"))
    print(len(stamps), len(spans))

main()
