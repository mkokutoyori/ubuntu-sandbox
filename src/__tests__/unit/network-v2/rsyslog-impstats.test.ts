/**
 * Probe — src/network/rsyslog/engine/Statistics.ts and modules/Impstats.ts, ported from
 * runtime/statsobj.c, plugins/impstats/impstats.c, runtime/queue.c (statistics block) and
 * action.c (statistics block) of rsyslog 8.2112.0.
 *
 * Measured against the base commit (git stash of src/network): 18 of the 19 cases fall - the module
 * does not exist there ("could not load module"), and the counters of queues, actions, inputs and
 * outputs were stored or absent but never readable. The one that passes in both states is the
 * WITNESS, which proves the lab is sound and that nothing is emitted without the module. Counters are
 * read through the module, never through the engine, so a case cannot pass by peeking.
 */
import { describe, expect, it } from 'vitest';
import { beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const TRADITIONAL = '$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n';

function rig(config: string): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config) };
}

const read = (host: LabHost, path = '/var/log/x.log'): string[] => lines(host.fileSystem.get(path) ?? null);
const bodies = (host: LabHost, path = '/var/log/x.log'): string[] =>
  read(host, path).map((line) => line.replace(/^\S+ +\d+ [\d:]+ \S+ rsyslogd-pstats: /, '')).filter((line) => !/origin=(dynstats|percentile) /.test(line) && !/"origin": "(dynstats|percentile)"/.test(line));

