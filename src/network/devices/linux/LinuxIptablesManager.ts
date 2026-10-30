/**
 * LinuxIptablesManager — iptables (netfilter) state manager.
 *
 * THE single source of truth for all packet filtering.
 * UFW is a frontend that translates its rules into iptables rules here.
 *
 * Faithfully reproduces real Linux iptables command behavior:
 * - 4 tables: filter, nat, mangle, raw
 * - Built-in chains with policies (ACCEPT/DROP)
 * - User-defined chains with reference counting
 * - Full rule matching: protocol, src/dst IP/CIDR, interfaces, ports, negation
 * - Match extensions: state, conntrack, multiport, comment, limit, mac, iprange
 * - Targets: ACCEPT, DROP, REJECT, LOG, MASQUERADE, DNAT, SNAT, REDIRECT, RETURN
 * - iptables-save / iptables-restore
 * - Real packet filtering with counter updates
 */

import { simulationNowMs } from '@/network/core/SystemClock';
import { HashlimitTables, hashlimitListing, parseHashlimit } from './IptablesHashlimit';
import {
  dscpListing, lengthListing, mssListing, parseDscp, parseLengthRange, parseMssRange, parseTos, tosListing, tosMatches, parseTimeWindow, timeWindowHolds, timeWindowListing,
} from './IptablesTimeLength';

import type { VirtualFileSystem } from './VirtualFileSystem';
import {
  IPAddress, IPv6Address, SubnetMask,
  IP_PROTO_DCCP, IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_SCTP, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_UDPLITE, PORT_BEARING_PROTOCOLS,
} from '../../core/types';
import { answersWithTcpReset, rejectTypeOf } from '../../core/IcmpErrors';
import { renderTable, IPTABLES_LISTING_TABLE, type TableColumn } from '@/network/devices/shells/cli/TextTable';
import { ConnectionTracker, type ConnectionState, type ConnectionTuple, type ErrorTranslation, type NatTranslation, type TrackedEntry } from './ConnectionTracker';
import type { NatManipulation } from './NatMapping';
import { NAT_ADDRESS_OPTION, natListing, natRangeOfTarget, natSaveOptions, type NatRange, type NatTargetName } from './NatRange';

// ─── Packet filtering types (shared with UFW) ───────────────────────

export type FirewallVerdict = 'accept' | 'drop' | 'reject';

export interface PacketInfo {
  direction: 'in' | 'out' | 'forward';
  protocol: number;         // 1=ICMP, 6=TCP, 17=UDP
  srcIP: string;
  dstIP: string;
  srcPort: number;          // 0 for ICMP
  dstPort: number;          // 0 for ICMP
  iface: string;            // interface name (e.g. 'eth0') — inbound iface
  outIface?: string;        // outbound interface (only for FORWARD packets)
  macAddress?: string;      // source MAC address (for -m mac --mac-source)
  isV6?: boolean;           // true for IPv6 packets
  icmpType?: number;        // ICMP message type, when protocol is ICMP
  icmpCode?: number;
  icmpId?: number;          // ICMP echo identifier, when the message carries one
  tcpFlags?: number;
  tcpOptions?: readonly number[];
  fragmentOffset?: number;
  ipPacketBytes?: number;
  ttl?: number;
  tos?: number;
  tcpMss?: number;
  srcAddrType?: string;
  dstAddrType?: string;
  addressTypeOf?: (ip: string) => string;
  related?: ConnectionTuple;
}

export type PacketFacts = Omit<PacketInfo, 'direction' | 'iface' | 'outIface'>;

const IPTABLES_MATCH_MODULES = new Set([
  'state', 'conntrack', 'multiport', 'limit', 'mac', 'iprange', 'comment',
  'tcp', 'udp', 'icmp', 'icmp6', 'addrtype', 'mark', 'recent',
  'connmark', 'owner', 'pkttype', 'length', 'ttl', 'hashlimit', 'string', 'time', 'connlimit', 'dscp', 'tos', 'tcpmss',
]);

const PROTOCOL_MATCH_MODULES = new Set(['tcp', 'udp', 'icmp', 'icmp6']);
const CONNECTION_TRACKING_MODULES: ReadonlySet<string> = new Set(['state', 'conntrack', 'connmark']);

type ModuleOptionFlags = '' | 'I' | 'M' | 'F' | 'IM' | 'IF';

const MODULE_OPTIONS: Readonly<Record<string, Readonly<Record<string, ModuleOptionFlags>>>> = {
  state: { '--state': 'IM' },
  conntrack: {
    '--ctstate': 'I', '--ctproto': 'I', '--ctorigsrc': 'I', '--ctorigdst': 'I', '--ctreplsrc': 'I', '--ctrepldst': 'I',
    '--ctstatus': 'I', '--ctexpire': 'I', '--ctorigsrcport': 'I', '--ctorigdstport': 'I', '--ctreplsrcport': 'I',
    '--ctrepldstport': 'I', '--ctdir': '',
  },
  multiport: { '--sports': 'I', '--dports': 'I', '--ports': 'I' },
  limit: { '--limit': '', '--limit-burst': '' },
  mac: { '--mac-source': 'IM' },
  iprange: { '--src-range': 'I', '--dst-range': 'I' },
  comment: { '--comment': 'M' },
  recent: {
    '--set': 'IF', '--rcheck': 'IF', '--update': 'IF', '--remove': 'IF', '--seconds': '', '--reap': 'F', '--hitcount': '',
    '--rttl': 'F', '--name': '', '--rsource': 'F', '--rdest': 'F', '--mask': '',
  },
  addrtype: { '--src-type': 'I', '--dst-type': 'I', '--limit-iface-in': 'F', '--limit-iface-out': 'F' },
  mark: { '--mark': 'IM' },
  connmark: { '--mark': 'IM' },
  owner: {
    '--uid-owner': 'I', '--gid-owner': 'I', '--pid-owner': 'I', '--sid-owner': 'I', '--cmd-owner': 'I',
    '--socket-exists': 'IF', '--suppl-groups': 'F',
  },
  pkttype: { '--pkt-type': 'IM' },
  length: { '--length': 'IM' },
  tcpmss: { '--mss': 'IM' },
  dscp: { '--dscp': 'I', '--dscp-class': 'I' },
  tos: { '--tos': 'IM' },
  connlimit: {
    '--connlimit-above': 'I', '--connlimit-upto': '', '--connlimit-mask': '', '--connlimit-saddr': 'F', '--connlimit-daddr': 'F',
  },
  time: {
    '--timestart': '', '--timestop': '', '--weekdays': 'I', '--monthdays': 'I', '--datestart': '', '--datestop': '',
    '--utc': 'F', '--kerneltz': 'F',
  },
  ttl: { '--ttl-eq': 'I', '--ttl-gt': '', '--ttl-lt': '' },
  hashlimit: {
    '--hashlimit-upto': 'I', '--hashlimit-above': 'I', '--hashlimit-burst': '', '--hashlimit-mode': '', '--hashlimit-srcmask': '',
    '--hashlimit-dstmask': '', '--hashlimit-name': 'M', '--hashlimit-htable-size': '', '--hashlimit-htable-max': '',
    '--hashlimit-htable-expire': '', '--hashlimit-htable-gcinterval': '', '--hashlimit-rate-match': 'F', '--hashlimit-rate-interval': '',
  },
  string: { '--algo': 'M', '--from': '', '--to': '', '--string': 'I', '--hex-string': 'I', '--icase': 'F' },
};

const MODULE_OPTION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  multiport: { '--source-ports': '--sports', '--destination-ports': '--dports' },
  ttl: { '--ttl': '--ttl-eq' },
  hashlimit: { '--hashlimit': '--hashlimit-upto' },
};

const DECIDED_MODULE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  state: ['--state'],
  conntrack: ['--ctstate'],
  multiport: ['--sports', '--dports', '--ports'],
  limit: ['--limit', '--limit-burst'],
  mac: ['--mac-source'],
  iprange: ['--src-range', '--dst-range'],
  comment: ['--comment'],
  addrtype: ['--src-type', '--dst-type'],
  pkttype: ['--pkt-type'],
  hashlimit: [
    '--hashlimit-upto', '--hashlimit-above', '--hashlimit-burst', '--hashlimit-mode', '--hashlimit-name', '--hashlimit-srcmask',
    '--hashlimit-dstmask', '--hashlimit-htable-size', '--hashlimit-htable-max', '--hashlimit-htable-gcinterval', '--hashlimit-htable-expire',
  ],
  tcpmss: ['--mss'],
  dscp: ['--dscp', '--dscp-class'],
  tos: ['--tos'],
  connlimit: ['--connlimit-above', '--connlimit-upto', '--connlimit-mask', '--connlimit-saddr', '--connlimit-daddr'],
  length: ['--length'],
  ttl: ['--ttl-eq', '--ttl-gt', '--ttl-lt'],
  time: ['--timestart', '--timestop', '--weekdays', '--monthdays', '--datestart', '--datestop', '--utc', '--kerneltz'],
  recent: ['--name', '--set', '--rcheck', '--update', '--remove', '--seconds', '--hitcount', '--rsource', '--rdest', '--mask', '--reap'],
};

const RECENT_ACTIONS = ['--set', '--rcheck', '--update', '--remove'] as const;

const MULTIPORT_LISTING = [['--dports', 'dports'], ['--sports', 'sports'], ['--ports', 'ports']] as const;

const TCP_FLAG_BITS: ReadonlyArray<readonly [string, number]> = [
  ['FIN', 0x01], ['SYN', 0x02], ['RST', 0x04], ['PSH', 0x08], ['ACK', 0x10], ['URG', 0x20], ['ALL', 0x3F], ['NONE', 0],
];

const TCP_SYN_MASK = 0x01 | 0x02 | 0x04 | 0x10;
const TCP_SYN_FLAG = 0x02;

interface IcmpTypeName {
  readonly name: string;
  readonly type: number;
  readonly codeMin: number;
  readonly codeMax: number;
}

const ICMP_ANY_TYPE = 0xFF;

const ICMPV4_TYPE_NAMES: readonly IcmpTypeName[] = [
  { name: 'any', type: 0xFF, codeMin: 0, codeMax: 0xFF },
  { name: 'echo-reply', type: 0, codeMin: 0, codeMax: 0xFF },
  { name: 'pong', type: 0, codeMin: 0, codeMax: 0xFF },
  { name: 'destination-unreachable', type: 3, codeMin: 0, codeMax: 0xFF },
  { name: 'network-unreachable', type: 3, codeMin: 0, codeMax: 0 },
  { name: 'host-unreachable', type: 3, codeMin: 1, codeMax: 1 },
  { name: 'protocol-unreachable', type: 3, codeMin: 2, codeMax: 2 },
  { name: 'port-unreachable', type: 3, codeMin: 3, codeMax: 3 },
  { name: 'fragmentation-needed', type: 3, codeMin: 4, codeMax: 4 },
  { name: 'source-route-failed', type: 3, codeMin: 5, codeMax: 5 },
  { name: 'network-unknown', type: 3, codeMin: 6, codeMax: 6 },
  { name: 'host-unknown', type: 3, codeMin: 7, codeMax: 7 },
  { name: 'network-prohibited', type: 3, codeMin: 9, codeMax: 9 },
  { name: 'host-prohibited', type: 3, codeMin: 10, codeMax: 10 },
  { name: 'TOS-network-unreachable', type: 3, codeMin: 11, codeMax: 11 },
  { name: 'TOS-host-unreachable', type: 3, codeMin: 12, codeMax: 12 },
  { name: 'communication-prohibited', type: 3, codeMin: 13, codeMax: 13 },
  { name: 'host-precedence-violation', type: 3, codeMin: 14, codeMax: 14 },
  { name: 'precedence-cutoff', type: 3, codeMin: 15, codeMax: 15 },
  { name: 'source-quench', type: 4, codeMin: 0, codeMax: 0xFF },
  { name: 'redirect', type: 5, codeMin: 0, codeMax: 0xFF },
  { name: 'network-redirect', type: 5, codeMin: 0, codeMax: 0 },
  { name: 'host-redirect', type: 5, codeMin: 1, codeMax: 1 },
  { name: 'TOS-network-redirect', type: 5, codeMin: 2, codeMax: 2 },
  { name: 'TOS-host-redirect', type: 5, codeMin: 3, codeMax: 3 },
  { name: 'echo-request', type: 8, codeMin: 0, codeMax: 0xFF },
  { name: 'ping', type: 8, codeMin: 0, codeMax: 0xFF },
  { name: 'router-advertisement', type: 9, codeMin: 0, codeMax: 0xFF },
  { name: 'router-solicitation', type: 10, codeMin: 0, codeMax: 0xFF },
  { name: 'time-exceeded', type: 11, codeMin: 0, codeMax: 0xFF },
  { name: 'ttl-exceeded', type: 11, codeMin: 0, codeMax: 0xFF },
  { name: 'ttl-zero-during-transit', type: 11, codeMin: 0, codeMax: 0 },
  { name: 'ttl-zero-during-reassembly', type: 11, codeMin: 1, codeMax: 1 },
  { name: 'parameter-problem', type: 12, codeMin: 0, codeMax: 0xFF },
  { name: 'ip-header-bad', type: 12, codeMin: 0, codeMax: 0 },
  { name: 'required-option-missing', type: 12, codeMin: 1, codeMax: 1 },
  { name: 'timestamp-request', type: 13, codeMin: 0, codeMax: 0xFF },
  { name: 'timestamp-reply', type: 14, codeMin: 0, codeMax: 0xFF },
  { name: 'address-mask-request', type: 17, codeMin: 0, codeMax: 0xFF },
  { name: 'address-mask-reply', type: 18, codeMin: 0, codeMax: 0xFF },
];

