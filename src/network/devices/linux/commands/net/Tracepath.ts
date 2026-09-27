import { IPAddress, IPv6Address } from '@/network/core/types';
import { strerror, type Errno } from '@/network/core/Errno';
import { UDP_OVER_IPV4_HEADER_BYTES } from '@/network/layers/transport/UdpEgress';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { UdpErrorReport } from '../../../EndHost';
import { makeArgCompleter } from '../completionHelpers';
import { getoptDiagnostic, shortOptions } from '../Getopt';
import { reverseNameOf } from '../../network/ReverseName';
import { INT_MAX, IPUTILS_VERSION_LINE, strtolOrErr } from './IputilsCommon';

const OPTSTRING = '46nbh?l:m:p:V';
const MAX_PROBES = 10;
const MAX_HOPS_DEFAULT = 30;
const MAX_HOPS_LIMIT = 255;
const HOST_COLUMN_SIZE = 52;
const HIS_ARRAY_SIZE = 64;
const DEFAULT_MTU_IPV4 = 65535;
const DEFAULT_BASEPORT = 44444;
const PROBE_WAIT_MS = 1000;

export const TRACEPATH_USAGE = [
  '',
  'Usage',
  '  tracepath [options] <destination>',
  '',
  'Options:',
  '  -4             use IPv4',
  '  -6             use IPv6',
  '  -b             print both name and ip',
  '  -l <length>    use packet <length>',
  '  -m <hops>      use maximum <hops>',
  '  -n             no dns name resolution',
  '  -p <port>      use destination <port>',
  '  -V             print version and exit',
  '  <destination>  dns name or ip address',
  '',
  'For more details see tracepath(8).',
].join('\n');

interface TracepathArgs {
  family: 4 | 6 | null;
  numeric: boolean;
  showBoth: boolean;
  mtu: number;
  maxHops: number;
  basePort: number;
  target: string;
}

