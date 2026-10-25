/**
 * Probe - src/network/rsyslog/modules/Imptcp.ts and PtcpFramer.ts, ported from plugins/imptcp/imptcp.c of the 8.2610 source tree:
 * the module and input parameters, the legacy $InputPTCPServer* directives, the per-byte framing state machine (octet counting
 * whose digits stay in the message when the count is refused, LF and additional delimiters, multi-line continuation decided by the
 * end of the receive buffer, regex framing, the Cisco ASA space, oversize splitting and truncation), stream compression
 * (stream:always, stream:auto with sniffing, zlib failures worded as logCompressedStreamFailure), sessions (limit, open and close
 * notices, the extra "openfailed" the epoll drain loop counts after every accept), the UNIX stream socket (path, unlink, mode),
 * the listener and io-work-q statistics objects, rate limiting and the sender statistics.  The refused, mirrored and
 * simulator-specific choices are pinned where they are observable.
 * Measured against the base commit (git stash push -- src/network): 44 of the 45 cases fail - the module did not exist, so loading it
 * was refused.  The one that passes either way is the WITNESS, an imtcp stream that proves the lab delivers a framed message in the
 * same rig.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { LabHost, LabNetwork, lines, startRsyslog, type LabEngine } from './_helpers/rsyslogLab';

const TEMPLATE = 'template(name="probe" type="string" string="%inputname%|%fromhost%|%fromhost-ip%|%fromhost-port%|%msg%\\n")\n';
const FILE_ACTION = '*.* action(type="omfile" file="/var/log/in.log" template="probe")\n';
const STATS_FILE = '/var/log/stats.log';
const STATS = `module(load="impstats" interval="60" log.syslog="off" log.file="${STATS_FILE}")\n`;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Rig {
  readonly net: LabNetwork;
  readonly client: LabHost;
  readonly server: LabHost;
  readonly srv: LabEngine;
}

function rig(config: string, options: { reverse?: boolean } = {}): Rig {
  const net = new LabNetwork();
  const client = new LabHost('10.0.0.1', net);
  const server = new LabHost('10.0.0.2', net);
  if (options.reverse !== false) net.reverse.set('10.0.0.1', 'Client.Example.COM');
  const srv = startRsyslog(server, config);
  return { net, client, server, srv };
}

const config = (input: string, module = 'module(load="imptcp")\n', global = ''): string => `${global}${TEMPLATE}${module}${input}${FILE_ACTION}`;
const filed = (r: Rig): string[] => lines(r.server.fileSystem.get('/var/log/in.log') ?? null);
const diagnostics = (r: Rig): string => `${r.srv.loader.log.lines().join('\n')}\n${r.srv.internalMessages.map((entry) => entry.text).join('\n')}`;

function connect(r: Rig, port = 514): { write(data: string | Uint8Array): void; close(): void } {
  const connection = r.client.network.connectStream('10.0.0.2', port);
  if ('errno' in connection) throw new Error(connection.errno);
  return { write: (data) => { connection.write(typeof data === 'string' ? encode(data) : data); }, close: () => connection.close() };
}

const send = (r: Rig, data: string | Uint8Array): void => {
  const session = connect(r);
  session.write(data);
  session.close();
};

const PTCP = 'input(type="imptcp" port="514")\n';
const statsOf = (r: Rig, name: string): string[] => {
  r.server.advance(60_000);
  return lines(r.server.fileSystem.get(STATS_FILE) ?? null).map((line) => line.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d+: /, '')).filter((line) => line.startsWith(name));
};

describe('imptcp: sessions and framing', () => {
  it('witness: imtcp delivers a framed message in the same rig', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\n');
    expect(filed(r)).toEqual(['imtcp|Client.Example.COM|10.0.0.1|40001| one']);
  });

  it('delivers LF-delimited messages with the peer name as the PTR record gives it', () => {
    const r = rig(config(PTCP));
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\n<13>Oct 19 12:00:02 ubuntu alice: two\n');
    expect(filed(r)).toEqual(['imptcp|Client.Example.COM|10.0.0.1|40001| one', 'imptcp|Client.Example.COM|10.0.0.1|40001| two']);
  });

  it('keeps the numeric address when there is no PTR record', () => {
    const r = rig(config(PTCP), { reverse: false });
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\n');
    expect(filed(r)[0]).toContain('imptcp|10.0.0.1|10.0.0.1|');
  });

  it('refuses a peer whose PTR record is an address and counts the failed open', () => {
    const r = rig(`${STATS}${config('input(type="imptcp" port="514" notifyOnConnectionOpen="on")\n')}`);
    r.net.reverse.set('10.0.0.1', '10.9.9.9');
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: refused\n');
    expect(filed(r)).toEqual([]);
    expect(diagnostics(r)).toContain('imptcp: connection could not be established with host: [MALICIOUS:IP=10.0.0.1]');
    expect(statsOf(r, 'imptcp(*/514/IPv4)')[0]).toContain('sessions.opened=0 sessions.openfailed=1');
  });

  it('reads an octet-counted frame whatever the segmentation', () => {
    const r = rig(config(PTCP));
    const session = connect(r);
    const body = '<13>Oct 19 12:00:01 ubuntu alice: counted';
    const frame = `${body.length} ${body}`;
    session.write(frame.slice(0, 3));
    session.write(frame.slice(3, 20));
    session.write(frame.slice(20));
    expect(filed(r)).toEqual(['imptcp|Client.Example.COM|10.0.0.1|40001| counted']);
  });

  it('uses the name parameter as inputname', () => {
    const r = rig(config('input(type="imptcp" port="514" name="edge")\n'));
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: named\n');
    expect(filed(r)[0].startsWith('edge|')).toBe(true);
  });

  it('with supportOctetCountedFraming off a leading number is part of the message', () => {
    const r = rig(config('input(type="imptcp" port="514" supportOctetCountedFraming="off")\n'));
    send(r, '12 <13>Oct 19 12:00:01 ubuntu alice: digits\n');
    expect(filed(r)).toHaveLength(1);
    expect(filed(r)[0]).toContain('digits');
  });

  it('drops the digits of an octet count of zero and goes on in octet stuffing', () => {
    const r = rig(`template(name="raw" type="string" string="%rawmsg%\\n")\nmodule(load="imptcp")\n${PTCP}*.* action(type="omfile" file="/var/log/in.log" template="raw")\n`);
    send(r, '0 <13>Oct 19 12:00:01 ubuntu alice: zero\n');
    expect(diagnostics(r)).toContain('imptcp: Framing Error in received TCP message from peer: (hostname) Client.Example.COM, (ip) 10.0.0.1: invalid octet count 0.');
    expect(filed(r)).toEqual(['<13>Oct 19 12:00:01 ubuntu alice: zero']);
  });

  it('keeps the digits of a count refused as too large in the message it falls back to', () => {
    const r = rig(`template(name="raw" type="string" string="%rawmsg%\\n")\nmodule(load="imptcp")\ninput(type="imptcp" port="514" maxFrameSize="20")\n*.* action(type="omfile" file="/var/log/in.log" template="raw")\n`);
    send(r, '999 <13>Oct 19 12:00:01 ubuntu alice: big\n');
    expect(filed(r)).toEqual(['999<13>Oct 19 12:00:01 ubuntu alice: big']);
  });

  it('reports a count not followed by a space and a frame larger than maxFrameSize', () => {
    const r = rig(config('input(type="imptcp" port="514" maxFrameSize="20")\n'));
    send(r, '5x<13>abcdef\n');
    send(r, '999 <13>Oct 19 12:00:01 ubuntu alice: too big\n');
    const text = diagnostics(r);
    expect(text).toContain('delimiter is not SP but has ASCII value 120.');
    expect(text).toContain('imptcp: Framing Error in received TCP message from peer: (hostname) Client.Example.COM, (ip) 10.0.0.1: frame too large: 999, change to octet stuffing');
  });

  it('honours an additional frame delimiter', () => {
    const r = rig(config('input(type="imptcp" port="514" addtlFrameDelimiter="0")\n'));
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: a\0<13>Oct 19 12:00:02 ubuntu alice: b\n');
    expect(filed(r).map((line) => line.split('| ')[1])).toEqual(['a', 'b']);
  });

  it('ignores a space in front of a frame with framingfix.cisco.asa', () => {
    const r = rig(config('input(type="imptcp" port="514" framingfix.cisco.asa="on")\n'));
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\n <13>Oct 19 12:00:02 ubuntu alice: two\n');
    expect(filed(r).map((line) => line.split('| ')[1])).toEqual(['one', 'two']);
  });

  it('multiLine continues a message until a line that starts with a priority, and submits at the end of the receive buffer', () => {
    const r = rig(config('input(type="imptcp" port="514" multiLine="on")\n'));
    const session = connect(r);
    session.write('<13>Oct 19 12:00:01 ubuntu alice: first\n  continued\n<13>Oct 19 12:00:02 ubuntu alice: second\n');
    session.write('<13>Oct 19 12:00:03 ubuntu alice: third\n');
    expect(filed(r).map((line) => line.split('| ')[1])).toEqual(['first#012  continued', 'second', 'third']);
  });

  it('regex framing cuts the stream where a line matches the delimiter expression', () => {
    const r = rig(config('input(type="imptcp" port="514" framing.delimiter.regex="^<[0-9]+>")\n'));
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\nsecond line\n<13>Oct 19 12:00:02 ubuntu alice: two\n<13>Oct 19 12:00:03 ubuntu alice: three');
    expect(filed(r).map((line) => line.split('| ')[1])).toEqual(['one#012second line', 'two']);
  });

  it('refuses a framing.delimiter.regex that does not compile', () => {
    const r = rig(config('input(type="imptcp" port="514" framing.delimiter.regex="(")\n'));
    expect(diagnostics(r)).toContain('imptcp: error in framing.delimiter.regex expansion');
  });

  it('splits an oversize line at the maximum message size and says where', () => {
    const r = rig(config(PTCP, 'module(load="imptcp")\n', 'global(maxMessageSize="128")\n'));
    send(r, `<13>Oct 19 12:00:01 ubuntu alice: ${'x'.repeat(200)}\n`);
    expect(filed(r)).toHaveLength(2);
    expect(diagnostics(r)).toContain('imptcp imptcp: message received is at least');
    expect(diagnostics(r)).toContain('larger than max msg size; message will be split starting at: "');
  });

  it('discardTruncatedMsg drops the rest of an oversize line', () => {
    const r = rig(config('input(type="imptcp" port="514" discardTruncatedMsg="on")\n', 'module(load="imptcp")\n', 'global(maxMessageSize="128")\n'));
    send(r, `<13>Oct 19 12:00:01 ubuntu alice: ${'x'.repeat(200)}\n<13>Oct 19 12:00:02 ubuntu alice: next\n`);
    expect(filed(r)).toHaveLength(2);
    expect(filed(r)[1]).toContain('next');
  });

  it('writes an oversize frame to the oversize message log', () => {
    const r = rig(config(PTCP, 'module(load="imptcp")\n', 'global(maxMessageSize="128" oversizemsg.errorfile="/var/log/oversize.json")\n'));
    send(r, `200 <13>Oct 19 12:00:01 ubuntu alice: ${'y'.repeat(200)}\n`);
    expect(r.server.fileSystem.get('/var/log/oversize.json') ?? '').toContain('"input": "imptcp"');
  });

  it('a short session limit refuses the next peer with the source wording', () => {
    const r = rig(config('input(type="imptcp" port="514" maxSessions="1")\n'));
    const first = connect(r);
    const second = connect(r);
    second.write('<13>Oct 19 12:00:01 ubuntu alice: refused\n');
    first.write('<13>Oct 19 12:00:02 ubuntu alice: kept\n');
    expect(filed(r).map((line) => line.split('| ')[1])).toEqual(['kept']);
    expect(diagnostics(r)).toContain('imptcp: too many tcp sessions - dropping incoming request');
    expect(diagnostics(r)).toContain('imptcp: failed to fully accept session from remote peer Client.Example.COM[10.0.0.1]. This can be caused by a peer that closed the session immediately after connect');
  });

  it('notifies on open and on close, naming the descriptor, the peer and the status', () => {
    const r = rig(config('input(type="imptcp" port="514" notifyOnConnectionOpen="on" notifyOnConnectionClose="on")\n'));
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: x\n');
    const text = diagnostics(r);
    expect(text).toContain('imptcp: connection established with host: Client.Example.COM');
    expect(text).toMatch(/imptcp session \d+ closed by remote peer Client\.Example\.COM\./);
    expect(text).toMatch(/imptcp: session on socket \d+ closed with iRet 0\./);
  });
});

