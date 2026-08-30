import { formatPingFailureLine, formatPingStats } from '@/network/devices/linux/LinuxFormatHelpers';
import { IPv6Address, IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { PingResult } from '../../../EndHost';
import { isValidIPv4 } from '@/network/core/ip';

const IPUTILS_VERSION = 'ping utility, iputils-s20221126, https://github.com/iputils/iputils/';
const DEFAULT_SIZE = 56;
// This default is only actually used by the non-interactive `runPing()`
// below, which loops `parsed.count` times synchronously and returns — it
// cannot support real "continuous until Ctrl+C" (there's no interactive
// context to interrupt it, so 0/infinite would hang forever). The
// interactive terminal path (`LinuxTerminalSession.tryStartPingStream`)
// overrides this to the real Linux "continuous by default" behavior
// itself, using `countGiven` to tell "no -c" apart from an explicit one.
const DEFAULT_COUNT = 4;
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_INTERVAL_MS = 1000;
const MIN_UNPRIVILEGED_INTERVAL_MS = 200;
const DEFAULT_MTU = 1500;
const ICMP_HEADER_SIZE = 8;
const IP_HEADER_SIZE = 20;

const PING_USAGE = `Usage: ping [-aAbBdDfhLnOqrRUvV64] [-c count] [-i interval] [-I interface]
            [-M pmtudisc_opt] [-p pattern] [-s packetsize] [-S sndbuf]
            [-t ttl] [-w deadline] [-W timeout] destination

Options:
  -c count         Stop after sending count ECHO_REQUEST packets.
  -s packetsize    Specifies the number of data bytes to be sent.
  -t ttl           Set the IP Time to Live.
  -w deadline      Time to wait before exiting, regardless of packet count.
  -W timeout       Time to wait for a response, in seconds.
  -i interval      Wait interval seconds between sending each packet.
  -I interface     Set source address to specified interface address.
  -p pattern       Fill ECHO_REQUEST packet with given hex pattern.
  -q               Quiet output (only summary at end).
  -v               Verbose output.
  -n               Numeric output only.
  -D               Print timestamp (unix time) before each line.
  -b               Allow pinging a broadcast address.
  -M pmtudisc_opt  Select Path MTU Discovery strategy: do, want, dont.
  -f               Flood ping. Root privilege required.
  -L               Suppress loopback of multicast packets. (deprecated)
  -V               Print version and exit.
  -4               Use IPv4 only.
  -6               Use IPv6 only.
`.trim();

export interface ParsedPingArgs {
  count: number;
  /** True once `-c` has been explicitly given — lets callers that support
   *  real unbounded pinging (the interactive terminal) tell "no -c" apart
   *  from a defaulted `count`, instead of treating both the same way. */
  countGiven: boolean;
  ttl?: number;
  size: number;
  timeoutMs: number;
  intervalMs: number;
  /** `-w deadline` — stop after this many milliseconds, regardless of `-c`. */
  deadlineMs?: number;
  targetStr: string;
  /** True once a destination positional argument has been seen — distinguishes "omitted" from "given as an empty string". */
  targetGiven: boolean;
  v6: boolean;
  iface?: string;
  pattern?: string;
  quiet: boolean;
  verbose: boolean;
  numeric: boolean;
  timestamp: boolean;
  broadcast: boolean;
  mtuDisc?: 'do' | 'want' | 'dont';
  flood: boolean;
  showVersion: boolean;
  showHelp: boolean;
  parseError?: string;
  extraTargets: string[];
}

function isValidHexPattern(p: string): boolean {
  return /^[0-9a-fA-F]+$/.test(p) && p.length > 0;
}

function isBroadcastAddress(ip: string): boolean {
  if (ip === '255.255.255.255') return true;
  return /\.255$/.test(ip);
}

export function parsePingArgs(args: string[], cmdName: 'ping' | 'ping6' = 'ping'): ParsedPingArgs {
  const result: ParsedPingArgs = {
    count: DEFAULT_COUNT,
    countGiven: false,
    size: DEFAULT_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    targetStr: '',
    targetGiven: false,
    v6: cmdName === 'ping6',
    quiet: false,
    verbose: false,
    numeric: false,
    timestamp: false,
    broadcast: false,
    flood: false,
    showVersion: false,
    showHelp: false,
    extraTargets: [],
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];

    if (a === '-V') { result.showVersion = true; continue; }
    if (a === '-h' || a === '--help') { result.showHelp = true; continue; }
    if (a === '-q') { result.quiet = true; continue; }
    if (a === '-v') { result.verbose = true; continue; }
    if (a === '-n') { result.numeric = true; continue; }
    if (a === '-D') { result.timestamp = true; continue; }
    if (a === '-b') { result.broadcast = true; continue; }
    if (a === '-f') { result.flood = true; continue; }
    if (a === '-L') { continue; }
    if (a === '-4') { result.v6 = false; continue; }
    if (a === '-6') { result.v6 = true; continue; }

    if (a === '-c') {
      if (!next) { result.parseError = 'ping: option requires an argument -- c\n' + PING_USAGE; return result; }
      const v = parseInt(next, 10);
      if (isNaN(v) || String(parseInt(next, 10)) !== next.replace(/^-/, '-')) {
        result.parseError = `ping: invalid argument: '${next}'`; return result;
      }
      if (v <= 0) {
        result.parseError = `ping: invalid argument: '${next}' (must be > 0)`; return result;
      }
      result.count = v; result.countGiven = true; i++; continue;
    }

    if (a === '-s') {
      if (!next) { result.parseError = 'ping: option requires an argument -- s\n' + PING_USAGE; return result; }
      const v = parseInt(next, 10);
      if (isNaN(v) || !Number.isInteger(parseFloat(next))) {
        result.parseError = `ping: invalid argument: '${next}'`; return result;
      }
      if (v < 0) {
        result.parseError = `ping: invalid argument: '${next}' (must be >= 0)`; return result;
      }
      result.size = v; i++; continue;
    }

    if (a === '-t') {
      if (!next) { result.parseError = 'ping: option requires an argument -- t\n' + PING_USAGE; return result; }
      const v = parseInt(next, 10);
      if (isNaN(v) || !Number.isInteger(parseFloat(next))) {
        result.parseError = `ping: invalid argument: '${next}'`; return result;
      }
      if (v < 1 || v > 255) {
        result.parseError = `ping: invalid argument: '${next}' for option -t (valid range: 1-255)`; return result;
      }
      result.ttl = v; i++; continue;
    }

    if (a === '-W') {
      if (!next) { result.parseError = 'ping: option requires an argument -- W\n' + PING_USAGE; return result; }
      const v = parseFloat(next);
      if (isNaN(v) || !/^[\d.]+$/.test(next)) {
        result.parseError = `ping: invalid argument: '${next}'`; return result;
      }
      result.timeoutMs = Math.round(v * 1000); i++; continue;
    }

    if (a === '-i') {
      if (!next) { result.parseError = 'ping: option requires an argument -- i\n' + PING_USAGE; return result; }
      const v = parseFloat(next);
      if (isNaN(v) || !/^[\d.]+$/.test(next)) {
        result.parseError = `ping: invalid argument: '${next}'`; return result;
      }
      result.intervalMs = Math.round(v * 1000); i++; continue;
    }

    if (a === '-w') {
      if (!next) { result.parseError = 'ping: option requires an argument -- w\n' + PING_USAGE; return result; }
      const v = parseFloat(next);
      if (isNaN(v) || !/^[\d.]+$/.test(next)) {
        result.parseError = `ping: invalid argument: '${next}'`; return result;
      }
      result.deadlineMs = Math.round(v * 1000); i++; continue;
    }

    if (a === '-I') {
      if (!next) { result.parseError = 'ping: option requires an argument -- I\n' + PING_USAGE; return result; }
      if ((next.startsWith('"') && !next.endsWith('"')) ||
          (next.startsWith("'") && !next.endsWith("'"))) {
        result.parseError = `ping: invalid syntax — unclosed quote in interface name '${next}'`; return result;
      }
      result.iface = next; i++; continue;
    }

    if (a === '-p') {
      if (next === undefined) { result.parseError = 'ping: option requires an argument -- p\n' + PING_USAGE; return result; }
      if (next === '') {
        result.parseError = `ping: invalid argument: pattern cannot be empty`; return result;
      }
      if (!isValidHexPattern(next)) {
        result.parseError = `ping: invalid argument: '${next}' for option -p (must be hex digits)`; return result;
      }
      result.pattern = next.toLowerCase(); i++; continue;
    }

    if (a === '-M') {
      if (!next) { result.parseError = 'ping: option requires an argument -- M\n' + PING_USAGE; return result; }
      if (next !== 'do' && next !== 'want' && next !== 'dont') {
        result.parseError = `ping: invalid argument: '${next}' for option -M (valid: do, want, dont)`; return result;
      }
      result.mtuDisc = next as 'do' | 'want' | 'dont'; i++; continue;
    }

    if (a.startsWith('-')) {
      continue;
    }

    if (!result.targetGiven) {
      result.targetStr = a;
      result.targetGiven = true;
    } else {
      result.extraTargets.push(a);
    }
  }

  return result;
}

