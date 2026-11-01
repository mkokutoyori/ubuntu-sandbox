import { IPAddress, IPv6Address } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { TraceProbeMethod, TraceSocketOptions } from '../../../EndHost';
import type { TracerouteHop } from '../../LinuxNetKernel';
import { isValidIPv4 } from '@/network/core/ip';
import { unquote } from '@/lib/format';
import { makeArgCompleter } from '../completionHelpers';
import { reverseNameOf } from '../../network/ReverseName';
import type { NssProtocolEntry } from '../../nss/types';
import {
  TRACEROUTE_VERSION_TEXT, tracerouteHeader, tracerouteHopLine,
} from '../../network/TracerouteRender';

const DEF_START_PORT = 33434;
const DEF_UDP_PORT = 53;
const DEF_TCP_PORT = 80;
const DEF_HOPS = 30;
const DEF_NUM_PROBES = 3;
const DEF_PACKET_BYTES = 60;
const DEF_RAW_PROT = 253;
const PROBE_WAIT_CAP_MS = 100;

export const TRACEROUTE_USAGE = [
  'Usage:',
  '  traceroute [ -4dFITnreU ] [ -f first_ttl ] [ -i device ] [ -m max_ttl ]'
    + ' [ -N squeries ] [ -p port ] [ -t tos ] [ -w MAX ] [ -q nqueries ]'
    + ' [ -s src_addr ] [ -z sendwait ] [ -M method ] [ -P proto ] [ --sport=port ]'
    + ' host [ packetlen ]',
  'Options:',
  '  -4                          Use IPv4',
  '  -d  --debug                 Enable socket level debugging',
  '  -F  --dont-fragment         Do not fragment packets',
  '  -f first_ttl  --first=first_ttl',
  '                              Start from the first_ttl hop (instead from 1)',
  '  -I  --icmp                  Use ICMP ECHO for tracerouting',
  '  -T  --tcp                   Use TCP SYN for tracerouting (default port is 80)',
  '  -i device  --interface=device',
  '                              Specify a network interface to operate with',
  '  -m max_ttl  --max-hops=max_ttl',
  '                              Set the max number of hops (max TTL to be',
  '                              reached). Default is 30',
  '  -N squeries  --sim-queries=squeries',
  '                              Set the number of probes to be tried',
  '                              simultaneously (default is 16)',
  '  -n                          Do not resolve IP addresses to their domain names',
  '  -p port  --port=port        Set the destination port to use. It is either',
  '                              initial udp port value for "default" method',
  '                              (incremented by each probe, default is 33434),',
  '                              or constant destination port for "udp" and',
  '                              "tcp" methods',
  '  -t tos  --tos=tos           Set the TOS (IPv4 type of service) value for',
  '                              outgoing packets',
  '  -w MAX  --wait=MAX          Wait for a probe no more than MAX seconds',
  '                              (default 5.0)',
  '  -q nqueries  --queries=nqueries',
  '                              Set the number of probes per each hop. Default',
  '                              is 3',
  '  -r                          Bypass the normal routing and send directly to a',
  '                              host on an attached network',
  '  -s src_addr  --source=src_addr',
  '                              Use source src_addr for outgoing packets',
  '  -z sendwait  --sendwait=sendwait',
  '                              Minimal time interval between probes',
  '  -e  --extensions            Show ICMP extensions (if present), including MPLS',
  '  -M name  --module=name      Use specified module for traceroute operations',
  '                              (default, icmp, tcp, udp, raw)',
  '  --sport=num                 Use source port num for outgoing packets.',
  "                              Implies `-N 1'",
  '  -U  --udp                   Use UDP to particular port for tracerouting',
  '                              (default port is 53)',
  '  -P prot  --protocol=prot    Use raw packet of protocol prot for',
  '                              tracerouting',
  '  -V  --version               Print version info and exit',
  '  --help                      Read this help and exit',
  '',
  'Arguments:',
  '+     host          The host to traceroute to',
  '      packetlen     The full packet length (default is the length of an IP',
  '                    header plus 40). Can be ignored or increased to a minimal',
  '                    allowed value',
].join('\n');

