/**
 * Probe — dyn_stats() and dyn_inc() of rsyslog 8.2112.0 (runtime/dynstats.c and the dyn_inc() function of
 * grammar/rainerscript.c), observed through impstats, the only place their counters exist: per-bucket objects
 * (origin dynstats.bucket, reporting namespace "values", metrics reset on every read unless resettable="off"), the
 * "global" object (origin dynstats, "<bucket>.ops_overflow / new_metric_add / no_metric / metrics_purged / ops_ignored /
 * purge_triggered"), maxCardinality, unusedMetricLife with the two-generation table (a metric used again after a purge
 * is taken back from the survivors, not counted as new), dyn_inc() doing nothing until impstats has switched statistics
 * on, and the parse-time refusals of an unknown or non-constant bucket name.
 *
 * Measured against the base commit (git stash of src/network, impstats present): 12 of the 13 cases fall - the object
 * was accepted and ignored and dyn_inc() was an unknown function. The one that passes in both states is the witness: a
 * config without dyn_stats loads clean.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const MSG = (program: string): string => `<13>Oct 19 12:00:01 ubuntu ${program}: x`;
const TRADITIONAL = '$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n';
const STATS_FILE = '/var/log/stats.log';

const stats = (extra = ''): string => `module(load="impstats" interval="60" log.syslog="off" log.file="${STATS_FILE}" ${extra})\n`;
const countOnProgram = (bucket: string): string =>
  `template(name="r" type="string" string="%$!r%\\n")\nset $!r = dyn_inc("${bucket}", $programname);\n*.* action(type="omfile" file="/var/log/out" template="r")\n`;

function start(config: string): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config) };
}

const report = (host: LabHost): string[] => lines(host.fileSystem.get(STATS_FILE) ?? null).map((line) => line.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d+: /, ''));
const results = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/out') ?? null);
const GLOBAL_ZERO = (bucket: string): string =>
  `${bucket}.ops_overflow=0 ${bucket}.new_metric_add=0 ${bucket}.no_metric=0 ${bucket}.metrics_purged=0 ${bucket}.ops_ignored=0 ${bucket}.purge_triggered=0`;

describe('dyn_stats', () => {
  it('witness: a config without dyn_stats loads without a diagnostic and dyn_stats-free impstats reports no bucket', () => {
    const { lab } = start(`${stats()}*.* /var/log/x.log`);
    expect(lab.loader.log.lines()).toEqual([]);
  });

  it('the global object is reported first, with no counter until a bucket exists', () => {
    const { host } = start(`${stats()}*.* /var/log/x.log`);
    host.advance(60_000);
    expect(report(host)[0]).toBe('global: origin=dynstats ');
  });

  it('counts each key in its own metric and resets them on every read, the bucket default', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="msgs")\n${countOnProgram('msgs')}`);
    for (const program of ['alice', 'alice', 'bob']) submitLocal(lab, MSG(program));
    host.advance(60_000);
    const first = report(host);
    expect(first).toContain('msgs: origin=dynstats.bucket alice=2 bob=1 ');
    expect(first).toContain(`global: origin=dynstats ${GLOBAL_ZERO('msgs').replace('new_metric_add=0', 'new_metric_add=2')} `);
    host.advance(60_000);
    expect(report(host).filter((line) => line.startsWith('msgs:')).pop()).toBe('msgs: origin=dynstats.bucket alice=0 bob=0 ');
  });

  it('resettable="off" keeps the totals across reads', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="msgs" resettable="off")\n${countOnProgram('msgs')}`);
    submitLocal(lab, MSG('alice'));
    host.advance(60_000);
    submitLocal(lab, MSG('alice'));
    host.advance(60_000);
    expect(report(host).filter((line) => line.startsWith('msgs:'))).toEqual([
      'msgs: origin=dynstats.bucket alice=1 ', 'msgs: origin=dynstats.bucket alice=2 ',
    ]);
  });

  it('json format nests the metrics under "values", for the bucket and for the global object', () => {
    const { host, lab } = start(`${stats('format="json"')}dyn_stats(name="msgs")\n${countOnProgram('msgs')}`);
    submitLocal(lab, MSG('alice'));
    host.advance(60_000);
    const out = report(host);
    expect(out).toContain('{ "name": "msgs", "origin": "dynstats.bucket", "values": { "alice": 1 } }');
    expect(out[0]).toBe('{ "name": "global", "origin": "dynstats", "values": { "msgs.ops_overflow": 0, "msgs.new_metric_add": 1, "msgs.no_metric": 0, "msgs.metrics_purged": 0, "msgs.ops_ignored": 0, "msgs.purge_triggered": 0 } }');
  });

  it('dyn_inc() answers 0, an empty key is counted as no_metric, and a full bucket answers -6 and counts ops_overflow', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="msgs" maxCardinality="2")\n${countOnProgram('msgs')}`);
    for (const program of ['a', 'b', 'c', 'a']) submitLocal(lab, MSG(program));
    expect(results(host)).toEqual(['0', '0', '-6', '0']);
    host.advance(60_000);
    const global = report(host)[0];
    expect(global).toContain('msgs.ops_overflow=1 msgs.new_metric_add=2 ');
    expect(report(host)).toContain('msgs: origin=dynstats.bucket a=2 b=1 ');
    const empty = start(`${stats()}dyn_stats(name="msgs")\ntemplate(name="r" type="string" string="%$!r%\\n")\nset $!r = dyn_inc("msgs", "");\n*.* action(type="omfile" file="/var/log/out" template="r")\n`);
    submitLocal(empty.lab, MSG('a'));
    expect(results(empty.host)).toEqual(['0']);
    empty.host.advance(60_000);
    expect(report(empty.host)[0]).toContain('msgs.no_metric=1 ');
  });

  it('counts nothing until impstats has switched statistics on', () => {
    const { host, lab } = start(`dyn_stats(name="msgs")\n${countOnProgram('msgs')}`);
    submitLocal(lab, MSG('a'));
    expect(results(host)).toEqual(['0']);
    expect(lab.config.statistics.enabled).toBe(false);
    const loaded = start(`${stats()}dyn_stats(name="msgs")\n${countOnProgram('msgs')}`);
    expect(loaded.lab.config.statistics.enabled).toBe(true);
  });

  it('a metric unused for unusedMetricLife is dropped after the read that finds the bucket expired, and says so', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="msgs" resettable="off" unusedMetricLife="100")\n${countOnProgram('msgs')}`);
    submitLocal(lab, MSG('alice'));
    host.advance(60_000);
    host.advance(60_000);
    expect(lab.internalMessages.some((entry) => entry.text.includes("dynstats: bucket 'msgs' is being reset"))).toBe(true);
    host.advance(60_000);
    const buckets = report(host).filter((line) => line.startsWith('msgs:'));
    expect(buckets).toEqual(['msgs: origin=dynstats.bucket alice=1 ', 'msgs: origin=dynstats.bucket alice=1 ', 'msgs: origin=dynstats.bucket ']);
    const globals = report(host).filter((line) => line.startsWith('global: origin=dynstats'));
    expect(globals[2]).toContain('msgs.purge_triggered=1 ');
  });

  it('a metric used again after a purge is taken back from the survivors and is not counted as new', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="msgs" resettable="off" unusedMetricLife="100")\n${countOnProgram('msgs')}`);
    submitLocal(lab, MSG('alice'));
    host.advance(60_000);
    host.advance(60_000);
    submitLocal(lab, MSG('alice'));
    host.advance(60_000);
    const last = report(host);
    expect(last.filter((line) => line.startsWith('msgs:')).pop()).toBe('msgs: origin=dynstats.bucket alice=2 ');
    expect(last.filter((line) => line.startsWith('global: origin=dynstats')).pop()).toContain('msgs.new_metric_add=1 msgs.no_metric=0 msgs.metrics_purged=0 ');
  });

  it('metrics left in the older generation are purged at the next reset, and counted', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="msgs" resettable="off" unusedMetricLife="100")\n${countOnProgram('msgs')}`);
    submitLocal(lab, MSG('alice'));
    for (let step = 0; step < 5; step++) host.advance(60_000);
    expect(report(host).filter((line) => line.startsWith('global: origin=dynstats')).pop()).toContain('msgs.metrics_purged=1 ');
  });

  it('several buckets are reported in declaration order, each with its own global counters', () => {
    const { host, lab } = start(`${stats()}dyn_stats(name="first")\ndyn_stats(name="second")\nset $!a = dyn_inc("first", $programname);\nset $!b = dyn_inc("second", "k");\n*.* /var/log/x.log\n`);
    submitLocal(lab, MSG('p'));
    host.advance(60_000);
    const out = report(host);
    expect(out.indexOf('first: origin=dynstats.bucket p=1 ')).toBeGreaterThan(-1);
    expect(out.indexOf('first: origin=dynstats.bucket p=1 ')).toBeLessThan(out.indexOf('second: origin=dynstats.bucket k=1 '));
    expect(out[0]).toContain('first.ops_overflow=0 ');
    expect(out[0]).toContain('second.new_metric_add=1 ');
  });

  it('refuses an unknown bucket and a bucket name that is not a constant string, at load time', () => {
    const unknown = start(`${stats()}set $!r = dyn_inc("nope", "k");\n*.* /var/log/x.log\n`);
    expect(unknown.lab.loader.log.lines().join('\n')).toContain("dyn-stats bucket 'nope' not found");
    const dynamic = start(`${stats()}dyn_stats(name="msgs")\nset $!r = dyn_inc($programname, "k");\n*.* /var/log/x.log\n`);
    expect(dynamic.lab.loader.log.lines().join('\n')).toContain('dyn-stats bucket-name (param 1) of dyn-stats manipulating functions like dyn_inc must be a constant string');
  });

  it('an unbound dyn_inc() answers -1 at run time', () => {
    const { host, lab } = start(`${stats()}${countOnProgram('nope')}`);
    submitLocal(lab, MSG('a'));
    expect(results(host)).toEqual(['-1']);
  });
});
