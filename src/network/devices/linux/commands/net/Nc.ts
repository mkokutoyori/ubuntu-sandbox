import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress, IPv6Address } from '../../../../core/types';
import { localDeviceOf } from '../../network/HostLookup';
import { makeArgCompleter } from '../completionHelpers';
import { PortNumber } from '../../../../core/ports/PortNumber';
import { strerror, type Errno } from '../../../../core/Errno';
import { connectErrno } from '../../../../tcp/types';
import { retransmitSilentSyn } from '../../../../tcp/SynRetransmission';
import {
  DiffServField, HopLimit, TimeToLive, TtlFloor,
} from '../../../../core/IpHeaderFields';
import { OPENBSD_NETCAT_LISTEN_BACKLOG } from '../../ports/ListenBacklogs';
import type { TcpListenOptions } from '../../../../tcp/TcpStack';
import { reverseNameOf } from '../../network/ReverseName';
import { NetcatExit, parseNetcatArguments, strtonum, type NetcatOptions } from './netcat/NetcatArguments';

const NOT_SET = -1;
const PORT_MAX = 65535;
const UDP_TEST_WRITES = 4;

type Stream = 'stdout' | 'stderr';

interface NcResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
  readonly exitCode: number;
}

class NcOutput {
  private readonly chunks: { stream: Stream; text: string }[] = [];

  write(stream: Stream, text: string): void {
    this.chunks.push({ stream, text });
  }

  finish(exitCode: number): NcResult {
    const of = (stream: Stream) => this.chunks.filter((c) => c.stream === stream).map((c) => c.text).join('\n');
    return {
      stdout: of('stdout'), stderr: of('stderr'),
      combined: this.chunks.map((c) => c.text).join('\n'), exitCode,
    };
  }
}

interface SocketSettings {
  readonly ttl?: TimeToLive | HopLimit;
  readonly diffServ?: DiffServField;
  readonly ttlFloor?: TtlFloor;
}

function socketSettingsOf(opts: NetcatOptions, over6: boolean): SocketSettings {
  let ttl: TimeToLive | HopLimit | undefined;
  if (opts.ttl !== NOT_SET) {
    if (over6) ttl = HopLimit.of(opts.ttl);
    else if (TimeToLive.isValid(opts.ttl)) ttl = TimeToLive.of(opts.ttl);
    else throw new NetcatExit([`nc: set IP TTL: ${strerror('EINVAL')}`]);
  }
  return {
    ...(ttl === undefined ? {} : { ttl }),
    ...(opts.typeOfService === NOT_SET ? {} : { diffServ: DiffServField.of(opts.typeOfService) }),
    ...(opts.minimumTtl === NOT_SET ? {} : { ttlFloor: TtlFloor.of(opts.minimumTtl) }),
  };
}

function strtoport(text: string): number {
  const r = strtonum(text, 1, PORT_MAX);
  if ('value' in r) return r.value;
  throw new NetcatExit([`nc: port number ${r.error}: ${text}`]);
}

function buildPorts(ctx: LinuxCommandContext, opts: NetcatOptions): number[] {
  const proto = opts.udp ? 'udp' : 'tcp';
  const ports: number[] = [];
  for (const text of opts.ports) {
    const service = /^[0-9]+$/.test(text) ? null : ctx.executor.resolveServicePort(text, proto);
    const dash = text.indexOf('-');
    if (service !== null) {
      ports.push(service);
    } else if (/^[0-9]/.test(text) && dash >= 0) {
      let hi = strtoport(text.slice(dash + 1));
      let lo = strtoport(text.slice(0, dash));
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let port = lo; port <= hi; port++) ports.push(port);
    } else {
      ports.push(strtoport(text));
    }
  }
  if (!opts.randomize) return ports;
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j], ports[i]];
  }
  return ports;
}