type MethodName = string;

export interface ParsedTracerouteArgs {
  targetStr: string;
  maxHops: number;
  probesPerHop: number;
  firstTtl: number;
  packetSize: number;
  waitMs: number;
  port?: number;
  tos?: number;
  waitSpec: [number, number, number];
  sendSeconds: number;
  namedPorts: Array<{ flag: string; name: string; position: number }>;
  protocol?: string;
  iface?: string;
  sourceStr?: string;
  sourcePort?: number;
  dontFragment: boolean;
  direct: boolean;
  family?: 4 | 6;
  flowLabel?: number;
  packetSizeGiven: boolean;
  numeric: boolean;
  method: MethodName;
  showVersion: boolean;
  showHelp: boolean;
  parseError?: string;
}

const UNBUILDABLE: Readonly<Record<string, string>> = {
  '-g': 'a loose source route (no LSRR IP option on these probes)',
  '-A': 'an AS path lookup (no routing registry is reachable)',
  '-O': 'a module-specific option',
  '-D': 'a DCCP Request',
  '--UL': 'a UDPLITE datagram',
  '--mtu': 'a path MTU discovery (no F= annotation is produced)',
  '--back': 'a backward-path hop estimate',
  '--fwmark': 'a firewall mark on outgoing packets',
};

const LONG_TO_SHORT: Readonly<Record<string, string>> = {
  '--icmp': '-I', '--tcp': '-T', '--udp': '-U', '--debug': '-d',
  '--extensions': '-e', '--dont-fragment': '-F', '--as-path-lookups': '-A',
  '--first': '-f', '--max-hops': '-m', '--sim-queries': '-N', '--port': '-p',
  '--tos': '-t', '--wait': '-w', '--queries': '-q', '--sendwait': '-z',
  '--module': '-M', '--interface': '-i', '--gateway': '-g', '--source': '-s',
  '--flowlabel': '-l', '--options': '-O', '--protocol': '-P', '--dccp': '-D',
};

const TAKES_VALUE = new Set(['-f', '-m', '-N', '-p', '-t', '-w', '-q', '-z', '-M',
  '-i', '-g', '-s', '-l', '-O', '-P', '--sport']);

function refuse(option: string): string {
  return `traceroute: option ${option}: this simulator cannot build ${UNBUILDABLE[option]}`;
}

function badOption(arg: string, position: number): string {
  return `Bad option \`${arg.slice(0, 2)}' (argc ${position})`;
}

function cannotHandle(option: string, argName: string, value: string, position: number): string {
  return `Cannot handle \`${option}' option with arg \`${value}' (argc ${position})`;
}

function splitArgs(args: string[]): Array<{ flag: string; value?: string; position: number }> {
  const out: Array<{ flag: string; value?: string; position: number }> = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw.startsWith('--') && raw.length > 2) {
      const [name, inline] = raw.split('=', 2);
      if (name === '--help' || name === '--version') {
        out.push({ flag: name, position: i + 1 });
        continue;
      }
      if (UNBUILDABLE[name] !== undefined) { out.push({ flag: name, position: i + 1 }); continue; }
      const short = name === '--sport' ? name : LONG_TO_SHORT[name];
      if (short === undefined) { out.push({ flag: raw, position: i + 1 }); continue; }
      if (TAKES_VALUE.has(short)) {
        const value = inline ?? args[++i];
        out.push({ flag: short, value, position: i + 1 });
      } else {
        out.push({ flag: short, position: i + 1 });
      }
      continue;
    }
    if (raw.startsWith('-') && raw.length > 1) {
      const flag = raw.slice(0, 2);
      if (TAKES_VALUE.has(flag)) {
        const value = raw.length > 2 ? raw.slice(2) : args[++i];
        out.push({ flag, value, position: i + 1 });
        continue;
      }
      for (const letter of raw.slice(1)) out.push({ flag: `-${letter}`, position: i + 1 });
      continue;
    }
    out.push({ flag: '', value: raw, position: i + 1 });
  }
  return out;
}