const ICMPV6_TYPE_NAMES: readonly IcmpTypeName[] = [
  { name: 'destination-unreachable', type: 1, codeMin: 0, codeMax: 0xFF },
  { name: 'no-route', type: 1, codeMin: 0, codeMax: 0 },
  { name: 'communication-prohibited', type: 1, codeMin: 1, codeMax: 1 },
  { name: 'beyond-scope', type: 1, codeMin: 2, codeMax: 2 },
  { name: 'address-unreachable', type: 1, codeMin: 3, codeMax: 3 },
  { name: 'port-unreachable', type: 1, codeMin: 4, codeMax: 4 },
  { name: 'failed-policy', type: 1, codeMin: 5, codeMax: 5 },
  { name: 'reject-route', type: 1, codeMin: 6, codeMax: 6 },
  { name: 'packet-too-big', type: 2, codeMin: 0, codeMax: 0xFF },
  { name: 'time-exceeded', type: 3, codeMin: 0, codeMax: 0xFF },
  { name: 'ttl-exceeded', type: 3, codeMin: 0, codeMax: 0xFF },
  { name: 'ttl-zero-during-transit', type: 3, codeMin: 0, codeMax: 0 },
  { name: 'ttl-zero-during-reassembly', type: 3, codeMin: 1, codeMax: 1 },
  { name: 'parameter-problem', type: 4, codeMin: 0, codeMax: 0xFF },
  { name: 'bad-header', type: 4, codeMin: 0, codeMax: 0 },
  { name: 'unknown-header-type', type: 4, codeMin: 1, codeMax: 1 },
  { name: 'unknown-option', type: 4, codeMin: 2, codeMax: 2 },
  { name: 'echo-request', type: 128, codeMin: 0, codeMax: 0xFF },
  { name: 'ping', type: 128, codeMin: 0, codeMax: 0xFF },
  { name: 'echo-reply', type: 129, codeMin: 0, codeMax: 0xFF },
  { name: 'pong', type: 129, codeMin: 0, codeMax: 0xFF },
  { name: 'router-solicitation', type: 133, codeMin: 0, codeMax: 0xFF },
  { name: 'router-advertisement', type: 134, codeMin: 0, codeMax: 0xFF },
  { name: 'neighbour-solicitation', type: 135, codeMin: 0, codeMax: 0xFF },
  { name: 'neighbor-solicitation', type: 135, codeMin: 0, codeMax: 0xFF },
  { name: 'neighbour-advertisement', type: 136, codeMin: 0, codeMax: 0xFF },
  { name: 'neighbor-advertisement', type: 136, codeMin: 0, codeMax: 0xFF },
  { name: 'redirect', type: 137, codeMin: 0, codeMax: 0xFF },
];

function parseUint8(text: string): number | null {
  const digits = /^(?:0x([0-9a-f]+)|(0[0-7]*)|([1-9][0-9]*))$/i.exec(text);
  if (digits === null) return null;
  const value = digits[1] !== undefined ? parseInt(digits[1], 16) : digits[2] !== undefined ? parseInt(digits[2], 8) : Number(digits[3]);
  return value <= 0xFF ? value : null;
}

function leadingCounter(text: string): number | null {
  const digits = /^\s*(\d+)/.exec(text);
  return digits === null ? null : Number(digits[1]);
}

function parseIcmpTypeSpec(text: string, family: 4 | 6, invert: boolean): IcmpTypeMatch | string {
  const names = family === 6 ? ICMPV6_TYPE_NAMES : ICMPV4_TYPE_NAMES;
  const label = family === 6 ? 'ICMPv6' : 'ICMP';
  const needle = text.toLowerCase();
  let found: IcmpTypeName | null = null;
  for (const entry of names) {
    if (!entry.name.toLowerCase().startsWith(needle)) continue;
    if (found !== null) return `Ambiguous ${label} type \`${text}': \`${found.name}' or \`${entry.name}'?`;
    found = entry;
  }
  if (found !== null) return { type: found.type, codeMin: found.codeMin, codeMax: found.codeMax, invert };
  const slash = text.indexOf('/');
  const typeText = slash === -1 ? text : text.slice(0, slash);
  const type = parseUint8(typeText);
  if (type === null) return `Invalid ${label} type \`${typeText}'\n`;
  if (slash === -1) return { type, codeMin: 0, codeMax: 0xFF, invert };
  const code = parseUint8(text.slice(slash + 1));
  if (code === null) return `Invalid ${label} code \`${text.slice(slash + 1)}'\n`;
  return { type, codeMin: code, codeMax: code, invert };
}

function parseTcpFlagList(text: string): number | string {
  let bits = 0;
  for (const token of text.split(',')) {
    if (token === '') continue;
    const entry = TCP_FLAG_BITS.find(([name]) => name.toLowerCase() === token.toLowerCase());
    if (entry === undefined) return token;
    bits |= entry[1];
  }
  return bits;
}

function tcpFlagListText(bits: number): string {
  const names: string[] = [];
  for (const [name, bit] of TCP_FLAG_BITS) {
    if (bit === 0x3F || bit === 0) continue;
    if ((bits & bit) !== 0) names.push(name);
  }
  return names.length === 0 ? 'NONE' : names.join(',');
}

function icmpTypeSpecText(match: IcmpTypeMatch): string {
  if (match.type === ICMP_ANY_TYPE) return 'any';
  const withCode = match.codeMin !== 0 || match.codeMax !== 0xFF;
  return withCode ? `${match.type}/${match.codeMin}` : String(match.type);
}

const TARGET_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  ACCEPT: [], DROP: [], RETURN: [], NOTRACK: [],
  REJECT: ['--reject-with'],
  LOG: ['--log-level', '--log-prefix', '--log-tcp-sequence', '--log-tcp-options', '--log-ip-options', '--log-uid'],
  MASQUERADE: ['--to-ports', '--random', '--random-fully'],
  DNAT: ['--to-destination', '--random', '--persistent'],
  SNAT: ['--to-source', '--random', '--random-fully', '--persistent'],
  REDIRECT: ['--to-ports', '--random'],
  MARK: ['--set-mark', '--set-xmark', '--and-mark', '--or-mark', '--xor-mark'],
};

// ─── Internal types ──────────────────────────────────────────────────

type TableName = 'filter' | 'nat' | 'mangle' | 'raw';

const RECENT_STAMPS_PER_ENTRY = 20;
type BuiltinPolicy = 'ACCEPT' | 'DROP';

interface MatchExtension {
  module: string;               // e.g. 'state', 'conntrack', 'multiport', 'comment', 'limit', 'mac', 'iprange'
  options: Map<string, string>; // e.g. '--state' => 'ESTABLISHED,RELATED'
  negated?: ReadonlySet<string>;
}

function inverts(match: MatchExtension, option: string): boolean {
  return match.negated?.has(option) ?? false;
}

interface TargetOptions {
  [key: string]: string;
}

interface TcpFlagsMatch {
  mask: number;
  comp: number;
  invert: boolean;
}

interface TcpOptionMatch {
  kind: number;
  invert: boolean;
}

interface IcmpTypeMatch {
  type: number;
  codeMin: number;
  codeMax: number;
  invert: boolean;
}

interface IptablesRule {
  protocol: string;       // 'tcp', 'udp', 'icmp', 'all', ''
  source: string;         // '' or IP/CIDR
  destination: string;    // '' or IP/CIDR
  inInterface: string;    // '' or 'eth0'
  outInterface: string;   // '' or 'eth0'
  sport: string;          // '' or '1024' or '1024:65535'
  dport: string;          // '' or '22' or '6000:6007'
  negSport: boolean;
  negDport: boolean;
  tcpFlags: TcpFlagsMatch | null;
  tcpOption: TcpOptionMatch | null;
  icmpType: IcmpTypeMatch | null;
  protocolMatch: '' | 'tcp' | 'udp' | 'icmp' | 'icmp6';
  fragment: '' | 'only' | 'not';
  goto: boolean;
  target: string;         // 'ACCEPT', 'DROP', 'REJECT', 'LOG', chain name, etc.
  targetOptions: TargetOptions;
  natRange: NatRange | null;
  matches: MatchExtension[];
  negSource: boolean;
  negDestination: boolean;
  negProtocol: boolean;
  negInInterface: boolean;
  negOutInterface: boolean;
  pkts: number;
  bytes: number;
}

interface IptablesChain {
  name: string;
  policy: BuiltinPolicy | null; // null for user-defined chains
  rules: IptablesRule[];
  pkts: number;
  bytes: number;
}

interface IptablesTable {
  name: TableName;
  chains: Map<string, IptablesChain>;
}

interface ListedRule {
  readonly r: IptablesRule;
  readonly index: number;
}

export interface IptablesOwnerNames {
  readonly user: (uid: number) => string | null;
  readonly group: (gid: number) => string | null;
}

export interface ListFormat {
  verbose: boolean;
  numeric: boolean;
  lineNumbers: boolean;
  exact: boolean;
}

const PKTTYPE_NAMES: Readonly<Record<string, 'unicast' | 'broadcast' | 'multicast'>> = {
  unicast: 'unicast', host: 'unicast', broadcast: 'broadcast', bcast: 'broadcast', multicast: 'multicast', mcast: 'multicast',
};

function pkttypeOf(name: string): 'unicast' | 'broadcast' | 'multicast' | null {
  return PKTTYPE_NAMES[name.toLowerCase()] ?? null;
}

function markListing(option: string, value: string): string {
  const [markText, maskText] = value.split('/');
  const hex = (text: string): string => `0x${(Number(text) >>> 0).toString(16)}`;
  switch (option) {
    case '--or-mark': return `MARK or ${hex(markText)}`;
    case '--and-mark': return `MARK and ${hex(markText)}`;
    case '--xor-mark': return `MARK xor ${hex(markText)}`;
    case '--set-xmark': return maskText === undefined ? `MARK set ${hex(markText)}` : `MARK xset ${hex(markText)}/${hex(maskText)}`;
    default: return `MARK set ${hex(markText)}`;
  }
}

function abbreviateCounter(n: number): string {
  if (n <= 99999) return String(n);
  let v = Math.floor((n + 500) / 1000);
  for (const suffix of ['K', 'M', 'G']) {
    if (v <= 9999) return `${v}${suffix}`;
    v = Math.floor((v + 500) / 1000);
  }
  return `${v}T`;
}

// ─── Table definitions ───────────────────────────────────────────────

const TABLE_BUILTIN_CHAINS: Record<TableName, string[]> = {
  filter: ['INPUT', 'FORWARD', 'OUTPUT'],
  nat: ['PREROUTING', 'INPUT', 'OUTPUT', 'POSTROUTING'],
  mangle: ['PREROUTING', 'INPUT', 'FORWARD', 'OUTPUT', 'POSTROUTING'],
  raw: ['PREROUTING', 'OUTPUT'],
};

// ─── NAT result ────────────────────────────────────────────────────

export interface NatResult {
  action: 'MASQUERADE' | 'DNAT' | 'SNAT' | 'REDIRECT' | 'DROP';
  address?: string;   // for DNAT: "ip:port", for SNAT: "ip", for REDIRECT: "port"
  range?: NatRange | null;
}

export type NatHook = 'PREROUTING' | 'OUTPUT' | 'INPUT' | 'POSTROUTING';

export interface NatHookContext {
  readonly masqueradeAddress: string | null;
  readonly redirectAddress: string | null;
  readonly outInterface: string | null;
}

export type NatHookOutcome =
  | { readonly kind: 'drop' }
  | { readonly kind: 'accept'; readonly translation: NatTranslation | null; readonly error: ErrorTranslation | null };

const TARGET_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  '--random', '--random-fully', '--persistent', '--log-tcp-sequence', '--log-tcp-options', '--log-ip-options', '--log-uid',
]);

const LOOPBACK_ADDRESS = '127.0.0.1';
const NAT_TARGETS: ReadonlySet<string> = new Set(['DNAT', 'SNAT', 'MASQUERADE', 'REDIRECT']);
const NAT_PORT_PROTOCOLS: ReadonlySet<number> = new Set([IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMP, IP_PROTO_SCTP, IP_PROTO_DCCP]);

type ChainOutcome = FirewallVerdict | NatResult;

const VALID_TABLES = new Set<string>(['filter', 'nat', 'mangle', 'raw']);
const PROTOCOL_NUMBERS: Readonly<Record<string, number>> = {
  tcp: IP_PROTO_TCP, udp: IP_PROTO_UDP, icmp: IP_PROTO_ICMP,
  icmpv6: IP_PROTO_ICMPV6, 'ipv6-icmp': IP_PROTO_ICMPV6, udplite: IP_PROTO_UDPLITE,
};

function protocolNumberOf(text: string): number | null {
  if (Object.prototype.hasOwnProperty.call(PROTOCOL_NUMBERS, text)) return PROTOCOL_NUMBERS[text];
  if (/^\d+$/.test(text) && Number(text) <= 255) return Number(text);
  return null;
}
const VALID_BUILTIN_POLICIES = new Set<string>(['ACCEPT', 'DROP']);
const VALID_TARGETS = new Set<string>(['ACCEPT', 'DROP', 'REJECT', 'LOG', 'MASQUERADE', 'DNAT', 'SNAT', 'REDIRECT', 'RETURN', 'MARK', 'NOTRACK']);

// Real netfilter's xt_nat hook mask (verified against a real `iptables`
// binary, not assumed): DNAT/REDIRECT only take effect before a routing
// decision is made (PREROUTING for network-arriving traffic, OUTPUT for
// locally-generated traffic); SNAT/MASQUERADE only after one (POSTROUTING),
// with SNAT additionally valid in INPUT for a packet already decided as
// locally-destined. `-A INPUT -j DNAT` is rejected on real Linux, not
// silently accepted — this table is what lets that rejection be real here.
const NAT_TARGET_HOOKS: Record<string, string[]> = {
  DNAT: ['PREROUTING', 'OUTPUT'],
  REDIRECT: ['PREROUTING', 'OUTPUT'],
  SNAT: ['POSTROUTING', 'INPUT'],
  MASQUERADE: ['POSTROUTING'],
};

const TARGET_TABLE: Readonly<Record<string, TableName>> = {
  DNAT: 'nat', REDIRECT: 'nat', SNAT: 'nat', MASQUERADE: 'nat', REJECT: 'filter',
};

// ─── Manager ─────────────────────────────────────────────────────────

export type IptablesServiceResolver = (port: number, proto: string) => string | null;

export class LinuxIptablesManager {
  private vfs: VirtualFileSystem | null = null;
  private resolveService: IptablesServiceResolver | null = null;
  private ownerNames: IptablesOwnerNames | null = null;
  private readonly hashlimits = new HashlimitTables();
  private hotDropped = false;
  private tables: Map<TableName, IptablesTable> = new Map();
  private readonly limitBuckets = new WeakMap<IptablesRule, { tokens: number; at: number }>();
  private readonly recentLists = new Map<string, Map<string, number[]>>();
  readonly connections: ConnectionTracker;
  private readonly attached = new WeakMap<object, TrackedEntry>();
  // `--reject-with` of the rule that produced the most recent 'reject'
  // verdict from filterPacket(), if any — read by the caller immediately
  // after filterPacket() to pick the right ICMP error / TCP RST.
  private lastRejectWith: string | null = null;
  private logCallback: ((prefix: string, pkt: PacketInfo) => void) | null = null;
  // `--set-mark`/`--set-xmark` of the most recent `-j MARK` match, if any
  // — MARK is non-terminal. Consumption by policy routing (`ip rule`) is
  // out of scope (PRD-Iptables-UFW.md §2.2); this only makes the mark
  // itself observable.
  private lastMark: string | null = null;

  readonly family: 4 | 6;

