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
  DSCP_CODEPOINTS, DiffServField, HopLimit, TimeToLive, TtlFloor,
} from '../../../../core/IpHeaderFields';
import { getoptDiagnostic, shortOptions } from '../Getopt';

const OPTSTRING = '46C:cDde:FH:hI:i:K:klM:m:NnO:o:P:p:q:R:rSs:T:tUuV:vW:w:X:x:Z:z';
const INT_MAX = 2147483647;
const UINT_MAX = 4294967295;
const PORT_MAX = 65535;
const UDP_TEST_WRITES = 4;

const USAGE = [
  'usage: nc [-46cDdFhklNnrStUuvz] [-C certfile] [-e name] [-H hash] [-I length]',
  '\t  [-i interval] [-K keyfile] [-M ttl] [-m minttl] [-O length]',
  '\t  [-o staplefile] [-P proxy_username] [-p source_port] [-R CAfile]',
  '\t  [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit] [-w timeout]',
  '\t  [-X proxy_protocol] [-x proxy_address[:port]] [-Z peercertfile]',
  '\t  [destination] [port]',
].join('\n');

const HELP = [
  USAGE,
  '\tCommand Summary:',
  ...[
    ['-4', '\tUse IPv4'], ['-6', '\tUse IPv6'], ['-C certfile', 'Public key file'], ['-c', '\tUse TLS'],
    ['-D', '\tEnable the debug socket option'], ['-d', '\tDetach from stdin'],
    ['-e name', '\tRequired name in peer certificate'], ['-F', '\tPass socket fd'],
    ['-H hash', '\tHash string of peer certificate'], ['-h', '\tThis help text'],
    ['-I length', 'TCP receive buffer length'], ['-i interval', 'Delay interval for lines sent, ports scanned'],
    ['-K keyfile', 'Private key file'], ['-k', '\tKeep inbound sockets open for multiple connects'],
    ['-l', '\tListen mode, for inbound connects'], ['-M ttl', '\tOutgoing TTL / Hop Limit'],
    ['-m minttl', 'Minimum incoming TTL / Hop Limit'], ['-N', '\tShutdown the network socket after EOF on stdin'],
    ['-n', '\tSuppress name/port resolutions'], ['-O length', 'TCP send buffer length'],
    ['-o staplefile', 'Staple file'], ['-P proxyuser', 'Username for proxy authentication'],
    ['-p port', '\tSpecify local port for remote connects'], ['-R CAfile', 'CA bundle'],
    ['-r', '\tRandomize remote ports'], ['-S', '\tEnable the TCP MD5 signature option'],
    ['-s sourceaddr', 'Local source address'], ['-T keyword', 'TOS value or TLS options'],
    ['-t', '\tAnswer TELNET negotiation'], ['-U', '\tUse UNIX domain socket'], ['-u', '\tUDP mode'],
    ['-V rtable', 'Specify alternate routing table'], ['-v', '\tVerbose'],
    ['-W recvlimit', 'Terminate after receiving a number of packets'],
    ['-w timeout', 'Timeout for connects and final net reads'],
    ['-X proto', 'Proxy protocol: "4", "4A", "5" (SOCKS) or "connect"'],
    ['-x addr[:port]', 'Specify proxy address and port'], ['-Z', '\tPeer certificate file'],
    ['-z', '\tZero-I/O mode [used for scanning]'],
  ].map(([flag, text]) => `\t\t${flag}\t${text}`),
  '\tPort numbers can be individual or ranges: lo-hi [inclusive]',
].join('\n');

const UNBUILDABLE: Readonly<Record<string, string>> = {
  C: 'TLS (libtls)', c: 'TLS (libtls)', e: 'TLS (libtls)', H: 'TLS (libtls)', K: 'TLS (libtls)',
  o: 'TLS (libtls)', R: 'TLS (libtls)', Z: 'TLS (libtls)',
  F: 'file-descriptor passing', I: 'a TCP receive buffer size', O: 'a TCP send buffer size',
  S: 'the TCP MD5 signature option',
  U: 'UNIX-domain sockets', V: 'alternate routing tables',
  P: 'proxy connections', x: 'proxy connections',
};

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