interface TracepathResult {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

class TracepathExit extends Error {
  constructor(readonly stderr: string[], readonly exitCode: number, readonly stdout: string[] = []) {
    super(stderr.join('\n'));
  }
}

function usage(before: string[] = []): TracepathExit {
  return new TracepathExit([...before, TRACEPATH_USAGE], 255);
}

function numberOrExit(text: string, min: bigint, max: bigint): number {
  const r = strtolOrErr('tracepath', text, 'invalid argument', min, max);
  if ('error' in r) throw new TracepathExit([r.error], 1);
  return r.value;
}

export function parseTracepathArgs(args: readonly string[]): TracepathArgs {
  const parsed: TracepathArgs = {
    family: null, numeric: false, showBoth: false, mtu: 0, maxHops: MAX_HOPS_DEFAULT, basePort: 0, target: '',
  };
  const operands: string[] = [];
  for (const token of shortOptions(args, OPTSTRING)) {
    if (token.kind === 'operand') { operands.push(token.value); continue; }
    if (token.kind !== 'option') throw usage([getoptDiagnostic('tracepath', token)]);
    switch (token.letter) {
      case '4':
      case '6': {
        const family = token.letter === '4' ? 4 : 6;
        if (parsed.family !== null && parsed.family !== family) {
          throw new TracepathExit(['tracepath: Only one -4 or -6 option may be specified'], 2);
        }
        parsed.family = family;
        break;
      }
      case 'n': parsed.numeric = true; break;
      case 'b': parsed.showBoth = true; break;
      case 'l': parsed.mtu = numberOrExit(token.argument!, 0n, BigInt(INT_MAX)); break;
      case 'm': parsed.maxHops = numberOrExit(token.argument!, 0n, BigInt(MAX_HOPS_LIMIT)); break;
      case 'p': parsed.basePort = numberOrExit(token.argument!, 0n, 65535n); break;
      case 'V': throw new TracepathExit([], 0, [`tracepath ${IPUTILS_VERSION_LINE}`]);
      default: throw usage();
    }
  }
  if (operands.length !== 1) throw usage();
  let target = operands[0];
  if (parsed.basePort === 0) {
    const slash = target.indexOf('/');
    if (slash >= 0) {
      parsed.basePort = numberOrExit(target.slice(slash + 1), 0n, 65535n);
      target = target.slice(0, slash);
    } else {
      parsed.basePort = DEFAULT_BASEPORT;
    }
  }
  parsed.target = target;
  return parsed;
}

function formatRtt(rttMs: number): string {
  const us = Math.round(rttMs * 1000);
  return `${String(Math.trunc(us / 1000)).padStart(3)}.${String(us % 1000).padStart(3, '0')}ms `;
}

function returnHops(replyTtl: number | undefined): number {
  const ttl = replyTtl ?? -1;
  if (ttl <= 64) return 65 - ttl;
  if (ttl <= 128) return 129 - ttl;
  return 256 - ttl;
}

interface RunState {
  mtu: number;
  ttl: number;
  hisptr: number;
  hopsTo: number;
  hopsFrom: number;
}

async function runTracepath(ctx: LinuxCommandContext, args: string[]): Promise<TracepathResult> {
  const out: string[] = [];
  const err: string[] = [];
  let parsed: TracepathArgs;
  try {
    parsed = parseTracepathArgs(args);
  } catch (e) {
    if (e instanceof TracepathExit) return { stdout: e.stdout, stderr: e.stderr, exitCode: e.exitCode };
    throw e;
  }

  const literal4 = IPAddress.tryParse(parsed.target);
  const literal6 = literal4 ? null : IPv6Address.tryParse(parsed.target);
  if (parsed.family === 6 || literal6) {
    return { stdout: [], stderr: ['tracepath: option -6: this simulator cannot build an IPv6 probe socket with IPV6_RECVERR'], exitCode: 1 };
  }
  const target = literal4 ?? await ctx.net.resolveHostname(parsed.target);
  if (!target) {
    return { stdout: [], stderr: [`tracepath: ${parsed.target}: Name or service not known`], exitCode: 1 };
  }

  const state: RunState = { mtu: parsed.mtu || DEFAULT_MTU_IPV4, ttl: 1, hisptr: 0, hopsTo: -1, hopsFrom: -1 };
  if (state.mtu <= UDP_OVER_IPV4_HEADER_BYTES) {
    return {
      stdout: [], stderr: [`tracepath: pktlen must be within: ${UDP_OVER_IPV4_HEADER_BYTES} < value <= ${INT_MAX}`], exitCode: 1,
    };
  }
  const sourcePort = ctx.executor.getSocketTable()?.allocateEphemeralPort() ?? 32768;

  const hostColumn = (address: string): string => {
    const name = parsed.numeric && !parsed.showBoth ? '' : reverseNameOf(ctx.executor.nss, address) ?? address;
    const shown = parsed.numeric
      ? `${address}${parsed.showBoth ? ` (${name})` : ''}`
      : `${name}${parsed.showBoth ? ` (${address})` : ''}`;
    const width = Math.min(shown.length, HOST_COLUMN_SIZE - 1);
    return shown + ' '.repeat(HOST_COLUMN_SIZE - width);
  };

  const recverr = (report: UdpErrorReport, sentTtl: number): number => {
    if (report.origin === 'none') return -1;
    if (report.origin === 'local' && report.errno !== 'EMSGSIZE') return -1;
    let line: string;
    if (report.origin === 'local') {
      line = `${String(state.ttl).padStart(2)}?: ${'[LOCALHOST]'.padEnd(32)} `;
    } else {
      line = `${String(sentTtl).padStart(2)}:  ${hostColumn(report.from)}${formatRtt(report.rttMs)}`;
    }
    const rethops = report.origin === 'icmp' ? returnHops(report.replyTtl) : returnHops(undefined);
    const errno: Errno = report.errno;
    switch (errno) {
      case 'EMSGSIZE':
        state.mtu = report.mtu ?? state.mtu;
        out.push(`${line}pmtu ${state.mtu}`);
        return state.mtu;
      case 'ECONNREFUSED':
        out.push(`${line}reached`);
        state.hopsTo = sentTtl;
        state.hopsFrom = rethops;
        return 0;
      case 'EPROTO':
        out.push(`${line}!P`);
        return 0;
      case 'EHOSTUNREACH':
        if (report.origin === 'icmp' && report.timeExceeded) {
          const asymm = rethops >= 0 && rethops !== sentTtl ? `asymm ${String(rethops).padStart(2)} ` : '';
          out.push(`${line}${asymm}`);
          return state.mtu;
        }
        out.push(`${line}!H`);
        return 0;
      case 'ENETUNREACH':
        out.push(`${line}!N`);
        return 0;
      case 'EACCES':
        out.push(`${line}!A`);
        return 0;
      default:
        out.push(line);
        err.push(`tracepath: NET ERROR: ${strerror(errno)}`);
        return 0;
    }
  };

  const probeTtl = async (): Promise<number> => {
    let attempt = 0;
    while (attempt < MAX_PROBES) {
      const port = parsed.basePort + state.hisptr;
      const report = await ctx.net.udpErrorProbe(target, {
        destinationPort: port, sourcePort, ttl: state.ttl,
        payloadBytes: state.mtu - UDP_OVER_IPV4_HEADER_BYTES, timeoutMs: PROBE_WAIT_MS,
      });
      if (report.origin !== 'local') {
        state.hisptr = (state.hisptr + 1) & (HIS_ARRAY_SIZE - 1);
        return recverr(report, state.ttl);
      }
      const res = recverr(report, state.ttl);
      if (res === 0) return 0;
      if (res > 0) { attempt = 0; continue; }
      attempt++;
    }
    state.hisptr = (state.hisptr + 1) & (HIS_ARRAY_SIZE - 1);
    out.push(`${String(state.ttl).padStart(2)}:  send failed`);
    return 0;
  };

  let done = false;
  for (state.ttl = 1; state.ttl <= parsed.maxHops && !done; state.ttl++) {
    let res = -1;
    for (let i = 0; i < 3; i++) {
      const oldMtu = state.mtu;
      res = await probeTtl();
      if (state.mtu !== oldMtu) { i = -1; continue; }
      if (res === 0) { done = true; break; }
      if (res > 0) break;
    }
    if (done) break;
    if (res < 0) out.push(`${String(state.ttl).padStart(2)}:  no reply`);
  }
  if (!done) out.push(`     Too many hops: pmtu ${state.mtu}`);
  out.push(`     Resume: pmtu ${state.mtu} ${state.hopsTo >= 0 ? `hops ${state.hopsTo} ` : ''}`
    + `${state.hopsFrom >= 0 ? `back ${state.hopsFrom} ` : ''}`);
  return { stdout: out, stderr: err, exitCode: 0 };
}

export const tracepathCommand: LinuxCommand = {
  name: 'tracepath',
  needsNetworkContext: true,
  ownsHelpOption: true,
  manSection: 8,
  usage: 'tracepath [options] <destination>',
  help: 'Traces path to a network host discovering MTU along this path.',
  helpText: TRACEPATH_USAGE,
  options: [
    { flag: '-n', description: 'no dns name resolution' },
    { flag: '-b', description: 'print both name and ip' },
    { flag: '-m', description: 'use maximum <hops>', takesArg: true, argName: 'hops' },
    { flag: '-l', description: 'use packet <length>', takesArg: true, argName: 'length' },
    { flag: '-p', description: 'use destination <port>', takesArg: true, argName: 'port' },
  ],
  complete: makeArgCompleter({ flags: ['-4', '-6', '-b', '-l', '-m', '-n', '-p', '-V'], hostsAtBarePosition: true }),
  run: async (ctx, args) => {
    const result = await runTracepath(ctx, args);
    return [...result.stdout, ...result.stderr].join('\n');
  },
  runWithStatus: async (ctx, args) => {
    const result = await runTracepath(ctx, args);
    return { output: result.stdout.join('\n'), stderr: result.stderr.join('\n'), exitCode: result.exitCode };
  },
};