function getaddrinfo(
  ctx: LinuxCommandContext, host: string, port: number, opts: NetcatOptions,
): IPAddress | IPv6Address {
  const failure = (reason: string) => new NetcatExit([`nc: getaddrinfo for host "${host}" port ${port}: ${reason}`]);
  const v4 = IPAddress.tryParse(host);
  const v6 = v4 ? null : IPv6Address.tryParse(host);
  if (v4 || v6) {
    if ((v4 && opts.family === 'inet6') || (v6 && opts.family === 'inet')) {
      throw failure('Address family for hostname not supported');
    }
    return (v4 ?? v6)!;
  }
  if (opts.numeric) throw failure('Name or service not known');
  const resolved = opts.family === 'inet6'
    ? ctx.net.resolveHostname6Sync(host)
    : ctx.net.resolveHostnameSync(host)
      ?? (opts.family === 'unspec' ? ctx.net.resolveHostname6Sync(host) : null);
  if (!resolved) throw failure('Name or service not known');
  return resolved;
}

function sourcePortOf(ctx: LinuxCommandContext, text: string | null): PortNumber | undefined {
  if (text === null) return undefined;
  const r = strtonum(text, 0, PORT_MAX);
  const value = 'value' in r ? r.value : ctx.executor.resolveServicePort(text);
  if (value === null) throw new NetcatExit(['nc: getaddrinfo: Servname not supported for ai_socktype']);
  if (value === 0) return undefined;
  if (!ctx.executor.portBindPermitted(value)) throw new NetcatExit([`nc: bind failed: ${strerror('EACCES')}`]);
  return PortNumber.of(value);
}

function sourceAddressOf(
  ctx: LinuxCommandContext, text: string | null, target: IPAddress | IPv6Address,
): IPAddress | IPv6Address | undefined {
  if (text === null) return undefined;
  const v6 = target instanceof IPv6Address;
  const v4Literal = IPAddress.tryParse(text);
  const v6Literal = v4Literal ? null : IPv6Address.tryParse(text);
  if ((v4Literal && v6) || (v6Literal && !v6)) throw new NetcatExit(['nc: getaddrinfo: Address family for hostname not supported']);
  const address = v4Literal ?? v6Literal ?? (v6 ? ctx.net.resolveHostname6Sync(text) : ctx.net.resolveHostnameSync(text));
  if (!address) throw new NetcatExit(['nc: getaddrinfo: Name or service not known']);
  const owned = address instanceof IPv6Address
    ? ctx.net.isLocalAddress6(address)
    : address.isLoopback() || ctx.net.isLocalAddress(address);
  if (!owned) throw new NetcatExit([`nc: bind failed: ${strerror('EADDRNOTAVAIL')}`]);
  return address;
}

function peerLabel(host: string, address: string, opts: NetcatOptions): string {
  return opts.numeric || host === address ? host : `${host} (${address})`;
}

function connectionInfo(
  ctx: LinuxCommandContext, host: string, address: string, port: number, proto: 'tcp' | 'udp', opts: NetcatOptions,
): string {
  const service = opts.numeric ? '*' : ctx.executor.resolveServiceName(port, proto) ?? '*';
  return `Connection to ${peerLabel(host, address, opts)} ${port} port [${proto}/${service}] succeeded!`;
}

function connectFailure(
  host: string, address: string, port: number, proto: 'tcp' | 'udp', errno: Errno, opts: NetcatOptions, timedOut = false,
): string {
  const where = opts.numeric || host === address ? host : `${host} (${address})`;
  return timedOut
    ? `nc: connect to ${where} port ${port} (${proto}) timed out: ${strerror('EINPROGRESS')}`
    : `nc: connect to ${where} port ${port} (${proto}) failed: ${strerror(errno)}`;
}

function udpTest(send: () => Errno | null): boolean {
  let answered = false;
  for (let i = 0; i < UDP_TEST_WRITES; i++) answered = send() === null;
  return answered;
}

const UNIX_CONNECT_ERRORS: Readonly<Record<string, Errno>> = {
  ENOENT: 'ENOENT', ECONNREFUSED: 'ECONNREFUSED', EACCES: 'EACCES',
};

export function ncUnixClientPath(args: readonly string[]): string | null {
  try {
    const opts = parseNetcatArguments(args);
    if (opts.family !== 'unix' || opts.listen || opts.zero) return null;
    return opts.host;
  } catch (error) {
    if (error instanceof NetcatExit) return null;
    throw error;
  }
}