interface NcOptions {
  family: 4 | 6 | null;
  numeric: boolean;
  verbose: boolean;
  zero: boolean;
  udp: boolean;
  listen: boolean;
  keep: boolean;
  detachStdin: boolean;
  randomize: boolean;
  sourcePort?: string;
  sourceAddress?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  ttl?: number;
  minimumTtl?: number;
  typeOfService?: number;
  shutdownWrite: boolean;
  operands: string[];
}

class NcExit extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join('\n'));
  }
}

function strtonum(text: string, min: number, max: number): { value: number } | { error: 'invalid' | 'too small' | 'too large' } {
  if (!/^\s*[+-]?\d+$/.test(text)) return { error: 'invalid' };
  const value = Number(text.trim());
  if (value < min) return { error: 'too small' };
  if (value > max) return { error: 'too large' };
  return { value };
}

function checkedNumber(text: string, min: number, max: number, label: string): number {
  const r = strtonum(text, min, max);
  if ('error' in r) throw new NcExit([`nc: ${label} ${r.error}: ${text}`]);
  return r.value;
}

function namedNumber(text: string, min: number, max: number, label: string): number {
  const r = strtonum(text, min, max);
  if ('error' in r) throw new NcExit([`nc: ${label} is ${r.error}`]);
  return r.value;
}

const TLS_KEYWORDS: ReadonlySet<string> = new Set([
  'alpn', 'ciphers', 'clientcert', 'muststaple', 'noname', 'noverify', 'protocols',
]);

const TYPE_OF_SERVICE_KEYWORDS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    Object.entries(DSCP_CODEPOINTS)
      .filter(([name]) => name !== 'default')
      .map(([name, dscp]) => [name, dscp << DiffServField.DSCP_SHIFT])),
  va: 0xb0,
  critical: 0xa0, inetcontrol: 0xc0, netcontrol: 0xe0,
  lowdelay: 0x10, reliability: 0x04, throughput: 0x08,
};

function typeOfServiceOf(text: string): number {
  if (TLS_KEYWORDS.has(text.split('=')[0])) {
    throw new NcExit([`nc: option -T: this simulator cannot build ${UNBUILDABLE.C}`]);
  }
  if (Object.prototype.hasOwnProperty.call(TYPE_OF_SERVICE_KEYWORDS, text)) return TYPE_OF_SERVICE_KEYWORDS[text];
  const parsed = text.length > 1 && text.startsWith('0x')
    ? { value: parseInt(/^[0-9a-fA-F]*/.exec(text.slice(2))![0] || '0', 16) }
    : strtonum(text, 0, 255);
  if ('error' in parsed || parsed.value > 255) throw new NcExit([`nc: illegal tos/tls value ${text}`]);
  return parsed.value;
}

interface SocketSettings {
  readonly ttl?: TimeToLive | HopLimit;
  readonly diffServ?: DiffServField;
  readonly ttlFloor?: TtlFloor;
}

function socketSettingsOf(opts: NcOptions, over6: boolean): SocketSettings {
  let ttl: TimeToLive | HopLimit | undefined;
  if (opts.ttl !== undefined) {
    if (over6) ttl = HopLimit.of(opts.ttl);
    else if (TimeToLive.isValid(opts.ttl)) ttl = TimeToLive.of(opts.ttl);
    else throw new NcExit([`nc: set IP TTL: ${strerror('EINVAL')}`]);
  }
  return {
    ...(ttl === undefined ? {} : { ttl }),
    ...(opts.typeOfService === undefined ? {} : { diffServ: DiffServField.of(opts.typeOfService) }),
    ...(opts.minimumTtl === undefined ? {} : { ttlFloor: TtlFloor.of(opts.minimumTtl) }),
  };
}

function usageExit(before: string[] = []): NcExit {
  return new NcExit([...before, USAGE]);
}

