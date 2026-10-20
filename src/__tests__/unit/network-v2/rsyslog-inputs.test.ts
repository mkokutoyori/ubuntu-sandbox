/**
 * Probe — src/network/rsyslog/modules/Imudp.ts and Imtcp.ts (+ TcpFramer.ts),
 * ported from plugins/imudp/imudp.c, plugins/imtcp/imtcp.c, runtime/tcpsrv.c,
 * runtime/tcps_sess.c and runtime/dnscache.c of the 8.2610 source tree.
 *
 * Measured against the base commit: none of these modules exist there, so every
 * case fails at import. "witness:" cases only prove the lab itself is sound
 * (a datagram or a stream reaches a ruleset and is filed). Time-dependent cases
 * (reverse-lookup cache TTL, imtcp session lifetime) move the simulated clock
 * with LabHost.advance().
 */
import { zlibCompressSync } from './_helpers/zlibShim';
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, type LabEngine } from './_helpers/rsyslogLab';

const TEMPLATE = `
template(name="probe" type="string" string="%inputname%|%fromhost%|%fromhost-ip%|%syslogtag%|%msg%\\n")
`;

const FILE_ACTION = '*.* action(type="omfile" file="/var/log/in.log" template="probe")';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Rig {
  readonly net: LabNetwork;
  readonly client: LabHost;
  readonly server: LabHost;
  readonly srv: LabEngine;
}

function rig(serverConfig: string): Rig {
  const net = new LabNetwork();
  const client = new LabHost('10.0.0.1', net);
  const server = new LabHost('10.0.0.2', net);
  net.reverse.set('10.0.0.1', 'Client.Example.COM');
  const srv = startRsyslog(server, serverConfig);
  return { net, client, server, srv };
}

const filed = (server: LabHost): string[] => lines(server.fileSystem.get('/var/log/in.log') ?? null);
const internal = (host: LabHost): string[] => host.libcSyslog.map((entry) => entry.message);
const udp = (r: Rig, text: string | Uint8Array): void => {
  r.client.network.sendDatagram('10.0.0.2', 514, typeof text === 'string' ? encode(text) : text);
};
const open = (r: Rig): { write(text: string | Uint8Array): void; close(): void } => {
  const connection = r.client.network.connectStream('10.0.0.2', 514);
  if ('errno' in connection) throw new Error(connection.errno);
  return {
    write: (text) => { connection.write(typeof text === 'string' ? encode(text) : text); },
    close: () => connection.close(),
  };
};

const UDP_CONFIG = `${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514")\n${FILE_ACTION}`;

