/**
 * Probe — src/network/rsyslog/modules/Omfwd.ts, ported from rsyslog tools/omfwd.c
 * (8.2610 source tree) and runtime/tcpclt.c, driven by two simulated machines
 * on a shared LabNetwork.
 *
 * Measured against the base commit: the module does not exist there, so every
 * case fails at import. Cases that would pass on any implementation that
 * forwards at all (and are therefore witnesses, not discriminators) are named
 * "witness:". Every time-dependent case (suspend / resume, pool resume interval,
 * rate-limit window, rebind interval) advances the machine's simulated clock
 * with LabHost.advance(); none reads the host's real clock.
 */
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const SERVER_CONFIG = `
module(load="imudp")
module(load="imtcp")
input(type="imudp" port="514")
input(type="imtcp" port="514")
template(name="onlyMsg" type="string" string="%msg%\\n")
*.* action(type="omfile" file="/var/log/remote.log" template="onlyMsg")
`;

const HELLO = '<13>Oct 19 12:00:01 ubuntu alice: hello world';

function lab(clientConfig: string, serverConfig = SERVER_CONFIG): { net: LabNetwork; client: LabHost; server: LabHost; cli: LabEngine; srv: LabEngine } {
  const net = new LabNetwork();
  const client = new LabHost('10.0.0.1', net);
  const server = new LabHost('10.0.0.2', net);
  const srv = startRsyslog(server, serverConfig);
  const cli = startRsyslog(client, clientConfig);
  return { net, client, server, cli, srv };
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const internal = (host: LabHost): string[] => host.libcSyslog.map((entry) => entry.message);

describe('omfwd over UDP', () => {
  it('witness: delivers one datagram in the traditional forward format and the peer files it', () => {
    const { client, server, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="udp")');
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams.map((datagram) => decode(datagram.payload))).toEqual(['<13>Oct 19 12:00:01 ubuntu alice: hello world']);
    expect(lines(server.fileSystem.get('/var/log/remote.log') ?? null)).toEqual([' hello world']);
  });

  it('legacy @host:port;template syntax selects the template and the port', () => {
    const { client, cli } = lab('*.* @10.0.0.2:5140;RSYSLOG_SyslogProtocol23Format');
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams[0].port).toBe(5140);
    expect(decode(client.sentDatagrams[0].payload)).toBe('<13>1 2026-10-19T12:00:01+00:00 ubuntu alice - - -  hello world\n');
  });

  it('truncates a message above the UDP limit to 65507 bytes and says so', () => {
    const { client, cli } = lab('global(maxMessageSize="100k")\ntemplate(name="big" type="string" string="%rawmsg%")\n*.* action(type="omfwd" target="10.0.0.2" template="big")');
    const raw = `<13>Oct 19 12:00:01 ubuntu alice: ${'x'.repeat(70000)}`;
    submitLocal(cli, raw);
    expect(client.sentDatagrams.map((datagram) => datagram.payload.length)).toEqual([65507]);
    expect(internal(client)).toContain(
      `omfwd/udp: message is ${raw.length} bytes long, but UDP can send at most 65507 bytes (by RFC limit) - truncating message [v8.2112.0 try https://www.rsyslog.com/e/2440 ]`,
    );
  });

  it('udp.sendToAll sends to every resolved address, the default stops at the first', () => {
    const { net, client, cli } = lab('*.* action(type="omfwd" target="dual" port="514" protocol="udp" udp.sendToAll="on")');
    net.names.set('dual', ['10.0.0.2', '10.0.0.3']);
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams.map((datagram) => datagram.address)).toEqual(['10.0.0.2', '10.0.0.3']);
    const single = lab('*.* action(type="omfwd" target="dual" port="514" protocol="udp")');
    single.net.names.set('dual', ['10.0.0.2', '10.0.0.3']);
    submitLocal(single.cli, HELLO);
    expect(single.client.sentDatagrams.map((datagram) => datagram.address)).toEqual(['10.0.0.2']);
  });

  it('a name that does not resolve suspends the action; the next message after the resume interval goes out', () => {
    const { net, client, cli } = lab('*.* action(type="omfwd" target="late.example" port="514" protocol="udp")');
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams).toHaveLength(0);
    expect(internal(client)[0]).toBe(
      "omfwd: could not get addrinfo for hostname 'late.example':'514': Name or service not known [v8.2112.0 try https://www.rsyslog.com/e/2007 ]",
    );
    net.names.set('late.example', ['10.0.0.2']);
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams).toHaveLength(0);
    client.advance(31_000);
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams).toHaveLength(1);
    expect(internal(client).some((text) => text.startsWith("action 'action-0-builtin:omfwd' resumed"))).toBe(true);
  });

  it('a send error closes the socket, reports errno and suspends', () => {
    const { client, cli } = lab('*.* action(type="omfwd" target="10.0.0.9" port="514" protocol="udp")');
    client.datagramFailures.set('10.0.0.9', 'ENETUNREACH');
    submitLocal(cli, HELLO);
    const messages = internal(client);
    expect(messages).toContain('omfwd/udp: socket 4: sendto() error: Network is unreachable [v8.2112.0 try https://www.rsyslog.com/e/2354 ]');
    expect(messages).toContain('omfwd: socket 4: error 101 sending via udp: Network is unreachable [v8.2112.0 try https://www.rsyslog.com/e/2354 ]');
  });

  it('rebindInterval re-creates the socket every N transmissions', () => {
    const { client, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="udp" rebindInterval="2")');
    for (let count = 0; count < 5; count++) submitLocal(cli, HELLO);
    expect(client.sentDatagrams).toHaveLength(5);
  });

  it('ratelimit drops past the burst inside the window and recovers when the simulated clock moves on', () => {
    const { client, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="udp" ratelimit.interval="5" ratelimit.burst="3")');
    for (let count = 0; count < 6; count++) submitLocal(cli, HELLO);
    expect(client.sentDatagrams).toHaveLength(3);
    client.advance(6_000);
    submitLocal(cli, HELLO);
    expect(client.sentDatagrams).toHaveLength(4);
    expect(internal(client).some((text) => text.includes('messages lost due to rate-limiting'))).toBe(true);
  });
});