function parseNcArgs(args: readonly string[]): NcOptions {
  const opts: NcOptions = {
    family: null, numeric: false, verbose: false, zero: false, udp: false, listen: false,
    keep: false, detachStdin: false, randomize: false, shutdownWrite: false, operands: [],
  };
  for (const token of shortOptions(args, OPTSTRING)) {
    if (token.kind === 'operand') { opts.operands.push(token.value); continue; }
    if (token.kind !== 'option') throw usageExit([getoptDiagnostic('nc', token)]);
    const { letter, argument } = token;
    switch (letter) {
      case '4': opts.family = 4; break;
      case '6': opts.family = 6; break;
      case 'D': case 't': break;
      case 'N': opts.shutdownWrite = true; break;
      case 'd': opts.detachStdin = true; break;
      case 'h': throw new NcExit([HELP]);
      case 'i': opts.intervalSeconds = checkedNumber(argument!, 0, UINT_MAX, 'interval'); break;
      case 'k': opts.keep = true; break;
      case 'l': opts.listen = true; break;
      case 'M': opts.ttl = namedNumber(argument!, 0, 255, 'ttl'); break;
      case 'm': opts.minimumTtl = namedNumber(argument!, 0, 255, 'minttl'); break;
      case 'T': opts.typeOfService = typeOfServiceOf(argument!); break;
      case 'n': opts.numeric = true; break;
      case 'p': opts.sourcePort = argument; break;
      case 'q': break;
      case 'r': opts.randomize = true; break;
      case 's': opts.sourceAddress = argument; break;
      case 'u': opts.udp = true; break;
      case 'v': opts.verbose = true; break;
      case 'W': checkedNumber(argument!, 1, INT_MAX, 'receive limit'); break;
      case 'w': opts.timeoutMs = checkedNumber(argument!, 0, Math.floor(INT_MAX / 1000), 'timeout') * 1000; break;
      case 'X':
        if (!['connect', '4', '4a', '5'].includes(argument!.toLowerCase())) {
          throw new NcExit(['nc: unsupported proxy protocol']);
        }
        throw new NcExit([`nc: option -X: this simulator cannot build ${UNBUILDABLE.x}`]);
      case 'z': opts.zero = true; break;
      default: throw new NcExit([`nc: option -${letter}: this simulator cannot build ${UNBUILDABLE[letter]}`]);
    }
  }
  if (opts.listen && opts.sourceAddress !== undefined) throw new NcExit(['nc: cannot use -s and -l']);
  if (opts.listen && opts.zero) throw new NcExit(['nc: cannot use -z and -l']);
  if (!opts.listen && opts.keep) throw new NcExit(['nc: must use -l with -k']);
  return opts;
}

function strtoport(ctx: LinuxCommandContext, text: string): number {
  const r = strtonum(text, 1, PORT_MAX);
  if ('value' in r) return r.value;
  if (r.error !== 'invalid') throw new NcExit([`nc: port number ${r.error}: ${text}`]);
  const port = ctx.executor.resolveServicePort(text);
  if (port === null) throw new NcExit([`nc: service "${text}" unknown`]);
  return port;
}

function buildPorts(ctx: LinuxCommandContext, text: string, randomize: boolean): number[] {
  const dash = text.indexOf('-');
  if (!/^\d/.test(text) || dash < 0) return [strtoport(ctx, text)];
  let hi = strtoport(ctx, text.slice(dash + 1));
  let lo = strtoport(ctx, text.slice(0, dash));
  if (lo > hi) [lo, hi] = [hi, lo];
  const ports = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  if (!randomize) return ports;
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j], ports[i]];
  }
  return ports;
}

function getaddrinfo(
  ctx: LinuxCommandContext, host: string, port: number, opts: NcOptions,
): IPAddress | IPv6Address {
  const failure = (reason: string) => new NcExit([`nc: getaddrinfo for host "${host}" port ${port}: ${reason}`]);
  const v4 = IPAddress.tryParse(host);
  const v6 = v4 ? null : IPv6Address.tryParse(host);
  if (v4 || v6) {
    if ((v4 && opts.family === 6) || (v6 && opts.family === 4)) {
      throw failure('Address family for hostname not supported');
    }
    return (v4 ?? v6)!;
  }
  if (opts.numeric) throw failure('Name or service not known');
  const resolved = opts.family === 6
    ? ctx.net.resolveHostname6Sync(host)
    : ctx.net.resolveHostnameSync(host)
      ?? (opts.family === null ? ctx.net.resolveHostname6Sync(host) : null);
  if (!resolved) throw failure('Name or service not known');
  return resolved;
}