describe('imptcp: statistics, rate limit, senders', () => {
  it('publishes a listener object whose counters follow the traffic, the extra failed open included', () => {
    const r = rig(`${STATS}${config(PTCP)}`);
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\n<13>Oct 19 12:00:02 ubuntu alice: two\n');
    const line = statsOf(r, 'imptcp(*/514/IPv4)')[0];
    expect(line).toContain('origin=imptcp submitted=2 sessions.opened=1 sessions.openfailed=1 sessions.closed=1 bytes.received=');
    expect(line).toContain('bytes.decompressed=0');
  });

  it('names the listener object after the input name and the address', () => {
    const r = rig(`${STATS}${config('input(type="imptcp" port="514" name="edge" address="10.0.0.2")\n')}`);
    expect(statsOf(r, 'edge(10.0.0.2/514/IPv4)')).toHaveLength(1);
  });

  it('publishes the io-work-q object, which only counts work when processOnPoller is off', () => {
    const polled = rig(`${STATS}${config(PTCP)}`);
    send(polled, '<13>Oct 19 12:00:01 ubuntu alice: one\n');
    expect(statsOf(polled, 'io-work-q')[0]).toContain('origin=imptcp enqueued=0 maxqsize=0');
    const queued = rig(`${STATS}${config(PTCP, 'module(load="imptcp" processOnPoller="off")\n')}`);
    send(queued, '<13>Oct 19 12:00:01 ubuntu alice: one\n');
    const line = statsOf(queued, 'io-work-q')[0];
    expect(line).not.toContain('enqueued=0');
    expect(line).toContain('maxqsize=1');
  });

  it('applies ratelimit.interval and ratelimit.burst per listener and counts only what passes', () => {
    const r = rig(`${STATS}${config('input(type="imptcp" port="514" ratelimit.interval="5" ratelimit.burst="2")\n')}`);
    send(r, ['one', 'two', 'three', 'four'].map((word) => `<13>Oct 19 12:00:01 ubuntu alice: ${word}\n`).join(''));
    expect(filed(r)).toHaveLength(2);
    expect(statsOf(r, 'imptcp(*/514/IPv4)')[0]).toContain('submitted=2 ');
  });

  it('refuses an unknown ratelimit.name when the listener is added', () => {
    const r = rig(config('input(type="imptcp" port="514" ratelimit.name="nope")\n'));
    expect(diagnostics(r)).toContain("ratelimit config 'nope' not found");
    expect(diagnostics(r)).toContain('imptcp: error -3003 trying to add listener');
  });

  it('feeds senders.keepTrack with the messages of each receive buffer', () => {
    const r = rig(`${STATS}global(senders.keepTrack="on")\n${config(PTCP)}`);
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: one\n<13>Oct 19 12:00:02 ubuntu alice: two\n');
    expect(statsOf(r, '_sender_stat')[0]).toBe('_sender_stat: sender=Client.Example.COM messages=2');
  });
});

