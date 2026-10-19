import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import type { ConnectionStatistics, ConnectionTracker, ConnectionTuple, FlowView } from '../../ConnectionTracker';
import { IP_PROTO_ICMP, IP_PROTO_ICMPV6, IPAddress, IPv6Address } from '../../../../core/types';
import { IP_PROTO_GRE } from '../../../../gre/types';
import {
  CONNTRACK_VERSION, STATUS_ASSURED, STATUS_SEEN_REPLY, parseConntrack,
  type AddressFilter, type AddressRole, type ConntrackFilter, type ProtocolOptionName,
} from './ConntrackArguments';

const CONNTRACK_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-L', aliases: ['--dump'], dest: 'dump', description: 'List conntrack or expectation table' },
  { flag: '-D', aliases: ['--delete'], dest: 'delete', description: 'Delete conntrack entries' },
  { flag: '-F', aliases: ['--flush'], dest: 'flush', description: 'Flush table' },
  { flag: '-C', aliases: ['--counter'], dest: 'count', description: 'Show counter' },
  { flag: '-S', aliases: ['--stats'], dest: 'stats', description: 'Show statistics' },
  { flag: '-V', aliases: ['--version'], dest: 'version', description: 'Show version' },
  { flag: '-s', aliases: ['--src', '--orig-src'], dest: 'src', takesArg: true, argName: 'ip', description: 'Source address from original direction' },
  { flag: '-d', aliases: ['--dst', '--orig-dst'], dest: 'dst', takesArg: true, argName: 'ip', description: 'Destination address from original direction' },
  { flag: '-r', aliases: ['--reply-src'], dest: 'reply-src', takesArg: true, argName: 'ip', description: 'Source address from reply direction' },
  { flag: '-q', aliases: ['--reply-dst'], dest: 'reply-dst', takesArg: true, argName: 'ip', description: 'Destination address from reply direction' },
  { flag: '-p', aliases: ['--protonum'], dest: 'protonum', takesArg: true, argName: 'proto', description: 'Layer 4 Protocol, eg. \'tcp\'' },
  { flag: '-f', aliases: ['--family'], dest: 'family', takesArg: true, argName: 'proto', description: 'Layer 3 Protocol, eg. \'ipv6\'' },
  { flag: '-u', aliases: ['--status'], dest: 'status', takesArg: true, argName: 'status', description: 'Set status, eg. ASSURED' },
  { flag: '-m', aliases: ['--mark'], dest: 'mark', takesArg: true, argName: 'mark', description: 'Mark of the flow' },
  { flag: '-o', aliases: ['--output'], dest: 'output', takesArg: true, argName: 'type', description: 'Output format, eg. extended' },
];

const PROTOCOL_NAMES: Readonly<Record<number, string>> = {
  6: 'tcp', 17: 'udp', 136: 'udplite', 1: 'icmp', 58: 'icmpv6', 132: 'sctp', 47: 'gre', 33: 'dccp',
};

const PORT_PROTOCOLS: ReadonlySet<number> = new Set([6, 17, 136, 132, 33]);

const STATISTIC_ORDER = [
  'found', 'invalid', 'insert', 'insert_failed', 'drop', 'early_drop', 'error', 'search_restart', 'clash_resolve', 'chaintoolong',
] as const;

const EXPECTATION_STATISTIC_ORDER = ['expect_new', 'expect_create', 'expect_delete'] as const;