function sourcePortOf(ctx: LinuxCommandContext, text: string | undefined): PortNumber | undefined {
  if (text === undefined) return undefined;
  const r = strtonum(text, 0, PORT_MAX);
  const value = 'value' in r ? r.value : ctx.executor.resolveServicePort(text);
  if (value === null) throw new NcExit(['nc: getaddrinfo: Servname not supported for ai_socktype']);
  if (value === 0) return undefined;
  if (!ctx.executor.portBindPermitted(value)) throw new NcExit([`nc: bind failed: ${strerror('EACCES')}`]);
  return PortNumber.of(value);
}

function sourceAddressOf(
  ctx: LinuxCommandContext, text: string | undefined, target: IPAddress | IPv6Address,
): IPAddress | IPv6Address | undefined {
  if (text === undefined) return undefined;
  const v6 = target instanceof IPv6Address;
  const v4Literal = IPAddress.tryParse(text);
  const v6Literal = v4Literal ? null : IPv6Address.tryParse(text);
  if ((v4Literal && v6) || (v6Literal && !v6)) throw new NcExit(['nc: getaddrinfo: Address family for hostname not supported']);
  const address = v4Literal ?? v6Literal ?? (v6 ? ctx.net.resolveHostname6Sync(text) : ctx.net.resolveHostnameSync(text));
  if (!address) throw new NcExit(['nc: getaddrinfo: Name or service not known']);
  const owned = address instanceof IPv6Address
    ? ctx.net.isLocalAddress6(address)
    : address.isLoopback() || ctx.net.isLocalAddress(address);
  if (!owned) throw new NcExit([`nc: bind failed: ${strerror('EADDRNOTAVAIL')}`]);
  return address;
}

function peerLabel(host: string, address: string, opts: NcOptions): string {
  return opts.numeric || host === address ? host : `${host} (${address})`;
}

function connectionInfo(
  ctx: LinuxCommandContext, host: string, address: string, port: number, proto: 'tcp' | 'udp', opts: NcOptions,
): string {
  const service = opts.numeric ? '*' : ctx.executor.resolveServiceName(port, proto) ?? '*';
  return `Connection to ${peerLabel(host, address, opts)} ${port} port [${proto}/${service}] succeeded!`;
}

function connectFailure(
  host: string, address: string, port: number, proto: 'tcp' | 'udp', errno: Errno, opts: NcOptions,
): string {
  const where = opts.numeric || host === address ? host : `${host} (${address})`;
  return `nc: connect to ${where} port ${port} (${proto}) failed: ${strerror(errno)}`;
}

function udpTest(send: () => Errno | null): boolean {
  let answered = false;
  for (let i = 0; i < UDP_TEST_WRITES; i++) answered = send() === null;
  return answered;
}