describe('imptcp: stream compression', () => {
  const message = '<13>Oct 19 12:00:01 ubuntu alice: compressed\n';
  const packed = (text: string): Uint8Array => new Uint8Array(deflateSync(Buffer.from(text)));

  it('stream:always inflates the stream and counts the bytes before and after', () => {
    const r = rig(`${STATS}${config('input(type="imptcp" port="514" compression.mode="stream:always")\n')}`);
    const stream = packed(message);
    const session = connect(r);
    session.write(stream.subarray(0, 7));
    session.write(stream.subarray(7));
    expect(filed(r)).toEqual(['imptcp|Client.Example.COM|10.0.0.1|40001| compressed']);
    const line = statsOf(r, 'imptcp(*/514/IPv4)')[0];
    expect(line).toContain(`bytes.received=${stream.length} `);
    expect(line).toContain(`bytes.decompressed=${message.length}`);
  });

  it('stream:always refuses data that is not a zlib stream with the zlib state named', () => {
    const r = rig(config('input(type="imptcp" port="514" compression.mode="stream:always")\n'));
    send(r, 'plain text that is not zlib\n');
    expect(filed(r)).toEqual([]);
    expect(diagnostics(r)).toContain('imptcp: received invalid compressed stream from peer Client.Example.COM[10.0.0.1]: zlib state Z_DATA_ERROR (-3)');
  });

  it('reports a stream cut before its end when the peer closes', () => {
    const r = rig(config('input(type="imptcp" port="514" compression.mode="stream:always")\n'));
    send(r, packed(message).subarray(0, 12));
    expect(diagnostics(r)).toContain('imptcp: detected truncated compressed stream from peer Client.Example.COM[10.0.0.1]: zlib state Z_BUF_ERROR (-5)');
  });

  it('reports data after the end of the stream', () => {
    const r = rig(config('input(type="imptcp" port="514" compression.mode="stream:always")\n'));
    const stream = packed(message);
    const joined = new Uint8Array(stream.length + 3);
    joined.set(stream, 0);
    joined.set(encode('abc'), stream.length);
    send(r, joined);
    expect(filed(r)).toHaveLength(1);
    expect(diagnostics(r)).toContain('received trailing data after end of compressed stream from peer Client.Example.COM[10.0.0.1]: zlib state Z_STREAM_END (1)');
  });

  it('stream:auto recognises a compressed stream and a plain one on the same listener', () => {
    const r = rig(config('input(type="imptcp" port="514" compression.mode="stream:auto")\n'));
    send(r, packed(message));
    send(r, '<13>Oct 19 12:00:02 ubuntu alice: plain\n');
    expect(filed(r).map((line) => line.split('| ')[1])).toEqual(['compressed', 'plain']);
  });

  it('stream:auto waits for two bytes before it decides', () => {
    const r = rig(config('input(type="imptcp" port="514" compression.mode="stream:auto")\n'));
    const session = connect(r);
    session.write('<');
    session.write('13>Oct 19 12:00:01 ubuntu alice: split\n');
    expect(filed(r)).toHaveLength(1);
  });

  it('refuses a compression.mode that is not one of the three', () => {
    const r = rig(config('input(type="imptcp" port="514" compression.mode="single")\n'));
    expect(diagnostics(r)).toContain("imptcp: invalid value for 'compression.mode' parameter (given is 'single')");
  });
});