const USAGE = [
  'Command line interface for the connection tracking system. Version 1.4.7',
  'Usage: conntrack [commands] [options]',
  '',
  'Commands:',
  '  -L [table] [options]\t\tList conntrack or expectation table',
  '  -G [table] parameters\t\tGet conntrack or expectation',
  '  -D [table] parameters\t\tDelete conntrack or expectation',
  '  -I [table] parameters\t\tCreate a conntrack or expectation',
  '  -U [table] parameters\t\tUpdate a conntrack',
  '  -E [table] [options]\t\tShow events',
  '  -F [table]\t\t\tFlush table',
  '  -C [table]\t\t\tShow counter',
  '  -S\t\t\t\tShow statistics',
  '',
  'Tables: conntrack, expect, dying, unconfirmed',
  '',
  'Conntrack parameters and options:',
  '  -n, --src-nat ip\t\t\tsource NAT ip',
  '  -g, --dst-nat ip\t\t\tdestination NAT ip',
  '  -j, --any-nat ip\t\t\tsource or destination NAT ip',
  '  -m, --mark mark\t\t\tSet mark',
  '  -c, --secmark secmark\t\t\tSet selinux secmark',
  '  -e, --event-mask eventmask\t\tEvent mask, eg. NEW,DESTROY',
  '  -z, --zero \t\t\t\tZero counters while listing',
  '  -o, --output type[,...]\t\tOutput format, eg. xml',
  '  -l, --label label[,...]\t\tconntrack labels',
  '',
  'Expectation parameters and options:',
  '  --tuple-src ip\tSource address in expect tuple',
  '  --tuple-dst ip\tDestination address in expect tuple',
  '',
  'Updating parameters and options:',
  '  --label-add label\tAdd label',
  '  --label-del label\tDelete label',
  '',
  'Common parameters and options:',
  '  -s, --src, --orig-src ip\t\tSource address from original direction',
  '  -d, --dst, --orig-dst ip\t\tDestination address from original direction',
  '  -r, --reply-src ip\t\tSource addres from reply direction',
  '  -q, --reply-dst ip\t\tDestination address from reply direction',
  "  -p, --protonum proto\t\tLayer 4 Protocol, eg. 'tcp'",
  "  -f, --family proto\t\tLayer 3 Protocol, eg. 'ipv6'",
  '  -t, --timeout timeout\t\tSet timeout',
  '  -u, --status status\t\tSet status, eg. ASSURED',
  '  -w, --zone value\t\tSet conntrack zone',
  '  --orig-zone value\t\tSet zone for original direction',
  '  --reply-zone value\t\tSet zone for reply direction',
  '  -b, --buffer-size\t\tNetlink socket buffer size',
  '  --mask-src ip\t\t\tSource mask address',
  '  --mask-dst ip\t\t\tDestination mask address',
  '',
].join('\n');

function protocolName(protocol: number): string {
  return PROTOCOL_NAMES[protocol] ?? 'unknown';
}

function withoutZone(address: string): string {
  return address.split('%')[0];
}

function tupleText(tuple: ConnectionTuple): string {
  const addresses = `src=${withoutZone(tuple.srcIP)} dst=${withoutZone(tuple.dstIP)}`;
  if (PORT_PROTOCOLS.has(tuple.protocol)) return `${addresses} sport=${tuple.srcPort} dport=${tuple.dstPort}`;
  if (tuple.protocol === IP_PROTO_GRE) return `${addresses} srckey=0x${tuple.srcPort.toString(16)} dstkey=0x${tuple.dstPort.toString(16)}`;
  if (tuple.protocol === IP_PROTO_ICMP || tuple.protocol === IP_PROTO_ICMPV6) {
    return `${addresses} type=${tuple.icmpType ?? 0} code=${tuple.icmpCode ?? 0} id=${tuple.icmpId ?? 0}`;
  }
  return addresses;
}

function flowLine(flow: FlowView, family: 4 | 6, extended: boolean): string {
  const protocol = flow.original.protocol;
  return [
    ...(extended ? [`${padToWidth(family === 4 ? 'ipv4' : 'ipv6', 8)} ${family === 4 ? 2 : 10}`] : []),
    `${padToWidth(protocolName(protocol), 8)} ${protocol}`,
    String(Math.floor(flow.remainingMs / 1000)),
    ...(flow.tcpState === null ? [] : [flow.tcpState]),
    tupleText(flow.original),
    ...(flow.replied ? [] : ['[UNREPLIED]']),
    tupleText(flow.reply),
    ...(flow.assured ? ['[ASSURED]'] : []),
    `mark=${flow.mark}`,
    'use=1',
  ].join(' ');
}