const UINT_RANGE = 2 ** 32;

function cNumberPrefix(text: string): { negative: boolean; digits: string; base: number } | null {
  const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)$/.exec(text);
  if (match === null) return null;
  const body = match[2];
  const base = /^0[xX]/.test(body) ? 16 : body.length > 1 && body.startsWith('0') ? 8 : 10;
  const digits = base === 16 ? body.slice(2) : body;
  return { negative: match[1] === '-', digits, base };
}

function strtoul(value: string | undefined): number | null {
  const parsed = value === undefined ? null : cNumberPrefix(value);
  if (parsed === null) return null;
  const magnitude = parseInt(parsed.digits, parsed.base) % UINT_RANGE;
  return parsed.negative ? (UINT_RANGE - magnitude) % UINT_RANGE : magnitude;
}

function strtol(value: string | undefined): number | null {
  const parsed = value === undefined ? null : cNumberPrefix(value);
  if (parsed === null) return null;
  const magnitude = parseInt(parsed.digits, parsed.base);
  return parsed.negative ? -magnitude : magnitude;
}

function strtod(value: string): number | null {
  if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return null;
  return Number(value);
}

function formatG(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e6) return String(value);
  return String(Number(value.toPrecision(6)));
}

function waitSpecOf(value: string): [number, number, number] | null {
  const parts = value.split(',');
  if (parts.length > 3) return null;
  const numbers = parts.map(strtod);
  if (numbers.some((n) => n === null)) return null;
  return [numbers[0]!, numbers[1] ?? 0, numbers[2] ?? 0];
}

const BUILT_MODULES = new Set(['default', 'icmp', 'tcp', 'udp', 'raw']);
const RAW_SOCKET_METHODS: ReadonlySet<string> = new Set(['tcp', 'raw']);
const UNBUILT_MODULES: Readonly<Record<string, string>> = {
  tcpconn: 'a connect()-based TCP trace',
  udplite: 'a UDPLITE datagram',
  dccp: 'a DCCP Request',
};

function mainValidationError(parsed: ParsedTracerouteArgs): string | null {
  if (!BUILT_MODULES.has(parsed.method)) {
    const unbuilt = UNBUILT_MODULES[parsed.method];
    return unbuilt === undefined
      ? `Unknown traceroute module ${parsed.method}`
      : `traceroute: module ${parsed.method}: this simulator cannot build ${unbuilt}`;
  }
  if (parsed.firstTtl === 0 || parsed.firstTtl > parsed.maxHops) return 'first hop out of range';
  if (parsed.maxHops > 255) return 'max hops cannot be more than 255';
  if (parsed.probesPerHop === 0 || parsed.probesPerHop > 10) return 'no more than 10 probes per hop';
  const [max, here, near] = parsed.waitSpec;
  if (max < 0 || here < 0 || near < 0) {
    return `bad wait specifications \`${formatG(max)},${formatG(here)},${formatG(near)}' used`;
  }
  if (parsed.packetSize > 65000) return `too big packetlen ${parsed.packetSize} specified`;
  if (parsed.sendSeconds < 0) return `bad sendtime \`${formatG(parsed.sendSeconds)}' specified`;
  return null;
}