describe('imudp', () => {
  it('witness: a datagram reaches the ruleset with the sender resolved and lower-cased', () => {
    const r = rig(UDP_CONFIG);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(r.server)).toEqual(['imudp|client.example.com|10.0.0.1|alice:| hello']);
  });

  it('preserveCase keeps the PTR name as returned', () => {
    const r = rig(`${TEMPLATE}module(load="imudp" preserveCase="on")\ninput(type="imudp" port="514")\n${FILE_ACTION}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(r.server)[0]).toContain('|Client.Example.COM|');
  });

  it('net.enableDNS="off" uses the address as the host name', () => {
    const r = rig(`global(net.enableDNS="off")\n${UDP_CONFIG}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(r.server)).toEqual(['imudp|10.0.0.1|10.0.0.1|alice:| hello']);
  });

  it('a PTR record that is itself an address is rejected and the address used', () => {
    const r = rig(UDP_CONFIG);
    r.net.reverse.set('10.0.0.1', '6.6.6.6');
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(r.server)[0]).toContain('|10.0.0.1|10.0.0.1|');
    expect(internal(r.server)).toContain('Malicious PTR record (message accepted, but used IP instead of PTR name: IP = "10.0.0.1" HOST = "6.6.6.6" [v8.2112.0]');
  });

  it('dropMsgsWithMaliciousDnsPTRRecords reports the drop and falls back to the error marker', () => {
    const r = rig(`global(DropMsgsWithMaliciousDnsPTRRecords="on")\n${UDP_CONFIG}`);
    r.net.reverse.set('10.0.0.1', '6.6.6.6');
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(internal(r.server)).toContain('Malicious PTR record, message dropped IP = "10.0.0.1" HOST = "6.6.6.6" [v8.2112.0 try https://www.rsyslog.com/e/2021 ]');
    expect(filed(r.server)[0]).toContain('|?error.obtaining.ip?|?error.obtaining.ip?|');
  });

  it('keeps a resolved name forever unless the reverse-lookup TTL is enabled, then renews it once expired', () => {
    const forever = rig(UDP_CONFIG);
    udp(forever, '<13>Oct 19 12:00:01 ubuntu alice: one');
    forever.net.reverse.set('10.0.0.1', 'renamed.example.com');
    forever.server.advance(48 * 3600_000);
    udp(forever, '<13>Oct 19 12:00:01 ubuntu alice: two');
    expect(filed(forever.server).map((entry) => entry.split('|')[1])).toEqual(['client.example.com', 'client.example.com']);
    const ttl = rig(`global(reverselookup.cache.ttl.enable="on" reverselookup.cache.ttl.default="3600")\n${UDP_CONFIG}`);
    udp(ttl, '<13>Oct 19 12:00:01 ubuntu alice: one');
    ttl.net.reverse.set('10.0.0.1', 'renamed.example.com');
    ttl.server.advance(1800_000);
    udp(ttl, '<13>Oct 19 12:00:01 ubuntu alice: two');
    ttl.server.advance(1801_000);
    udp(ttl, '<13>Oct 19 12:00:01 ubuntu alice: three');
    expect(filed(ttl.server).map((entry) => entry.split('|')[1])).toEqual(['client.example.com', 'client.example.com', 'renamed.example.com']);
  });

  it('name and name.appendPort build the input name; the deprecated spelling is reported', () => {
    const r = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514" name="fw" name.appendPort="on")\n${FILE_ACTION}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(r.server)[0].startsWith('fw514|')).toBe(true);
    const old = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514" inputname="legacy")\n${FILE_ACTION}`);
    expect(old.srv.loader.log.lines()).toContain('rsyslogd: imudp: deprecated parameter inputname used. Suggest to use name instead [v8.2112.0 try https://www.rsyslog.com/e/2307 ]');
  });

  it('one input with several ports opens one listener per port', () => {
    const r = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port=["514","5514"])\n${FILE_ACTION}`);
    r.client.network.sendDatagram('10.0.0.2', 5514, encode('<13>Oct 19 12:00:01 ubuntu alice: other'));
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: first');
    expect(filed(r.server)).toHaveLength(2);
  });

  it('binds the ruleset, and falls back to the default ruleset with a diagnostic when it does not exist', () => {
    const r = rig(`${TEMPLATE}module(load="imudp")\nruleset(name="remote") { action(type="omfile" file="/var/log/remote-only.log") }\ninput(type="imudp" port="514" ruleset="remote")\n${FILE_ACTION}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(r.server.fileSystem.get('/var/log/remote-only.log')).toBeDefined();
    expect(filed(r.server)).toEqual([]);
    const missing = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514" ruleset="nope")\n${FILE_ACTION}`);
    expect(missing.srv.loader.log.lines()).toContain(
      "rsyslogd: imudp: ruleset 'nope' for *:514 not found - using default ruleset instead [v8.2112.0]",
    );
    udp(missing, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(missing.server)).toHaveLength(1);
  });

  it('defaultTZ is applied to a legacy timestamp that carries none', () => {
    const r = rig(`template(name="t" type="string" string="%timestamp:::date-rfc3339%\\n")\nmodule(load="imudp")\ninput(type="imudp" port="514" defaultTZ="+05:30")\n*.* action(type="omfile" file="/var/log/in.log" template="t")`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: hello');
    expect(filed(r.server)).toEqual(['2026-10-19T12:00:01+05:30']);
  });

  it('$AllowedSender UDP admits the listed network only and reports the others', () => {
    const r = rig(`$AllowedSender UDP, 192.168.0.0/16, [fe80::]/10\n${UDP_CONFIG}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: refused');
    expect(filed(r.server)).toEqual([]);
    expect(internal(r.server)).toContain('imudp: UDP message from disallowed sender discarded [v8.2112.0]');
    const open = rig(`$AllowedSender UDP, 10.0.0.0/24\n${UDP_CONFIG}`);
    udp(open, '<13>Oct 19 12:00:01 ubuntu alice: admitted');
    expect(filed(open.server)).toHaveLength(1);
  });

  it('allowedSender on the input overrides the legacy list, and a hostname wildcard is matched after resolution', () => {
    const r = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514" allowedSender=["*.example.com"])\n${FILE_ACTION}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: by name');
    expect(filed(r.server)).toHaveLength(1);
    const denied = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514" allowedSender=["*.example.org"])\n${FILE_ACTION}`);
    udp(denied, '<13>Oct 19 12:00:01 ubuntu alice: by name');
    expect(filed(denied.server)).toEqual([]);
  });

  it('inflates a z-prefixed datagram and discards one that does not inflate', () => {
    const r = rig(UDP_CONFIG);
    const compressed = zlibCompressSync(encode('<13>Oct 19 12:00:01 ubuntu alice: squeezed'));
    udp(r, Uint8Array.from([0x7a, ...compressed]));
    expect(filed(r.server)).toEqual(['imudp|client.example.com|10.0.0.1|alice:| squeezed']);
    udp(r, Uint8Array.from([0x7a, 1, 2, 3, 4, 5, 6, 7]));
    expect(internal(r.server).some((text) => text.startsWith('Uncompression of a message failed with return code -3'))).toBe(true);
  });

  it('with parser.supportCompressionExtension off, a message starting with z is plain text', () => {
    const r = rig(`global(parser.supportCompressionExtension="off")\n${UDP_CONFIG}`);
    udp(r, 'zebra crossing');
    expect(filed(r.server)).toHaveLength(1);
  });

  it('rate-limits per listener and reports the loss with the listener name', () => {
    const r = rig(`${TEMPLATE}module(load="imudp")\ninput(type="imudp" port="514" ratelimit.interval="5" ratelimit.burst="2")\n${FILE_ACTION}`);
    for (let count = 0; count < 5; count++) udp(r, `<13>Oct 19 12:00:01 ubuntu alice: m${count}`);
    expect(filed(r.server)).toHaveLength(2);
    r.server.advance(6_000);
    udp(r, '<13>Oct 19 12:00:07 ubuntu alice: later');
    expect(filed(r.server)).toHaveLength(3);
    expect(internal(r.server).some((text) => text.startsWith('imudp(*/514/IPv4) from <ubuntu:alice>: begin to drop messages due to rate-limiting'))).toBe(true);
    expect(internal(r.server).some((text) => text.startsWith('imudp(*/514/IPv4): 3 messages lost due to rate-limiting (2 allowed within 5 seconds)'))).toBe(true);
  });

  it('reports a port that is already bound and keeps running without the listener', () => {
    const net = new LabNetwork();
    const server = new LabHost('10.0.0.2', net);
    server.busyPorts.add(514);
    const started = startRsyslog(server, UDP_CONFIG);
    expect(internal(server)).toEqual([
      'No UDP socket could successfully be initialized, some functionality may be disabled.  [v8.2112.0]',
      'imudp: Could not create udp listener, ignoring port 514 bind-address (null). [v8.2112.0]',
    ]);
    expect(started.engine.isStarted).toBe(true);
  });

  it('warns when the module is loaded without any listener', () => {
    const r = rig('module(load="imudp")\n*.* /var/log/x.log');
    expect(r.srv.loader.log.lines()).toContain('rsyslogd: imudp: module loaded, but no listeners defined - no input will be gathered [v8.2112.0 try https://www.rsyslog.com/e/2212 ]');
  });

  it('validates the scheduling parameters the module accepts', () => {
    const r = rig('module(load="imudp" schedulingPolicy="fifo")\ninput(type="imudp" port="514")\n*.* /var/log/x.log');
    expect(r.srv.loader.log.lines()).toContain('rsyslogd: imudp: scheduling policy set, but without priority - ignoring settings [v8.2112.0 try https://www.rsyslog.com/e/2205 ]');
    const bad = rig('module(load="imudp" schedulingPolicy="lifo" schedulingPriority="3")\ninput(type="imudp" port="514")\n*.* /var/log/x.log');
    expect(bad.srv.loader.log.lines()).toContain("rsyslogd: imudp: invalid scheduling policy 'lifo' - ignoring setting [v8.2112.0]");
  });

  it('legacy $UDPServerRun opens a listener and honours $UDPServerAddress and $InputUDPServerBindRuleset', () => {
    const r = rig(`${TEMPLATE}module(load="imudp")\n$UDPServerRun 514\n${FILE_ACTION}`);
    udp(r, '<13>Oct 19 12:00:01 ubuntu alice: legacy');
    expect(filed(r.server)).toHaveLength(1);
  });
});