describe('imptcp: unix socket', () => {
  const unixConfig = (extra = '', input = 'input(type="imptcp" path="/run/ptcp.sock"') => config(`${input}${extra})\n`);

  it('listens on a stream socket, names the peer after the local host and counts the listener under IPv4', () => {
    const r = rig(`${STATS}${unixConfig()}`);
    const connection = r.server.connectUnix('/run/ptcp.sock');
    if ('errno' in connection) throw new Error(connection.errno);
    connection.write(encode('<13>Oct 19 12:00:01 ubuntu alice: local\n'));
    connection.close();
    expect(filed(r)).toEqual(['imptcp|ubuntu|127.0.0.1|| local']);
    expect(statsOf(r, 'imptcp(*//run/ptcp.sock/IPv4)')).toHaveLength(1);
  });

  it('creates the socket with the requested mode and removes it on shutdown when unlink is on', () => {
    const r = rig(unixConfig(' unlink="on" fileCreateMode="0600"'));
    expect(r.server.unixStreamOptions[0]).toEqual({ path: '/run/ptcp.sock', options: { unlink: true, mode: 0o600, uid: null, gid: null } });
  });

  it('reports a bind failure with the source wording', () => {
    const net = new LabNetwork();
    const server = new LabHost('10.0.0.2', net);
    server.unixStreamErrors.set('/run/ptcp.sock', { errno: 'EADDRINUSE', stage: 'bind' });
    const srv = startRsyslog(server, unixConfig());
    expect(srv.internalMessages.map((entry) => entry.text).join('\n')).toContain('imptcp: error while binding unix socket: Address already in use');
  });

  it('refuses an input with neither port nor path', () => {
    const r = rig(config('input(type="imptcp" name="x")\n'));
    expect(diagnostics(r)).toContain('imptcp: Must have either port or path defined');
  });
});

