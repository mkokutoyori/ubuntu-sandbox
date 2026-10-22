/**
 * Probe — the janitor of rsyslog 8.2608.0 (tools/rsyslogd.c mainloop, runtime/janitor.c, tools/omfile.c janitorCB) and
 * the sender table of runtime/statsobj.c (statsRecordSender, getSenderStats, checkGoneAwaySenders), driven by
 * global(janitor.interval), global(senders.keepTrack / reportNew / reportGoneAway / timeoutAfter).
 *
 * The janitor wakes every janitor.interval minutes (default 10), first one interval after start. omfile's callback
 * closes a file whose nInactive has reached closeTimeout, and otherwise adds the janitor interval to nInactive: with the
 * defaults a file with closeTimeout="1" is closed by the SECOND run, twenty minutes in, not after one minute. imtcp
 * records every received chunk against the sender; the table is printed by impstats after the objects as
 * "_sender_stat: sender=<host> messages=<n>" (legacy) or a hand-built JSON object, reset with resetcounters, and swept by
 * the janitor.
 *
 * Measured against the preceding commit (git stash of src/network): 8 of the 9 cases fall - janitor.interval and the
 * senders.* parameters were stored and never read, and omfile closed idle files on its own one-minute tick (so even the
 * "nothing is closed before the first run" case fails). The one that passes in both states is "records nothing when
 * keepTrack is off", a non-regression: the table was never kept before.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, type LabEngine } from './_helpers/rsyslogLab';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const STATS_FILE = '/var/log/stats.log';
const stats = (extra = ''): string => `module(load="impstats" interval="30" log.syslog="off" log.file="${STATS_FILE}" ${extra})\n`;
const DYNAFILE = 'template(name="dyn" type="string" string="/var/log/%programname%.log")\n';

function rig(config: string): { net: LabNetwork; client: LabHost; server: LabHost; lab: LabEngine } {
  const net = new LabNetwork();
  const client = new LabHost('10.0.0.1', net);
  const server = new LabHost('10.0.0.2', net);
  net.reverse.set('10.0.0.1', 'Client.Example.COM');
  return { net, client, server, lab: startRsyslog(server, config) };
}

const report = (host: LabHost): string[] => lines(host.fileSystem.get(STATS_FILE) ?? null).map((line) => line.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d+: /, ''));
const closeTimeouts = (host: LabHost): number => {
  const matches = report(host).filter((line) => line.startsWith('dynafile cache')).map((line) => Number(/closetimeouts=(\d+)/.exec(line)?.[1]));
  return matches[matches.length - 1];
};
const internal = (lab: LabEngine): string => lab.internalMessages.map((entry) => entry.text).join('\n');
const send = (client: LabHost, text: string): void => {
  const connection = client.network.connectStream('10.0.0.2', 514);
  if ('errno' in connection) throw new Error(connection.errno);
  connection.write(encode(text));
};

describe('janitor and omfile idle files', () => {
  const dyna = (global: string, timeout: number): string => `${global}${DYNAFILE}${stats()}*.* action(type="omfile" dynaFile="dyn" closeTimeout="${timeout}")\n`;
  const writeOne = (r: ReturnType<typeof rig>): void => {
    r.lab.engine.submit({ raw: '<13>Oct 19 12:00:01 ubuntu alice: x', inputName: 'imuxsock', fromHost: null, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset: null });
  };

  it('witness: nothing is closed before the first janitor run', () => {
    const r = rig(dyna('', 1));
    writeOne(r);
    r.server.advance(9 * 60_000);
    expect(closeTimeouts(r.server)).toBe(0);
  });

  it('with the default interval of ten minutes a file with closeTimeout 1 is closed by the second run', () => {
    const r = rig(dyna('', 1));
    writeOne(r);
    r.server.advance(10 * 60_000 + 31_000);
    expect(closeTimeouts(r.server)).toBe(0);
    r.server.advance(10 * 60_000);
    expect(closeTimeouts(r.server)).toBe(1);
  });

  it('janitor.interval sets the step: closeTimeout 3 and interval 1 close the file at the fourth minute', () => {
    const r = rig(dyna('global(janitor.interval="1")\n', 3));
    writeOne(r);
    r.server.advance(3 * 60_000 + 31_000);
    expect(closeTimeouts(r.server)).toBe(0);
    r.server.advance(60_000);
    expect(closeTimeouts(r.server)).toBe(1);
  });

  it('a write between two runs starts the count again', () => {
    const r = rig(dyna('global(janitor.interval="1")\n', 3));
    writeOne(r);
    r.server.advance(2 * 60_000 + 30_000);
    writeOne(r);
    r.server.advance(3 * 60_000);
    expect(closeTimeouts(r.server)).toBe(0);
    r.server.advance(2 * 60_000);
    expect(closeTimeouts(r.server)).toBe(1);
  });
});

describe('sender statistics', () => {
  const tcp = (global: string, extra = ''): string => `${global}module(load="imtcp")\ninput(type="imtcp" port="514")\n${stats(extra)}*.* /var/log/x.log\n`;
  const senderLines = (host: LabHost): string[] => report(host).filter((line) => line.includes('_sender_stat'));

  it('counts the messages of each sender when keepTrack is on and prints them after the objects', () => {
    const r = rig(tcp('global(senders.keepTrack="on")\n'));
    send(r.client, '<13>Oct 19 12:00:01 ubuntu a: one\n<13>Oct 19 12:00:01 ubuntu a: two\n');
    send(r.client, '<13>Oct 19 12:00:01 ubuntu a: three\n');
    r.server.advance(30_000);
    expect(senderLines(r.server)).toEqual(['_sender_stat: sender=Client.Example.COM messages=3']);
    expect(report(r.server).at(-1)).toBe('_sender_stat: sender=Client.Example.COM messages=3');
  });

  it('prints a JSON object per sender with the hand-built spacing of the source, and resets it with resetcounters', () => {
    const r = rig(tcp('global(senders.keepTrack="on")\n', 'format="json" resetcounters="on"'));
    send(r.client, '<13>Oct 19 12:00:01 ubuntu a: one\n');
    r.server.advance(30_000);
    r.server.advance(30_000);
    expect(senderLines(r.server)).toEqual([
      '{ "name":"_sender_stat", "origin":"impstats", "sender":"Client.Example.COM", "messages":1}',
      '{ "name":"_sender_stat", "origin":"impstats", "sender":"Client.Example.COM", "messages":0}',
    ]);
  });

  it('records nothing when keepTrack is off', () => {
    const r = rig(tcp(''));
    send(r.client, '<13>Oct 19 12:00:01 ubuntu a: one\n');
    r.server.advance(30_000);
    expect(senderLines(r.server)).toEqual([]);
  });

  it('reports a new sender when reportNew is on', () => {
    const r = rig(tcp('global(senders.keepTrack="on" senders.reportNew="on")\n'));
    send(r.client, '<13>Oct 19 12:00:01 ubuntu a: one\n');
    expect(internal(r.lab)).toContain("new sender 'Client.Example.COM'");
  });

  it('removes a sender the janitor finds silent for senders.timeoutAfter seconds, and says when it was last seen', () => {
    const r = rig(tcp('global(janitor.interval="1" senders.keepTrack="on" senders.reportGoneAway="on" senders.timeoutAfter="120")\n'));
    send(r.client, '<13>Oct 19 12:00:01 ubuntu a: one\n');
    r.server.advance(30_000);
    expect(senderLines(r.server)).toHaveLength(1);
    r.server.advance(4 * 60_000);
    expect(internal(r.lab)).toContain("removing sender 'Client.Example.COM' from connection table, last seen at 2026-10-19 12:00:00");
    expect(report(r.server).at(-1)).not.toContain('_sender_stat');
    expect(senderLines(r.server).length).toBeGreaterThan(0);
  });
});