async function runConnect(ctx: LinuxCommandContext, opts: NcOptions, stdin: string, out: NcOutput): Promise<number> {
  const wait = (ms: number): Promise<void> => ctx.net.getScheduler().delay(ms);
  if (opts.operands.length !== 2) throw usageExit();
  const [host, portText] = opts.operands;
  const ports = buildPorts(ctx, portText, opts.randomize);
  const target = getaddrinfo(ctx, host, ports[0], opts);
  const address = target.toString();
  const sourcePort = sourcePortOf(ctx, opts.sourcePort);
  const sourceIP = sourceAddressOf(ctx, opts.sourceAddress, target);
  const payload = opts.zero || opts.detachStdin ? '' : stdin;
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
      if (socket === 'EADDRINUSE' || socket === 'EADDRNOTAVAIL' || socket === 'EACCES') throw new NcExit([`nc: bind failed: ${strerror(socket)}`]);
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
      if (exchanges && opts.verbose) out.write('stderr', connectionInfo(ctx, host, address, port, proto, opts));
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
      (attempt) => attempt.outcome === 'timeout', wait, opts.timeoutMs);
    if (exchange.outcome !== 'open') {
      if (opts.verbose) {
        out.write('stderr', connectFailure(host, address, port, proto, connectErrno(exchange.outcome), opts));
      }
      continue;
    }
    ret = 0;
    if (opts.verbose) out.write('stderr', connectionInfo(ctx, host, address, port, proto, opts));
    if (!opts.zero && opts.intervalSeconds) await wait(opts.intervalSeconds * 1000);
    if (!opts.zero && exchange.received !== '') out.write('stdout', exchange.received.replace(/\r?\n$/, ''));
  }
  return ret;
}

function runListen(ctx: LinuxCommandContext, opts: NcOptions, out: NcOutput): number {
  if (opts.operands.length > 1 || (opts.operands.length === 0 && opts.sourcePort === undefined)) throw usageExit();
  const port = strtoport(ctx, opts.sourcePort ?? opts.operands[0]);
  const ownerUid = ctx.executor.userMgr.currentUid;
  if (opts.udp) {
    const failure = ctx.net.udpListen(port, 'nc', { pid: ctx.executor.currentPid(), uid: ownerUid });
    if (failure !== null) throw new NcExit([`nc: ${strerror(failure)}`]);
    if (opts.verbose) out.write('stderr', `Bound on 0.0.0.0 ${port}`);
    return 0;
  }
  const table = ctx.executor.getSocketTable();
  if (!table) throw new NcExit(['nc: no socket table available']);
  try {
    table.bind('tcp', '0.0.0.0', port, ctx.executor.currentPid(), 'nc', undefined, { ownerUid });
  } catch (error) {
    const denied = error instanceof Error && error.message.startsWith('EACCES');
    throw new NcExit([`nc: ${strerror(denied ? 'EACCES' : 'EADDRINUSE')}`]);
  }
  if (!openTcpListener(ctx, port, ownerUid, socketSettingsOf(opts, false))) {
    table.unbind('tcp', '0.0.0.0', port);
    throw new NcExit([`nc: ${strerror('EADDRINUSE')}`]);
  }
  if (opts.verbose) out.write('stderr', `Listening on 0.0.0.0 ${port}`);
  return 0;
}

function openTcpListener(
  ctx: LinuxCommandContext, port: number, ownerUid: number, settings: SocketSettings,
): boolean {
  const device = localDeviceOf(ctx) as unknown as {
    getTcpStack?: () => {
      listen(
        localPort: number,
        opts: { onAccept: (socket: unknown) => void; ownerUid?: number } & SocketSettings,
      ): unknown;
    };
  } | null;
  const stack = device?.getTcpStack?.();
  if (!stack) return true;
  try {
    stack.listen(port, { onAccept: () => undefined, ownerUid, ...settings });
    return true;
  } catch {
    return false;
  }
}

async function runNc(ctx: LinuxCommandContext, args: string[], stdin = ''): Promise<NcResult> {
  const out = new NcOutput();
  try {
    const opts = parseNcArgs(args);
    const code = opts.listen ? runListen(ctx, opts, out) : await runConnect(ctx, opts, stdin, out);
    return out.finish(code);
  } catch (error) {
    if (!(error instanceof NcExit)) throw error;
    for (const line of error.lines) out.write('stderr', line);
    return out.finish(1);
  }
}

export const ncCommand: LinuxCommand = {
  name: 'nc',
  package: 'netcat-openbsd',
  aliases: ['ncat'],
  needsNetworkContext: true,
  ownsHelpOption: true,
  readsStdin: true,
  complete: makeArgCompleter({
    flags: ['-4', '-6', '-d', '-h', '-i', '-k', '-l', '-M', '-m', '-N', '-n', '-p', '-q', '-r', '-s', '-T', '-u', '-v', '-W', '-w', '-z'],
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