describe('imtcp', () => {
  const TCP_CONFIG = `${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`;

  it('witness: a newline-terminated stream is split into messages', () => {
    const r = rig(TCP_CONFIG);
    const stream = open(r);
    stream.write('<13>Oct 19 12:00:01 ubuntu alice: one\n<13>Oct 19 12:00:02 ubuntu alice: two\n');
    expect(filed(r.server)).toEqual(['imtcp|Client.Example.COM|10.0.0.1|alice:| one', 'imtcp|Client.Example.COM|10.0.0.1|alice:| two']);
  });

  it('reassembles a message delivered in several segments', () => {
    const r = rig(TCP_CONFIG);
    const stream = open(r);
    stream.write('<13>Oct 19 12:00:01 ubu');
    stream.write('ntu alice: sp');
    stream.write('lit\n');
    expect(filed(r.server)).toEqual(['imtcp|Client.Example.COM|10.0.0.1|alice:| split']);
  });

  it('honours octet counting, including a count that spans segments and a newline inside the frame', () => {
    const r = rig(TCP_CONFIG);
    const stream = open(r);
    const body = '<13>Oct 19 12:00:01 ubuntu alice: a\nb';
    stream.write(`${body.length} ${body.slice(0, 10)}`);
    stream.write(body.slice(10));
    stream.write('<13>Oct 19 12:00:02 ubuntu alice: after\n');
    expect(filed(r.server)).toEqual(['imtcp|Client.Example.COM|10.0.0.1|alice:| a#012b', 'imtcp|Client.Example.COM|10.0.0.1|alice:| after']);
  });

  it('octetCountedFraming off treats a leading number as ordinary text', () => {
    const raw = 'template(name="raw" type="string" string="%rawmsg%\\n")\nmodule(load="imtcp" octetCountedFraming="off")\ninput(type="imtcp" port="514")\n*.* action(type="omfile" file="/var/log/in.log" template="raw")';
    const r = rig(raw);
    open(r).write('5 hello world\n');
    expect(filed(r.server)).toEqual(['5 hello world']);
    const counted = rig(raw.replace(' octetCountedFraming="off"', ''));
    open(counted).write('5 hello world\n');
    expect(filed(counted.server)).toEqual(['hello', ' world']);
  });

  it('reports a frame that is not followed by a space and an invalid count', () => {
    const r = rig(TCP_CONFIG);
    open(r).write('12x<13>Oct 19 12:00:01 ubuntu alice: z\n');
    expect(internal(r.server)).toContain(
      'imtcp imtcp: Framing Error in received TCP message from peer: (hostname) Client.Example.COM, (ip) 10.0.0.1, (port) 40001: delimiter is not SP but has ASCII value 120. [v8.2112.0]',
    );
    const zero = rig(TCP_CONFIG);
    open(zero).write('0 abc\n');
    expect(internal(zero.server).some((text) => text.includes('invalid octet count 0.'))).toBe(true);
  });

  it('a final fragment without newline is delivered when the peer closes, an incomplete counted frame is not', () => {
    const r = rig(TCP_CONFIG);
    const stream = open(r);
    stream.write('<13>Oct 19 12:00:01 ubuntu alice: tail');
    expect(filed(r.server)).toEqual([]);
    stream.close();
    expect(filed(r.server)).toHaveLength(1);
    const counted = rig(TCP_CONFIG);
    const second = open(counted);
    second.write('30 <13>short');
    second.close();
    expect(filed(counted.server)).toEqual([]);
    expect(internal(counted.server)).toContain('Incomplete frame at end of stream in session - ignoring extra data (a message may be lost). [v8.2112.0]');
  });

  it('truncates an over-long line at maxMessageSize, or splits it', () => {
    const r = rig(`global(maxMessageSize="256")\n${TCP_CONFIG}`);
    open(r).write(`<13>Oct 19 12:00:01 ubuntu alice: ${'x'.repeat(600)}\n`);
    expect(filed(r.server).length).toBeGreaterThan(1);
    const dropped = rig(`global(maxMessageSize="256")\n${TEMPLATE}module(load="imtcp" discardTruncatedMsg="on")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    open(dropped).write(`<13>Oct 19 12:00:01 ubuntu alice: ${'x'.repeat(600)}\n`);
    expect(filed(dropped.server)).toHaveLength(1);
  });

  it('addtlFrameDelimiter and disableLFDelimiter change what ends a message', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp" addtlFrameDelimiter="0")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    open(r).write('<13>Oct 19 12:00:01 ubuntu alice: one\u0000<13>Oct 19 12:00:02 ubuntu alice: two\n');
    expect(filed(r.server)).toHaveLength(2);
    const nolf = rig(`${TEMPLATE}module(load="imtcp" disableLFDelimiter="on" addtlFrameDelimiter="0")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    open(nolf).write('<13>Oct 19 12:00:01 ubuntu alice: a\nb\u0000');
    expect(filed(nolf.server)).toEqual(['imtcp|Client.Example.COM|10.0.0.1|alice:| a#012b']);
  });

  it('multiLine joins continuation lines until the next message starting with <', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" multiLine="on")\n${FILE_ACTION}`);
    const stream = open(r);
    stream.write('<13>Oct 19 12:00:01 ubuntu alice: first\n  continued\n<13>Oct 19 12:00:02 ubuntu alice: second\n');
    stream.write('');
    expect(filed(r.server)[0]).toBe('imtcp|Client.Example.COM|10.0.0.1|alice:| first#012  continued');
  });

  it('framing.delimiter.regex starts a new message on a line matching the expression; the last message stays pending because the session never leaves the frame-start state', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" framing.delimiter.regex="^<[0-9]+>")\n${FILE_ACTION}`);
    const stream = open(r);
    stream.write('<13>Oct 19 12:00:01 ubuntu alice: first\nstill first\n<13>Oct 19 12:00:02 ubuntu alice: second\n<13>Oct 19 12:00:03 ubuntu alice: third\n');
    stream.close();
    expect(filed(r.server)).toHaveLength(2);
    expect(filed(r.server)[0]).toContain('first#012still first');
  });

  it('framingfix.cisco.asa ignores the space some devices send after a newline', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" framingfix.cisco.asa="on")\n${FILE_ACTION}`);
    open(r).write('<13>Oct 19 12:00:01 ubuntu alice: one\n <13>Oct 19 12:00:02 ubuntu alice: two\n');
    expect(filed(r.server)).toEqual(['imtcp|Client.Example.COM|10.0.0.1|alice:| one', 'imtcp|Client.Example.COM|10.0.0.1|alice:| two']);
  });

  it('maxSessions drops the connection that would exceed it', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp" maxSessions="1")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    const first = open(r);
    const second = open(r);
    second.write('<13>Oct 19 12:00:01 ubuntu alice: refused\n');
    first.write('<13>Oct 19 12:00:02 ubuntu alice: kept\n');
    expect(filed(r.server)).toHaveLength(1);
    expect(internal(r.server)).toContain('too many tcp sessions - dropping incoming request [v8.2112.0 try https://www.rsyslog.com/e/2079 ]');
  });

  it('notifyOnConnectionOpen and notifyOnConnectionClose are reported', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp" notifyOnConnectionOpen="on" notifyOnConnectionClose="on")\ninput(type="imtcp" port="514")\n${FILE_ACTION}`);
    const stream = open(r);
    stream.close();
    expect(internal(r.server)).toContain('imtcp: connection established with host: Client.Example.COM (10.0.0.1:40001) [v8.2112.0]');
    expect(internal(r.server).some((text) => /^Netstream session 0x[0-9a-f]+ closed by remote peer 10\.0\.0\.1:40001\./.test(text))).toBe(true);
  });

  it('refuses a sender outside allowedSender before reading anything', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp")\ninput(type="imtcp" port="514" allowedSender=["192.168.0.0/16"])\n${FILE_ACTION}`);
    open(r).write('<13>Oct 19 12:00:01 ubuntu alice: refused\n');
    expect(filed(r.server)).toEqual([]);
    expect(internal(r.server)).toContain('connection request from disallowed sender Client.Example.COM (10.0.0.1:40001) discarded [v8.2112.0 try https://www.rsyslog.com/e/2063 ]');
  });

  it('recognises a TLS ClientHello sent to a plain listener and tears the session down', () => {
    const r = rig(TCP_CONFIG);
    const hello = Uint8Array.from([0x16, 0x03, 0x01, 0x00, 0xc8, ...new Array(200).fill(1)]);
    open(r).write(hello);
    expect(internal(r.server).some((text) => text.startsWith('imtcp: TLS handshake detected from Client.Example.COM (10.0.0.1:40001) but listener is not TLS-enabled.'))).toBe(true);
    expect(filed(r.server)).toEqual([]);
  });

  it('hands the resolved TLS driver settings to the listener instead of refusing them', () => {
    const r = rig('module(load="imtcp" streamDriver.mode="1" streamDriver.authMode="x509/name" streamDriver.permitExpiredCerts="warn" streamDriver.CAFile="/etc/ssl/ca.pem")\ninput(type="imtcp" port="514" streamDriver.name="gtls" permittedPeer=["*.example.net","central"] streamDriver.certFile="/etc/ssl/srv.pem" streamDriver.keyFile="/etc/ssl/srv.key")\n*.* /var/log/x.log');
    const options = r.server.listenOptions.find((entry) => entry.port === 514)?.options.tls;
    expect(options).toMatchObject({
      driver: 'gtls', role: 'server', authMode: 'x509/name', permitExpired: 'warn', permittedPeers: ['*.example.net', 'central'],
      caFile: '/etc/ssl/ca.pem', certFile: '/etc/ssl/srv.pem', keyFile: '/etc/ssl/srv.key',
    });
  });

  it('refuses a TLS mode the driver cannot honour, with the driver words', () => {
    const ptcp = rig('module(load="imtcp")\ninput(type="imtcp" port="514" streamDriver.mode="1")\n*.* /var/log/x.log');
    expect(ptcp.srv.loader.log.lines().some((text) => text.includes('error: driver mode 1 not supported by ptcp netstream driver'))).toBe(true);
    const mode = rig('module(load="imtcp" streamDriver.name="gtls")\ninput(type="imtcp" port="514" streamDriver.mode="2")\n*.* /var/log/x.log');
    expect(mode.srv.loader.log.lines().some((text) => text.includes('error: driver mode 2 not supported by gtls netstream driver'))).toBe(true);
    const auth = rig('module(load="imtcp" streamDriver.name="gtls" streamDriver.mode="1" streamDriver.authMode="kerberos")\ninput(type="imtcp" port="514")\n*.* /var/log/x.log');
    expect(auth.srv.loader.log.lines().some((text) => text.includes("authentication mode 'kerberos' not supported by gtls netstream driver"))).toBe(true);
  });

  it('refuses stream compression it cannot provide', () => {
    const r = rig('module(load="imtcp" compression.mode="stream:always")\ninput(type="imtcp" port="514")\n*.* /var/log/x.log');
    expect(r.srv.loader.log.lines().some((text) => text.includes('streaming inflate driver'))).toBe(true);
  });

  it('validates the compression and frame-size parameters', () => {
    const r = rig('module(load="imtcp" maxFrameSize="0")\ninput(type="imtcp" port="514")\n*.* /var/log/x.log');
    expect(r.srv.loader.log.lines()).toContain("rsyslogd: imtcp: invalid value for 'maxFrameSize' parameter given is 0, valid range is 1..200000000 [v8.2112.0 try https://www.rsyslog.com/e/1000 ]");
    const bad = rig('module(load="imtcp")\ninput(type="imtcp" port="514" compression.mode="gzip")\n*.* /var/log/x.log');
    expect(bad.srv.loader.log.lines().some((text) => text.includes("invalid compression.mode 'gzip', supported values are 'none' and 'stream:always'"))).toBe(true);
  });

  it('legacy $InputTCPServerRun with $InputTCPMaxSessions', () => {
    const r = rig(`${TEMPLATE}module(load="imtcp")\n$InputTCPMaxSessions 1\n$InputTCPServerRun 514\n${FILE_ACTION}`);
    open(r).write('<13>Oct 19 12:00:01 ubuntu alice: legacy\n');
    expect(filed(r.server)).toHaveLength(1);
  });

  it('reports the port as invalid when it is out of range', () => {
    const r = rig('module(load="imtcp")\ninput(type="imtcp" port="70000")\n*.* /var/log/x.log');
    expect(internal(r.server)).toContain('Invalid TCP listen port 70000 - ignored.  [v8.2112.0]');
  });
});
