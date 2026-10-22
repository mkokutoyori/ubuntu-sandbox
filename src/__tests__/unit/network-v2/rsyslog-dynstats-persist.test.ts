/**
 * Probe — dyn_stats state persistence of rsyslog 8.2608.0 (runtime/dynstats.c: persistStateInterval,
 * persistStateTimeInterval, statefile.directory, loadPersistedState, persistBucketState, getStateFileName, the
 * duplicate-bucket warning). State file: "<dir>/dynstats-state:<bucket>", compact json-c text
 * {"name":"<bucket>","values":{"<metric>":<n>}} with "/" escaped, written when the update count or the interval
 * is reached and, synchronously, at stop; reloaded at bucket creation as an initial offset of each metric.
 *
 * Measured against the base commit (git stash of src/network): 9 of the 10 cases fall - the three parameters
 * are refused as unknown. The one that passes in both states is the WITNESS (a bucket without persistence
 * writes nothing).
 * The metrics are written in the order the source's hash table (engine/HashTable.ts, checked against the C table
 * compiled with gcc: alice then bob in a 3079-slot table iterate as bob, alice) walks them.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const MSG = (program: string): string => `<13>Oct 19 12:00:01 ubuntu ${program}: x`;
const STATS = 'module(load="impstats" interval="3600" log.syslog="off" log.file="/var/log/stats.log")\n';
const COUNT = 'set $!r = dyn_inc("msgs", $programname);\n*.* /var/log/x.log\n';
const STATE = '/var/spool/rsyslog/dynstats-state:msgs';

function start(host: LabHost, bucket: string, extra = ''): ReturnType<typeof startRsyslog> {
  return startRsyslog(host, `global(workDirectory="/var/spool/rsyslog")\n${STATS}dyn_stats(name="${bucket}" ${extra})\n${COUNT.replace(/msgs/, bucket)}`);
}

const rig = (): LabHost => new LabHost('10.0.0.1', new LabNetwork());

describe('dyn_stats persistence', () => {
  it('witness: a bucket without persistence parameters writes no state file, even at stop', () => {
    const host = rig();
    const lab = start(host, 'msgs');
    submitLocal(lab, MSG('alice'));
    lab.engine.stop();
    expect(host.fileSystem.has(STATE)).toBe(false);
  });

  it('writes the state at stop, as compact json', () => {
    const host = rig();
    const lab = start(host, 'msgs', 'persistStateInterval="100" resettable="off"');
    for (const program of ['alice', 'alice', 'bob']) submitLocal(lab, MSG(program));
    lab.engine.stop();
    expect(host.fileSystem.get(STATE)).toBe('{"name":"msgs","values":{"bob":1,"alice":2}}');
  });

  it('persists what the final impstats report left: a resettable bucket is read, hence reset, before the state is written', () => {
    const host = rig();
    const lab = start(host, 'msgs', 'persistStateInterval="100"');
    submitLocal(lab, MSG('alice'));
    lab.engine.stop();
    expect(host.fileSystem.get(STATE)).toBe('{"name":"msgs","values":{"alice":0}}');
  });

  it('writes after persistStateInterval updates, without waiting for the stop', () => {
    const host = rig();
    const lab = start(host, 'msgs', 'persistStateInterval="3"');
    submitLocal(lab, MSG('alice'));
    submitLocal(lab, MSG('alice'));
    expect(host.fileSystem.has(STATE)).toBe(false);
    submitLocal(lab, MSG('bob'));
    expect(host.fileSystem.get(STATE)).toBe('{"name":"msgs","values":{"bob":1,"alice":2}}');
  });

  it('writes when persistStateTimeInterval has elapsed at the next update', () => {
    const host = rig();
    const lab = start(host, 'msgs', 'persistStateTimeInterval="30"');
    submitLocal(lab, MSG('alice'));
    expect(host.fileSystem.has(STATE)).toBe(false);
    host.advance(31_000);
    submitLocal(lab, MSG('alice'));
    expect(host.fileSystem.get(STATE)).toBe('{"name":"msgs","values":{"alice":2}}');
  });

  it('reloads the persisted values as the starting count of each metric', () => {
    const host = rig();
    host.fileSystem.set(STATE, '{"name":"msgs","values":{"alice":5}}');
    const lab = start(host, 'msgs', 'persistStateInterval="100" resettable="off"');
    submitLocal(lab, MSG('alice'));
    host.advance(3_600_000);
    const out = lab.host.fileSystem.get('/var/log/stats.log') ?? '';
    expect(out).toContain('msgs: origin=dynstats.bucket alice=6 ');
    expect(out).toContain('msgs.new_metric_add=1');
  });

  it('says so when the state file does not exist, then that opening it failed', () => {
    const host = rig();
    const lab = start(host, 'msgs', 'persistStateInterval="100"');
    const text = lab.loader.log.lines().join('\n');
    expect(text).toContain("dyn_stats: warning state file doesn't exist: '/var/spool/rsyslog/dynstats-state:msgs'");
    expect(text).toContain('dynstats: openStateFile failed - there should be messages before this one with the reason.');
  });

  it('refuses negative and non-integer persisted values and keeps the others', () => {
    const host = rig();
    host.fileSystem.set(STATE, '{"name":"msgs","values":{"a":-1,"b":"x","c":4}}');
    const lab = start(host, 'msgs', 'persistStateInterval="100"');
    const text = lab.loader.log.lines().join('\n');
    expect(text).toContain("contains negative value -1 for metric 'a' - ignoring");
    expect(text).toContain("contains non-integer value for metric 'b'");
    host.advance(3_600_000);
    expect(host.fileSystem.get('/var/log/stats.log') ?? '').toContain('msgs: origin=dynstats.bucket c=4 ');
  });

  it('statefile.directory overrides the work directory and a slash in the name is sanitised', () => {
    const host = rig();
    const lab = start(host, 'a/b', 'persistStateInterval="100" resettable="off" statefile.directory="/var/lib/stats"');
    submitLocal(lab, MSG('alice'));
    lab.engine.stop();
    expect(host.fileSystem.get('/var/lib/stats/dynstats-state:a_b')).toBe('{"name":"a\\/b","values":{"alice":1}}');
    expect(lab.loader.log.lines().join('\n')).toContain("dynstats: bucket name 'a/b' contains slashes, sanitized to 'a_b' for state file");
  });

  it('warns about a duplicate bucket name', () => {
    const host = rig();
    const lab = startRsyslog(host, `${STATS}dyn_stats(name="msgs")\ndyn_stats(name="msgs")\n*.* /var/log/x.log`);
    expect(lab.loader.log.lines().join('\n')).toContain("dynstats: duplicate bucket name 'msgs' in current config set; impstats output may be ambiguous");
  });
});