export function parseTracerouteArgs(args: string[]): ParsedTracerouteArgs {
  const result: ParsedTracerouteArgs = {
    targetStr: '', maxHops: DEF_HOPS, probesPerHop: DEF_NUM_PROBES, firstTtl: 1,
    packetSize: DEF_PACKET_BYTES, waitMs: 5000, waitSpec: [5, 3, 10], sendSeconds: 0, namedPorts: [],
    numeric: false, method: 'default', dontFragment: false, direct: false, packetSizeGiven: false,
    showVersion: false, showHelp: false,
  };
  const fail = (message: string): ParsedTracerouteArgs => ({ ...result, parseError: message });
  const unsigned = (flag: string, name: string, value: string | undefined, position: number) => {
    const n = strtoul(value);
    return n === null ? cannotHandle(flag, name, value ?? '', position) : n;
  };

  for (const { flag, value, position } of splitArgs(args)) {
    if (flag === '') {
      const cleaned = unquote(value ?? '');
      if (cleaned === '') continue;
      if (result.targetStr === '') { result.targetStr = cleaned; continue; }
      const length = strtol(cleaned);
      if (length === null) {
        return fail(`Cannot handle "packetlen" cmdline arg \`${cleaned}' on position 2`
          + ` (argc ${position})`);
      }
      result.packetSize = length;
      result.packetSizeGiven = true;
      continue;
    }
    if (flag === '--help') { result.showHelp = true; return result; }
    if (flag === '-V' || flag === '--version') { result.showVersion = true; return result; }
    if (UNBUILDABLE[flag] !== undefined) return fail(refuse(flag));
    switch (flag) {
      case '-d': case '-e': break;
      case '-4': result.family = 4; break;
      case '-6': result.family = 6; break;
      case '-l': {
        const n = unsigned('-l', 'flow_label', value, position);
        if (typeof n === 'string') return fail(n);
        result.flowLabel = n & 0xfffff;
        break;
      }
      case '-n': result.numeric = true; break;
      case '-F': result.dontFragment = true; break;
      case '-r': result.direct = true; break;
      case '-i': result.iface = value ?? ''; break;
      case '-s': result.sourceStr = value ?? ''; break;
      case '-P': result.method = 'raw'; result.protocol = value ?? ''; break;
      case '-I': result.method = 'icmp'; break;
      case '-T': result.method = 'tcp'; break;
      case '-U': result.method = 'udp'; break;
      case '-M': result.method = value ?? ''; break;
      case '--sport': case '-p': {
        const n = strtoul(value);
        if (n === null) {
          result.namedPorts.push({ flag, name: value ?? '', position });
          break;
        }
        if (flag === '-p') result.port = n & 0xffff; else result.sourcePort = n & 0xffff;
        break;
      }
      case '-m': {
        const n = unsigned('-m', 'max_ttl', value, position);
        if (typeof n === 'string') return fail(n);
        result.maxHops = n;
        break;
      }
      case '-f': {
        const n = unsigned('-f', 'first_ttl', value, position);
        if (typeof n === 'string') return fail(n);
        result.firstTtl = n;
        break;
      }
      case '-q': {
        const n = unsigned('-q', 'nqueries', value, position);
        if (typeof n === 'string') return fail(n);
        result.probesPerHop = n;
        break;
      }
      case '-N': {
        const n = unsigned('-N', 'squeries', value, position);
        if (typeof n === 'string') return fail(n);
        break;
      }
      case '-t': {
        const n = unsigned('-t', 'tos', value, position);
        if (typeof n === 'string') return fail(n);
        result.tos = n & 0xff;
        break;
      }
      case '-w': {
        const spec = value === undefined ? null : waitSpecOf(value);
        if (spec === null) return fail(cannotHandle('-w', 'MAX,HERE,NEAR', value ?? '', position));
        result.waitSpec = spec;
        result.waitMs = Math.max(0, Math.round(spec[0] * 1000));
        break;
      }
      case '-z': {
        const seconds = value === undefined ? null : strtod(value);
        if (seconds === null) return fail(cannotHandle('-z', 'sendwait', value ?? '', position));
        result.sendSeconds = seconds;
        break;
      }
      default:
        return fail(badOption(flag, position));
    }
  }
  return result;
}

const IPV6_HEADER_BYTES = 40;
const DEF_DATA_BYTES = 40;
const PROBE_HEADER_BYTES: Readonly<Record<string, number>> = { icmp: 8, tcp: 20 };

function ipv6PacketBytesOf(parsed: ParsedTracerouteArgs): number {
  const moduleHeader = PROBE_HEADER_BYTES[parsed.method] ?? 8;
  const headers = IPV6_HEADER_BYTES + moduleHeader;
  if (!parsed.packetSizeGiven) return headers + (DEF_DATA_BYTES - moduleHeader);
  return parsed.packetSize >= headers ? parsed.packetSize : headers;
}