  constructor(
    vfs?: VirtualFileSystem,
    resolveService?: IptablesServiceResolver,
    opts?: { family?: 4 | 6; ownerNames?: IptablesOwnerNames },
  ) {
    if (vfs) this.vfs = vfs;
    if (resolveService) this.resolveService = resolveService;
    this.family = opts?.family ?? 4;
    this.ownerNames = opts?.ownerNames ?? null;
    this.connections = new ConnectionTracker(this.family);
    this.initializeTables();
  }

  setLogCallback(cb: (prefix: string, pkt: PacketInfo) => void): void {
    this.logCallback = cb;
  }

  hasDropOnInputPort(port: number, protocol: 'tcp' | 'udp' = 'tcp'): boolean {
    const filter = this.tables.get('filter');
    const input = filter?.chains.get('INPUT');
    if (!input) return false;
    for (const rule of input.rules) {
      if (rule.target !== 'DROP' && rule.target !== 'REJECT') continue;
      if (rule.protocol && rule.protocol !== protocol) continue;
      if (rule.dport !== String(port)) continue;
      return true;
    }
    return false;
  }

  /**
   * Wipe all tables/chains/rules back to the fresh-boot default (built-in
   * chains only, ACCEPT policy, no rules) — real netfilter state does not
   * survive a reboot; only persistence units (`ufw`, `netfilter-persistent`)
   * reconstruct it afterwards from disk. Used by the `reboot`/`shutdown`
   * command handler, before those units' boot-time lifecycle events fire.
   */
  resetAll(): void {
    this.initializeTables();
    this.connections.flush();
  }

  /** Whether a chain currently exists in the given table. */
  hasChain(tableName: TableName, chainName: string): boolean {
    return this.tables.get(tableName)?.chains.has(chainName) ?? false;
  }