function statisticsLines(cpus: number, names: readonly string[], totals: Readonly<Record<string, number>>): string {
  return Array.from({ length: cpus }, (_, cpu) => (
    `cpu=${padToWidth(String(cpu), 4)}\t${names.map((name) => `${name}=${cpu === 0 ? totals[name] ?? 0 : 0} `).join('')}`
  )).join('\n');
}

function summed(parts: readonly ConnectionStatistics[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const part of parts) for (const [name, value] of Object.entries(part)) total[name] = (total[name] ?? 0) + value;
  return total;
}

type Address = IPAddress | IPv6Address;

function groupsOf(address: Address): readonly number[] {
  return address instanceof IPv6Address ? address.getHextets() : address.toString().split('.').map(Number);
}

function maskGroups(prefix: number, groups: number, width: number): readonly number[] {
  return Array.from({ length: groups }, (_, index) => {
    const bits = Math.max(0, Math.min(width, prefix - index * width));
    return bits === 0 ? 0 : ((2 ** width - 1) << (width - bits)) & (2 ** width - 1);
  });
}

function parsedAddress(text: string): Address | null {
  const bare = withoutZone(text);
  return IPAddress.tryParse(bare) ?? IPv6Address.tryParse(bare);
}

function sameNetwork(flowAddress: string, wanted: Address, mask: readonly number[] | null): boolean {
  const actual = parsedAddress(flowAddress);
  if (actual === null || (actual instanceof IPv6Address) !== (wanted instanceof IPv6Address)) return false;
  const left = groupsOf(actual);
  const right = groupsOf(wanted);
  return left.every((group, index) => (group & (mask?.[index] ?? -1)) === (right[index] & (mask?.[index] ?? -1)));
}

function addressMatches(flowAddress: string, role: AddressRole, filter: ConntrackFilter): boolean {
  const wanted: AddressFilter | undefined = filter.addresses.get(role);
  const maskKey = role === 'src' ? 'mask-src' : role === 'dst' ? 'mask-dst' : null;
  const maskAddress = maskKey === null ? undefined : filter.masks.get(maskKey);
  if (wanted === undefined && maskAddress === undefined) return true;
  const base = wanted?.address ?? (maskAddress instanceof IPv6Address ? new IPv6Address('::') : new IPAddress('0.0.0.0'));
  const wide = base instanceof IPv6Address;
  const mask = maskAddress !== undefined
    ? groupsOf(maskAddress)
    : wanted?.prefix === null || wanted === undefined ? null : maskGroups(wanted.prefix, wide ? 8 : 4, wide ? 16 : 8);
  return sameNetwork(flowAddress, base, mask);
}

const PROTOCOL_VALUE_OF_FLOW: Readonly<Record<ProtocolOptionName, ((flow: FlowView) => number | undefined) | undefined>> = {
  sport: (flow) => flow.original.srcPort, dport: (flow) => flow.original.dstPort,
  'reply-port-src': (flow) => flow.reply.srcPort, 'reply-port-dst': (flow) => flow.reply.dstPort,
  srckey: (flow) => flow.original.srcPort, dstkey: (flow) => flow.original.dstPort,
  'reply-key-src': (flow) => flow.reply.srcPort, 'reply-key-dst': (flow) => flow.reply.dstPort,
  'icmp-type': (flow) => flow.original.icmpType, 'icmp-code': (flow) => flow.original.icmpCode,
  'icmp-id': (flow) => flow.original.icmpId,
  'mask-port-src': undefined, 'mask-port-dst': undefined, 'tuple-port-src': undefined, 'tuple-port-dst': undefined,
  state: undefined, 'mask-key-src': undefined, 'mask-key-dst': undefined, 'tuple-key-src': undefined, 'tuple-key-dst': undefined,
};

