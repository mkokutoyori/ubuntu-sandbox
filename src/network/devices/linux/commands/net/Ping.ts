import {
  formatPingHeader, formatPing6Header, formatPingReplyLine, formatPingStats,
  PING_TIMING_MIN_SIZE, type PingAddressRenderer,
} from '@/network/devices/linux/LinuxFormatHelpers';
import { IPv6Address, IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { EchoRoute, PingResult, TraceSocketOptions } from '../../../EndHost';
import { reverseNameOf } from '../../network/ReverseName';
import { getoptDiagnostic, shortOptions } from '../Getopt';

const IPUTILS_VERSION_LINE = 'from iputils 20221126';
const DEFAULT_SIZE = 56;
const DETACHED_DEFAULT_COUNT = 4;
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_INTERVAL_MS = 1000;
const MIN_USER_INTERVAL_MS = 2;
const MIN_USER_BROADCAST_INTERVAL_MS = 1000;
const IP_AND_ICMP_HEADERS = 28;
const INT_MAX = 2147483647;
const LONG_MAX = '9223372036854775807';
const MAX_PATTERN_BYTES = 16;

const OPTSTRING = 'h?4bRT:6F:N:aABc:CdDe:fi:I:l:Lm:M:nOp:qQ:rs:S:t:UvVw:W:';

const UNBUILDABLE: Readonly<Record<string, string>> = {
  a: 'an audible bell',
  A: 'an adaptive interval',
  e: 'a chosen ICMP identifier',
  l: 'a preload of unanswered probes',
  m: 'SO_MARK',
  Q: 'a TOS byte on ICMP echo',
  r: 'SO_DONTROUTE',
  R: 'the IP record-route option',
  T: 'the IP timestamp option',
  U: 'user-to-user latency',
  F: 'an IPv6 flow label',
  N: 'ICMPv6 node information queries',
};

export const PING_USAGE = [
  '',
  'Usage',
  '  ping [options] <destination>',
  '',
  'Options:',
  '  <destination>      dns name or ip address',
  '  -a                 use audible ping',
  '  -A                 use adaptive ping',
  '  -B                 sticky source address',
  '  -c <count>         stop after <count> replies',
  '  -C                 call connect() syscall on socket creation',
  '  -D                 print timestamps',
  '  -d                 use SO_DEBUG socket option',
  '  -e <identifier>    define identifier for ping session, default is random for',
  '                     SOCK_RAW and kernel defined for SOCK_DGRAM',
  '                     Imply using SOCK_RAW (for IPv4 only for identifier 0)',
  '  -f                 flood ping',
  '  -h                 print help and exit',
  '  -I <interface>     either interface name or address',
  '  -i <interval>      seconds between sending each packet',
  '  -L                 suppress loopback of multicast packets',
  '  -l <preload>       send <preload> number of packages while waiting replies',
  '  -m <mark>          tag the packets going out',
  '  -M <pmtud opt>     define mtu discovery, can be one of <do|dont|want>',
  '  -n                 no dns name resolution',
  '  -O                 report outstanding replies',
  '  -p <pattern>       contents of padding byte',
  '  -q                 quiet output',
  '  -Q <tclass>        use quality of service <tclass> bits',
  '  -s <size>          use <size> as number of data bytes to be sent',
  '  -S <size>          use <size> as SO_SNDBUF socket option value',
  '  -t <ttl>           define time to live',
  '  -U                 print user-to-user latency',
  '  -v                 verbose output',
  '  -V                 print version and exit',
  '  -w <deadline>      reply wait <deadline> in seconds',
  '  -W <timeout>       time to wait for response',
  '',
  'IPv4 options:',
  '  -4                 use IPv4',
  '  -b                 allow pinging broadcast',
  '  -R                 record route',
  '  -T <timestamp>     define timestamp, can be one of <tsonly|tsandaddr|tsprespec>',
  '',
  'IPv6 options:',
  '  -6                 use IPv6',
  '  -F <flowlabel>     define flow label, default is random',
  '  -N <nodeinfo opt>  use icmp6 node info query, try <help> as argument',
  '',
  'For more details see ping(8).',
].join('\n');

export interface ParsedPingArgs {
  count: number;
  countGiven: boolean;
  ttl?: number;
  size: number;
  timeoutMs: number;
  timeoutGiven: boolean;
  intervalMs: number;
  intervalGiven: boolean;
  deadlineMs?: number;
  targets: string[];
  family?: 4 | 6;
  device?: string;
  source?: IPAddress;
  pattern?: string;
  quiet: boolean;
  numeric: boolean;
  timestamp: boolean;
  broadcast: boolean;
  outstanding: boolean;
  mtuDisc?: 'do' | 'want' | 'dont';
  flood: boolean;
}

type ParseOutcome =
  | { kind: 'parsed'; args: ParsedPingArgs; warnings: string[] }
  | { kind: 'exit'; lines: string[]; code: number };

function strtolPrefix(text: string): { value: bigint; rest: string } | null {
  const m = /^\s*([+-]?\d+)/.exec(text);
  if (m === null) return null;
  return { value: BigInt(m[1]), rest: text.slice(m[0].length) };
}

function strtolOrErr(
  cmd: string, text: string, message: string, min: bigint, max: bigint,
): { value: number } | { error: string } {
  const parsed = text === '' ? null : strtolPrefix(text);
  if (parsed === null || parsed.rest !== '') return { error: `${cmd}: ${message}: '${text}'` };
  if (parsed.value > BigInt(LONG_MAX) || parsed.value < -BigInt(LONG_MAX) - 1n) {
    return { error: `${cmd}: ${message}: '${text}': Numerical result out of range` };
  }
  if (parsed.value < min || parsed.value > max) {
    return { error: `${cmd}: ${message}: '${text}': out of range: ${min} <= value <= ${max}` };
  }
  return { value: Number(parsed.value) };
}

function pingStrtod(
  cmd: string, text: string, message: string, warnings: string[],
): { value: number } | { error: string } {
  if (text === '') return { error: `${cmd}: ${message}: ` };
  const m = /^\s*[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(text);
  const value = m === null ? 0 : Number(m[0]);
  const rest = m === null ? text : text.slice(m[0].length);
  if (rest !== '') {
    warnings.push(`${cmd}: option argument contains garbage: ${rest}`);
    warnings.push(`${cmd}: this will become fatal error in the future`);
  }
  if (!Number.isFinite(value)) return { error: `${cmd}: ${message}: ${text}: Numerical result out of range` };
  return { value };
}

function inetAton(text: string): IPAddress | null {
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = parseInt(part, 8);
    else if (/^[1-9]\d*$/.test(part)) value = parseInt(part, 10);
    else return null;
    values.push(value);
  }
  const last = values[values.length - 1];
  const leading = values.slice(0, -1);
  if (leading.some((v) => v > 255)) return null;
  const lastMax = 2 ** (8 * (4 - leading.length)) - 1;
  if (last > lastMax) return null;
  let address = 0;
  leading.forEach((v, i) => { address += v * 2 ** (8 * (3 - i)); });
  address += last;
  return new IPAddress([
    Math.floor(address / 2 ** 24) % 256, Math.floor(address / 2 ** 16) % 256,
    Math.floor(address / 2 ** 8) % 256, address % 256,
  ].join('.'));
}

function usageExit(prefix: string[]): ParseOutcome {
  return { kind: 'exit', lines: [...prefix, PING_USAGE], code: 2 };
}

export function parsePingArgs(args: readonly string[], cmd: 'ping' | 'ping6' = 'ping'): ParseOutcome {
  const parsed: ParsedPingArgs = {
    count: 0, countGiven: false, size: DEFAULT_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS, timeoutGiven: false,
    intervalMs: DEFAULT_INTERVAL_MS, intervalGiven: false,
    targets: [], family: cmd === 'ping6' ? 6 : undefined,
    quiet: false, numeric: false, timestamp: false, broadcast: false,
    outstanding: false, flood: false,
  };
  const warnings: string[] = [];
  const fail = (line: string): ParseOutcome => ({ kind: 'exit', lines: [...warnings, line], code: 2 });

  const apply = (ch: string, arg: string | undefined): ParseOutcome | null => {
    switch (ch) {
      case '4':
        if (parsed.family === 6) return fail(`${cmd}: only one -4 or -6 option may be specified`);
        parsed.family = 4; return null;
      case '6':
        if (parsed.family === 4) return fail(`${cmd}: only one -4 or -6 option may be specified`);
        parsed.family = 6; return null;
      case 'b': parsed.broadcast = true; return null;
      case 'B': case 'C': case 'd': case 'L': case 'v': return null;
      case 'c': {
        const r = strtolOrErr(cmd, arg!, 'invalid argument', 1n, BigInt(LONG_MAX));
        if ('error' in r) return fail(r.error);
        parsed.count = r.value; parsed.countGiven = true; return null;
      }
      case 'D': parsed.timestamp = true; return null;
      case 'f': parsed.flood = true; parsed.numeric = true; return null;
      case 'i': {
        const r = pingStrtod(cmd, arg!, 'bad timing interval', warnings);
        if ('error' in r) return fail(r.error);
        if (r.value > INT_MAX / 1000) return fail(`${cmd}: bad timing interval: ${arg}`);
        parsed.intervalMs = Math.trunc(r.value * 1000); parsed.intervalGiven = true; return null;
      }
      case 'I': {
        if (arg!.includes(':')) {
          return fail(`${cmd}: option -I: this simulator cannot build an IPv6 source or interface binding`);
        }
        const address = inetAton(arg!);
        if (address !== null) parsed.source = address;
        else parsed.device = arg;
        return null;
      }
      case 'M':
        if (arg === 'do' || arg === 'dont' || arg === 'want') { parsed.mtuDisc = arg; return null; }
        return fail(`${cmd}: invalid -M argument: ${arg}`);
      case 'n': parsed.numeric = true; return null;
      case 'O': parsed.outstanding = true; return null;
      case 'p': parsed.pattern = arg; return null;
      case 'q': parsed.quiet = true; return null;
      case 's': {
        const r = strtolOrErr(cmd, arg!, 'invalid argument', 0n, BigInt(INT_MAX));
        if ('error' in r) return fail(r.error);
        parsed.size = r.value; return null;
      }
      case 'S': {
        const r = strtolOrErr(cmd, arg!, 'invalid argument', 1n, BigInt(INT_MAX));
        return 'error' in r ? fail(r.error) : null;
      }
      case 't': {
        const r = strtolOrErr(cmd, arg!, 'invalid argument', 0n, 255n);
        if ('error' in r) return fail(r.error);
        parsed.ttl = r.value; return null;
      }
      case 'V':
        return { kind: 'exit', lines: [...warnings, `${cmd} ${IPUTILS_VERSION_LINE}`], code: 0 };
      case 'w': {
        const r = strtolOrErr(cmd, arg!, 'invalid argument', 0n, BigInt(INT_MAX));
        if ('error' in r) return fail(r.error);
        parsed.deadlineMs = r.value * 1000; return null;
      }
      case 'W': {
        const r = pingStrtod(cmd, arg!, 'bad linger time', warnings);
        if ('error' in r) return fail(r.error);
        if (r.value < 0 || r.value > INT_MAX / 1000) return fail(`${cmd}: bad linger time: ${arg}`);
        parsed.timeoutMs = Math.trunc(r.value * 1000); parsed.timeoutGiven = true; return null;
      }
      case 'h': case '?':
        return usageExit(warnings);
      default:
        return fail(`${cmd}: option -${ch}: this simulator cannot build ${UNBUILDABLE[ch]}`);
    }
  };

  for (const token of shortOptions(args, OPTSTRING)) {
    if (token.kind === 'operand') { parsed.targets.push(token.value); continue; }
    if (token.kind !== 'option') return usageExit([...warnings, getoptDiagnostic(cmd, token)]);
    const outcome = apply(token.letter, token.argument);
    if (outcome !== null) return outcome;
  }
  return { kind: 'parsed', args: parsed, warnings };
}

export interface EchoProbe {
  ident: number;
  timeoutMs: number;
  ttl?: number;
  dataSize: number;
  df: boolean;
  socket: TraceSocketOptions;
}

export interface PingHost {
  readonly uid: number;
  interfaceExists(name: string): boolean;
  isLocalAddress(ip: IPAddress): boolean;
  isBroadcast(ip: IPAddress): boolean;
  route(target: IPAddress, socket: TraceSocketOptions): EchoRoute | null;
  canReach6(target: IPv6Address): boolean;
  resolveHostname(name: string): Promise<IPAddress | null>;
  resolveHostname6(name: string): Promise<IPv6Address | null>;
  reverseName(ip: string): string | null;
  allocateIdent(): number;
  echo(target: IPAddress, seq: number, probe: EchoProbe): Promise<PingResult>;
  echo6(target: IPv6Address, seq: number, timeoutMs: number): Promise<PingResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PingRun {
  run(shouldStop: () => boolean): Promise<number>;
  interrupt(): void;
}

function patternBytes(pattern: string): number[] {
  const bytes: number[] = [];
  let rest = pattern;
  while (rest.length > 0 && bytes.length < MAX_PATTERN_BYTES) {
    const m = /^[0-9a-fA-F]{1,2}/.exec(rest);
    if (m === null) break;
    bytes.push(parseInt(m[0], 16));
    rest = rest.slice(m[0].length);
  }
  return bytes;
}

function timestampPrefix(enabled: boolean): string {
  if (!enabled) return '';
  const nowMs = Date.now();
  return `[${Math.floor(nowMs / 1000)}.${String((nowMs % 1000) * 1000).padStart(6, '0')}] `;
}

interface PingPlan {
  label: string;
  header: string;
  renderAddress: PingAddressRenderer;
  echo: (seq: number) => Promise<PingResult>;
}

export function createPing(
  argv: readonly string[], host: PingHost, emit: (line: string) => void,
  options: { cmd?: 'ping' | 'ping6'; detached?: boolean } = {},
): PingRun {
  const cmd = options.cmd ?? 'ping';
  const results: PingResult[] = [];
  const sendTimes: number[] = [];
  let parsed: ParsedPingArgs | null = null;
  let plan: PingPlan | null = null;
  let finished = false;
  let dots = '';
  let ewmaUs8: number | undefined;

  const summary = (interrupted = false): number => {
    if (finished || plan === null || parsed === null) return finished ? 0 : 2;
    finished = true;
    const elapsed = sendTimes.length === 0 ? 0 : sendTimes[sendTimes.length - 1] - sendTimes[0];
    const stats = formatPingStats(plan.label, results.length, results, elapsed, {
      timing: parsed.size >= PING_TIMING_MIN_SIZE,
      flood: parsed.flood,
      dots,
      ewmaMs: ewmaUs8 === undefined ? undefined : ewmaUs8 / 8 / 1000,
    });
    for (const line of interrupted && !parsed.flood ? stats.slice(1) : stats) emit(line);
    const received = results.filter((r) => r.success).length;
    return received === 0 || (parsed.deadlineMs !== undefined && parsed.countGiven && received < parsed.count) ? 1 : 0;
  };

  const prepare = async (): Promise<number | null> => {
    const outcome = parsePingArgs(argv, cmd);
    if (outcome.kind === 'exit') {
      for (const line of outcome.lines) emit(line);
      return outcome.code;
    }
    for (const line of outcome.warnings) emit(line);
    const args = outcome.args;
    parsed = args;
    if (args.targets.length === 0) { emit(`${cmd}: usage error: Destination address required`); return 1; }
    if (args.targets.length > 1) {
      emit(`${cmd}: ${args.targets.length} destinations: this simulator cannot build IP source routing`);
      return 2;
    }
    if (!options.detached || args.countGiven || args.deadlineMs !== undefined) {
      if (!args.countGiven) args.count = 0;
    } else {
      args.count = DETACHED_DEFAULT_COUNT;
    }
    if (args.pattern !== undefined) {
      const bad = /[^0-9a-fA-F]/.exec(args.pattern);
      if (bad !== null) {
        emit(`${cmd}: patterns must be specified as hex digits: ${args.pattern.slice(bad.index)}`);
        return 2;
      }
      if (!args.quiet) {
        emit(`PATTERN: 0x${patternBytes(args.pattern).map((b) => b.toString(16).padStart(2, '0')).join('')}`);
      }
    }
    const target = args.targets[0];
    const v6 = args.family === 6 || (args.family !== 4 && target.includes(':'));
    const prepared = v6 ? await prepareV6(args, target) : await prepareV4(args, target);
    if (typeof prepared === 'number') return prepared;
    plan = prepared;
    emit(plan.header);
    const interval = args.flood && !args.intervalGiven ? 0 : args.intervalMs;
    args.intervalMs = interval;
    if (host.uid !== 0 && interval < MIN_USER_INTERVAL_MS) {
      emit(`${cmd}: cannot flood; minimal interval allowed for user is ${MIN_USER_INTERVAL_MS}ms`);
      return 2;
    }
    return null;
  };

  const prepareV4 = async (args: ParsedPingArgs, target: string): Promise<PingPlan | number> => {
    const literal = inetAton(target);
    const address = literal ?? await host.resolveHostname(target);
    if (address === null) { emit(`${cmd}: ${target}: Name or service not known`); return 2; }
    const numeric = args.numeric || literal !== null;
    const socket: TraceSocketOptions = { iface: args.device, sourceIp: args.source };
    if (args.device !== undefined && !host.interfaceExists(args.device)) {
      emit(`${cmd}: SO_BINDTODEVICE ${args.device}: No such device`);
      return 2;
    }
    const broadcast = host.isBroadcast(address);
    if (args.source === undefined && broadcast) {
      if (!args.broadcast) {
        emit(`${cmd}: Do you want to ping broadcast? Then -b. If not, check your local firewall rules`);
        return 2;
      }
      emit('WARNING: pinging broadcast address');
    }
    const route = host.route(address, socket);
    if (args.source === undefined && (route === null || route.source === null)) {
      emit(`${cmd}: connect: Network is unreachable`);
      return 2;
    }
    if (broadcast && host.uid !== 0) {
      if (args.intervalMs < MIN_USER_BROADCAST_INTERVAL_MS) {
        emit(`${cmd}: broadcast ping with too short interval: ${args.intervalMs}`);
        return 2;
      }
      if (args.mtuDisc !== undefined && args.mtuDisc !== 'do') {
        emit(`${cmd}: broadcast ping does not fragment`);
        return 2;
      }
    }
    if (args.source !== undefined && !host.isLocalAddress(args.source)) {
      emit(`${cmd}: bind: Cannot assign requested address`);
      return 2;
    }
    const mtuDisc = args.mtuDisc ?? (broadcast ? 'do' : 'want');
    const packetSize = args.size + IP_AND_ICMP_HEADERS;
    const ident = host.allocateIdent();
    const renderAddress: PingAddressRenderer = numeric
      ? (ip) => ip
      : (ip) => `${host.reverseName(ip) ?? ip} (${ip})`;
    const bound = args.device !== undefined || args.source !== undefined
      ? { source: (args.source ?? route?.source)!.toString(), device: args.device }
      : undefined;
    return {
      label: target,
      header: formatPingHeader(address, args.size, target === address.toString() ? undefined : target, bound),
      renderAddress,
      echo: async (seq) => {
        const path = host.route(address, socket);
        const mtu = path?.mtu ?? Number.MAX_SAFE_INTEGER;
        if (mtuDisc === 'do' && packetSize > mtu) {
          return { success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '', error: `local error: message too long, mtu=${mtu}` };
        }
        const fits = packetSize <= mtu && !(path?.mtuLocked ?? false);
        return host.echo(address, seq, {
          ident, timeoutMs: args.timeoutMs, ttl: args.ttl, dataSize: args.size,
          df: mtuDisc === 'do' || (mtuDisc === 'want' && fits), socket,
        });
      },
    };
  };

  const prepareV6 = async (args: ParsedPingArgs, target: string): Promise<PingPlan | number> => {
    if (args.device !== undefined || args.source !== undefined) {
      emit(`${cmd}: option -I: this simulator cannot build an IPv6 source or interface binding`);
      return 2;
    }
    let address: IPv6Address | null = null;
    try { address = new IPv6Address(target); } catch { address = await host.resolveHostname6(target); }
    if (address === null) { emit(`${cmd}: ${target}: Name or service not known`); return 2; }
    if (!host.canReach6(address)) { emit(`${cmd}: connect: Network is unreachable`); return 2; }
    const resolved = address;
    return {
      label: target,
      header: formatPing6Header(resolved, args.size, target === resolved.toString() ? undefined : target),
      renderAddress: (ip) => ip,
      echo: (seq) => host.echo6(resolved, seq, args.timeoutMs),
    };
  };

  const report = (r: PingResult, args: ParsedPingArgs, current: PingPlan): void => {
    if (r.success) {
      const us = Math.round(r.rttMs * 1000);
      ewmaUs8 = ewmaUs8 === undefined ? us * 8 : ewmaUs8 + us - Math.trunc(ewmaUs8 / 8);
    }
    if (args.flood) {
      if (!r.success) dots += r.error !== undefined && formatPingReplyLine(r, args.size) !== null ? 'E' : '.';
      return;
    }
    if (args.quiet) return;
    if (r.error?.startsWith('local error')) { emit(`${cmd}: ${r.error}`); return; }
    const line = formatPingReplyLine(r, args.size, current.renderAddress);
    if (line !== null) emit(`${timestampPrefix(args.timestamp)}${line}`);
  };

  const run = async (shouldStop: () => boolean): Promise<number> => {
    const early = await prepare();
    if (early !== null) { finished = true; return early; }
    const args = parsed!;
    const current = plan!;
    const startedAt = host.now();
    const deadlineHit = () => args.deadlineMs !== undefined && host.now() - startedAt >= args.deadlineMs;
    for (let seq = 1; ; seq++) {
      if (shouldStop() || finished) break;
      if (args.outstanding && seq > 1 && !results[results.length - 1].success && !args.quiet && !args.flood) {
        emit(`${timestampPrefix(args.timestamp)}no answer yet for icmp_seq=${seq - 1}`);
      }
      sendTimes.push(host.now());
      const r = { ...(await current.echo(seq)), seq };
      if (finished) break;
      results.push(r);
      report(r, args, current);
      const received = results.filter((x) => x.success).length;
      const errors = results.filter((x) => !x.success && x.error !== undefined).length;
      if (args.deadlineMs === undefined && args.count > 0 && results.length >= args.count) break;
      if (args.deadlineMs !== undefined && args.count > 0 && received >= args.count) break;
      if (args.deadlineMs !== undefined && errors > 0) break;
      if (deadlineHit() || shouldStop()) break;
      if (args.intervalMs > 0) await host.sleep(args.intervalMs);
      if (deadlineHit()) break;
    }
    if (finished) return results.some((r) => r.success) ? 0 : 1;
    return summary();
  };

  return {
    run,
    interrupt: () => { if (plan !== null) summary(true); finished = true; },
  };
}

export interface PingTiming {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function pingHostOf(
  ctx: LinuxCommandContext,
  timing: PingTiming = {
    sleep: (ms) => ctx.net.getScheduler().delay(ms),
    now: () => ctx.net.getScheduler().now(),
  },
  uid = ctx.executor.userMgr.currentUid,
): PingHost {
  return {
    uid,
    interfaceExists: (name) => ctx.net.getPorts().has(name),
    isLocalAddress: (ip) => ctx.net.isLocalAddress(ip),
    isBroadcast: (ip) => ctx.net.isBroadcastDestination(ip),
    route: (target, socket) => ctx.net.echoRouteFor(target, socket),
    canReach6: (target) => ctx.net.canReach6(target),
    resolveHostname: (name) => ctx.net.resolveHostname(name),
    resolveHostname6: (name) => ctx.net.resolveHostname6(name),
    reverseName: (ip) => reverseNameOf(ctx.executor.nss, ip),
    allocateIdent: () => ctx.net.allocateEchoIdent(),
    echo: async (target, seq, probe) => {
      const [result] = await ctx.net.pingSequence(target, 1, probe.timeoutMs, probe.ttl, {
        dataSize: probe.dataSize, df: probe.df, firstSeq: seq, ident: probe.ident, socket: probe.socket,
      });
      return result ?? { success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '' };
    },
    echo6: async (target, seq, timeoutMs) => {
      const [result] = await ctx.net.ping6Sequence(target, 1, timeoutMs);
      return { ...(result ?? { success: false, rttMs: 0, ttl: 0, bytes: 0, fromIP: '' }), seq };
    },
    sleep: timing.sleep,
    now: timing.now,
  };
}

async function runDetached(
  ctx: LinuxCommandContext, args: string[], cmd: 'ping' | 'ping6',
): Promise<{ output: string; exitCode: number }> {
  const lines: string[] = [];
  const exitCode = await createPing(args, pingHostOf(ctx), (line) => lines.push(line), { cmd, detached: true })
    .run(() => false);
  return { output: lines.join('\n'), exitCode };
}

const PING_FLAGS_LIST = [
  '-4', '-6', '-B', '-b', '-C', '-c', '-D', '-d', '-f', '-h', '-I', '-i', '-L', '-M', '-n',
  '-O', '-p', '-q', '-S', '-s', '-t', '-V', '-v', '-W', '-w',
];

function completePingFlags(_ctx: LinuxCommandContext, args: string[]): string[] {
  const partial = args[args.length - 1] ?? '';
  if (partial.startsWith('-')) {
    return PING_FLAGS_LIST.filter(f => f.startsWith(partial));
  }
  return [];
}

export const pingCommand: LinuxCommand = {
  name: 'ping',
  needsNetworkContext: true,
  ownsHelpOption: true,
  manSection: 8,
  usage: 'ping [options] <destination>',
  help: 'Send ICMP ECHO_REQUEST packets to network hosts.',
  helpText: PING_USAGE,
  options: [
    { flag: '-c', description: 'Stop after <count> replies.', takesArg: true, argName: 'count' },
    { flag: '-s', description: 'Use <size> as number of data bytes to be sent.', takesArg: true, argName: 'size' },
    { flag: '-t', description: 'Define time to live.', takesArg: true, argName: 'ttl' },
    { flag: '-w', description: 'Reply wait <deadline> in seconds.', takesArg: true, argName: 'deadline' },
    { flag: '-W', description: 'Time to wait for response.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Seconds between sending each packet.', takesArg: true, argName: 'interval' },
    { flag: '-I', description: 'Either interface name or address.', takesArg: true, argName: 'interface' },
    { flag: '-p', description: 'Contents of padding byte.', takesArg: true, argName: 'pattern' },
    { flag: '-M', description: 'Define mtu discovery, can be one of <do|dont|want>.', takesArg: true, argName: 'pmtud opt' },
    { flag: '-q', description: 'Quiet output.' },
    { flag: '-D', description: 'Print timestamps.' },
    { flag: '-O', description: 'Report outstanding replies.' },
    { flag: '-b', description: 'Allow pinging broadcast.' },
    { flag: '-f', description: 'Flood ping.' },
    { flag: '-n', description: 'No dns name resolution.' },
    { flag: '-V', description: 'Print version and exit.' },
    { flag: '-4', description: 'Use IPv4.' },
    { flag: '-6', description: 'Use IPv6.' },
  ],

  complete: completePingFlags,

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await pingCommand.runWithStatus!(ctx, args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    for (const sc of ['socket', 'connect', 'bind', 'sendto', 'recvfrom', 'close']) {
      ctx.executor.publishAuditSyscall(sc);
    }
    return runDetached(ctx, args, 'ping');
  },
};

export const ping6Command: LinuxCommand = {
  name: 'ping6',
  needsNetworkContext: true,
  ownsHelpOption: true,
  manSection: 8,
  usage: 'ping6 [options] <destination>',
  help: 'Send ICMPv6 ECHO_REQUEST packets to network hosts (alias for ping -6).',
  helpText: PING_USAGE,
  options: pingCommand.options,

  complete: completePingFlags,

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ping6Command.runWithStatus!(ctx, args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return runDetached(ctx, args, 'ping6');
  },
};