function probeMethod(parsed: ParsedTracerouteArgs, protocol: number): TraceProbeMethod {
  const tos = parsed.tos === undefined ? {} : { tos: parsed.tos };
  switch (parsed.method) {
    case 'icmp': return { kind: 'icmp', ...tos };
    case 'tcp': return { kind: 'tcp', port: parsed.port ?? DEF_TCP_PORT, ...tos };
    case 'udp': return { kind: 'udp', port: parsed.port ?? DEF_UDP_PORT, ...tos };
    case 'raw': return { kind: 'raw', protocol, ...tos };
    default: return { kind: 'default-udp', port: parsed.port ?? DEF_START_PORT, ...tos };
  }
}

export type TraceTarget = IPAddress | IPv6Address;

export interface TracerouteHost {
  rawSocketsPermitted: boolean;
  mayBindPort(port: number): boolean;
  resolveHostname(name: string): Promise<IPAddress | null>;
  resolveHostname6(name: string): Promise<IPv6Address | null>;
  interfaceExists(name: string): boolean;
  ownsAddress(address: TraceTarget): boolean;
  canReach(target: TraceTarget, socket: TraceSocketOptions): boolean;
  protocolNumber(name: string): number | null;
  servicePort(name: string): number | null;
  reverseName(ip: string): string | null;
  trace(
    target: TraceTarget, parsed: ParsedTracerouteArgs, method: TraceProbeMethod, socket: TraceSocketOptions,
    onHop: (hop: TracerouteHop) => void, shouldStop: () => boolean,
  ): Promise<void>;
}

function unknownHost(name: string): string {
  return `${name}: Name or service not known\n`
    + `Cannot handle "host" cmdline arg \`${name}' on position 1 (argc 1)`;
}

function rawProtocolOf(parsed: ParsedTracerouteArgs, host: TracerouteHost, args: string[]): number | string {
  if (parsed.method !== 'raw') return 0;
  const spec = parsed.protocol ?? '';
  if (spec === '') return DEF_RAW_PROT;
  if (/^\d+$/.test(spec) && Number(spec) <= 255) return Number(spec);
  const named = host.protocolNumber(spec);
  if (named !== null) return named;
  const position = args.findIndex((a) => a === spec || a.endsWith(spec)) + 1;
  return cannotHandle('-P', 'prot', spec, position);
}

async function sourceOf(
  parsed: ParsedTracerouteArgs, host: TracerouteHost, args: string[],
): Promise<TraceTarget | null | string> {
  if (parsed.sourceStr === undefined) return null;
  const text = parsed.sourceStr;
  const literal6 = text.includes(':') ? IPv6Address.tryParse(text) : null;
  const address = literal6 !== null ? literal6
    : isValidIPv4(text) ? new IPAddress(text)
      : parsed.family === 6 ? await host.resolveHostname6(text) : await host.resolveHostname(text);
  if (address !== null) return address;
  const position = args.findIndex((a) => a === text || a.endsWith(text)) + 1;
  return `${text}: Name or service not known\n${cannotHandle('-s', 'src_addr', text, position)}`;
}

function socketErrorOf(
  target: TraceTarget, socket: TraceSocketOptions, host: TracerouteHost, bindsSourcePort: boolean,
): string | null {
  if (socket.iface !== undefined && !host.interfaceExists(socket.iface)) {
    return 'setsockopt SO_BINDTODEVICE: No such device';
  }
  const boundSource = socket.sourceIp ?? socket.sourceIp6;
  if (boundSource !== undefined && !host.ownsAddress(boundSource)) {
    return 'bind: Cannot assign requested address';
  }
  if (bindsSourcePort && socket.sourcePort !== undefined && !host.mayBindPort(socket.sourcePort)) {
    return 'bind: Permission denied';
  }
  if (!host.canReach(target, socket)) return 'connect: Network is unreachable';
  return null;
}