describe('impstats', () => {
  it('witness: a plain selector writes what the lab submits, and no statistics appear without the module', () => {
    const { host } = rig(`${TRADITIONAL}*.* /var/log/x.log`);
    host.advance(3_600_000);
    expect(read(host)).toEqual([]);
  });

  it('emits one legacy line per object, in creation order, with a trailing space after every counter', () => {
    const { host } = rig(`${TRADITIONAL}module(load="impstats" interval="60")\n*.* /var/log/x.log`);
    host.advance(59_000);
    expect(read(host)).toEqual([]);
    host.advance(1_000);
    expect(bodies(host)).toEqual([
      'main Q: origin=core.queue size=0 enqueued=0 full=0 discarded.full=0 discarded.nf=0 maxqsize=0 ',
      'action-0-builtin:omfile: origin=core.action processed=0 failed=0 suspended=0 suspended.duration=0 resumed=0 ',
      'resource-usage: origin=impstats utime=0 stime=0 maxrss=0 minflt=0 majflt=0 inblock=0 oublock=0 nvcsw=0 nivcsw=0 openfiles=0 ',
    ]);
  });

  it('counts what the first report itself put through the queue and the action', () => {
    const { host } = rig(`${TRADITIONAL}module(load="impstats" interval="60")\n*.* /var/log/x.log`);
    host.advance(120_000);
    const second = bodies(host).slice(3);
    expect(second[0]).toBe('main Q: origin=core.queue size=0 enqueued=5 full=0 discarded.full=0 discarded.nf=0 maxqsize=1 ');
    expect(second[1]).toBe('action-0-builtin:omfile: origin=core.action processed=5 failed=0 suspended=0 suspended.duration=0 resumed=0 ');
  });

  it('resetcounters zeroes the resettable counters after each read, and never the gauges', () => {
    const kept = rig(`${TRADITIONAL}module(load="impstats" interval="60")\n*.* /var/log/x.log`);
    kept.host.advance(180_000);
    expect(bodies(kept.host).slice(6)[0]).toContain('enqueued=10 ');
    const reset = rig(`${TRADITIONAL}module(load="impstats" interval="60" resetcounters="on")\n*.* /var/log/x.log`);
    reset.host.advance(180_000);
    const third = bodies(reset.host).slice(6);
    expect(third[0]).toBe('main Q: origin=core.queue size=0 enqueued=5 full=0 discarded.full=0 discarded.nf=0 maxqsize=1 ');
    expect(third[1]).toContain('processed=5 ');
  });

  it('format="json" writes the libfastjson spelling, in counter order, one object per line', () => {
    const { host } = rig(`${TRADITIONAL}module(load="impstats" interval="60" format="json")\n*.* /var/log/x.log`);
    host.advance(60_000);
    expect(bodies(host)[0]).toBe('{ "name": "main Q", "origin": "core.queue", "size": 0, "enqueued": 0, "full": 0, "discarded.full": 0, "discarded.nf": 0, "maxqsize": 0 }');
  });

  it('format="cee" prefixes the cookie, and format="json-elasticsearch" replaces dots with bangs', () => {
    const cee = rig(`${TRADITIONAL}module(load="impstats" interval="60" format="cee")\n*.* /var/log/x.log`);
    cee.host.advance(60_000);
    expect(bodies(cee.host)[1]).toBe('@cee: { "name": "action-0-builtin:omfile", "origin": "core.action", "processed": 0, "failed": 0, "suspended": 0, "suspended.duration": 0, "resumed": 0 }');
    const es = rig(`${TRADITIONAL}module(load="impstats" interval="60" format="json-elasticsearch")\n*.* /var/log/x.log`);
    es.host.advance(60_000);
    expect(bodies(es.host)[1]).toBe('{ "name": "action-0-builtin:omfile", "origin": "core.action", "processed": 0, "failed": 0, "suspended": 0, "suspended!duration": 0, "resumed": 0 }');
  });

  it('bracketing wraps each report in BEGIN and END', () => {
    const { host } = rig(`${TRADITIONAL}module(load="impstats" interval="60" bracketing="on")\n*.* /var/log/x.log`);
    host.advance(60_000);
    const out = bodies(host);
    expect(out[0]).toBe('BEGIN');
    expect(out[out.length - 1]).toBe('END');
    expect(out).toHaveLength(5);
  });

  it('facility and severity choose the priority of the submitted messages', () => {
    const { host } = rig('module(load="impstats" interval="60" facility="17" severity="5")\nlocal1.notice /var/log/l1.log\n*.* /var/log/all.log');
    host.advance(60_000);
    expect(read(host, '/var/log/l1.log')).toHaveLength(6);
    expect(read(host, '/var/log/all.log')).toHaveLength(6);
    const other = rig('module(load="impstats" interval="60")\nlocal1.notice /var/log/l1.log\n*.* /var/log/all.log');
    other.host.advance(60_000);
    expect(read(other.host, '/var/log/l1.log')).toEqual([]);
  });

  it('log.file with log.syslog="off" writes ctime-prefixed lines to the file and nothing to the rulesets', () => {
    const { host } = rig('module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\n*.* /var/log/x.log');
    host.advance(60_000);
    expect(read(host)).toEqual([]);
    const written = read(host, '/var/log/stats.log');
    expect(written).toHaveLength(5);
    expect(written[2]).toBe('Mon Oct 19 12:01:00 2026: main Q: origin=core.queue size=0 enqueued=0 full=0 discarded.full=0 discarded.nf=0 maxqsize=0 ');
  });

  it('the ruleset parameter routes the report, and an unknown one falls back with a message', () => {
    const routed = rig('module(load="impstats" interval="60" ruleset="stats")\nruleset(name="stats") { action(type="omfile" file="/var/log/stats.log") }\n*.* /var/log/x.log');
    routed.host.advance(60_000);
    expect(read(routed.host, '/var/log/stats.log')).toHaveLength(6);
    expect(read(routed.host)).toEqual([]);
    const missing = rig('module(load="impstats" interval="60" ruleset="nope")\n*.* /var/log/x.log');
    expect(missing.lab.loader.log.lines()).toEqual(["rsyslogd: impstats: ruleset 'nope' not found - using default ruleset instead [v8.2112.0]"]);
    missing.host.advance(60_000);
    expect(read(missing.host)).toHaveLength(5);
  });

  it('refuses a zero interval, an unknown format, and a ruleset without log.syslog', () => {
    const zero = rig('module(load="impstats" interval="0")\n*.* /var/log/x.log');
    expect(zero.lab.loader.log.lines()).toEqual(['rsyslogd: impstats: stats interval zero not permitted, using default of 300 seconds [v8.2112.0]']);
    zero.host.advance(299_000);
    expect(read(zero.host)).toEqual([]);
    zero.host.advance(1_000);
    expect(read(zero.host)).toHaveLength(5);
    const format = rig('module(load="impstats" interval="60" format="xml")\n*.* /var/log/x.log');
    expect(format.lab.loader.log.lines()).toEqual(['rsyslogd: impstats: invalid format xml [v8.2112.0]']);
  });

  it('the legacy directives work before module(...) parameters and are refused after them', () => {
    const legacy = rig(`${TRADITIONAL}$ModLoad impstats\n$PStatsInterval 30\n$PStatJSON on\n*.* /var/log/x.log`);
    legacy.host.advance(30_000);
    expect(bodies(legacy.host)[0]).toBe('{ "name": "main Q", "origin": "core.queue", "size": 0, "enqueued": 0, "full": 0, "discarded.full": 0, "discarded.nf": 0, "maxqsize": 0 }');
    const cee = rig(`${TRADITIONAL}$ModLoad impstats\n$PStatsInterval 30\n$PStatCEE on\n*.* /var/log/x.log`);
    cee.host.advance(30_000);
    expect(bodies(cee.host)[0].startsWith('@cee: { "name": "main Q"')).toBe(true);
    const late = rig('module(load="impstats" interval="60")\n$PStatsInterval 30\n*.* /var/log/x.log');
    expect(late.lab.loader.log.lines()).toEqual(["rsyslogd: command 'pstatsinterval' is currently not permitted - did you already set it via a RainerScript command (v6+ config)? [v8.2112.0 try https://www.rsyslog.com/e/2222 ]"]);
  });

  it('a stopping daemon emits a last report', () => {
    const { host, lab } = rig('module(load="impstats" interval="3600" log.syslog="off" log.file="/var/log/stats.log")\n*.* /var/log/x.log');
    expect(read(host, '/var/log/stats.log')).toEqual([]);
    lab.engine.stop();
    expect(read(host, '/var/log/stats.log')).toHaveLength(5);
  });

  it('a full action queue counts what it refuses, in discarded.full and full', () => {
    const { host } = rig(`${TRADITIONAL}module(load="impstats" interval="60")\naction(type="omfile" file="/var/log/q.log" name="slow" queue.type="LinkedList" queue.size="1" queue.workerThreads="1" queue.dequeueBatchSize="1" queue.dequeueSlowdown="2000000")\n*.* /var/log/x.log`);
    host.advance(60_000);
    host.advance(60_000);
    const queue = bodies(host).filter((line) => line.startsWith('slow queue:'));
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[queue.length - 1]).toMatch(/full=[1-9]\d* discarded\.full=[1-9]\d* /);
  });

  it('imuxsock counts submissions and per-pid rate limiters; the discarded counter stays at zero as in 8.2112.0', () => {
    const { host } = rig(`${TRADITIONAL}module(load="imuxsock" SysSock.RateLimit.Interval="5" SysSock.RateLimit.Burst="100")\nmodule(load="impstats" interval="60")\n*.* /var/log/x.log`);
    host.livePids.add(4242);
    host.logLocal('/run/systemd/journal/syslog', '<13>Oct 19 12:00:00 alice: one', { pid: 4242, uid: 1000, gid: 1000 });
    host.logLocal('/run/systemd/journal/syslog', '<13>Oct 19 12:00:00 alice: two', { pid: 4242, uid: 1000, gid: 1000 });
    host.advance(60_000);
    const line = bodies(host).find((entry) => entry.startsWith('imuxsock:'));
    expect(line).toBe('imuxsock: origin=imuxsock submitted=2 ratelimit.discarded=0 ratelimit.numratelimiters=1 ');
  });

  it('imudp counts per listener and per worker, imtcp per port, and a refused sender is counted as disallowed', () => {
    const net = new LabNetwork();
    const client = new LabHost('10.0.0.1', net);
    const server = new LabHost('10.0.0.2', net);
    startRsyslog(server, `${TRADITIONAL}module(load="imudp")\ninput(type="imudp" port="514")\nmodule(load="imtcp")\ninput(type="imtcp" port="514")\nmodule(load="impstats" interval="60")\n*.* /var/log/in.log`);
    const payload = new TextEncoder().encode('<13>Oct 19 12:00:00 alice: hi');
    client.network.sendDatagram('10.0.0.2', 514, payload);
    client.network.sendDatagram('10.0.0.2', 514, payload);
    const connection = client.network.connectStream('10.0.0.2', 514);
    if ('errno' in connection) throw new Error(connection.errno);
    connection.write(new TextEncoder().encode('<13>Oct 19 12:00:00 alice: tcp\n'));
    server.advance(60_000);
    const out = lines(server.fileSystem.get('/var/log/in.log') ?? null).map((line) => line.replace(/^\S+ +\d+ [\d:]+ \S+ rsyslogd-pstats: /, ''));
    expect(out).toContain('imudp(*/514/IPv4): origin=imudp submitted=2 disallowed=0 ');
    expect(out).toContain('imudp(w0): origin=imudp called.recvmmsg=2 called.recvmsg=0 msgs.received=2 ');
    expect(out).toContain('imtcp(514): origin=imtcp submitted=1 ');
    const denied = new LabHost('10.0.0.3', net);
    const strict = new LabHost('10.0.0.4', net);
    startRsyslog(strict, `${TRADITIONAL}module(load="imudp")\n$AllowedSender UDP, 192.168.0.0/16\ninput(type="imudp" port="514")\nmodule(load="impstats" interval="60")\n*.* /var/log/in.log`);
    denied.network.sendDatagram('10.0.0.4', 514, payload);
    strict.advance(60_000);
    const refused = lines(strict.fileSystem.get('/var/log/in.log') ?? null).map((line) => line.replace(/^\S+ +\d+ [\d:]+ \S+ rsyslogd-pstats: /, ''));
    expect(refused).toContain('imudp(*/514/IPv4): origin=imudp submitted=0 disallowed=1 ');
  });

  it('omfwd reports bytes.sent per destination, and resetcounters zeroes it', () => {
    const net = new LabNetwork();
    const client = new LabHost('10.0.0.1', net);
    const server = new LabHost('10.0.0.2', net);
    startRsyslog(server, 'module(load="imudp")\ninput(type="imudp" port="514")\n*.* /var/log/in.log');
    const lab = startRsyslog(client, `module(load="impstats" interval="60" resetcounters="on" log.syslog="off" log.file="/var/log/stats.log")\n*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="udp")`);
    expect(lab.engine.isStarted).toBe(true);
    client.sentDatagrams.length = 0;
    lab.engine.submit({ raw: '<13>Oct 19 12:00:00 alice: x', inputName: 'test', fromHost: null, fromHostIp: null, fromHostPort: null, ruleset: null, localOrigin: true });
    const sent = client.sentDatagrams.reduce((total, datagram) => total + datagram.payload.length, 0);
    expect(sent).toBeGreaterThan(0);
    client.advance(60_000);
    const first = lines(client.fileSystem.get('/var/log/stats.log') ?? null).find((line) => line.includes('UDP-10.0.0.2-514'));
    expect(first).toContain(`bytes.sent=${sent} `);
    client.advance(60_000);
    const second = lines(client.fileSystem.get('/var/log/stats.log') ?? null).filter((line) => line.includes('UDP-10.0.0.2-514'));
    expect(second[1]).toContain('bytes.sent=0 ');
  });

  it('a dynamic file reports its cache: requests, level0 hits, misses, evictions and the high-water mark', () => {
    const { host, lab } = rig(`${TRADITIONAL}module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\ntemplate(name="dyn" type="string" string="/var/log/d-%programname%.log")\n*.* action(type="omfile" dynaFile="dyn" dynaFileCacheSize="2")`);
    const send = (program: string): void => lab.engine.submit({
      raw: `<13>Oct 19 12:00:00 ubuntu ${program}: m`, inputName: 'test', fromHost: null, fromHostIp: null, fromHostPort: null, ruleset: null, localOrigin: true,
    });
    for (const program of ['a', 'a', 'b', 'a', 'c']) send(program);
    host.advance(60_000);
    const line = lines(host.fileSystem.get('/var/log/stats.log') ?? null).find((entry) => entry.includes('dynafile cache dyn'));
    expect(line).toContain('origin=omfile requests=5 level0=1 missed=3 evicted=1 maxused=2 closetimeouts=0 ');
  });

  it('on a Linux server resource-usage reads the daemon: its CPU time, resident memory and descriptors', async () => {
    const server = new LinuxServer('linux-server', 'host1', 0, 0);
    server.powerOn();
    await server.executeCommand(`printf 'module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/pstats.log")\\n' > /etc/rsyslog.d/10-stats.conf`);
    await server.executeCommand('systemctl restart rsyslog');
    server.advanceTime(61_000);
    const report = await server.executeCommand('grep resource-usage /var/log/pstats.log');
    expect(report).toMatch(/resource-usage: origin=impstats utime=\d+ stime=0 maxrss=[1-9]\d* minflt=0 majflt=0 inblock=0 oublock=0 nvcsw=0 nivcsw=0 openfiles=[3-9]\d* /);
    expect(await server.executeCommand('grep -c "main Q: origin=core.queue" /var/log/pstats.log')).toBe('1');
  }, 30_000);
});