function runUnixConnect(ctx: LinuxCommandContext, opts: NetcatOptions, stdin: string, out: NcOutput): number {
  const path = opts.host!;
  let received = '';
  const end = ctx.executor.connectUnixStream(path, { onData: (text) => { received += text; }, onClose: () => undefined });
  if ('errno' in end) {
    out.write('stderr', `nc: ${path}: ${strerror(UNIX_CONNECT_ERRORS[end.errno])}`);
    return 1;
  }
  if (!opts.zero && !opts.detach && stdin !== '') end.write(stdin);
  end.close();
  if (!opts.zero && received !== '') out.write('stdout', received.replace(/\r?\n$/, ''));
  return 0;
}

async function runConnect(ctx: LinuxCommandContext, opts: NetcatOptions, stdin: string, out: NcOutput): Promise<number> {
  const wait = (ms: number): Promise<void> => ctx.net.getScheduler().delay(ms);
  const host = opts.host!;
  const ports = buildPorts(ctx, opts);
  const target = getaddrinfo(ctx, host, ports[0], opts);
  const address = target.toString();
  const sourcePort = sourcePortOf(ctx, opts.sourcePort);
  const sourceIP = sourceAddressOf(ctx, opts.sourceAddress, target);
  if (opts.dccp) return 1;
  const payload = opts.zero || opts.detach ? '' : stdin;
  const proto = opts.udp ? 'udp' : 'tcp';
  const settings = socketSettingsOf(opts, target instanceof IPv6Address);
  let ret = 1;

  for (const port of ports) {
    if (opts.udp) {
      const socket = ctx.net.udpConnect(target, port, {
        localPort: sourcePort?.value, source: sourceIP, processName: 'nc',
        pid: ctx.executor.currentPid(), uid: ctx.executor.userMgr.currentUid,
        ...(settings.ttl === undefined ? {} : { ttl: settings.ttl }),
        ...(settings.diffServ === undefined ? {} : { diffServ: settings.diffServ }),
      });
      if (socket === 'EADDRINUSE' || socket === 'EADDRNOTAVAIL' || socket === 'EACCES') throw new NetcatExit([`nc: bind failed: ${strerror(socket)}`]);
      if (typeof socket === 'string') {
        if (opts.verbose) out.write('stderr', connectFailure(host, address, port, proto, socket, opts));
        continue;
      }
      ret = 0;
      const exchanges = opts.zero;
      if (exchanges && !udpTest(() => socket.send(new Uint8Array([0x58])))) {
        ret = 1;
        socket.close();
        continue;
      }
      if (exchanges) out.write('stderr', connectionInfo(ctx, host, address, port, proto, opts));
      if (payload !== '') socket.send(new TextEncoder().encode(payload));
      socket.close();
      continue;
    }

    if (!ctx.executor.hasFreeEphemeralPort() && sourcePort === undefined) {
      if (opts.verbose) out.write('stderr', connectFailure(host, address, port, proto, 'EADDRNOTAVAIL', opts));
      continue;
    }
    const exchange = await retransmitSilentSyn(
      () => ctx.net.tcpExchange(target, port, payload, {
        sourcePort, sourceIP, ...settings, ...(opts.shutdownWrite ? { shutdownWrite: true } : {}),
      }),
      (attempt) => attempt.outcome === 'timeout', wait, opts.timeoutMs > 0 ? opts.timeoutMs : undefined);
    if (exchange.outcome !== 'open') {
      if (opts.verbose) {
        out.write('stderr', connectFailure(host, address, port, proto, connectErrno(exchange.outcome), opts,
          exchange.outcome === 'timeout' && opts.timeoutMs > 0));
      }
      continue;
    }
    ret = 0;
    if (opts.verbose || opts.zero) out.write('stderr', connectionInfo(ctx, host, address, port, proto, opts));
    if (!opts.zero && opts.intervalSeconds > 0) await wait(opts.intervalSeconds * 1000);
    if (!opts.zero && exchange.received !== '') out.write('stdout', exchange.received.replace(/\r?\n$/, ''));
  }
  return ret;
}

function listenServicePort(text: string, proto: 'tcp' | 'udp', ctx: LinuxCommandContext): number {
  const r = strtonum(text, 0, PORT_MAX);
  if ('value' in r) return r.value;
  const service = /^[0-9]+$/.test(text) ? null : ctx.executor.resolveServicePort(text, proto);
  if (service === null) throw new NetcatExit(['nc: getaddrinfo: Servname not supported for ai_socktype']);
  return service;
}