describe('omfwd over TCP', () => {
  it('witness: connects, frames with LF and the peer files the message', () => {
    const { server, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="tcp")');
    submitLocal(cli, HELLO);
    expect(server.tcpAccepted[0].receivedText()).toBe(`${HELLO}\n`);
    expect(lines(server.fileSystem.get('/var/log/remote.log') ?? null)).toEqual([' hello world']);
  });

  it('does not double the delimiter when the message already ends with it', () => {
    const { server, cli } = lab('template(name="nl" type="string" string="%msg%\\n")\n*.* action(type="omfwd" target="10.0.0.2" protocol="tcp" template="nl")');
    submitLocal(cli, HELLO);
    expect(server.tcpAccepted[0].receivedText()).toBe(' hello world\n');
  });

  it('tcp_framedelimiter changes the terminator byte', () => {
    const { server, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" protocol="tcp" tcp_framedelimiter="0")');
    submitLocal(cli, HELLO);
    expect(server.tcpAccepted[0].receivedText()).toBe(`${HELLO}\u0000`);
  });

  it('octet-counted framing prefixes the byte count, both syntaxes', () => {
    const modern = lab('*.* action(type="omfwd" target="10.0.0.2" protocol="tcp" tcp_framing="octet-counted")');
    submitLocal(modern.cli, HELLO);
    expect(modern.server.tcpAccepted[0].receivedText()).toBe(`${HELLO.length} ${HELLO}`);
    const legacy = lab('*.* @@(o)10.0.0.2:514');
    submitLocal(legacy.cli, HELLO);
    expect(legacy.server.tcpAccepted[0].receivedText()).toBe(`${HELLO.length} ${HELLO}`);
  });

  it('single-message compression sends a z-prefixed zlib stream, forced into octet counting, and the peer inflates it', () => {
    const long = `<13>Oct 19 12:00:01 ubuntu alice: ${'abcdefgh '.repeat(40)}`;
    const { server, cli } = lab('*.* @@(z5)10.0.0.2:514');
    submitLocal(cli, long);
    const wire = server.tcpAccepted[0].received[0];
    const header = /^(\d+) /.exec(decode(wire.subarray(0, 8)));
    expect(header).not.toBeNull();
    const body = wire.subarray((header as RegExpExecArray)[0].length);
    expect(body[0]).toBe(0x7a);
    expect(body.length).toBe(Number((header as RegExpExecArray)[1]));
    expect(decode(inflateSync(Buffer.from(body.subarray(1))))).toBe(long);
    expect(lines(server.fileSystem.get('/var/log/remote.log') ?? null)[0]).toBe(` ${'abcdefgh '.repeat(40)}`);
  });

  it('refuses a connection error, suspends, reports the connect failure and resumes after the interval', () => {
    const { net, client, server, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" port="601" protocol="tcp")');
    submitLocal(cli, HELLO);
    expect(internal(client)).toContain('cannot connect to 10.0.0.2:601 (took 0.00 seconds): Connection refused [v8.2112.0 try https://www.rsyslog.com/e/2027 ]');
    const listener = startRsyslog(server, `${SERVER_CONFIG.replace('port="514" ruleset', 'port="514" ruleset')}\ninput(type="imtcp" port="601")`);
    expect(net.hosts.size).toBe(2);
    submitLocal(cli, HELLO);
    expect(server.tcpAccepted).toHaveLength(0);
    client.advance(31_000);
    submitLocal(cli, HELLO);
    expect(server.tcpAccepted.map((connection) => connection.receivedText())).toEqual([`${HELLO}\n`]);
    listener.engine.stop();
  });

  it('detects a peer that closed the connection and reconnects at once because no target is left active', () => {
    const { server, cli, client } = lab('*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="tcp")');
    submitLocal(cli, HELLO);
    server.tcpAccepted[0].close();
    submitLocal(cli, '<13>Oct 19 12:00:02 ubuntu alice: second');
    expect(internal(client)).toContain('ptcp network driver: CheckConnection detected that peer closed connection. [v8.2112.0 try https://www.rsyslog.com/e/2027 ]');
    expect(internal(client).some((text) => text.includes('remote server closed connection.'))).toBe(true);
    expect(server.tcpAccepted.map((connection) => connection.receivedText())).toEqual([`${HELLO}\n`, '<13>Oct 19 12:00:02 ubuntu alice: second\n']);
  });

  it('resendLastMsgOnReconnect repeats the previous frame on the new connection; the failed message itself is delivered twice, as omfwd does because tcpclt reconnects without marking the target connected', () => {
    const { server, cli } = lab('*.* action(type="omfwd" target="10.0.0.2" port="514" protocol="tcp" resendLastMsgOnReconnect="on" extendedConnectionCheck="off")');
    submitLocal(cli, '<13>Oct 19 12:00:01 ubuntu alice: first');
    server.tcpAccepted[0].close();
    submitLocal(cli, '<13>Oct 19 12:00:02 ubuntu alice: second');
    const second = server.tcpAccepted[1].receivedText();
    expect(second).toBe('<13>Oct 19 12:00:01 ubuntu alice: first\n<13>Oct 19 12:00:02 ubuntu alice: second\n<13>Oct 19 12:00:02 ubuntu alice: second\n');
  });

  it('a pool of two targets alternates and survives the loss of one', () => {
    const net = new LabNetwork();
    const client = new LabHost('10.0.0.1', net);
    const one = new LabHost('10.0.0.2', net);
    const two = new LabHost('10.0.0.3', net);
    startRsyslog(one, SERVER_CONFIG);
    startRsyslog(two, SERVER_CONFIG);
    const cli = startRsyslog(client, '*.* action(type="omfwd" target=["10.0.0.2","10.0.0.3"] port="514" protocol="tcp")');
    for (let count = 0; count < 4; count++) submitLocal(cli, `<13>Oct 19 12:00:0${count} ubuntu alice: m${count}`);
    expect(lines(one.fileSystem.get('/var/log/remote.log') ?? null)).toEqual([' m0', ' m2']);
    expect(lines(two.fileSystem.get('/var/log/remote.log') ?? null)).toEqual([' m1', ' m3']);
  });

  it('targetSrv orders SRV records by priority and builds the target pool', () => {
    const net = new LabNetwork();
    const client = new LabHost('10.0.0.1', net);
    net.srv.set('_syslog._tcp.logs.example', [
      { host: 'b.example.', port: 515, priority: 20, weight: 0 },
      { host: 'a.example.', port: 514, priority: 10, weight: 5 },
    ]);
    net.names.set('a.example', ['10.0.0.2']);
    net.names.set('b.example', ['10.0.0.3']);
    const a = new LabHost('10.0.0.2', net);
    const b = new LabHost('10.0.0.3', net);
    startRsyslog(a, SERVER_CONFIG);
    startRsyslog(b, `${SERVER_CONFIG}\ninput(type="imtcp" port="515")`);
    const cli = startRsyslog(client, '*.* action(type="omfwd" targetSrv="logs.example" protocol="tcp")');
    expect(cli.loader.log.lines()).toEqual([]);
    submitLocal(cli, HELLO);
    submitLocal(cli, HELLO);
    expect(a.tcpAccepted).toHaveLength(1);
    expect(b.tcpAccepted).toHaveLength(1);
  });
});

describe('omfwd configuration diagnostics', () => {
  const diagnostics = (config: string): string[] => lab(config).cli.loader.log.lines();

  it('rejects an unknown protocol', () => {
    expect(diagnostics('*.* action(type="omfwd" target="x" protocol="sctp")')).toContain(
      'rsyslogd: omfwd: invalid protocol "sctp" [v8.2112.0 try https://www.rsyslog.com/e/2213 ]',
    );
  });

  it('rejects an unknown framing', () => {
    expect(diagnostics('*.* action(type="omfwd" target="x" protocol="tcp" tcp_framing="chunked")')).toContain(
      'rsyslogd: omfwd: invalid framing "chunked" [v8.2112.0 try https://www.rsyslog.com/e/2214 ]',
    );
  });

  it('requires exactly one of target and targetSrv', () => {
    expect(diagnostics('*.* action(type="omfwd" protocol="tcp")')[0]).toContain('omfwd: either target or targetSrv must be specified');
    expect(diagnostics('*.* action(type="omfwd" target="x" targetSrv="y")')[0]).toContain('omfwd: target and targetSrv are mutually exclusive');
  });

  it('refuses TLS and stream compression it cannot provide instead of storing them', () => {
    expect(diagnostics('*.* action(type="omfwd" target="x" protocol="tcp" streamdriver="gtls" streamdriver.mode="1")')[0]).toContain('requires a TLS network stream driver');
    expect(diagnostics('*.* action(type="omfwd" target="x" protocol="tcp" compression.mode="stream:always")')[0]).toContain('requires a streaming deflate driver');
  });

  it('honours compatibility.defaults.secure="strict" for a TLS-capable driver left at mode 0', () => {
    const messages = diagnostics('global(compatibility.defaults.secure="strict")\n*.* action(type="omfwd" target="x" protocol="tcp" streamdriver="gtls" streamdriver.mode="0")');
    expect(messages[0]).toContain('compatibility.defaults.secure="strict" rejects explicit streamdriver.mode="0" with TLS-capable stream driver "gtls"');
  });

  it('warns about the insecure default only in warn mode', () => {
    const quiet = diagnostics('*.* action(type="omfwd" target="x")');
    expect(quiet).toEqual([]);
    const warn = diagnostics('global(compatibility.defaults.secure="warn")\n*.* action(type="omfwd" target="x")');
    expect(warn[0]).toContain('backward-compatible insecure default in use: omfwd action uses protocol="udp" (without TLS)');
  });

  it('warns when ports and targets disagree in number', () => {
    const messages = diagnostics('*.* action(type="omfwd" target=["a","b"] port=["1","2","3"] protocol="tcp")');
    expect(messages.some((text) => text.includes('defined 3 ports, but only 2 targets - ignoring extra ports'))).toBe(true);
  });
});
