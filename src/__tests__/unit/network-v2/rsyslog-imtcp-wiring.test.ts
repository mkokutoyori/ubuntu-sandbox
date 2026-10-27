/**
 * Probe - four things imtcp parsed and then never used, found while porting imptcp (whose source evaluates the same parameters):
 * the keep-alive settings of the input (SO_KEEPALIVE, TCP_KEEPCNT, TCP_KEEPIDLE, TCP_KEEPINTVL on every accepted socket), the
 * listen backlog (socketBacklog), the oversize message log (an oversize frame is written to oversizemsg.errorfile by
 * writeOversizeMessageLog before the message is queued) and the "submitted" counter, which counts the messages the rate limiter let
 * through and not the ones it dropped.
 * Measured against the base commit (git stash push -- src/network): 4 of the 6 cases fall.  The 2 that pass either way are the
 * WITNESS (an unlimited listener counts what it receives) and the non-regression that keep-alive stays off unless asked for.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const TEMPLATE = 'template(name="probe" type="string" string="%msg%\\n")\n';
const FILE_ACTION = '*.* action(type="omfile" file="/var/log/in.log" template="probe")\n';
const STATS = 'module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\n';

function rig(config: string) {
  const net = new LabNetwork();
  const client = new LabHost('10.0.0.1', net);
  const server = new LabHost('10.0.0.2', net);
  const srv = startRsyslog(server, config);
  return { client, server, srv };
}

const send = (client: LabHost, text: string): void => {
  const connection = client.network.connectStream('10.0.0.2', 514);
  if ('errno' in connection) throw new Error(connection.errno);
  connection.write(encode(text));
  connection.close();
};

describe('imtcp parameters that used to be parsed and ignored', () => {
  it('witness: the submitted counter counts what an unlimited listener receives', () => {
    const { client, server } = rig(`${STATS}${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    send(client, '<13>Oct 19 12:00:01 ubuntu a: one\n<13>Oct 19 12:00:02 ubuntu a: two\n');
    server.advance(60_000);
    expect(server.fileSystem.get('/var/log/stats.log')).toContain('submitted=2');
  });

  it('hands the keep-alive settings to every accepted socket', () => {
    const { server } = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" keepAlive="on" keepAlive.probes="3" keepAlive.time="60" keepAlive.interval="10")\n${FILE_ACTION}`);
    expect(server.listenOptions[0].options.keepAlive).toEqual({ probes: 3, timeSeconds: 60, intervalSeconds: 10 });
  });

  it('leaves keep-alive off unless the input asks for it', () => {
    const { server } = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    expect(server.listenOptions[0].options.keepAlive).toBeUndefined();
  });

  it('passes socketBacklog to the listening socket', () => {
    const { server } = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" socketBacklog="16")\n${FILE_ACTION}`);
    expect(server.listenOptions[0].options.backlog).toBe(16);
  });

  it('writes an oversize frame to the oversize message log', () => {
    const { client, server } = rig(`global(maxMessageSize="128" oversizemsg.errorfile="/var/log/oversize.json")\n${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    send(client, `200 <13>Oct 19 12:00:01 ubuntu a: ${'z'.repeat(200)}\n`);
    expect(server.fileSystem.get('/var/log/oversize.json') ?? '').toContain('"input": "imtcp"');
  });

  it('counts as submitted only the messages the rate limiter lets through', () => {
    const { client, server } = rig(`${STATS}${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" ratelimit.interval="5" ratelimit.burst="2")\n${FILE_ACTION}`);
    send(client, ['one', 'two', 'three', 'four'].map((word) => `<13>Oct 19 12:00:01 ubuntu a: ${word}\n`).join(''));
    expect(lines(server.fileSystem.get('/var/log/in.log') ?? null)).toHaveLength(2);
    server.advance(60_000);
    expect(server.fileSystem.get('/var/log/stats.log')).toContain('submitted=2');
  });
});