function listenAddressOf(ctx: LinuxCommandContext, opts: NetcatOptions): string {
  const wildcard = opts.family === 'inet6' ? '::' : '0.0.0.0';
  if (opts.host === null) return wildcard;
  const failure = (reason: string) => new NetcatExit([`nc: getaddrinfo: ${reason}`]);
  const v4 = IPAddress.tryParse(opts.host);
  const v6 = v4 ? null : IPv6Address.tryParse(opts.host);
  if ((v4 && opts.family === 'inet6') || (v6 && opts.family === 'inet')) throw failure('Address family for hostname not supported');
  if (v4 || v6) return (v4 ?? v6)!.toString();
  if (opts.numeric) throw failure('Name or service not known');
  const resolved = opts.family === 'inet6' ? ctx.net.resolveHostname6Sync(opts.host) : ctx.net.resolveHostnameSync(opts.host);
  if (!resolved) throw failure('Name or service not known');
  return resolved.toString();
}

function localAddressOwned(ctx: LinuxCommandContext, address: string): boolean {
  if (address === '0.0.0.0' || address === '::') return true;
  const v6 = IPv6Address.tryParse(address);
  if (v6) return ctx.net.isLocalAddress6(v6);
  const v4 = IPAddress.tryParse(address);
  return v4 !== null && (v4.isLoopback() || ctx.net.isLocalAddress(v4));
}

function reportSock(ctx: LinuxCommandContext, message: string, address: string, port: number, opts: NetcatOptions): string {
  const name = opts.numeric ? address : reverseNameOf(ctx.executor.nss, address) ?? address;
  return `${message} on ${name} ${port}`;
}

function runListen(ctx: LinuxCommandContext, opts: NetcatOptions, out: NcOutput, stdin: string): number {
  const proto = opts.udp ? 'udp' : 'tcp';
  const address = listenAddressOf(ctx, opts);
  const port = listenServicePort(opts.ports[0], proto, ctx);
  const ownerUid = ctx.executor.userMgr.currentUid;
  if (!localAddressOwned(ctx, address)) throw new NetcatExit([`nc: ${strerror('EADDRNOTAVAIL')}`]);
  if (opts.udp) {
    const pid = ctx.executor.currentPid();
    let announced = false;
    const failure = ctx.net.udpListen(port, 'nc', { pid, uid: ownerUid },
      (payload, from) => {
        if (opts.verbose && !announced) ctx.executor.emitLateStderr(pid, `${reportSock(ctx, 'Connection received', from.address, from.port, opts)}\n`);
        announced = !opts.keep;
        ctx.executor.emitLateStdout(pid, new TextDecoder().decode(payload));
      }, address);
    if (failure !== null) throw new NetcatExit([`nc: ${strerror(failure)}`]);
    if (opts.verbose) announceListening(ctx, out, reportSock(ctx, 'Bound', address, port, opts));
    return 0;
  }
  const table = ctx.executor.getSocketTable();
  if (!table) throw new NetcatExit(['nc: no socket table available']);
  try {
    table.bind('tcp', address, port, ctx.executor.currentPid(), 'nc', undefined, { ownerUid });
  } catch (error) {
    const denied = error instanceof Error && error.message.startsWith('EACCES');
    throw new NetcatExit([`nc: ${strerror(denied ? 'EACCES' : 'EADDRINUSE')}`]);
  }
  const listenerPid = ctx.executor.currentPid();
  const announce = (peer: string, peerPort: number): void => {
    if (opts.verbose) ctx.executor.emitLateStderr(listenerPid, `${reportSock(ctx, 'Connection received', peer, peerPort, opts)}\n`);
  };
  if (!openTcpListener(ctx, port, address, ownerUid, socketSettingsOf(opts, address.includes(':')), opts.keep, stdin, announce)) {
    table.unbind('tcp', address, port);
    throw new NetcatExit([`nc: ${strerror('EADDRINUSE')}`]);
  }
  if (opts.verbose) announceListening(ctx, out, reportSock(ctx, 'Listening', address, port, opts));
  return 0;
}