function flowMatches(flow: FlowView, filter: ConntrackFilter): boolean {
  if (filter.protocol !== null && flow.original.protocol !== filter.protocol) return false;
  if (!addressMatches(flow.original.srcIP, 'src', filter) || !addressMatches(flow.original.dstIP, 'dst', filter)) return false;
  if (!addressMatches(flow.reply.srcIP, 'reply-src', filter) || !addressMatches(flow.reply.dstIP, 'reply-dst', filter)) return false;
  if (filter.status !== null) {
    const status = (flow.replied ? STATUS_SEEN_REPLY : 0) | (flow.assured ? STATUS_ASSURED : 0);
    if ((status & filter.status.mask) !== filter.status.value) return false;
  }
  if (filter.mark !== null && ((flow.mark & filter.mark.mask) >>> 0) !== filter.mark.value) return false;
  for (const zone of filter.zones.values()) if (zone !== 0) return false;
  if (filter.tcpState !== null && flow.tcpState !== filter.tcpState) return false;
  for (const [name, wanted] of filter.protocolValues) {
    if (PROTOCOL_VALUE_OF_FLOW[name]?.(flow) !== wanted) return false;
  }
  return true;
}

export function runConntrack(
  ctx: LinuxCommandContext, args: string[],
): { output: string; exitCode: number } {
  const outcome = parseConntrack(args);
  if (outcome.kind === 'refused') return outcome.refusal;
  const { command, table, filter, extendedOutput } = outcome.parsed;

  if (command === 'version') return { output: CONNTRACK_VERSION, exitCode: 0 };
  if (command === 'help') return { output: USAGE, exitCode: 0 };

  const everyTracker: readonly (readonly [4 | 6, ConnectionTracker])[] = [
    [4, ctx.executor.iptables.connections], [6, ctx.executor.ip6tables.connections],
  ];
  const trackers = everyTracker.filter(([family]) => filter.family === null || filter.family === family);
  const message = (text: string): string => `${CONNTRACK_VERSION}: ${text}`;
  const cpus = ctx.executor.hardware.cpu.logicalCpus;

  if (command === 'count') {
    return { output: table === 'expect' ? '0' : String(everyTracker.reduce((count, [, tracker]) => count + tracker.flows().length, 0)), exitCode: 0 };
  }

  if (command === 'stats') {
    if (table === 'expect') return { output: statisticsLines(cpus, EXPECTATION_STATISTIC_ORDER, {}), exitCode: 0 };
    return { output: statisticsLines(cpus, STATISTIC_ORDER, summed(everyTracker.map(([, tracker]) => tracker.statistics))), exitCode: 0 };
  }

  if (command === 'flush') {
    if (table === 'expect') return { output: message('expectation table has been emptied.'), exitCode: 0 };
    for (const [, tracker] of trackers) tracker.flush();
    return { output: message('connection tracking table has been emptied.'), exitCode: 0 };
  }

  if (command === 'delete') {
    if (table === 'expect') return { output: message('this simulator cannot build the deletion of expectations'), exitCode: 1 };
    const removed = trackers.flatMap(([family, tracker]) => tracker
      .delete((flow) => flowMatches(flow, filter))
      .map((flow) => flowLine(flow, family, extendedOutput)));
    return { output: [...removed, message(`${removed.length} flow entries have been deleted.`)].join('\n'), exitCode: removed.length === 0 ? 1 : 0 };
  }

  if (table === 'expect') return { output: message('0 expectations have been shown.'), exitCode: 0 };
  if (table !== 'conntrack') return { output: message('0 flow entries have been shown.'), exitCode: 0 };

  const lines = trackers.flatMap(([family, tracker]) => tracker.flows()
    .filter((flow) => flowMatches(flow, filter))
    .map((flow) => flowLine(flow, family, extendedOutput)));
  return { output: [...lines, message(`${lines.length} flow entries have been shown.`)].join('\n'), exitCode: 0 };
}

export const conntrackCommand: LinuxCommand = {
  name: 'conntrack',
  package: 'conntrack',
  needsNetworkContext: true,
  usage: 'conntrack [-L | -D | -F | -C | -S] [table] [options]',
  manSection: 8,
  binaryPath: '/usr/sbin/conntrack',
  ownsHelpOption: true,
  options: CONNTRACK_OPTIONS,
  help: 'Command line interface for the netfilter connection tracking table.',
  run(ctx, args) { return runConntrack(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runConntrack(ctx, args); },
};