export async function runTraceroute(
  args: string[], host: TracerouteHost, emit: (line: string) => void,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  if (args.length === 0) { emit(TRACEROUTE_USAGE); return 0; }
  const parsed = parseTracerouteArgs(args);
  if (parsed.showVersion) { emit(TRACEROUTE_VERSION_TEXT); return 0; }
  if (parsed.showHelp) { emit(TRACEROUTE_USAGE); return 0; }
  if (parsed.parseError) { emit(parsed.parseError); return 2; }
  if (!parsed.targetStr) { emit(TRACEROUTE_USAGE); return 2; }

  for (const named of parsed.namedPorts) {
    const port = host.servicePort(named.name);
    if (port === null) {
      emit(cannotHandle(named.flag, named.flag === '-p' ? 'port' : 'num', named.name, named.position));
      return 2;
    }
    if (named.flag === '-p') parsed.port = port; else parsed.sourcePort = port;
  }
  const protocol = rawProtocolOf(parsed, host, args);
  if (typeof protocol === 'string') { emit(protocol); return 2; }
  const source = await sourceOf(parsed, host, args);
  if (typeof source === 'string') { emit(source); return 2; }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
    emit(unknownHost(parsed.targetStr));
    return 2;
  }
  const wantsIpv6 = parsed.family === 6 || (parsed.family === undefined && parsed.targetStr.includes(':'));
  let target: TraceTarget | null;
  if (wantsIpv6) {
    target = IPv6Address.tryParse(parsed.targetStr) ?? await host.resolveHostname6(parsed.targetStr);
    if (!target && parsed.targetStr.toLowerCase() === 'localhost') target = new IPv6Address('::1');
  } else {
    target = parsed.targetStr.includes(':') ? null : await host.resolveHostname(parsed.targetStr);
    if (!target && parsed.targetStr.toLowerCase() === 'localhost') target = new IPAddress('127.0.0.1');
  }
  if (!target) { emit(unknownHost(parsed.targetStr)); return 2; }
  const targetIsIpv6 = target instanceof IPv6Address;
  const invalid = mainValidationError(parsed);
  if (invalid !== null) { emit(invalid); return 2; }
  if (source !== null && (source instanceof IPv6Address) !== targetIsIpv6) {
    emit('IP version mismatch in addresses specified');
    return 2;
  }

  if (RAW_SOCKET_METHODS.has(parsed.method) && !host.rawSocketsPermitted) {
    emit('You do not have enough privileges to use this traceroute method.\nsocket: Operation not permitted');
    return 1;
  }

  const socket: TraceSocketOptions = {
    dontFragment: parsed.dontFragment,
    direct: parsed.direct,
    ...(parsed.iface === undefined ? {} : { iface: parsed.iface }),
    ...(source === null ? {} : source instanceof IPv6Address ? { sourceIp6: source } : { sourceIp: source }),
    ...(parsed.flowLabel === undefined ? {} : { flowLabel: parsed.flowLabel }),
    ...(parsed.sourcePort === undefined ? {} : { sourcePort: parsed.sourcePort }),
  };
  const packetBytes = targetIsIpv6 ? ipv6PacketBytesOf(parsed) : parsed.packetSize;
  const header = tracerouteHeader(parsed.targetStr, target.toString(), parsed.maxHops, packetBytes);
  const perProbeSocket = parsed.method === 'default' || parsed.method === 'udp';
  const socketError = socketErrorOf(target, socket, host, perProbeSocket);
  if (socketError !== null) {
    emit(perProbeSocket ? `${header}\n${socketError}` : `\n${socketError}`);
    return 1;
  }

  emit(header);
  const render = { numeric: parsed.numeric, nameOf: (ip: string) => host.reverseName(ip), family: targetIsIpv6 ? 6 as const : 4 as const };
  await host.trace(
    target, parsed, probeMethod(parsed, protocol), socket,
    (hop) => emit(tracerouteHopLine(hop, render)), shouldStop);
  return 0;
}