function announceListening(ctx: LinuxCommandContext, out: NcOutput, line: string): void {
  const pid = ctx.executor.currentPid();
  if (ctx.executor.isBackgroundJob(pid)) ctx.executor.emitLateStderr(pid, `${line}\n`);
  else out.write('stderr', line);
}

function openTcpListener(
  ctx: LinuxCommandContext, port: number, address: string, ownerUid: number, settings: SocketSettings, keep: boolean, greeting: string,
  announce: (peer: string, peerPort: number) => void,
): boolean {
  const device = localDeviceOf(ctx) as unknown as {
    getTcpStack?: () => { listen(localPort: number, opts: TcpListenOptions, localIp?: string): unknown };
  } | null;
  const stack = device?.getTcpStack?.();
  if (!stack) return true;
  try {
    const pid = ctx.executor.currentPid();
    stack.listen(port, {
      onAccept: (socket) => {
        announce(socket.remoteIp, socket.remotePort);
        socket.onData((chunk) => {
          if (typeof chunk === 'string') ctx.executor.emitLateStdout(pid, chunk);
          else if (chunk instanceof Uint8Array) ctx.executor.emitLateStdout(pid, new TextDecoder().decode(chunk));
        });
        socket.onEnd(() => {
          if (keep) socket.close();
          else ctx.executor.processMgr.exit(pid, 0);
        });
        if (greeting !== '') socket.write(greeting);
      },
      ownerUid, backlog: OPENBSD_NETCAT_LISTEN_BACKLOG, ...settings,
    }, address);
    return true;
  } catch {
    return false;
  }
}

async function runNc(ctx: LinuxCommandContext, args: string[], stdin = ''): Promise<NcResult> {
  const out = new NcOutput();
  try {
    const opts = parseNetcatArguments(args);
    if (opts.family === 'unix' && opts.listen) throw new NetcatExit(['nc: option -l: this simulator cannot build UNIX-domain listening sockets']);
    if (opts.family === 'unix' && opts.udp) throw new NetcatExit(['nc: option -u: this simulator cannot build UNIX-domain datagram sockets']);
    if (opts.proxyHost !== null) throw new NetcatExit(['nc: option -x: this simulator cannot build proxy connections']);
    const code = opts.family === 'unix' ? runUnixConnect(ctx, opts, stdin, out)
      : opts.listen ? runListen(ctx, opts, out, stdin) : await runConnect(ctx, opts, stdin, out);
    return out.finish(code);
  } catch (error) {
    if (!(error instanceof NetcatExit)) throw error;
    for (const line of error.lines) out.write('stderr', line);
    return out.finish(error.exitCode);
  }
}

export const ncCommand: LinuxCommand = {
  name: 'nc',
  package: 'netcat-openbsd',
  aliases: ['ncat'],
  needsNetworkContext: true,
  opensWireSession: true,
  ownsHelpOption: true,
  readsStdin: true,
  complete: makeArgCompleter({
    flags: ['-4', '-6', '-d', '-h', '-i', '-k', '-l', '-M', '-m', '-N', '-n', '-p', '-q', '-r', '-s', '-T', '-U', '-u', '-v', '-W', '-w', '-z'],
    hostsAtBarePosition: true,
  }),
  manSection: 1,
  usage: 'nc [-46DdhklNnrtuvz] [-i interval] [-p source_port] [-s sourceaddr] [-W recvlimit] [-w timeout] [destination] [port]',
  help: 'Arbitrary TCP and UDP connections and listens.',
  options: [
    { flag: '-z', description: 'Zero-I/O mode [used for scanning]' },
    { flag: '-v', description: 'Verbose' },
    { flag: '-u', description: 'UDP mode' },
    { flag: '-n', description: 'Suppress name/port resolutions' },
    { flag: '-p', description: 'Specify local port for remote connects', takesArg: true, argName: 'port' },
    { flag: '-s', description: 'Local source address', takesArg: true, argName: 'sourceaddr' },
    { flag: '-w', description: 'Timeout for connects and final net reads', takesArg: true, argName: 'timeout' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return (await runNc(ctx, args, stdin)).combined;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    const result = await runNc(ctx, args, stdin);
    return { output: result.stdout, exitCode: result.exitCode, stderr: result.stderr };
  },
};