function formatPingHeader(target: string, size: number, hostname?: string): string {
  const totalSize = size + IP_HEADER_SIZE + ICMP_HEADER_SIZE;
  const displayName = hostname ?? target;
  return `PING ${displayName} (${target}) ${size}(${totalSize}) bytes of data.`;
}

function formatReplyLine(r: PingResult, size: number, timestamp: boolean): string {
  const replySize = size + ICMP_HEADER_SIZE;
  let line: string;
  if (r.success) {
    const ms = r.rttMs.toFixed(3);
    line = `${replySize} bytes from ${r.fromIP}: icmp_seq=${r.seq} ttl=${r.ttl} time=${ms} ms`;
  } else {
    const echec = formatPingFailureLine(r);
    if (!echec) return '';
    line = echec;
  }
  if (timestamp) {
    const ts = (Date.now() / 1000).toFixed(6);
    return `[${ts}] ${line}`;
  }
  return line;
}


async function runPing(
  ctx: LinuxCommandContext,
  args: string[],
  cmdName: 'ping' | 'ping6',
): Promise<string> {
  const parsed = parsePingArgs(args, cmdName);

  if (parsed.showVersion) return IPUTILS_VERSION;
  if (parsed.showHelp) return PING_USAGE;
  if (parsed.parseError) return parsed.parseError;

  if (parsed.extraTargets.length > 0) {
    return `ping: invalid argument: '${parsed.extraTargets[0]}'`;
  }

  if (!parsed.targetGiven) return `Usage: ping [-c count] [-t ttl] [-s size] <destination>\n\n${PING_USAGE}`;
  const rawTarget = parsed.targetStr.replace(/^['"]|['"]$/g, '').trim();
  if (rawTarget === '') {
    return `ping: invalid argument: empty hostname`;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(rawTarget) && !isValidIPv4(rawTarget)) {
    return `ping: invalid address: ${rawTarget}`;
  }

  const isRoot = ctx.executor.userMgr.currentUid === 0;

  if (parsed.flood && !isRoot) {
    return 'ping: -f flood: Permission denied (privileged operation, must run as root)';
  }
  if (parsed.intervalMs < MIN_UNPRIVILEGED_INTERVAL_MS && !parsed.flood && !isRoot) {
    return `ping: -i ${(parsed.intervalMs / 1000).toFixed(1)}: Permission denied (privileged operation, interval < 200ms requires root)`;
  }

  if (parsed.iface) {
    const ports = ctx.net.getPorts();
    if (!ports.has(parsed.iface)) {
      return `ping: ${parsed.iface}: invalid argument — device not found`;
    }
  }

  {
    const ports = ctx.net.getPorts();
    const primary = ports.get('eth0');
    if (primary && !primary.getIsUp()) {
      return `ping: connect: Network is unreachable`;
    }
  }

  const dfSet = parsed.mtuDisc === 'do' || parsed.mtuDisc === 'want';
  const totalPktSize = parsed.size + IP_HEADER_SIZE + ICMP_HEADER_SIZE;

  // The kernel knows its own outbound interface MTU before ever sending, so
  // a locally-oversized DF packet is refused without touching the wire —
  // but path MTU beyond this host is genuinely unknown until a router along
  // the way replies with Fragmentation Needed (RFC 1191), so that part is
  // left to the real send/receive path below, not guessed from every
  // device's MTU in the topology.
  if (dfSet) {
    let pathMtu = DEFAULT_MTU;
    const ports = ctx.net.getPorts();
    if (parsed.iface && ports.has(parsed.iface)) {
      const p = ports.get(parsed.iface)!;
      pathMtu = p.getMTU();
    } else if (ports.size > 0) {
      for (const [name, p] of ports) {
        if (name !== 'lo') { pathMtu = p.getMTU(); break; }
      }
    }
    if (totalPktSize > pathMtu) {
      return `ping: local error: Message too long, mtu=${pathMtu}`;
    }
  }

  if (parsed.v6 || rawTarget.includes(':')) {
    const targetIP6 = await ctx.net.resolveHostname6(rawTarget);
    if (!targetIP6) {
      return `${cmdName}: ${rawTarget}: Name or service not known`;
    }
    const results = await ctx.net.ping6Sequence(targetIP6, parsed.count, parsed.timeoutMs);
    const isHostname6 = rawTarget !== targetIP6.toString();
    return ctx.fmt.formatPing6Output(targetIP6, parsed.count, results, parsed.size, isHostname6 ? rawTarget : undefined);
  }

  const targetIP = await ctx.net.resolveHostname(rawTarget);
  if (!targetIP) {
    return `${cmdName}: ${rawTarget}: Name or service not known`;
  }

  const targetStr = targetIP.toString();
  if (isBroadcastAddress(targetStr) && !parsed.broadcast) {
    return `WARNING: pinging broadcast address ${targetStr}\n` +
           `Do you want to ping broadcast? Then -b. If not, check your command.`;
  }

  if (dfSet && totalPktSize > DEFAULT_MTU) {
    return `ping: local error: Message too long, mtu=${DEFAULT_MTU}`;
  }

  if (!ctx.net.hasRoute(targetIP)) {
    return `ping: connect: Network is unreachable`;
  }

  const isHostname = rawTarget !== targetStr;
  // -f sends as fast as the wire allows instead of waiting -i seconds
  // between echoes — that's the whole point of a flood ping.
  const sendIntervalMs = parsed.flood ? 0 : parsed.intervalMs;
  // Real ping only sets DF when explicitly asked (-M do/want) — unlike this
  // simulator's IPv4 default (DF set unless told otherwise), so this always
  // states the bit explicitly instead of falling through to that default.
  const dfOverride = dfSet;
  const results: PingResult[] = [];
  for (let seq = 1; seq <= parsed.count; seq++) {
    const batch = await ctx.net.pingSequence(
      targetIP, 1, parsed.timeoutMs, parsed.ttl,
      { dataSize: parsed.size, df: dfOverride },
    );
    if (batch.length > 0) {
      results.push({ ...batch[0], seq });
    } else {
      results.push({ success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '', error: 'Destination unreachable' });
    }
    if (seq < parsed.count && sendIntervalMs > 0) {
      await ctx.net.getScheduler().delay(sendIntervalMs);
    }
  }

  return formatPingOutput(targetStr, parsed.count, results, parsed, isHostname ? rawTarget : undefined);
}

function formatPingOutput(
  targetStr: string,
  count: number,
  results: PingResult[],
  opts: ParsedPingArgs,
  hostname?: string,
): string {
  const { size, quiet, timestamp, pattern } = opts;
  const lines: string[] = [formatPingHeader(targetStr, size, hostname)];

  if (pattern) {
    lines.push(`PATTERN: 0x${pattern}`);
  }

  if (results.length === 0) {
    lines.push('connect: Network is unreachable');
  } else if (!quiet) {
    for (const r of results) {
      const line = formatReplyLine(r, size, timestamp);
      if (line) lines.push(line);
    }
  }

  lines.push(...formatPingStats(targetStr, count, results));
  return lines.join('\n');
}

const PING_FLAGS_LIST = [
  '-c', '-s', '-t', '-w', '-W', '-i', '-I', '-p', '-q', '-v', '-n',
  '-D', '-b', '-M', '-f', '-L', '-V', '-h', '-4', '-6',
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
  manSection: 8,
  usage: 'ping [-aAbBdDfhLnOqrRUvV64] [-c count] [-i interval] [-I interface] [-M pmtudisc_opt] [-p pattern] [-s packetsize] [-t ttl] [-w deadline] [-W timeout] destination',
  help: 'Send ICMP ECHO_REQUEST packets to network hosts.',
  options: [
    { flag: '-c', description: 'Stop after sending count packets.', takesArg: true, argName: 'count' },
    { flag: '-s', description: 'Specifies the number of data bytes to be sent (default 56).', takesArg: true, argName: 'packetsize' },
    { flag: '-t', description: 'Set the IP Time to Live.', takesArg: true, argName: 'ttl' },
    { flag: '-w', description: 'Stop after deadline seconds, regardless of packets sent/received.', takesArg: true, argName: 'deadline' },
    { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Wait interval seconds between packets (default 1).', takesArg: true, argName: 'interval' },
    { flag: '-I', description: 'Bind to a specific interface address.', takesArg: true, argName: 'interface' },
    { flag: '-p', description: 'Fill ECHO_REQUEST packet with given hex pattern.', takesArg: true, argName: 'pattern' },
    { flag: '-M', description: 'Select Path MTU Discovery strategy (do/want/dont).', takesArg: true, argName: 'pmtudisc_opt' },
    { flag: '-q', description: 'Quiet output (only summary at end).' },
    { flag: '-D', description: 'Print Unix timestamp before each line.' },
    { flag: '-b', description: 'Allow pinging a broadcast address.' },
    { flag: '-f', description: 'Flood ping. Root privilege required.' },
    { flag: '-V', description: 'Print version and exit.' },
    { flag: '-4', description: 'Use IPv4.' },
    { flag: '-6', description: 'Use IPv6.' },
  ],

  complete: completePingFlags,

  run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    for (const sc of ['socket', 'connect', 'bind', 'sendto', 'recvfrom', 'close']) {
      ctx.executor.publishAuditSyscall(sc);
    }
    return runPing(ctx, args, 'ping');
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    const output = await pingCommand.run(ctx, args) as string;
    return { output, exitCode: pingExitCode(output) };
  },
};

export function pingExitCode(output: string): number {
  const received = /(\d+) (?:packets )?received/.exec(output);
  if (received) return Number(received[1]) > 0 ? 0 : 1;
  return 2;
}

export const ping6Command: LinuxCommand = {
  name: 'ping6',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ping6 [-c count] [-s size] [-W timeout] [-i interval] <destination>',
  help: 'Send ICMPv6 ECHO_REQUEST packets to network hosts (alias for ping -6).',
  options: [
    { flag: '-c', description: 'Stop after sending count packets.', takesArg: true, argName: 'count' },
    { flag: '-s', description: 'ICMP payload size in bytes (default 56).', takesArg: true, argName: 'size' },
    { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Wait interval seconds between packets.', takesArg: true, argName: 'interval' },
  ],

  complete: completePingFlags,

  run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return runPing(ctx, args, 'ping6');
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    const output = await ping6Command.run(ctx, args) as string;
    return { output, exitCode: pingExitCode(output) };
  },
};