export function tracerouteHostOf(
  ctx: LinuxCommandContext, rawSocketsPermitted = ctx.executor.holdsCapability('CAP_NET_RAW'),
  uid = ctx.executor.userMgr.currentUid,
): TracerouteHost {
  return {
    rawSocketsPermitted,
    mayBindPort: (port) => ctx.executor.portBindPermitted(port, uid),
    resolveHostname: (name) => ctx.net.resolveHostname(name),
    resolveHostname6: (name) => ctx.net.resolveHostname6(name),
    interfaceExists: (name) => ctx.net.getPorts().has(name),
    ownsAddress: (address) => address instanceof IPv6Address
      ? ctx.net.isLocalAddress6(address) : ctx.net.isLocalAddress(address),
    canReach: (target, socket) => target instanceof IPv6Address
      ? ctx.net.canTraceTo6(target, socket) : ctx.net.canTraceTo(target, socket),
    protocolNumber: (name) => {
      const found = ctx.executor.nss.lookup<NssProtocolEntry>('protocols', (src) => src.getprotobyname?.(name));
      return found.status === 'SUCCESS' && found.entry ? found.entry.number : null;
    },
    servicePort: (name) => ctx.executor.resolveServicePort(name),
    reverseName: (ip) => reverseNameOf(ctx.executor.nss, ip),
    trace: async (target, parsed, method, socket, onHop, shouldStop) => {
      const hooks = { onHop, shouldStop, compressedWaitMs: Math.max(0, parsed.waitMs - PROBE_WAIT_CAP_MS) };
      const timeoutMs = Math.min(parsed.waitMs, PROBE_WAIT_CAP_MS);
      if (target instanceof IPv6Address) {
        await ctx.net.traceroute6(
          target, parsed.maxHops, parsed.probesPerHop, parsed.firstTtl, timeoutMs, method, socket, hooks);
        return;
      }
      await ctx.net.traceroute(
        target, parsed.maxHops, parsed.probesPerHop, parsed.firstTtl, timeoutMs, method, socket, hooks);
    },
  };
}

export const TRACEROUTE_COMMAND_NAMES: readonly string[] = ['traceroute', 'traceroute6'];

export function tracerouteArgvOf(name: string, args: readonly string[]): string[] {
  return name === 'traceroute6' ? ['-6', ...args] : [...args];
}

export const tracerouteCommand: LinuxCommand = {
  name: 'traceroute',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-4', '-F', '-I', '-M', '-N', '-P', '-T', '-U', '-V', '-d', '-e', '-f', '-i', '-m', '-n',
      '-p', '-q', '-r', '-s', '-t', '-w', '-z', '--sport', '--help', '--version'],
    interfacesAfter: ['-i'],
    hostsAtBarePosition: true,
  }),
  manSection: 8,
  usage: 'traceroute [ -4dFITnreU ] [ -f first_ttl ] [ -i device ] [ -m max_ttl ] [ -N squeries ]'
    + ' [ -p port ] [ -t tos ] [ -w MAX ] [ -q nqueries ] [ -s src_addr ] [ -z sendwait ]'
    + ' [ -M method ] [ -P proto ] [ --sport=port ] host [ packetlen ]',
  help:
    'Print the route packets trace to network host.\n\n'
    + 'Traces the path that an IP packet follows from the local host to a\n'
    + 'remote destination by sending probe packets with increasing TTL values.',
  helpText: TRACEROUTE_USAGE,

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const lines: string[] = [];
    await runTraceroute(args, tracerouteHostOf(ctx), (line) => lines.push(line));
    return lines.join('\n');
  },
};

export const traceroute6Command: LinuxCommand = {
  ...tracerouteCommand,
  name: 'traceroute6',
  usage: 'traceroute6 [ -dFITnreU ] [ -f first_ttl ] [ -i device ] [ -m max_ttl ] [ -N squeries ]'
    + ' [ -p port ] [ -t tos ] [ -l flow_label ] [ -w MAX ] [ -q nqueries ] [ -s src_addr ] [ -z sendwait ]'
    + ' [ -M method ] [ -P proto ] [ --sport=port ] host [ packetlen ]',

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const lines: string[] = [];
    await runTraceroute(tracerouteArgvOf('traceroute6', args), tracerouteHostOf(ctx), (line) => lines.push(line));
    return lines.join('\n');
  },
};