describe('imptcp: module parameters and legacy directives', () => {
  it('accepts threads, maxsessions and processOnPoller on module()', () => {
    const r = rig(config(PTCP, 'module(load="imptcp" threads="4" maxsessions="1" processOnPoller="off")\n'));
    const first = connect(r);
    const second = connect(r);
    first.write('<13>Oct 19 12:00:01 ubuntu alice: kept\n');
    second.write('<13>Oct 19 12:00:02 ubuntu alice: refused\n');
    expect(filed(r)).toHaveLength(1);
  });

  it('runs a listener declared with $InputPTCPServerRun after the legacy settings', () => {
    const r = rig(`${TEMPLATE}module(load="imptcp")\n$InputPTCPServerInputName legacy\n$InputPTCPServerSupportOctetCountedFraming off\n$InputPTCPServerRun 514\n${FILE_ACTION}`);
    send(r, '<13>Oct 19 12:00:01 ubuntu alice: old style\n');
    expect(filed(r)[0].startsWith('legacy|')).toBe(true);
  });

  it('refuses the legacy helper-thread directive once module() set the parameters', () => {
    const r = rig(`${TEMPLATE}module(load="imptcp" threads="3")\n$InputPTCPServerHelperThreads 5\n${PTCP}${FILE_ACTION}`);
    expect(diagnostics(r)).toContain("command 'inputptcpserverhelperthreads' is currently not permitted - did you already set it via a RainerScript command (v6+ config)?");
  });

  it('says so when no listener is defined', () => {
    const r = rig(`${TEMPLATE}module(load="imptcp")\n${FILE_ACTION}`);
    expect(diagnostics(r)).toContain('imptcp: no ptcp server defined, module can not run.');
  });

  it('refuses a maxFrameSize above the limit', () => {
    const r = rig(config('input(type="imptcp" port="514" maxFrameSize="200000001")\n'));
    expect(diagnostics(r)).toContain("imptcp: invalid value for 'maxFrameSize' parameter given is 200000001, max is 200000000");
  });

  it('passes the keep-alive settings and the backlog to the listening socket', () => {
    const r = rig(config('input(type="imptcp" port="514" keepAlive="on" keepAlive.probes="3" keepAlive.time="60" keepAlive.interval="10" socketBacklog="16")\n'));
    const options = r.server.listenOptions[0].options;
    expect(options.keepAlive).toEqual({ probes: 3, timeSeconds: 60, intervalSeconds: 10 });
    expect(options.backlog).toBe(16);
  });

  it('writes the dynamic port to listenPortFileName without a newline', () => {
    const r = rig(config('input(type="imptcp" port="0" listenPortFileName="/var/run/ptcp.port")\n'));
    expect(r.server.fileSystem.get('/var/run/ptcp.port')).toMatch(/^\d+$/);
  });

  it('resolves a service name for the port', () => {
    const net = new LabNetwork();
    net.services.set('syslog-conn', 6514);
    const server = new LabHost('10.0.0.2', net);
    startRsyslog(server, config('input(type="imptcp" port="syslog-conn")\n'));
    expect(server.listenOptions[0].port).toBe(6514);
  });
});