  private initializeTables(): void {
    for (const [tableName, chainNames] of Object.entries(TABLE_BUILTIN_CHAINS)) {
      const table: IptablesTable = {
        name: tableName as TableName,
        chains: new Map(),
      };
      for (const chainName of chainNames) {
        table.chains.set(chainName, {
          name: chainName,
          policy: 'ACCEPT',
          rules: [],
          pkts: 0,
          bytes: 0,
        });
      }
      this.tables.set(tableName as TableName, table);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // REAL PACKET FILTERING — the single source of truth
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Evaluate the filter table against an actual packet.
   * This is THE only packet filtering engine in the system.
   * UFW translates its rules into iptables rules; this method evaluates them.
   *
   * Supports INPUT, OUTPUT, and FORWARD chains based on pkt.direction.
   */
  filterPacket(pkt: PacketInfo, subject?: object): FirewallVerdict {
    this.lastRejectWith = null;
    this.lastMark = null;
    const entry = subject === undefined ? this.connections.enter(pkt) : this.track(pkt, subject);
    const filterTable = this.tables.get('filter')!;
    const chainName = pkt.direction === 'in' ? 'INPUT'
                    : pkt.direction === 'out' ? 'OUTPUT'
                    : 'FORWARD';
    const chain = filterTable.chains.get(chainName)!;
    const outcome = this.evaluateChain(filterTable, chain, pkt, 0, entry.state);
    const verdict = typeof outcome === 'string' ? outcome : 'drop';
    if (verdict === 'accept' && pkt.direction !== 'forward' && !this.connections.confirm(entry)) return 'drop';
    return verdict;
  }

  track(pkt: PacketInfo, subject: object): TrackedEntry {
    const known = this.attached.get(subject);
    if (known !== undefined) return known;
    const entry = this.connections.enter(pkt);
    this.attached.set(subject, entry);
    return entry;
  }

  carry(from: object, to: object): void {
    const entry = this.attached.get(from);
    if (entry !== undefined) this.attached.set(to, entry);
  }

  confirmForwarded(subject: object): boolean {
    const entry = this.attached.get(subject);
    return entry === undefined || this.connections.confirm(entry);
  }

  isTracked(subject: object): boolean {
    return this.attached.has(subject);
  }

  needsConnectionTracking(): boolean {
    return [...this.tables.values()].some((table) => [...table.chains.values()].some((chain) =>
      chain.rules.some((rule) => NAT_TARGETS.has(rule.target)
        || rule.matches.some((match) => CONNECTION_TRACKING_MODULES.has(match.module)))));
  }

  natHook(
    facts: () => PacketInfo, subject: object, hook: NatHook, context: NatHookContext,
    decide: (state: ConnectionState) => NatResult | null,
  ): NatHookOutcome {
    const entry = this.attached.get(subject) ?? this.track(facts(), subject);
    const manipulation: NatManipulation = hook === 'PREROUTING' || hook === 'OUTPUT' ? 'destination' : 'source';
    if (entry.state === 'RELATED') return { kind: 'accept', translation: null, error: this.connections.errorTranslation(entry, manipulation) };
    if (entry.state === 'NEW' && !this.connections.initialized(entry, manipulation)) {
      const result = decide(entry.state);
      if (result?.action === 'DROP') return { kind: 'drop' };
      const range = result === null ? null : this.natRangeFor(result, context, facts(), hook);
      if (range === 'drop') return { kind: 'drop' };
      if (range === null) this.connections.bindUnchanged(entry, manipulation);
      else this.connections.bind(entry, range, manipulation);
      if (result?.action === 'MASQUERADE' && range !== null && context.outInterface !== null) {
        this.connections.masquerade(entry, context.outInterface);
      }
    } else if (hook === 'POSTROUTING' && context.outInterface !== null
      && this.connections.leavesByAnotherInterface(entry, context.outInterface)) {
      this.connections.kill(entry);
      return { kind: 'drop' };
    }
    return { kind: 'accept', translation: this.connections.translation(entry, manipulation), error: null };
  }

  private natRangeFor(result: NatResult, context: NatHookContext, pkt: PacketInfo, hook: NatHook): NatRange | 'drop' | null {
    const range = result.range ?? null;
    if (range === null) return null;
    if (result.action === 'DNAT' || result.action === 'SNAT') return range;
    if (result.action === 'MASQUERADE' && pkt.srcIP === '0.0.0.0') return null;
    const address = result.action === 'MASQUERADE' ? context.masqueradeAddress
      : hook === 'OUTPUT' ? LOOPBACK_ADDRESS : context.redirectAddress;
    if (address === null) return 'drop';
    return { ...range, addresses: { min: new IPAddress(address), max: new IPAddress(address) } };
  }

  /**
   * `--reject-with` of the rule that produced the 'reject' verdict from the
   * most recent `filterPacket()` call, if any. Callers read this
   * immediately after `filterPacket()` returns 'reject' to pick the right
   * ICMP error (or TCP RST for `tcp-reset`).
   */
  getLastRejectWith(): string | null {
    return this.lastRejectWith;
  }

  /**
   * `--set-mark`/`--set-xmark` value of the most recent `-j MARK` match
   * from the last `filterPacket()` call, if any. PRD-Iptables-UFW.md
   * Phase 8 (objectif F.15) — consumption by policy routing is out of
   * scope; this only exposes the mark itself.
   */
  getLastMark(): string | null {
    return this.lastMark;
  }

  /**
   * Evaluate nat table for a packet (PREROUTING, OUTPUT, or POSTROUTING —
   * OUTPUT is a locally-generated packet's own DNAT/REDIRECT hook, real on
   * Linux exactly like PREROUTING's, just before that host's own outbound
   * routing decision instead of an arriving one).
   * Returns DNAT/SNAT/MASQUERADE/REDIRECT target info or null.
   */
  evaluateNat(pkt: PacketInfo, hook: NatHook, state?: ConnectionState): NatResult | null {
    const natTable = this.tables.get('nat');
    if (!natTable) return null;
    const chain = natTable.chains.get(hook);
    if (!chain) return null;

    const outcome = this.evaluateChain(natTable, chain, pkt, 0, state ?? this.connections.classify(pkt));
    if (typeof outcome !== 'string') return outcome;
    return outcome === 'accept' ? null : { action: 'DROP' };
  }

  /**
   * Evaluate a chain against a packet.
   * Returns { verdict, terminated } where terminated=true means a rule explicitly
   * decided the packet's fate (ACCEPT/DROP/REJECT). terminated=false means the
   * chain was exhausted without a terminal decision (equivalent to RETURN).
   */
  private evaluateChain(table: IptablesTable, chain: IptablesChain, pkt: PacketInfo, depth: number, state: ConnectionState): ChainOutcome {
    if (depth > 20) return 'accept';

    const innerResult = this.evaluateChainInner(table, chain, pkt, depth, state);
    if (innerResult !== null) return innerResult;
    chain.pkts++;
    chain.bytes += pkt.ipPacketBytes ?? 0;

    // No rule matched → apply chain policy (only built-in chains have policies)
    if (chain.policy === 'DROP') return 'drop';
    return 'accept';
  }

  /**
   * Inner chain evaluation. Returns null if the chain was exhausted (RETURN behavior),
   * or a FirewallVerdict if a terminal decision was made.
   */
  private evaluateChainInner(table: IptablesTable, chain: IptablesChain, pkt: PacketInfo, depth: number, state: ConnectionState): ChainOutcome | null {
    if (depth > 20) return 'accept';

    const bytes = pkt.ipPacketBytes ?? 0;
    for (const rule of chain.rules) {
      if (this.ruleMatchesPacket(rule, pkt, state)) {
        // Update counters
        rule.pkts++;
        rule.bytes += bytes;

        // If target is a user-defined chain, jump into it
        const targetChain = table.chains.get(rule.target);
        if (targetChain && targetChain.policy === null) {
          const result = this.evaluateChainInner(table, targetChain, pkt, depth + 1, state);
          // null = sub-chain fell through (RETURN) → continue in calling chain
          if (result === null) {
            if (rule.goto) return null;
            continue;
          }
          return result;
        }

        switch (rule.target) {
          case 'ACCEPT': return 'accept';
          case 'DROP': return 'drop';
          case 'REJECT':
            this.lastRejectWith = rule.targetOptions['--reject-with'] ?? null;
            return 'reject';
          case 'RETURN': return null; // return to calling chain
          case 'MASQUERADE': return { action: 'MASQUERADE', range: rule.natRange };
          case 'DNAT': return { action: 'DNAT', address: rule.targetOptions['--to-destination'] || '', range: rule.natRange };
          case 'SNAT': return { action: 'SNAT', address: rule.targetOptions['--to-source'] || '', range: rule.natRange };
          case 'REDIRECT': return { action: 'REDIRECT', address: rule.targetOptions['--to-port'] || rule.targetOptions['--to-ports'] || '', range: rule.natRange };
          case 'LOG':
            this.logCallback?.(rule.targetOptions['--log-prefix'] ?? '', pkt);
            continue; // LOG doesn't terminate; continue to next rule
          case 'MARK': // MARK doesn't terminate
            this.lastMark = rule.targetOptions['--set-mark'] ?? rule.targetOptions['--set-xmark'] ?? this.lastMark;
            continue;
          case 'NOTRACK': continue; // NOTRACK doesn't terminate
          default: continue;
        }
      } else if (this.hotDropped) {
        this.hotDropped = false;
        return 'drop';
      }
    }

    // Chain exhausted without terminal decision
    return null;
  }

  private ruleMatchesPacket(rule: IptablesRule, pkt: PacketInfo, state: ConnectionState): boolean {
    // Protocol check
    if (rule.protocol && rule.protocol !== 'all') {
      const matches = pkt.protocol === (protocolNumberOf(rule.protocol) ?? -1);
      if (rule.negProtocol ? matches : !matches) return false;
    }

    // Source IP check
    if (rule.source) {
      const matches = this.ipMatchesSpec(pkt.srcIP, rule.source);
      if (rule.negSource ? matches : !matches) return false;
    }

    // Destination IP check
    if (rule.destination) {
      const matches = this.ipMatchesSpec(pkt.dstIP, rule.destination);
      if (rule.negDestination ? matches : !matches) return false;
    }

    // Input interface
    if (rule.inInterface) {
      const matches = pkt.iface === rule.inInterface;
      if (rule.negInInterface ? matches : !matches) return false;
    }

    // Output interface — for FORWARD packets, match against outIface
    if (rule.outInterface) {
      const outIf = pkt.outIface || pkt.iface;
      const matches = outIf === rule.outInterface;
      if (rule.negOutInterface ? matches : !matches) return false;
    }

    if (rule.fragment !== '') {
      const isFragment = (pkt.fragmentOffset ?? 0) > 0;
      if (isFragment !== (rule.fragment === 'only')) return false;
    }

    // Destination port
    if (rule.dport) {
      if (this.portMatchesSpec(pkt.dstPort, rule.dport) === rule.negDport) return false;
    }

    // Source port
    if (rule.sport) {
      if (this.portMatchesSpec(pkt.srcPort, rule.sport) === rule.negSport) return false;
    }

    if (rule.tcpFlags !== null) {
      if (pkt.tcpFlags === undefined) return false;
      const holds = (pkt.tcpFlags & rule.tcpFlags.mask) === rule.tcpFlags.comp;
      if (holds === rule.tcpFlags.invert) return false;
    }

    if (rule.tcpOption !== null) {
      if (pkt.tcpOptions === undefined) return false;
      if (pkt.tcpOptions.includes(rule.tcpOption.kind) === rule.tcpOption.invert) return false;
    }

    if (rule.icmpType !== null) {
      if (pkt.icmpType === undefined) return false;
      const wanted = rule.icmpType;
      const code = pkt.icmpCode ?? 0;
      const holds = wanted.type === ICMP_ANY_TYPE
        || (pkt.icmpType === wanted.type && code >= wanted.codeMin && code <= wanted.codeMax);
      if (holds === wanted.invert) return false;
    }

    // Match extensions
    for (const m of rule.matches) {
      const decided = DECIDED_MODULE_OPTIONS[m.module];
      if (decided === undefined) return false;
      for (const option of m.options.keys()) {
        if (!decided.includes(option)) return false;
      }
      const inverted = (option: string): boolean => inverts(m, option);
      if (m.module === 'multiport') {
        const dports = m.options.get('--dports');
        const sports = m.options.get('--sports');
        const either = m.options.get('--ports');
        if (dports !== undefined && this.portMatchesSpec(pkt.dstPort, dports) === inverted('--dports')) return false;
        if (sports !== undefined && this.portMatchesSpec(pkt.srcPort, sports) === inverted('--sports')) return false;
        if (either !== undefined
          && (this.portMatchesSpec(pkt.srcPort, either) || this.portMatchesSpec(pkt.dstPort, either)) === inverted('--ports')) return false;
      }
      if (m.module === 'limit') {
        if (!this.spendLimitCredit(rule, m)) return false;
      }
      if (m.module === 'recent') {
        const action = RECENT_ACTIONS.find((name) => m.options.has(name)) ?? '--rcheck';
        if (this.matchRecent(pkt, m) === inverted(action)) return false;
      }
      if (m.module === 'hashlimit') {
        const config = parseHashlimit(m.options, m.negated ?? new Set());
        if (typeof config === 'string') return false;
        const outcome = this.hashlimits.evaluate(config, pkt, simulationNowMs(), (ip, bits) => this.maskedAddress(ip, bits));
        if (outcome === 'hotdrop') {
          this.hotDropped = true;
          return false;
        }
        if ((outcome === 'over') !== config.above) return false;
      }
      if (m.module === 'pkttype') {
        const kind = pkttypeOf(m.options.get('--pkt-type') ?? '');
        const actual = pkt.dstAddrType ?? pkt.addressTypeOf?.(pkt.dstIP);
        if (kind === null || actual === undefined) return false;
        const carried = actual === 'BROADCAST' ? 'broadcast' : actual === 'MULTICAST' ? 'multicast' : 'unicast';
        if ((carried === kind) === inverted('--pkt-type')) return false;
      }
      if (m.module === 'tcpmss') {
        const range = parseMssRange(m.options.get('--mss') ?? '');
        if (typeof range === 'string') return false;
        const holds = pkt.tcpMss !== undefined && pkt.tcpMss >= range.min && pkt.tcpMss <= range.max;
        if (pkt.tcpMss === undefined ? !inverted('--mss') : holds === inverted('--mss')) return false;
      }
      if (m.module === 'dscp') {
        const wanted = parseDscp(m.options);
        if (typeof wanted === 'string' || pkt.tos === undefined) return false;
        if (((pkt.tos >> 2) === wanted) === (m.negated !== undefined && m.negated.size > 0)) return false;
      }
      if (m.module === 'tos') {
        const wanted = parseTos(m.options.get('--tos') ?? '');
        if (typeof wanted === 'string' || pkt.tos === undefined) return false;
        if (tosMatches(wanted, pkt.tos) === inverted('--tos')) return false;
      }
      if (m.module === 'connlimit') {
        if (this.connlimitExceeded(m, pkt, state) === this.connlimitView(m).inverted) return false;
      }
      if (m.module === 'addrtype') {
        for (const [option, actual] of [
          ['--src-type', pkt.srcAddrType ?? pkt.addressTypeOf?.(pkt.srcIP)], ['--dst-type', pkt.dstAddrType ?? pkt.addressTypeOf?.(pkt.dstIP)],
        ] as const) {
          const wanted = m.options.get(option);
          if (wanted === undefined) continue;
          if (actual === undefined) return false;
          if (wanted.toUpperCase().split(',').includes(actual) === inverted(option)) return false;
        }
      }
      if (m.module === 'ttl') {
        if (pkt.ttl === undefined) return false;
        const wanted = Number(m.options.get('--ttl-eq') ?? m.options.get('--ttl-gt') ?? m.options.get('--ttl-lt'));
        const holds = m.options.has('--ttl-eq') ? pkt.ttl === wanted
          : m.options.has('--ttl-gt') ? pkt.ttl > wanted : pkt.ttl < wanted;
        if (holds === inverted('--ttl-eq')) return false;
      }
      if (m.module === 'length') {
        const range = parseLengthRange(m.options.get('--length') ?? '');
        if (typeof range === 'string' || pkt.ipPacketBytes === undefined) return false;
        const inside = pkt.ipPacketBytes >= range.min && pkt.ipPacketBytes <= range.max;
        if (inside === inverted('--length')) return false;
      }
      if (m.module === 'time') {
        const window = parseTimeWindow(m.options, m.negated ?? new Set());
        if (typeof window === 'string' || !timeWindowHolds(window, simulationNowMs())) return false;
      }
      if (m.module === 'state' || m.module === 'conntrack') {
        const option = m.module === 'state' ? '--state' : '--ctstate';
        const wanted = (m.options.get(option) ?? '').toUpperCase();
        if (wanted !== '' && wanted.split(',').includes(state) === inverted(option)) return false;
      }
      // mac match: check source MAC address
      if (m.module === 'mac') {
        const macSrc = m.options.get('--mac-source');
        if (macSrc) {
          if (!pkt.macAddress) return false;
          if ((pkt.macAddress.toLowerCase() === macSrc.toLowerCase()) === inverted('--mac-source')) return false;
        }
      }
      // iprange match: check IP ranges
      if (m.module === 'iprange') {
        const srcRange = m.options.get('--src-range');
        const dstRange = m.options.get('--dst-range');
        if (srcRange && this.ipInRange(pkt.srcIP, srcRange) === inverted('--src-range')) return false;
        if (dstRange && this.ipInRange(pkt.dstIP, dstRange) === inverted('--dst-range')) return false;
      }
      // comment match: no filtering effect, just stored
    }

    return true;
  }

  private connlimitView(m: MatchExtension): { limit: number; mask: number; daddr: boolean; inverted: boolean } {
    const above = m.options.get('--connlimit-above');
    const limit = Number(above ?? m.options.get('--connlimit-upto') ?? 0);
    const mask = Number(m.options.get('--connlimit-mask') ?? (this.family === 6 ? 128 : 32));
    const inverted = above === undefined || inverts(m, '--connlimit-above');
    return { limit, mask, daddr: m.options.has('--connlimit-daddr'), inverted };
  }

  private connlimitExceeded(m: MatchExtension, pkt: PacketInfo, state: ConnectionState): boolean {
    const { limit, mask, daddr } = this.connlimitView(m);
    const subject = daddr ? pkt.dstIP : pkt.srcIP;
    const group = `${subject}/${mask}`;
    const sameGroup = this.addressMatcher(group);
    const counted = this.connections.count((original, tcpState) => {
      if (tcpState === 'TIME_WAIT' || tcpState === 'CLOSE') return false;
      return sameGroup(daddr ? original.dstIP : original.srcIP);
    });
    return counted + (state === 'NEW' ? 1 : 0) > limit;
  }

  private maskedAddress(ip: string, bits: number | null): string {
    if (bits === null || this.family === 6) return ip;
    const value = this.ipToNumber(ip);
    if (value === null) return ip;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return String((value & mask) >>> 0);
  }

  private addressMatcher(spec: string): (ip: string) => boolean {
    if (this.family === 6) return (ip) => this.ipMatchesSpec(ip, spec);
    const [network, prefixText] = spec.split('/');
    const prefix = Number(prefixText);
    const networkNumber = this.ipToNumber(network);
    if (networkNumber === null || Number.isNaN(prefix)) return () => false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const wanted = networkNumber & mask;
    return (ip) => {
      const value = this.ipToNumber(ip);
      return value !== null && (value & mask) === wanted;
    };
  }

  private ipMatchesSpec(ip: string, spec: string): boolean {
    if (this.family === 6) return this.ip6MatchesSpec(ip, spec);
    if (!spec.includes('/')) return ip === spec;
    const [network, prefixStr] = spec.split('/');
    const prefix = parseInt(prefixStr);
    if (isNaN(prefix)) return false;
    const ipNum = this.ipToNumber(ip);
    const netNum = this.ipToNumber(network);
    if (ipNum === null || netNum === null) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) === (netNum & mask);
  }

  private ip6MatchesSpec(ip: string, spec: string): boolean {
    const slashIdx = spec.lastIndexOf('/');
    const network = slashIdx === -1 ? spec : spec.slice(0, slashIdx);
    const prefix = slashIdx === -1 ? 128 : parseInt(spec.slice(slashIdx + 1), 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
    const ipAddr = this.tryParseV6(ip);
    const netAddr = this.tryParseV6(network);
    if (!ipAddr || !netAddr) return false;
    return ipAddr.isInSameSubnet(netAddr, prefix);
  }

  private tryParseV6(addr: string): IPv6Address | null {
    try { return new IPv6Address(addr); } catch { return null; }
  }

  private ipToNumber(ip: string): number | null {
    return IPAddress.tryParse(ip)?.toUint32() ?? null;
  }

  /** Unsigned lexicographic comparison of two IPv6 addresses (hextet by hextet). */
  private compareV6(a: IPv6Address, b: IPv6Address): number {
    const ah = a.getHextets(), bh = b.getHextets();
    for (let i = 0; i < 8; i++) {
      if (ah[i] !== bh[i]) return ah[i] - bh[i];
    }
    return 0;
  }

  private portMatchesSpec(port: number, spec: string): boolean {
    if (spec.includes(':')) {
      const [s, e] = spec.split(':');
      return port >= parseInt(s) && port <= parseInt(e);
    }
    if (spec.includes(',')) {
      return spec.split(',').map(p => parseInt(p)).includes(port);
    }
    return port === parseInt(spec);
  }

  /** Check if an IP address is within a range like "192.168.1.10-192.168.1.50" */
  private ipInRange(ip: string, range: string): boolean {
    const parts = range.split('-');
    if (parts.length !== 2) return false;
    if (this.family === 6) {
      const ipAddr = this.tryParseV6(ip);
      const startAddr = this.tryParseV6(parts[0].trim());
      const endAddr = this.tryParseV6(parts[1].trim());
      if (!ipAddr || !startAddr || !endAddr) return false;
      return this.compareV6(ipAddr, startAddr) >= 0 && this.compareV6(ipAddr, endAddr) <= 0;
    }
    const ipNum = this.ipToNumber(ip);
    const startNum = this.ipToNumber(parts[0].trim());
    const endNum = this.ipToNumber(parts[1].trim());
    if (ipNum === null || startNum === null || endNum === null) return false;
    return ipNum >= startNum && ipNum <= endNum;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROGRAMMATIC API — used by UFW to inject/remove iptables rules
  // ═══════════════════════════════════════════════════════════════════

  /** Get the filter table (used by UFW to manipulate chains) */
  getTable(name: TableName): IptablesTable | undefined {
    return this.tables.get(name);
  }

  /** Append a rule programmatically (used by UFW) */
  appendRule(tableName: TableName, chainName: string, rule: IptablesRule): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain) return false;
    chain.rules.push(rule);
    return true;
  }

  /** Insert a rule at a position (1-indexed) programmatically */
  insertRule(tableName: TableName, chainName: string, pos: number, rule: IptablesRule): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain) return false;
    const idx = Math.min(Math.max(pos - 1, 0), chain.rules.length);
    chain.rules.splice(idx, 0, rule);
    return true;
  }

  /** Flush all rules from a chain */
  flushChain(tableName: TableName, chainName: string): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain) return false;
    chain.rules = [];
    return true;
  }

  /** Set the policy of a built-in chain */
  setPolicy(tableName: TableName, chainName: string, policy: BuiltinPolicy): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain || chain.policy === null) return false;
    chain.policy = policy;
    return true;
  }

  /** Get the policy of a chain */
  getPolicy(tableName: TableName, chainName: string): string | null {
    const table = this.tables.get(tableName);
    if (!table) return null;
    const chain = table.chains.get(chainName);
    return chain?.policy ?? null;
  }

  /** Create a new user-defined chain */
  createChain(tableName: TableName, chainName: string): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    if (table.chains.has(chainName)) return false;
    table.chains.set(chainName, { name: chainName, policy: null, rules: [], pkts: 0, bytes: 0 });
    return true;
  }

  /** Delete a user-defined chain */
  deleteChain(tableName: TableName, chainName: string): string | null {
    const table = this.tables.get(tableName);
    if (!table) return 'table not found';
    const chain = table.chains.get(chainName);
    if (!chain) return 'No chain/target/match by that name';
    if (chain.policy !== null) return `Can't delete built-in chain`;
    if (chain.rules.length > 0) return 'Directory not empty';
    table.chains.delete(chainName);
    return null;
  }

  private spendLimitCredit(rule: IptablesRule, m: MatchExtension): boolean {
    const rate = m.options.get('--limit') ?? '3/hour';
    const burst = parseInt(m.options.get('--limit-burst') ?? '5', 10) || 5;
    const parsed = rate.match(/^(\d+)\/(sec|second|min|minute|hour|day)$/);
    const per = parsed?.[2] ?? 'hour';
    const unitMs = per.startsWith('sec') ? 1000
      : per.startsWith('min') ? 60000
      : per === 'hour' ? 3600000 : 86400000;
    const refillMs = unitMs / (parseInt(parsed?.[1] ?? '3', 10) || 1);

    const now = simulationNowMs();
    const bucket = this.limitBuckets.get(rule) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / refillMs);
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.limitBuckets.set(rule, bucket);
    return allowed;
  }

  private matchRecent(pkt: PacketInfo, m: MatchExtension): boolean {
    const name = m.options.get('--name') ?? 'DEFAULT';
    const side = m.options.has('--rdest') ? pkt.dstIP : pkt.srcIP;
    if (!side) return false;
    const key = this.recentKey(side, m.options.get('--mask'));

    let list = this.recentLists.get(name);
    if (!list) { list = new Map(); this.recentLists.set(name, list); }
    const now = simulationNowMs();

    if (m.options.has('--remove')) {
      const known = list.delete(key);
      return known;
    }
    if (m.options.has('--set')) {
      const stamps = list.get(key) ?? [];
      LinuxIptablesManager.stamp(stamps, now);
      list.set(key, stamps);
      return true;
    }

    const stamps = list.get(key);
    if (!stamps) return false;
    const seconds = parseInt(m.options.get('--seconds') ?? '0', 10) || 0;
    const hitcount = parseInt(m.options.get('--hitcount') ?? '0', 10) || 0;
    const floor = seconds > 0 ? now - seconds * 1000 : -Infinity;
    const inWindow = stamps.filter(t => t >= floor).length;
    const matched = hitcount > 0 ? inWindow >= hitcount : inWindow > 0;
    if (matched && m.options.has('--update')) LinuxIptablesManager.stamp(stamps, now);
    return matched;
  }

  private static stamp(stamps: number[], now: number): void {
    stamps.push(now);
    if (stamps.length > RECENT_STAMPS_PER_ENTRY) stamps.shift();
  }

  private recentKey(address: string, mask: string | undefined): string {
    if (!mask || mask === '255.255.255.255') return address;
    const host = IPAddress.tryParse(address);
    if (!host || !IPAddress.isValid(mask)) return address;
    return host.networkAddress(new SubnetMask(mask)).toString();
  }

  /** Create a default empty rule (helper for UFW) */
  static createRule(overrides?: Partial<IptablesRule>): IptablesRule {
    return {
      protocol: '', source: '', destination: '',
      inInterface: '', outInterface: '',
      sport: '', dport: '', negSport: false, negDport: false,
      tcpFlags: null, tcpOption: null, icmpType: null, protocolMatch: '', fragment: '', goto: false,
      target: '', targetOptions: {}, natRange: null, matches: [],
      negSource: false, negDestination: false, negProtocol: false,
      negInInterface: false, negOutInterface: false,
      pkts: 0, bytes: 0,
      ...overrides,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMAND-LINE INTERFACE — iptables [-t table] <command>
  // ═══════════════════════════════════════════════════════════════════

  execute(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: this.showUsage(), exitCode: 2 };

    // Parse -t table
    let tableName: TableName = 'filter';
    const a = [...args];
    const tIdx = a.indexOf('-t');
    if (tIdx !== -1 && tIdx + 1 < a.length) {
      const t = a[tIdx + 1];
      if (!VALID_TABLES.has(t)) {
        return { output: `iptables v1.8.7 (nf_tables): can't initialize iptables table \`${t}': Table does not exist`, exitCode: 1 };
      }
      tableName = t as TableName;
      a.splice(tIdx, 2);
    }

    for (let k = a.length - 1; k >= 0; k--) {
      if (!['-w', '--wait', '-W', '--wait-interval'].includes(a[k])) continue;
      a.splice(k, k + 1 < a.length && /^\d+$/.test(a[k + 1]) ? 2 : 1);
    }

    const table = this.tables.get(tableName)!;
    if (a.length === 0) return { output: this.showUsage(), exitCode: 2 };

    const cmd = a[0];
    const rest = a.slice(1);

    switch (cmd) {
      case '-L': case '--list':       return this.cmdList(table, rest);
      case '-S': case '--list-rules': return this.cmdListRules(table, rest);
      case '-F': case '--flush':      return this.cmdFlush(table, rest);
      case '-P': case '--policy':     return this.cmdPolicy(table, rest);
      case '-A': case '--append':     return this.cmdAppend(table, rest);
      case '-D': case '--delete':     return this.cmdDelete(table, rest);
      case '-I': case '--insert':     return this.cmdInsert(table, rest);
      case '-R': case '--replace':    return this.cmdReplace(table, rest);
      case '-C': case '--check':      return this.cmdCheck(table, rest);
      case '-N': case '--new-chain':  return this.cmdNewChain(table, rest);
      case '-X': case '--delete-chain': return this.cmdDeleteChain(table, rest);
      case '-E': case '--rename-chain': return this.cmdRenameChain(table, rest);
      case '-Z': case '--zero':       return this.cmdZero(table, rest);
      default:
        return { output: `iptables v1.8.7 (nf_tables): unknown option "${cmd}"`, exitCode: 2 };
    }
  }

  // ─── -L ────────────────────────────────────────────────────────

  private cmdList(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    let chainName = '';
    let numeric = false, verbose = false, lineNumbers = false, exact = false;

    for (const arg of args) {
      const flags = /^-[nvx]+$/.test(arg) ? [...arg.slice(1)].map((c) => `-${c}`) : [arg];
      for (const flag of flags) {
        switch (flag) {
          case '-n': case '--numeric': numeric = true; break;
          case '-v': case '--verbose': verbose = true; break;
          case '-x': case '--exact': exact = true; break;
          case '--line-numbers': lineNumbers = true; break;
          default: if (!flag.startsWith('-')) chainName = flag; break;
        }
      }
    }

    const opts: ListFormat = { verbose, numeric, lineNumbers, exact };
    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
      return { output: this.fmtChainList(chain, table, opts), exitCode: 0 };
    }

    const parts: string[] = [];
    for (const chain of table.chains.values()) {
      if (parts.length > 0) parts.push('');
      parts.push(this.fmtChainList(chain, table, opts));
    }
    return { output: parts.join('\n'), exitCode: 0 };
  }

  listTable(tableName: TableName, opts: ListFormat, chains?: readonly string[]): string {
    const table = this.tables.get(tableName);
    if (!table) return '';
    const parts: string[] = [];
    for (const chain of table.chains.values()) {
      if (chains && !chains.includes(chain.name)) continue;
      if (parts.length > 0) parts.push('');
      parts.push(this.fmtChainList(chain, table, opts));
    }
    return parts.join('\n');
  }

  private fmtChainList(chain: IptablesChain, table: IptablesTable, opts: ListFormat): string {
    const { verbose, numeric, lineNumbers, exact } = opts;
    const count = (n: number): string => (exact ? String(n) : abbreviateCounter(n));
    const lines: string[] = [];
    if (chain.policy !== null) {
      const counters = verbose
        ? ` ${count(chain.pkts)} packets, ${count(chain.bytes)} bytes`
        : '';
      lines.push(`Chain ${chain.name} (policy ${chain.policy}${counters})`);
    } else {
      lines.push(`Chain ${chain.name} (${this.countRefs(chain.name, table)} references)`);
    }

    const rows = chain.rules.map((r, i) => ({ r, index: i + 1 }));
    const anyIface = numeric ? '*' : 'any';
    const counterWidth = exact ? 9 : 6;
    const counter = (pick: (row: ListedRule) => number, header: string, headerWidth: number): TableColumn<ListedRule> => ({
      header: `${header} `, width: counterWidth, headerWidth, align: 'right',
      value: (row) => `${count(pick(row))} `,
    });
    const columns: Array<TableColumn<ListedRule>> = [];
    if (lineNumbers) columns.push({ header: 'num', width: 5, value: (row) => String(row.index) });
    if (verbose) {
      columns.push(counter((row) => row.r.pkts, 'pkts', exact ? 9 : 6));
      columns.push(counter((row) => row.r.bytes, 'bytes', exact ? 11 : 6));
    }
    columns.push(
      { header: 'target', width: 10, value: (row) => `${row.r.target} ` },
      { header: ' prot ', width: 6, value: (row) => `${row.r.negProtocol ? '!' : ' '}${row.r.protocol || 'all'}` },
      { header: 'opt', width: 3, value: (row) => (row.r.fragment === 'only' ? '-f ' : row.r.fragment === 'not' ? '!f ' : '-- ') },
    );
    if (verbose) {
      columns.push(
        { header: ' in', width: 8, value: (row) => ` ${(row.r.negInInterface ? '!' : '') + (row.r.inInterface || anyIface)}` },
        { header: 'out', width: 7, value: (row) => (row.r.negOutInterface ? '!' : '') + (row.r.outInterface || anyIface) },
      );
    }
    columns.push(
      { header: ' source', width: 21, value: (row) => this.fmtAddr(row.r.source, row.r.negSource, numeric) },
      { header: ' destination', width: 21, value: (row) => this.fmtAddr(row.r.destination, row.r.negDestination, numeric) },
      { header: '', width: 0, value: (row) => this.fmtRuleExtras(row.r, numeric) },
    );
    lines.push(...renderTable(rows, columns, IPTABLES_LISTING_TABLE));
    return lines.join('\n');
  }

  private fmtAddr(addr: string, neg: boolean, numeric: boolean): string {
    const text = addr || (numeric ? '0.0.0.0/0' : 'anywhere');
    return `${neg ? '!' : ' '}${text}`;
  }

  private fmtRuleExtras(r: IptablesRule, numeric: boolean): string {
    const parts: string[] = [];
    const transport: string[] = [];
    if (r.sport) transport.push(this.portTerm('spt', r.sport, r.negSport, r.protocol, numeric));
    if (r.dport) transport.push(this.portTerm('dpt', r.dport, r.negDport, r.protocol, numeric));
    if (r.tcpOption !== null) transport.push(`option=${r.tcpOption.invert ? '!' : ''}${r.tcpOption.kind}`);
    if (r.tcpFlags !== null) {
      const { mask, comp, invert } = r.tcpFlags;
      const hex = (bits: number): string => `0x${bits.toString(16).toUpperCase().padStart(2, '0')}`;
      transport.push(`flags:${invert ? '!' : ''}${numeric ? `${hex(mask)}/${hex(comp)}` : `${tcpFlagListText(mask)}/${tcpFlagListText(comp)}`}`);
    }
    if (transport.length > 0) parts.push(`${r.protocol} ${transport.join(' ')}`);
    if (r.icmpType !== null) parts.push(this.icmpListText(r.icmpType, numeric));
    for (const m of r.matches) {
      const s = this.fmtMatch(m, numeric);
      if (s) parts.push(s);
    }
    const t = r.natRange === null ? this.fmtTargetExtras(r.targetOptions) : natListing(r.target as NatTargetName, r.natRange);
    if (t) parts.push(t);
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  private portTerm(name: 'spt' | 'dpt', spec: string, negated: boolean, proto: string, numeric: boolean): string {
    return `${name}${spec.includes(':') ? 's' : ''}:${negated ? '!' : ''}${this.portLabel(spec, proto, numeric)}`;
  }

  private icmpListText(match: IcmpTypeMatch, numeric: boolean): string {
    const names = this.family === 6 ? ICMPV6_TYPE_NAMES : ICMPV4_TYPE_NAMES;
    const lead = this.family === 6 ? 'ipv6-icmp' : 'icmp';
    const named = numeric ? undefined : names.find((entry) => entry.type === match.type
      && entry.codeMin === match.codeMin && entry.codeMax === match.codeMax);
    if (named !== undefined) return `${lead} ${match.invert ? '!' : ''}${named.name}`;
    const codes = match.codeMin === match.codeMax ? ` code ${match.codeMin}` : '';
    return `${lead}${match.invert ? ' !' : ''}type ${match.type}${codes}`;
  }

  private portLabel(spec: string, proto: string, numeric: boolean): string {
    if (numeric || !this.resolveService || !/^\d+$/.test(spec)) return spec;
    return this.resolveService(parseInt(spec, 10), proto || 'tcp') ?? spec;
  }

  private fmtMatch(m: MatchExtension, numeric: boolean): string {
    const o = m.options;
    const bang = (option: string): string => (inverts(m, option) ? '! ' : '');
    switch (m.module) {
      case 'tcp': case 'udp': case 'icmp': return '';
      case 'state':     return o.get('--state') ? `${bang('--state')}state ${o.get('--state')}` : '';
      case 'conntrack': return o.get('--ctstate') ? `${bang('--ctstate')}ctstate ${o.get('--ctstate')}` : '';
      case 'multiport': {
        const listed = MULTIPORT_LISTING.find(([option]) => o.get(option));
        if (listed === undefined) return 'multiport';
        const [option, label] = listed;
        return `multiport ${label} ${inverts(m, option) ? ' !' : ''}${o.get(option)}`;
      }
      case 'recent': {
        const flags: Array<[string, string]> = [['--set', 'SET'], ['--rcheck', 'CHECK'], ['--update', 'UPDATE'], ['--remove', 'REMOVE']];
        const named = flags.filter(([option]) => o.has(option));
        const inverted = named.some(([option]) => inverts(m, option));
        const parts = [`${inverted ? '! ' : ''}recent:`, ...named.map(([, label]) => label)];
        if (o.has('--seconds')) parts.push(`seconds: ${o.get('--seconds')}`);
        if (o.has('--reap')) parts.push('reap');
        if (o.has('--hitcount')) parts.push(`hit_count: ${o.get('--hitcount')}`);
        if (o.has('--rttl')) parts.push('TTL-Match');
        parts.push(`name: ${o.get('--name') || 'DEFAULT'}`, `side: ${o.has('--rdest') ? 'dest' : 'source'}`);
        parts.push(`mask: ${o.get('--mask') || (this.family === 6 ? 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' : '255.255.255.255')}`);
        return parts.join(' ');
      }
      case 'string': {
        const quoted = (o.get('--string') ?? '').replace(/["\\]/g, (c) => `\\${c}`);
        const tail = [`ALGO name ${o.get('--algo') ?? 'bm'}`];
        if (o.has('--from') && o.get('--from') !== '0') tail.push(`FROM ${o.get('--from')}`);
        const to = o.get('--to') ?? '65535';
        if (to !== '0') tail.push(`TO ${to}`);
        if (o.has('--icase')) tail.push('ICASE');
        return `STRING match ${inverts(m, '--string') ? '!' : ''} "${quoted}" ${tail.join(' ')}`;
      }
      case 'owner': return this.ownerListing(m, numeric);
      case 'hashlimit': {
        const config = parseHashlimit(o, m.negated ?? new Set());
        return typeof config === 'string' ? '' : hashlimitListing(config, this.family === 6 ? 128 : 32);
      }
      case 'tcpmss': {
        const range = parseMssRange(o.get('--mss') ?? '');
        return typeof range === 'string' ? '' : mssListing(range, inverts(m, '--mss'));
      }
      case 'dscp': {
        const value = parseDscp(o);
        return typeof value === 'string' ? '' : dscpListing(value, (m.negated?.size ?? 0) > 0);
      }
      case 'tos': {
        const value = parseTos(o.get('--tos') ?? '');
        return typeof value === 'string' ? '' : tosListing(value, inverts(m, '--tos'));
      }
      case 'connlimit': {
        const view = this.connlimitView(m);
        return `#conn ${view.daddr ? 'dst' : 'src'}/${view.mask} ${view.inverted ? '<=' : '>'} ${view.limit}`;
      }
      case 'length': {
        const range = parseLengthRange(o.get('--length') ?? '');
        return typeof range === 'string' ? '' : lengthListing(range, inverts(m, '--length'));
      }
      case 'time': {
        const window = parseTimeWindow(o, m.negated ?? new Set());
        return typeof window === 'string' ? '' : timeWindowListing(window);
      }
      case 'ttl': {
        const modes: Array<[string, string]> = [['--ttl-eq', '=='], ['--ttl-gt', '>'], ['--ttl-lt', '<']];
        const [option, sign] = modes.find(([name]) => o.has(name)) ?? ['--ttl-eq', '=='];
        return `TTL match TTL ${inverts(m, option) ? '!=' : sign} ${o.get(option) ?? ''}`;
      }
      case 'mark': {
        const [mark, mask] = (o.get('--mark') ?? '0').split('/');
        const hex = (text: string): string => `0x${(Number(text) >>> 0).toString(16)}`;
        return `mark match${inverts(m, '--mark') ? ' !' : ''} ${hex(mark)}${mask === undefined ? '' : `/${hex(mask)}`}`;
      }
      case 'pkttype': return `PKTTYPE ${inverts(m, '--pkt-type') ? '!' : ''}= ${pkttypeOf(o.get('--pkt-type') ?? '') ?? o.get('--pkt-type') ?? ''}`;
      case 'iprange': {
        const ranges: string[] = [];
        if (o.has('--src-range')) ranges.push(`source IP range${inverts(m, '--src-range') ? ' !' : ''} ${o.get('--src-range')}`);
        if (o.has('--dst-range')) ranges.push(`destination IP range${inverts(m, '--dst-range') ? ' !' : ''} ${o.get('--dst-range')}`);
        return ranges.join(' ');
      }
      case 'addrtype': {
        const types: string[] = ['ADDRTYPE match'];
        if (o.has('--src-type')) types.push(`src-type ${inverts(m, '--src-type') ? '!' : ''}${o.get('--src-type')}`);
        if (o.has('--dst-type')) types.push(`dst-type ${inverts(m, '--dst-type') ? '!' : ''}${o.get('--dst-type')}`);
        return types.join(' ');
      }
      case 'comment':   return `/* ${o.get('--comment') ?? ''} */`;
      case 'limit':     return `limit: avg ${o.get('--limit') ?? ''} burst ${o.get('--limit-burst') ?? '5'}`;
      case 'mac':       return o.get('--mac-source') ? `MAC ${inverts(m, '--mac-source') ? '!' : ''}${o.get('--mac-source')}` : '';
      default: {
        const parts: string[] = [];
        for (const [k, v] of o) parts.push(`${bang(k)}${v ? `${k.replace(/^--/, '')} ${v}` : k.replace(/^--/, '')}`);
        return parts.join(' ');
      }
    }
  }

  private ownerListing(m: MatchExtension, numeric: boolean): string {
    const items: Array<[string, string]> = [
      ['--socket-exists', 'owner socket exists'], ['--uid-owner', 'owner UID match'],
      ['--gid-owner', 'owner GID match'], ['--suppl-groups', 'incl. suppl. groups'],
    ];
    const out: string[] = [];
    for (const [option, label] of items) {
      if (!m.options.has(option)) continue;
      const raw = m.options.get(option) ?? '';
      const names = numeric ? null : this.ownerNames;
      const resolver = option === '--uid-owner' ? names?.user : option === '--gid-owner' ? names?.group : undefined;
      const value = resolver !== undefined && /^\d+$/.test(raw) ? (resolver(Number(raw)) ?? raw) : raw;
      out.push(`${inverts(m, option) ? '! ' : ''}${label}${value === '' ? '' : ` ${value}`}`);
    }
    return out.join(' ');
  }

  private fmtTargetExtras(opts: TargetOptions): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(opts)) {
      switch (k) {
        case '--to-destination': case '--to-source': parts.push(`to:${v}`); break;
        case '--to-ports':       parts.push(`redir ports ${v}`); break;
        case '--reject-with':    parts.push(`reject-with ${v}`); break;
        case '--log-prefix':     parts.push(`LOG flags 0 level 4 prefix "${v}"`); break;
        case '--log-level':      break;
        case '--set-mark': case '--or-mark': case '--and-mark': case '--xor-mark': case '--set-xmark':
          parts.push(markListing(k, v));
          break;
        default:                 parts.push(v ? `${k.replace(/^--/, '')} ${v}` : k.replace(/^--/, '')); break;
      }
    }
    return parts.join(' ');
  }

  private countRefs(name: string, table: IptablesTable): number {
    let n = 0;
    for (const c of table.chains.values()) for (const r of c.rules) if (r.target === name) n++;
    return n;
  }

  // ─── -S ────────────────────────────────────────────────────────

  private cmdListRules(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const chainName = args.find(a => !a.startsWith('-'));
    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
      return { output: this.fmtChainRules(chain), exitCode: 0 };
    }
    const lines: string[] = [];
    for (const chain of table.chains.values()) lines.push(this.fmtChainDeclaration(chain));
    for (const chain of table.chains.values()) lines.push(...this.fmtChainRuleLines(chain));
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private fmtChainDeclaration(chain: IptablesChain): string {
    return chain.policy !== null ? `-P ${chain.name} ${chain.policy}` : `-N ${chain.name}`;
  }

  private fmtChainRuleLines(chain: IptablesChain): string[] {
    return chain.rules.map((rule) => this.fmtRuleCmd('A', chain.name, rule));
  }

  private fmtChainRules(chain: IptablesChain): string {
    return [this.fmtChainDeclaration(chain), ...this.fmtChainRuleLines(chain)].join('\n');
  }

  private hostMasked(address: string): string {
    return address.includes('/') ? address : `${address}/${this.family === 6 ? 128 : 32}`;
  }

  fmtRuleCmd(action: string, chainName: string, rule: IptablesRule): string {
    const p: string[] = [`-${action} ${chainName}`];
    if (rule.source)       { if (rule.negSource) p.push('!'); p.push(`-s ${this.hostMasked(rule.source)}`); }
    if (rule.destination)  { if (rule.negDestination) p.push('!'); p.push(`-d ${this.hostMasked(rule.destination)}`); }
    if (rule.inInterface)  { if (rule.negInInterface) p.push('!'); p.push(`-i ${rule.inInterface}`); }
    if (rule.outInterface) { if (rule.negOutInterface) p.push('!'); p.push(`-o ${rule.outInterface}`); }
    if (rule.protocol && rule.protocol !== 'all') { if (rule.negProtocol) p.push('!'); p.push(`-p ${rule.protocol}`); }
    if (rule.fragment !== '') p.push(rule.fragment === 'not' ? '! -f' : '-f');
    const carrier = this.protocolModule(rule);
    if (carrier !== '') p.push(`-m ${carrier}`);
    if (rule.sport) p.push(`${rule.negSport ? '! ' : ''}--sport ${rule.sport}`);
    if (rule.dport) p.push(`${rule.negDport ? '! ' : ''}--dport ${rule.dport}`);
    if (rule.tcpOption !== null) p.push(`${rule.tcpOption.invert ? '! ' : ''}--tcp-option ${rule.tcpOption.kind}`);
    if (rule.tcpFlags !== null) {
      p.push(`${rule.tcpFlags.invert ? '! ' : ''}--tcp-flags ${tcpFlagListText(rule.tcpFlags.mask)} ${tcpFlagListText(rule.tcpFlags.comp)}`);
    }
    if (rule.icmpType !== null) {
      p.push(`${rule.icmpType.invert ? '! ' : ''}${this.family === 6 ? '--icmpv6-type' : '--icmp-type'} ${icmpTypeSpecText(rule.icmpType)}`);
    }
    for (const m of rule.matches) {
      p.push(`-m ${m.module}`);
      for (const [opt, val] of m.options) {
        p.push(`${inverts(m, opt) ? '! ' : ''}${val === '' ? opt : `${opt} ${this.quote(val)}`}`);
      }
    }
    if (rule.target) {
      p.push(`${rule.goto ? '-g' : '-j'} ${rule.target}`);
      if (rule.natRange === null) {
        for (const [opt, val] of Object.entries(rule.targetOptions)) p.push(`${opt} ${this.quote(val)}`);
      } else {
        p.push(...natSaveOptions(rule.target as NatTargetName, rule.natRange));
      }
    }
    return p.join(' ');
  }

  private protocolModule(rule: IptablesRule): string {
    if (rule.sport || rule.dport || rule.tcpOption !== null || rule.tcpFlags !== null) {
      return rule.protocol === 'tcp' || rule.protocol === 'udp' ? rule.protocol : '';
    }
    if (rule.icmpType !== null) return this.family === 6 ? 'icmp6' : 'icmp';
    return '';
  }

  private quote(v: string): string { return v.includes(' ') ? `"${v}"` : v; }

  // ─── -F ────────────────────────────────────────────────────────

  private cmdFlush(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const cn = args.find(a => !a.startsWith('-'));
    if (cn) {
      const ch = table.chains.get(cn);
      if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
      ch.rules = [];
    } else {
      for (const ch of table.chains.values()) ch.rules = [];
    }
    return { output: '', exitCode: 0 };
  }

  // ─── -P ────────────────────────────────────────────────────────

  private cmdPolicy(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -P requires a chain and a policy', exitCode: 2 };
    const [cn, pol] = args;
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    if (ch.policy === null) return { output: `iptables: Can't set policy on user-defined chain \`${cn}'`, exitCode: 1 };
    if (!VALID_BUILTIN_POLICIES.has(pol)) return { output: 'iptables v1.8.7 (nf_tables): Bad policy name. Try ACCEPT or DROP.', exitCode: 2 };
    ch.policy = pol as BuiltinPolicy;
    return { output: '', exitCode: 0 };
  }

  // ─── -A ────────────────────────────────────────────────────────

  private cmdAppend(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: 'iptables v1.8.7 (nf_tables): -A requires a chain name', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    const r = this.parseRuleFor(cn, args.slice(1));
    if ('exitCode' in r) return r;
    // Validate target exists if it's a chain jump
    if (r.target && !VALID_TARGETS.has(r.target) && !table.chains.has(r.target)) {
      return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    }
    const natErr = this.natTargetChainError(table, cn, r.target, 'RULE_APPEND')
      ?? this.structureError(r, cn, 'RULE_APPEND');
    if (natErr) return { output: natErr, exitCode: 4 };
    ch.rules.push(r);
    return { output: '', exitCode: 0 };
  }

  private get banner(): string {
    return `${this.family === 6 ? 'ip6tables' : 'iptables'} v1.8.7 (nf_tables)`;
  }

  private rejectWithError(rule: IptablesRule): string | null {
    if (rule.target !== 'REJECT') return null;
    const argument = rule.targetOptions['--reject-with'];
    if (argument === undefined) return null;
    if (argument === '') return this.parameterProblem('option "--reject-with" requires an argument');
    const type = rejectTypeOf(this.family, argument);
    if (type === null) return this.parameterProblem(`unknown reject type "${argument}"`);
    rule.targetOptions['--reject-with'] = type.name;
    return null;
  }

  private structureError(
    rule: IptablesRule, chainName: string, op: 'RULE_APPEND' | 'RULE_INSERT' | 'RULE_REPLACE',
  ): string | null {
    return this.tcpResetError(rule, chainName, op) ?? this.protocolMatchError(rule, chainName, op);
  }

  private protocolMatchError(
    rule: IptablesRule, chainName: string, op: 'RULE_APPEND' | 'RULE_INSERT' | 'RULE_REPLACE',
  ): string | null {
    if (rule.protocolMatch === '') return null;
    const wanted = { tcp: IP_PROTO_TCP, udp: IP_PROTO_UDP, icmp: IP_PROTO_ICMP, icmp6: IP_PROTO_ICMPV6 }[rule.protocolMatch];
    const protocol = rule.negProtocol ? null : protocolNumberOf(rule.protocol);
    return protocol === wanted ? null : `${this.banner}:  ${op} failed (Invalid argument): rule in chain ${chainName}`;
  }

  private tcpResetError(
    rule: IptablesRule, chainName: string, op: 'RULE_APPEND' | 'RULE_INSERT' | 'RULE_REPLACE',
  ): string | null {
    const argument = rule.target === 'REJECT' ? rule.targetOptions['--reject-with'] : undefined;
    if (argument === undefined || !answersWithTcpReset(this.family, argument)) return null;
    const onlyTcp = !rule.negProtocol && protocolNumberOf(rule.protocol) === IP_PROTO_TCP;
    return onlyTcp ? null : `${this.banner}:  ${op} failed (Invalid argument): rule in chain ${chainName}`;
  }

  /**
   * Reject a nat-table target in a built-in chain its real netfilter hook
   * mask doesn't cover (see NAT_TARGET_HOOKS) — e.g. `-A INPUT -j DNAT`.
   * A jump into a user-defined chain isn't traced back to which built-in
   * chain(s) can reach it, so only direct rules on a built-in chain are
   * checked here, matching the scope already accepted elsewhere in this
   * manager for chain-reachability analysis.
   */
  private natTargetChainError(
    table: IptablesTable, chainName: string, target: string,
    op: 'RULE_APPEND' | 'RULE_INSERT' | 'RULE_REPLACE',
  ): string | null {
    const refusal = `${this.banner}:  ${op} failed (Invalid argument): rule in chain ${chainName}`;
    const requiredTable = TARGET_TABLE[target];
    if (requiredTable !== undefined && requiredTable !== table.name) return refusal;
    const allowedChains = NAT_TARGET_HOOKS[target];
    if (!allowedChains) return null;
    if (!TABLE_BUILTIN_CHAINS.nat.includes(chainName)) return null;
    if (allowedChains.includes(chainName)) return null;
    return refusal;
  }

  // ─── -D ────────────────────────────────────────────────────────

  private cmdDelete(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -D requires a chain and rule specification or number', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };

    // Delete by number
    if (args.length === 2 && /^\d+$/.test(args[1])) {
      const num = parseInt(args[1]);
      if (num < 1 || num > ch.rules.length) return { output: 'iptables: Index of deletion too big.', exitCode: 1 };
      ch.rules.splice(num - 1, 1);
      return { output: '', exitCode: 0 };
    }

    // Delete by specification
    const spec = this.parseRuleFor(cn, args.slice(1));
    if ('exitCode' in spec) return spec;
    const idx = ch.rules.findIndex(r => this.rulesEqual(r, spec));
    if (idx === -1) return { output: 'iptables: Bad rule (does a matching rule exist in that chain?).', exitCode: 1 };
    ch.rules.splice(idx, 1);
    return { output: '', exitCode: 0 };
  }

  // ─── -I ────────────────────────────────────────────────────────

  private cmdInsert(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: 'iptables v1.8.7 (nf_tables): -I requires a chain name', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };

    let pos = 1;
    let ruleArgs: string[];
    if (args.length > 1 && /^\d+$/.test(args[1])) {
      pos = parseInt(args[1]);
      ruleArgs = args.slice(2);
    } else {
      ruleArgs = args.slice(1);
    }

    const r = this.parseRuleFor(cn, ruleArgs);
    if ('exitCode' in r) return r;
    const natErrI = this.natTargetChainError(table, cn, r.target, 'RULE_INSERT')
      ?? this.structureError(r, cn, 'RULE_INSERT');
    if (natErrI) return { output: natErrI, exitCode: 4 };
    ch.rules.splice(Math.min(pos - 1, ch.rules.length), 0, r);
    return { output: '', exitCode: 0 };
  }

  // ─── -R ────────────────────────────────────────────────────────

  private cmdReplace(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 3) return { output: 'iptables v1.8.7 (nf_tables): -R requires a chain, rule number, and rule specification', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    const num = parseInt(args[1]);
    if (isNaN(num) || num < 1 || num > ch.rules.length) return { output: 'iptables: Index of replacement too big.', exitCode: 1 };
    const r = this.parseRuleFor(cn, args.slice(2));
    if ('exitCode' in r) return r;
    const natErrR = this.natTargetChainError(table, cn, r.target, 'RULE_REPLACE')
      ?? this.structureError(r, cn, 'RULE_REPLACE');
    if (natErrR) return { output: natErrR, exitCode: 4 };
    ch.rules[num - 1] = r;
    return { output: '', exitCode: 0 };
  }

  // ─── -C ────────────────────────────────────────────────────────

  private cmdCheck(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -C requires a chain and rule specification', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    const spec = this.parseRuleFor(cn, args.slice(1));
    if ('exitCode' in spec) return spec;
    if (!ch.rules.some(r => this.rulesEqual(r, spec))) {
      return { output: 'iptables: Bad rule (does a matching rule exist in that chain?).', exitCode: 1 };
    }
    return { output: '', exitCode: 0 };
  }

  // ─── -N ────────────────────────────────────────────────────────

  private cmdNewChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: 'iptables v1.8.7 (nf_tables): -N requires a chain name', exitCode: 2 };
    if (table.chains.has(args[0])) return { output: 'iptables: Chain already exists.', exitCode: 1 };
    table.chains.set(args[0], { name: args[0], policy: null, rules: [], pkts: 0, bytes: 0 });
    return { output: '', exitCode: 0 };
  }

  // ─── -X ────────────────────────────────────────────────────────

  private cmdDeleteChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      const del: string[] = [];
      for (const [n, c] of table.chains) if (c.policy === null && c.rules.length === 0) del.push(n);
      for (const n of del) table.chains.delete(n);
      return { output: '', exitCode: 0 };
    }
    const err = this.deleteChain(table.name, args[0]);
    if (err) {
      if (err.includes('built-in')) return { output: `iptables: ${err}`, exitCode: 1 };
      return { output: `iptables: ${err}.`, exitCode: 1 };
    }
    return { output: '', exitCode: 0 };
  }

  // ─── -E ────────────────────────────────────────────────────────

  private cmdRenameChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -E requires old and new chain names', exitCode: 2 };
    const [oldN, newN] = args;
    const ch = table.chains.get(oldN);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    if (ch.policy !== null) return { output: "iptables: Can't rename built-in chain.", exitCode: 1 };
    if (table.chains.has(newN)) return { output: 'iptables: File exists.', exitCode: 1 };
    table.chains.delete(oldN);
    ch.name = newN;
    table.chains.set(newN, ch);
    for (const c of table.chains.values()) for (const r of c.rules) if (r.target === oldN) r.target = newN;
    return { output: '', exitCode: 0 };
  }

  // ─── -Z ────────────────────────────────────────────────────────

  private cmdZero(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const cn = args.find(a => !a.startsWith('-'));
    const chains = cn ? [table.chains.get(cn)].filter(Boolean) as IptablesChain[] : [...table.chains.values()];
    if (cn && !table.chains.has(cn)) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    for (const ch of chains) {
      ch.pkts = 0; ch.bytes = 0;
      for (const r of ch.rules) { r.pkts = 0; r.bytes = 0; }
    }
    return { output: '', exitCode: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // iptables-save / iptables-restore
  // ═══════════════════════════════════════════════════════════════════

  executeSave(): string {
    const lines: string[] = ['# Generated by iptables-save'];
    for (const [tn, table] of this.tables) {
      const hasContent = [...table.chains.values()].some(c => c.rules.length > 0 || (c.policy !== null && c.policy !== 'ACCEPT') || c.policy === null);
      if (!hasContent && tn !== 'filter') continue;

      lines.push(`*${tn}`);
      for (const [, ch] of table.chains) {
        lines.push(`:${ch.name} ${ch.policy ?? '-'} [${ch.pkts}:${ch.bytes}]`);
      }
      for (const [, ch] of table.chains) {
        for (const r of ch.rules) lines.push(this.fmtRuleCmd('A', ch.name, r));
      }
      lines.push('COMMIT');
    }
    return lines.join('\n');
  }

  executeRestore(input: string): { output: string; exitCode: number } {
    const lines = input.split('\n');
    let curTable: IptablesTable | null = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('*')) {
        const tn = line.slice(1);
        if (!VALID_TABLES.has(tn)) return { output: `iptables-restore: line failed: ${line}`, exitCode: 1 };
        curTable = this.tables.get(tn as TableName)!;
        for (const ch of curTable.chains.values()) ch.rules = [];
        continue;
      }
      if (line === 'COMMIT') { curTable = null; continue; }
      if (!curTable) continue;

      if (line.startsWith(':')) {
        const m = line.match(/^:(\S+)\s+(\S+)\s+\[(\d+):(\d+)\]/);
        if (m) {
          let ch = curTable.chains.get(m[1]);
          if (!ch) { ch = { name: m[1], policy: null, rules: [], pkts: 0, bytes: 0 }; curTable.chains.set(m[1], ch); }
          if (m[2] !== '-') ch.policy = m[2] as BuiltinPolicy;
          ch.pkts = parseInt(m[3]); ch.bytes = parseInt(m[4]);
        }
        continue;
      }

      if (line.startsWith('-A ')) {
        const ruleArgs = this.tokenize(line.slice(3));
        const res = this.cmdAppend(curTable, ruleArgs);
        if (res.exitCode !== 0) return { output: `iptables-restore: line failed: ${line}`, exitCode: 1 };
      }
    }
    return { output: '', exitCode: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // nft list ruleset — the nftables view onto the same live tables
  // (Ubuntu's iptables-nft backend and nft share one netfilter state).
  // ═══════════════════════════════════════════════════════════════════

  listRuleset(): string {
    const fam = this.family === 6 ? 'ip6' : 'ip';
    const lines: string[] = [];
    for (const [tn, table] of this.tables) {
      const hasContent = [...table.chains.values()].some(
        (c) => c.rules.length > 0 || (c.policy !== null && c.policy !== 'ACCEPT'),
      );
      if (!hasContent) continue;

      lines.push(`table ${fam} ${tn} {`);
      for (const [, ch] of table.chains) {
        if (ch.rules.length === 0 && (ch.policy === null || ch.policy === 'ACCEPT')) continue;
        lines.push(`\tchain ${ch.name} {`);
        const hookLine = this.nftHookLine(tn, ch.name, ch.policy);
        if (hookLine) lines.push(`\t\t${hookLine}`);
        for (const r of ch.rules) lines.push(`\t\t${this.fmtNftRule(r)}`);
        lines.push('\t}');
      }
      lines.push('}');
    }
    return lines.join('\n');
  }

  private static readonly NFT_HOOKS: Record<string, { hook: string; prio: number }> = {
    'filter:INPUT': { hook: 'input', prio: 0 },
    'filter:FORWARD': { hook: 'forward', prio: 0 },
    'filter:OUTPUT': { hook: 'output', prio: 0 },
    'nat:PREROUTING': { hook: 'prerouting', prio: -100 },
    'nat:INPUT': { hook: 'input', prio: 100 },
    'nat:OUTPUT': { hook: 'output', prio: -100 },
    'nat:POSTROUTING': { hook: 'postrouting', prio: 100 },
    'mangle:PREROUTING': { hook: 'prerouting', prio: -150 },
    'mangle:INPUT': { hook: 'input', prio: -150 },
    'mangle:FORWARD': { hook: 'forward', prio: -150 },
    'mangle:OUTPUT': { hook: 'output', prio: -150 },
    'mangle:POSTROUTING': { hook: 'postrouting', prio: -150 },
    'raw:PREROUTING': { hook: 'prerouting', prio: -300 },
    'raw:OUTPUT': { hook: 'output', prio: -300 },
  };

  private nftHookLine(tableName: TableName, chainName: string, policy: BuiltinPolicy | null): string {
    if (policy === null) return '';
    const spec = LinuxIptablesManager.NFT_HOOKS[`${tableName}:${chainName}`];
    if (!spec) return '';
    const type = tableName === 'nat' ? 'nat' : 'filter';
    return `type ${type} hook ${spec.hook} priority ${spec.prio}; policy ${policy.toLowerCase()};`;
  }

  private fmtNftRule(r: IptablesRule): string {
    const fam = this.family === 6 ? 'ip6' : 'ip';
    const parts: string[] = [];
    if (r.source) parts.push(`${fam} saddr ${r.negSource ? '!= ' : ''}${r.source}`);
    if (r.destination) parts.push(`${fam} daddr ${r.negDestination ? '!= ' : ''}${r.destination}`);
    if (r.inInterface) parts.push(`iifname ${r.negInInterface ? '!= ' : ''}"${r.inInterface}"`);
    if (r.outInterface) parts.push(`oifname ${r.negOutInterface ? '!= ' : ''}"${r.outInterface}"`);
    if (r.protocol && r.protocol !== 'all') {
      if (r.sport) parts.push(`${r.protocol} sport ${r.sport}`);
      if (r.dport) parts.push(`${r.protocol} dport ${r.dport}`);
      if (!r.sport && !r.dport) parts.push(`meta l4proto ${r.protocol}`);
    }
    for (const m of r.matches) {
      const s = this.fmtNftMatch(m);
      if (s) parts.push(s);
    }
    parts.push(`counter packets ${r.pkts} bytes ${r.bytes}`);
    const action = this.fmtNftAction(r);
    if (action) parts.push(action);
    return parts.join(' ');
  }

  private fmtNftMatch(m: MatchExtension): string {
    const o = m.options;
    switch (m.module) {
      case 'state': return o.get('--state') ? `ct state ${(o.get('--state') ?? '').toLowerCase()}` : '';
      case 'conntrack': return o.get('--ctstate') ? `ct state ${(o.get('--ctstate') ?? '').toLowerCase()}` : '';
      case 'comment': return o.get('--comment') ? `comment "${o.get('--comment')}"` : '';
      case 'limit': return o.get('--limit') ? `limit rate ${o.get('--limit')}` : '';
      case 'mac': return o.get('--mac-source') ? `ether saddr ${o.get('--mac-source')}` : '';
      default: return '';
    }
  }

  private fmtNftAction(r: IptablesRule): string {
    switch (r.target) {
      case 'ACCEPT': return 'accept';
      case 'DROP': return 'drop';
      case 'REJECT': {
        const w = r.targetOptions['--reject-with'];
        if (w === 'tcp-reset') return 'reject with tcp reset';
        if (w) return `reject with icmp type ${w.replace(/^icmp-/, '')}`;
        return 'reject';
      }
      case 'RETURN': return 'return';
      case 'LOG': {
        const prefix = r.targetOptions['--log-prefix'];
        return prefix ? `log prefix "${prefix}"` : 'log';
      }
      case 'MASQUERADE': return 'masquerade';
      case 'DNAT': return `dnat to ${r.targetOptions['--to-destination'] ?? ''}`;
      case 'SNAT': return `snat to ${r.targetOptions['--to-source'] ?? ''}`;
      case 'REDIRECT': return `redirect to :${r.targetOptions['--to-port'] ?? r.targetOptions['--to-ports'] ?? ''}`;
      default: return `jump ${r.target}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Rule parsing & validation
  // ═══════════════════════════════════════════════════════════════════

  private get tool(): string {
    return this.family === 6 ? 'ip6tables' : 'iptables';
  }

  private parameterProblem(message: string): string {
    return `${this.banner}: ${message}\nTry \`${this.tool} -h' or '${this.tool} --help' for more information.`;
  }

  private parseRuleFor(chain: string, args: string[]): IptablesRule | { output: string; exitCode: number } {
    const rule = this.parseRule(args);
    if (typeof rule === 'string') return { output: rule, exitCode: 2 };
    const misplaced = this.interfaceOptionProblem(chain, rule);
    return misplaced === null ? rule : { output: misplaced, exitCode: 2 };
  }

  private interfaceOptionProblem(chain: string, rule: IptablesRule): string | null {
    if ((chain === 'PREROUTING' || chain === 'INPUT') && rule.outInterface !== '') {
      return this.parameterProblem(`Can't use -o with ${chain}\n`);
    }
    if ((chain === 'POSTROUTING' || chain === 'OUTPUT') && rule.inInterface !== '') {
      return this.parameterProblem(`Can't use -i with ${chain}\n`);
    }
    return null;
  }

  private multiportProtocolProblem(rule: IptablesRule): string | null {
    const protocol = rule.negProtocol ? null : protocolNumberOf(rule.protocol);
    if (protocol !== null && PORT_BEARING_PROTOCOLS.has(protocol)) return null;
    return this.parameterProblem(rule.protocol === '' && !rule.negProtocol
      ? "multiport needs `-p tcp', `-p udp', `-p udplite', `-p sctp' or `-p dccp'"
      : 'multiport only works with TCP, UDP, UDPLITE, SCTP and DCCP');
  }

  private static moduleProblem(module: string, options: ReadonlyMap<string, string>, negated: ReadonlySet<string>): string | null {
    if (module === 'recent' && !RECENT_ACTIONS.some((name) => options.has(name))) {
      return "recent: you must specify one of `--set', `--rcheck' `--update' or `--remove'";
    }
    if (module === 'hashlimit') {
      const config = parseHashlimit(options, negated);
      if (typeof config === 'string') return config;
    }
    if (module === 'pkttype' && pkttypeOf(options.get('--pkt-type') ?? '') === null) {
      return `Bad packet type '${options.get('--pkt-type') ?? ''}'`;
    }
    if (module === 'tcpmss') {
      const range = parseMssRange(options.get('--mss') ?? '');
      if (typeof range === 'string') return range;
    }
    if (module === 'dscp') {
      const value = parseDscp(options);
      if (typeof value === 'string') return value;
    }
    if (module === 'tos') {
      const value = parseTos(options.get('--tos') ?? '');
      if (typeof value === 'string') return value;
    }
    if (module === 'connlimit' && !options.has('--connlimit-above') && !options.has('--connlimit-upto')) {
      return 'You must specify "--connlimit-above" or "--connlimit-upto".';
    }
    if (module === 'time') {
      const window = parseTimeWindow(options, negated);
      if (typeof window === 'string') return window;
    }
    if (module === 'length') {
      const range = parseLengthRange(options.get('--length') ?? '');
      if (typeof range === 'string') return range;
    }
    if (module === 'string' && !options.has('--string') && !options.has('--hex-string')) {
      return "STRING match: You must specify `--string' or `--hex-string'";
    }
    return null;
  }

  private optionApplies(rule: IptablesRule, module: 'tcp' | 'port' | 'icmp'): boolean {
    const protocol = rule.negProtocol ? null : protocolNumberOf(rule.protocol);
    if (module === 'tcp') return rule.protocolMatch === 'tcp' || protocol === IP_PROTO_TCP;
    if (module === 'port') {
      return rule.protocolMatch === 'tcp' || rule.protocolMatch === 'udp'
        || (protocol !== null && PORT_BEARING_PROTOCOLS.has(protocol));
    }
    if (this.family === 6) return rule.protocolMatch === 'icmp6' || protocol === IP_PROTO_ICMPV6;
    return rule.protocolMatch === 'icmp' || protocol === IP_PROTO_ICMP;
  }

  parseRule(args: string[]): IptablesRule | string {
    const rule = LinuxIptablesManager.createRule();
    let i = 0;

    while (i < args.length) {
      const isNeg = args[i] === '!';
      if (isNeg) { i++; if (i >= args.length) break; }
      const flag = args[i];

      switch (flag) {
        case '-p': case '--protocol':
          i++;
          if (i >= args.length) return 'iptables: option "-p" requires an argument';
          if (isNeg) rule.negProtocol = true;
          rule.protocol = args[i];
          if (rule.protocol !== 'all' && protocolNumberOf(rule.protocol) === null) {
            return `iptables v1.8.7 (nf_tables): unknown protocol "${rule.protocol}"`;
          }
          break;

        case '-s': case '--source':
          i++;
          if (i >= args.length) return 'iptables: option "-s" requires an argument';
          if (isNeg) rule.negSource = true;
          rule.source = args[i];
          if (!this.validateIPSpec(rule.source)) return `iptables: host/network \`${rule.source}' not found`;
          break;

        case '-d': case '--destination':
          i++;
          if (i >= args.length) return 'iptables: option "-d" requires an argument';
          if (isNeg) rule.negDestination = true;
          rule.destination = args[i];
          if (!this.validateIPSpec(rule.destination)) return `iptables: host/network \`${rule.destination}' not found`;
          break;

        case '-i': case '--in-interface':
          i++;
          if (i >= args.length) return 'iptables: option "-i" requires an argument';
          if (isNeg) rule.negInInterface = true;
          rule.inInterface = args[i];
          break;

        case '-o': case '--out-interface':
          i++;
          if (i >= args.length) return 'iptables: option "-o" requires an argument';
          if (isNeg) rule.negOutInterface = true;
          rule.outInterface = args[i];
          break;

        case '--sport': case '--source-port': case '--dport': case '--destination-port': {
          const source = flag === '--sport' || flag === '--source-port';
          if (!this.optionApplies(rule, 'port')) return this.parameterProblem(`unknown option "${flag}"`);
          i++;
          if (i >= args.length) return this.parameterProblem(`option "${flag}" requires an argument`);
          if (source ? rule.sport : rule.dport) {
            return this.parameterProblem(`Only one \`--${source ? 'source' : 'destination'}-port' allowed`);
          }
          const spec = args[i];
          if (!this.validatePortSpec(spec)) return `iptables: invalid port/service \`${spec}' specified`;
          if (source) { rule.sport = spec; rule.negSport = isNeg; } else { rule.dport = spec; rule.negDport = isNeg; }
          break;
        }

        case '--syn': case '--tcp-flags': {
          if (!this.optionApplies(rule, 'tcp')) return this.parameterProblem(`unknown option "${flag}"`);
          if (rule.tcpFlags !== null) return this.parameterProblem('Only one of `--syn\' or `--tcp-flags\'  allowed');
          if (flag === '--syn') {
            rule.tcpFlags = { mask: TCP_SYN_MASK, comp: TCP_SYN_FLAG, invert: isNeg };
            break;
          }
          if (i + 1 >= args.length) return this.parameterProblem(`option "${flag}" requires an argument`);
          const comp = args[i + 2];
          if (comp === undefined || comp.startsWith('-') || comp.startsWith('!')) {
            return this.parameterProblem('--tcp-flags requires two args.');
          }
          const mask = parseTcpFlagList(args[i + 1]);
          if (typeof mask === 'string') return this.parameterProblem(`Unknown TCP flag \`${mask}'`);
          const wanted = parseTcpFlagList(comp);
          if (typeof wanted === 'string') return this.parameterProblem(`Unknown TCP flag \`${wanted}'`);
          rule.tcpFlags = { mask, comp: wanted, invert: isNeg };
          i += 2;
          break;
        }

        case '--tcp-option': {
          if (!this.optionApplies(rule, 'tcp')) return this.parameterProblem(`unknown option "${flag}"`);
          i++;
          if (i >= args.length) return this.parameterProblem(`option "${flag}" requires an argument`);
          if (rule.tcpOption !== null) return this.parameterProblem('Only one `--tcp-option\' allowed');
          const kind = parseUint8(args[i]);
          if (kind === null || kind < 1) return this.parameterProblem(`Bad TCP option "${args[i]}"`);
          rule.tcpOption = { kind, invert: isNeg };
          break;
        }

        case '--icmp-type': case '--icmpv6-type': {
          const expected = this.family === 6 ? '--icmpv6-type' : '--icmp-type';
          if (flag !== expected || !this.optionApplies(rule, 'icmp')) return this.parameterProblem(`unknown option "${flag}"`);
          i++;
          if (i >= args.length) return this.parameterProblem(`option "${flag}" requires an argument`);
          const parsed = parseIcmpTypeSpec(args[i], this.family, isNeg);
          if (typeof parsed === 'string') return this.parameterProblem(parsed);
          rule.icmpType = parsed;
          break;
        }

        case '-f': case '--fragment':
          if (this.family === 6) return this.parameterProblem(`unknown option "${flag}"`);
          rule.fragment = isNeg ? 'not' : 'only';
          break;

        case '-c': case '--set-counters': {
          if (i + 1 >= args.length) return this.parameterProblem(`option "${flag}" requires an argument`);
          const packetsText = args[i + 1];
          const comma = packetsText.indexOf(',', 1);
          let bytesText: string | undefined = comma >= 0 ? packetsText.slice(comma + 1) : undefined;
          let consumed = 1;
          if (bytesText === undefined && i + 2 < args.length && !args[i + 2].startsWith('-') && !args[i + 2].startsWith('!')) {
            bytesText = args[i + 2];
            consumed = 2;
          }
          if (bytesText === undefined) return this.parameterProblem('-c requires packet and byte counter');
          const packets = leadingCounter(packetsText);
          if (packets === null) return this.parameterProblem('-c packet counter not numeric');
          const bytes = leadingCounter(bytesText);
          if (bytes === null) return this.parameterProblem('-c byte counter not numeric');
          rule.pkts = packets;
          rule.bytes = bytes;
          i += consumed;
          break;
        }

        case '-n': case '--numeric': case '-v': case '--verbose': case '-x': case '--exact': case '--line-numbers':
          break;

        case '-j': case '--jump': case '-g': case '--goto': {
          i++;
          if (i >= args.length) return `iptables: option "${flag}" requires an argument`;
          rule.goto = flag === '-g' || flag === '--goto';
          rule.target = args[i];
          i++;
          const allowed = TARGET_OPTIONS[rule.target] ?? [];
          const optionCounts = new Map<string, number>();
          while (i < args.length && args[i].startsWith('--')) {
            const typed = args[i];
            const candidates = allowed.includes(typed) ? [typed] : allowed.filter((name) => name.startsWith(typed));
            if (candidates.length !== 1) break;
            const optName = candidates[0];
            optionCounts.set(optName, (optionCounts.get(optName) ?? 0) + 1);
            i++;
            if (TARGET_FLAG_OPTIONS.has(optName)) {
              rule.targetOptions[optName] = '';
            } else if (i < args.length) {
              rule.targetOptions[optName] = args[i]; i++;
            } else {
              rule.targetOptions[optName] = '';
            }
          }
          const natProblem = this.natTargetProblem(rule, optionCounts);
          if (natProblem !== null) return natProblem;
          const rejectError = this.rejectWithError(rule);
          if (rejectError !== null) return rejectError;
          continue;
        }

        case '-m': case '--match': {
          i++;
          if (i >= args.length) return 'iptables: option "-m" requires an argument';
          const mod = args[i];
          const module = mod.toLowerCase();
          if (!IPTABLES_MATCH_MODULES.has(module)) {
            return `iptables v1.8.7 (nf_tables): Couldn't load match \`${mod}':`
              + 'No such file or directory';
          }
          if (PROTOCOL_MATCH_MODULES.has(module)) {
            rule.protocolMatch = module as IptablesRule['protocolMatch'];
            i++;
            continue;
          }
          const accepted = MODULE_OPTIONS[module];
          const options = new Map<string, string>();
          const negated = new Set<string>();
          i++;
          while (i < args.length) {
            const inverted = args[i] === '!' && i + 1 < args.length;
            const typed = inverted ? args[i + 1] : args[i];
            const name = MODULE_OPTION_ALIASES[module]?.[typed] ?? typed;
            const flags = accepted[name];
            if (flags === undefined) break;
            if (module === 'multiport') {
              const problem = this.multiportProtocolProblem(rule);
              if (problem !== null) return problem;
            }
            if (options.has(name)) return this.parameterProblem(`${module}: option "${name}" can only be used once.\n`);
            if (inverted && !flags.includes('I')) return this.parameterProblem(`${module}: option "${name}" cannot be inverted.\n`);
            i += inverted ? 2 : 1;
            let value = '';
            if (!flags.includes('F')) {
              if (i >= args.length) return this.parameterProblem(`${module}: option "${name}" requires an argument.\n`);
              value = args[i];
              i++;
            }
            options.set(name, value);
            if (inverted) negated.add(name);
          }
          const missing = Object.entries(accepted).find(([name, flags]) => flags.includes('M') && !options.has(name));
          if (missing !== undefined) return this.parameterProblem(`${module}: option "${missing[0]}" must be specified\n`);
          const incomplete = LinuxIptablesManager.moduleProblem(module, options, negated);
          if (incomplete !== null) return this.parameterProblem(incomplete);
          rule.matches.push({ module, options, negated });
          continue;
        }

        default:
          return flag.startsWith('-')
            ? this.parameterProblem(`unknown option "${flag}"`)
            : `Bad argument \`${flag}'\nTry \`${this.tool} -h' or '${this.tool} --help' for more information.`;
      }
      i++;
    }
    return rule;
  }

  // ─── Validation helpers ────────────────────────────────────────

  private natTargetProblem(rule: IptablesRule, counts: ReadonlyMap<string, number>): string | null {
    if (!NAT_TARGETS.has(rule.target)) return null;
    if (this.family === 6) {
      for (const opt of ['--to-source', '--to-destination']) {
        const v = rule.targetOptions[opt];
        if (v !== undefined && v !== '' && !this.validateNatTarget(v)) return `iptables v1.8.7: Bad IP address "${v}"`;
      }
      return null;
    }
    const target = rule.target as NatTargetName;
    const option = NAT_ADDRESS_OPTION[target];
    const addressed = target === 'DNAT' || target === 'SNAT';
    const given = rule.targetOptions[option];
    if (given === '') return this.parameterProblem(`option "${option}" requires an argument`);
    const protocol = protocolNumberOf(rule.protocol);
    const parsed = natRangeOfTarget(target, {
      toAddress: addressed ? given : undefined,
      toPorts: addressed ? undefined : given,
      random: '--random' in rule.targetOptions,
      randomFully: '--random-fully' in rule.targetOptions,
      persistent: '--persistent' in rule.targetOptions,
      toAddressCount: counts.get(option) ?? 0,
    }, protocol !== null && NAT_PORT_PROTOCOLS.has(protocol));
    if (parsed.kind === 'problem') return this.parameterProblem(parsed.problem);
    rule.natRange = parsed.range;
    return null;
  }

  private validateNatTarget(spec: string): boolean {
    // En IPv6 le port se met entre crochets (`[fd00::9]:80`) parce que
    // l'adresse contient elle-meme des deux-points : les couper comme
    // en IPv4 detruirait l'adresse.
    const entre = /^\[(.+)\](?::\d+(?:-\d+)?)?$/.exec(spec);
    const adresses = entre ? entre[1] : spec;
    const bornes = adresses.split('-').filter((b) => b.length > 0);
    return bornes.length > 0 && bornes.every((b) => this.tryParseV6(b) !== null);
  }

  private validateIPSpec(spec: string): boolean {
    if (this.family === 6) return this.validateIPv6Spec(spec);
    if (spec.includes('/')) {
      const [ip, prefix] = spec.split('/');
      const p = parseInt(prefix);
      if (isNaN(p) || p < 0 || p > 32) return false;
      return this.ipToNumber(ip) !== null;
    }
    return this.ipToNumber(spec) !== null;
  }

  private validateIPv6Spec(spec: string): boolean {
    const slashIdx = spec.lastIndexOf('/');
    const addr = slashIdx === -1 ? spec : spec.slice(0, slashIdx);
    if (slashIdx !== -1) {
      const p = parseInt(spec.slice(slashIdx + 1), 10);
      if (isNaN(p) || p < 0 || p > 128) return false;
    }
    return this.tryParseV6(addr) !== null;
  }

  private validatePortSpec(spec: string): boolean {
    if (spec.includes(':')) {
      const [s, e] = spec.split(':');
      const si = parseInt(s), ei = parseInt(e);
      return !isNaN(si) && !isNaN(ei) && si >= 0 && si <= 65535 && ei >= 0 && ei <= 65535;
    }
    if (spec.includes(',')) {
      return spec.split(',').every(p => { const n = parseInt(p); return !isNaN(n) && n >= 0 && n <= 65535; });
    }
    const n = parseInt(spec);
    return !isNaN(n) && n >= 0 && n <= 65535;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private rulesEqual(a: IptablesRule, b: IptablesRule): boolean {
    return a.protocol === b.protocol && a.source === b.source && a.destination === b.destination &&
      a.inInterface === b.inInterface && a.outInterface === b.outInterface &&
      a.sport === b.sport && a.dport === b.dport && a.target === b.target &&
      a.negSport === b.negSport && a.negDport === b.negDport && a.fragment === b.fragment && a.goto === b.goto &&
      JSON.stringify(a.tcpFlags) === JSON.stringify(b.tcpFlags) && JSON.stringify(a.tcpOption) === JSON.stringify(b.tcpOption) &&
      JSON.stringify(a.icmpType) === JSON.stringify(b.icmpType) &&
      a.negSource === b.negSource && a.negDestination === b.negDestination &&
      a.negProtocol === b.negProtocol && a.negInInterface === b.negInInterface &&
      a.negOutInterface === b.negOutInterface &&
      a.matches.length === b.matches.length &&
      a.matches.every((m, i) => m.module === b.matches[i].module &&
        m.options.size === b.matches[i].options.size &&
        [...m.options].every(([k, v]) => b.matches[i].options.get(k) === v &&
          inverts(m, k) === inverts(b.matches[i], k)));
  }

  private tokenize(line: string): string[] {
    const tokens: string[] = [];
    let cur = '', inQ = false, qc = '';
    for (const ch of line) {
      if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
      else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
      else if (ch === ' ' || ch === '\t') { if (cur) { tokens.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  private showUsage(): string {
    return [
      'iptables v1.8.7 (nf_tables)',
      '',
      'Usage: iptables [-t table] {-A|-C|-D} chain rule-specification',
      '       iptables [-t table] -I chain [rulenum] rule-specification',
      '       iptables [-t table] -R chain rulenum rule-specification',
      '       iptables [-t table] -D chain rulenum',
      '       iptables [-t table] -S [chain [rulenum]]',
      '       iptables [-t table] {-F|-L|-Z} [chain [rulenum]] [options...]',
      '       iptables [-t table] -N chain',
      '       iptables [-t table] -X [chain]',
      '       iptables [-t table] -P chain target',
      '       iptables [-t table] -E old-chain-name new-chain-name',
    ].join('\n');
  }
}
