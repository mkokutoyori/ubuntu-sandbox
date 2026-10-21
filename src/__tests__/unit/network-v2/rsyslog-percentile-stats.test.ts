/**
 * Probe — percentile_stats() and percentile_observe() of rsyslog 8.2610.0 (runtime/perctile_stats.c,
 * perctile_ringbuf.c and the function of grammar/rainerscript.c), observed through impstats: the numbers of the
 * source's own test (tests/perctile-simple.sh: 1..1000 then 1001..2000, p95=950, p50=500, p99=990, window_sum=500500),
 * the one-report lag of the percentiles (they are computed by the read notifier after the line is written), a ring
 * buffer that holds one cell fewer than its power-of-two size, window_* counters that restart at the first observation
 * after a report, counters that are unsigned 64-bit and printed signed, the global object, the delimiter, the 128-byte
 * statname limit, and the parse-time refusals.
 *
 * Measured against the base commit (git stash of src/network, dyn_stats present): the object was accepted and ignored and
 * percentile_observe() was an unknown function. 13 of the 14 cases fall; the one that passes in both states is the
 * witness (a config without percentile_stats loads clean).
 * Not kept from the source: a bucket without windowsize (0 or 1) is refused at load - the source builds a ring buffer of
 * size 0 or 1 whose first append trips an assert.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const STATS_FILE = '/var/log/stats.log';
const stats = (extra = ''): string => `module(load="impstats" interval="60" log.syslog="off" log.file="${STATS_FILE}" ${extra})\n`;
const BUCKET = 'percentile_stats(name="b" percentiles=["95", "50", "99"] windowsize="1000" delimiter="|")\n';
const observeProgram = (bucket = 'b', key = 's'): string =>
  `template(name="r" type="string" string="%$!r%\\n")\nset $!r = percentile_observe("${bucket}", "${key}", $programname);\n*.* action(type="omfile" file="/var/log/out" template="r")\n`;
const MSG = (program: string | number): string => `<13>Oct 19 12:00:01 ubuntu ${program}: x`;

function start(config: string): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config) };
}

const report = (host: LabHost): string[] => lines(host.fileSystem.get(STATS_FILE) ?? null).map((line) => line.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d+: /, ''));
const bucketLines = (host: LabHost, name = 'b'): string[] => report(host).filter((line) => line.startsWith(`${name}: origin=percentile.bucket`));
const results = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/out') ?? null);
const observe = (lab: ReturnType<typeof startRsyslog>, from: number, to: number): void => {
  for (let value = from; value <= to; value++) submitLocal(lab, MSG(value));
};

describe('percentile_stats', () => {
  it('witness: a config without percentile_stats loads clean, and its global object is reported after the dyn_stats one', () => {
    const { host, lab } = start(`${stats()}*.* /var/log/x.log`);
    expect(lab.loader.log.lines()).toEqual([]);
    host.advance(60_000);
    expect(report(host).slice(0, 2)).toEqual(['global: origin=dynstats ', 'global: origin=percentile ']);
  });

  it('reproduces the source test: percentiles of 1..1000 then of 1001..2000, with their window counters', () => {
    const { host, lab } = start(`${stats()}${BUCKET}${observeProgram()}`);
    observe(lab, 1, 1000);
    host.advance(60_000);
    host.advance(60_000);
    observe(lab, 1001, 2000);
    host.advance(60_000);
    host.advance(60_000);
    const seen = bucketLines(host);
    expect(seen[1]).toBe('b: origin=percentile.bucket s|p95=950 s|p50=500 s|p99=990 s|window_min=1 s|window_max=1000 s|window_sum=500500 s|window_count=1000 ');
    expect(seen[3]).toBe('b: origin=percentile.bucket s|p95=1950 s|p50=1500 s|p99=1990 s|window_min=1001 s|window_max=2000 s|window_sum=1500500 s|window_count=1000 ');
  });

  it('computes the percentiles after writing the line: the first report shows them still at zero', () => {
    const { host, lab } = start(`${stats()}${BUCKET}${observeProgram()}`);
    observe(lab, 1, 10);
    host.advance(60_000);
    expect(bucketLines(host)[0]).toBe('b: origin=percentile.bucket s|p95=0 s|p50=0 s|p99=0 s|window_min=1 s|window_max=10 s|window_sum=55 s|window_count=10 ');
    host.advance(60_000);
    expect(bucketLines(host)[1]).toBe('b: origin=percentile.bucket s|p95=9 s|p50=5 s|p99=9 s|window_min=1 s|window_max=10 s|window_sum=55 s|window_count=10 ');
  });

  it('keeps the last percentiles and window while nothing new is observed', () => {
    const { host, lab } = start(`${stats()}${BUCKET}${observeProgram()}`);
    observe(lab, 1, 10);
    for (let step = 0; step < 4; step++) host.advance(60_000);
    const seen = bucketLines(host);
    expect(seen[3]).toBe(seen[1]);
  });

  it('the ring buffer holds one cell fewer than its power of two: windowsize 4 keeps three values for the percentiles', () => {
    const { host, lab } = start(`${stats()}percentile_stats(name="b" percentiles=["50", "95"] windowsize="4")\n${observeProgram()}`);
    observe(lab, 1, 5);
    host.advance(60_000);
    host.advance(60_000);
    expect(bucketLines(host)[1]).toBe('b: origin=percentile.bucket s.p50=3 s.p95=4 s.window_min=1 s.window_max=5 s.window_sum=15 s.window_count=5 ');
  });

  it('the window counters restart at the first observation after a report', () => {
    const { host, lab } = start(`${stats()}${BUCKET}${observeProgram()}`);
    observe(lab, 100, 102);
    host.advance(60_000);
    observe(lab, 7, 8);
    host.advance(60_000);
    expect(bucketLines(host)[1]).toContain('s|window_min=7 s|window_max=8 s|window_sum=15 s|window_count=2 ');
  });

  it('the global object counts keys per bucket and the json format nests the values', () => {
    const { host, lab } = start(`${stats('format="json"')}${BUCKET}template(name="r" type="string" string="%$!r%\\n")\nset $!r = percentile_observe("b", "one", 5);\nset $!r = percentile_observe("b", "two", 6);\nset $!r = percentile_observe("b", "one", 7);\n*.* action(type="omfile" file="/var/log/out" template="r")\n`);
    submitLocal(lab, MSG('x'));
    host.advance(60_000);
    const out = report(host);
    expect(out).toContain('{ "name": "global", "origin": "percentile", "values": { "b.new_metric_add": 2, "b.ops_overflow": 0 } }');
    expect(out).toContain('{ "name": "b", "origin": "percentile.bucket", "values": { "one|p95": 0, "one|p50": 0, "one|p99": 0, "one|window_min": 5, "one|window_max": 7, "one|window_sum": 12, "one|window_count": 2, "two|p95": 0, "two|p50": 0, "two|p99": 0, "two|window_min": 6, "two|window_max": 6, "two|window_sum": 6, "two|window_count": 1 } }');
  });

  it('uses "." as the default delimiter, answers 0, and counts even when impstats is absent', () => {
    const { host, lab } = start(`percentile_stats(name="b" percentiles=["50"] windowsize="8")\n${observeProgram()}`);
    submitLocal(lab, MSG(4));
    expect(results(host)).toEqual(['0']);
    const reported = start(`${stats()}percentile_stats(name="b" percentiles=["50"] windowsize="8")\n${observeProgram()}`);
    submitLocal(reported.lab, MSG(4));
    reported.host.advance(60_000);
    expect(bucketLines(reported.host)[0]).toContain('s.p50=0 s.window_min=4 ');
  });

  it('counters are unsigned 64-bit and printed signed: a negative value is the largest one', () => {
    const { host, lab } = start(`${stats()}${BUCKET}template(name="r" type="string" string="%$!r%\\n")\nset $!r = percentile_observe("b", "s", -1);\nset $!r = percentile_observe("b", "s", 5);\n*.* action(type="omfile" file="/var/log/out" template="r")\n`);
    submitLocal(lab, MSG('x'));
    host.advance(60_000);
    expect(bucketLines(host)[0]).toContain('s|window_min=5 s|window_max=-1 s|window_sum=4 s|window_count=2 ');
  });

  it('a value that is not a number is reported as an error and answers 0', () => {
    const { host, lab } = start(`${stats()}${BUCKET}${observeProgram()}`);
    submitLocal(lab, MSG('abc'));
    expect(results(host)).toEqual(['0']);
    expect(lab.internalMessages.some((entry) => entry.text.includes("error during config processing: rainerscript: percentile_obs - didn't get a valid number: abc"))).toBe(true);
    host.advance(60_000);
    expect(bucketLines(host)[0]).toBe('b: origin=percentile.bucket ');
  });

  it('a statname that does not fit the 128-byte buffer is refused with -2425 and creates nothing', () => {
    const { host, lab } = start(`${stats()}${BUCKET}template(name="r" type="string" string="%$!r%\\n")\nset $!r = percentile_observe("b", "${'k'.repeat(130)}", 5);\n*.* action(type="omfile" file="/var/log/out" template="r")\n`);
    submitLocal(lab, MSG('x'));
    expect(results(host)).toEqual(['-2425']);
    expect(lab.internalMessages.some((entry) => entry.text.includes('perctile_obs(): name: b, key: kkkk'))).toBe(true);
    host.advance(60_000);
    expect(bucketLines(host)[0]).toBe('b: origin=percentile.bucket ');
  });

  it('refuses an unknown bucket and a bucket name that is not a constant string, at load time', () => {
    const unknown = start(`${stats()}set $!r = percentile_observe("nope", "s", 1);\n*.* /var/log/x.log\n`);
    expect(unknown.lab.loader.log.lines().join('\n')).toContain("perctile-stats bucket 'nope' not found");
    const dynamic = start(`${stats()}${BUCKET}set $!r = percentile_observe($programname, "s", 1);\n*.* /var/log/x.log\n`);
    expect(dynamic.lab.loader.log.lines().join('\n')).toContain('percentile-stats bucket-name (param 1) of perctile-stats manipulating functions like percentile_observe must be a constant string');
  });

  it('an unbound percentile_observe() answers -1 at run time', () => {
    const { host, lab } = start(`${stats()}${observeProgram('nope')}`);
    submitLocal(lab, MSG(1));
    expect(results(host)).toEqual(['-1']);
  });

  it('a bucket without percentiles is silently not created, and one without a usable windowsize is refused', () => {
    const none = start(`${stats()}percentile_stats(name="b" windowsize="8")\n${observeProgram()}`);
    expect(none.lab.loader.log.lines().join('\n')).toContain("perctile-stats bucket 'b' not found");
    const small = start(`${stats()}percentile_stats(name="b" percentiles=["50"])\n${observeProgram()}`);
    expect(small.lab.loader.log.lines().join('\n')).toContain("percentile_stats: bucket 'b' needs a windowsize of at least 2 - bucket not created");
  });
});
