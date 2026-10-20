import { strtol } from '../../../../core/CRuntime';
import { inetAton } from '../../../../core/InetAton';
import {
  IP_PROTO_DCCP, IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_SCTP, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_UDPLITE, IPv6Address, type IPAddress,
} from '../../../../core/types';
import { IP_PROTO_GRE } from '../../../../gre/types';
import type { TcpConntrackState } from '../../ConnectionTracker';
import { shortOptions, type LongOption } from '../Getopt';

export const CONNTRACK_VERSION = 'conntrack v1.4.7 (conntrack-tools)';

export type ConntrackCommand =
  | 'list' | 'create' | 'delete' | 'get' | 'flush' | 'event' | 'count' | 'stats' | 'update' | 'add' | 'version' | 'help';

export type ConntrackTable = 'conntrack' | 'expect' | 'dying' | 'unconfirmed';

export type OptionName =
  | 'src' | 'dst' | 'reply-src' | 'reply-dst' | 'protonum' | 'timeout' | 'status' | 'zero' | 'event-mask'
  | 'tuple-src' | 'tuple-dst' | 'mask-src' | 'mask-dst' | 'nat-range' | 'mark' | 'id' | 'family'
  | 'src-nat' | 'dst-nat' | 'output' | 'secmark' | 'buffer-size' | 'any-nat' | 'zone' | 'label'
  | 'label-add' | 'label-del' | 'orig-zone' | 'reply-zone';

export type ProtocolOptionName =
  | 'sport' | 'dport' | 'reply-port-src' | 'reply-port-dst' | 'mask-port-src' | 'mask-port-dst' | 'tuple-port-src'
  | 'tuple-port-dst' | 'state' | 'icmp-type' | 'icmp-code' | 'icmp-id' | 'srckey' | 'dstkey' | 'reply-key-src'
  | 'reply-key-dst' | 'mask-key-src' | 'mask-key-dst' | 'tuple-key-src' | 'tuple-key-dst';

export type AddressRole = 'src' | 'dst' | 'reply-src' | 'reply-dst';

export interface AddressFilter {
  readonly address: IPAddress | IPv6Address;
  readonly prefix: number | null;
}

export interface BitFilter {
  readonly value: number;
  readonly mask: number;
}

export interface ConntrackFilter {
  readonly family: 4 | 6 | null;
  readonly protocol: number | null;
  readonly addresses: ReadonlyMap<AddressRole, AddressFilter>;
  readonly masks: ReadonlyMap<'mask-src' | 'mask-dst', IPAddress | IPv6Address>;
  readonly status: BitFilter | null;
  readonly mark: BitFilter | null;
  readonly zones: ReadonlyMap<'zone' | 'orig-zone' | 'reply-zone', number>;
  readonly protocolValues: ReadonlyMap<ProtocolOptionName, number>;
  readonly tcpState: TcpConntrackState | null;
}

export interface ParsedConntrack {
  readonly command: ConntrackCommand;
  readonly table: ConntrackTable;
  readonly filter: ConntrackFilter;
  readonly extendedOutput: boolean;
}

export interface ConntrackRefusal {
  readonly output: string;
  readonly exitCode: number;
}

export type ConntrackParse =
  | { readonly kind: 'parsed'; readonly parsed: ParsedConntrack }
  | { readonly kind: 'refused'; readonly refusal: ConntrackRefusal };

const OTHER_PROBLEM = 1;
const PARAMETER_PROBLEM = 2;

const TRY_HELP = "Try `conntrack -h' or 'conntrack --help' for more information.";

const OPTSTRING = ':L::I::U::D::G::E::F::A::hVs:d:r:q:p:t:u:e:a:z[:]:{:}:m:i:f:o:n::g::c:b:C::Sj::w:l:<:>::(:):';

const PROTOCOL_LETTERS: readonly (readonly [string, string, string])[] = [
  ['\u0001', 'sport', 'orig-port-src'], ['\u0002', 'dport', 'orig-port-dst'], ['\u0003', 'reply-port-src', 'reply-port-src'],
  ['\u0004', 'reply-port-dst', 'reply-port-dst'], ['\u0005', 'mask-port-src', 'mask-port-src'],
  ['\u0006', 'mask-port-dst', 'mask-port-dst'], ['\u0007', 'tuple-port-src', 'tuple-port-src'],
  ['\u0008', 'tuple-port-dst', 'tuple-port-dst'], ['\u0009', 'state', 'state'],
  ['\u000a', 'icmp-type', 'icmpv6-type'], ['\u000b', 'icmp-code', 'icmpv6-code'], ['\u000c', 'icmp-id', 'icmpv6-id'],
  ['\u000d', 'srckey', 'orig-key-src'], ['\u000e', 'dstkey', 'orig-key-dst'], ['\u000f', 'reply-key-src', 'reply-key-src'],
  ['\u0010', 'reply-key-dst', 'reply-key-dst'], ['\u0011', 'mask-key-src', 'mask-key-src'],
  ['\u0012', 'mask-key-dst', 'mask-key-dst'], ['\u0013', 'tuple-key-src', 'tuple-key-src'],
  ['\u0014', 'tuple-key-dst', 'tuple-key-dst'],
];

const LONG_OPTIONS: readonly LongOption[] = [
  ...([
    ['dump', 'L'], ['create', 'I'], ['add', 'A'], ['delete', 'D'], ['update', 'U'], ['get', 'G'], ['flush', 'F'],
    ['event', 'E'], ['counter', 'C'], ['stats', 'S'], ['version', 'V'], ['help', 'h'], ['zero', 'z'], ['id', 'i'],
    ['src-nat', 'n'], ['dst-nat', 'g'], ['any-nat', 'j'], ['label-del', '>'],
  ] as const).map(([name, letter]) => ({ name, letter, takesArgument: false })),
  ...([
    ['orig-src', 's'], ['src', 's'], ['orig-dst', 'd'], ['dst', 'd'], ['reply-src', 'r'], ['reply-dst', 'q'],
    ['protonum', 'p'], ['timeout', 't'], ['status', 'u'], ['event-mask', 'e'], ['tuple-src', '['], ['tuple-dst', ']'],
    ['mask-src', '{'], ['mask-dst', '}'], ['nat-range', 'a'], ['mark', 'm'], ['secmark', 'c'], ['family', 'f'],
    ['output', 'o'], ['buffer-size', 'b'], ['zone', 'w'], ['label', 'l'], ['label-add', '<'], ['orig-zone', '('],
    ['reply-zone', ')'],
  ] as const).map(([name, letter]) => ({ name, letter, takesArgument: true })),
  ...PROTOCOL_LETTERS.flatMap(([letter, canonical, alias]) => [
    { name: canonical, letter, takesArgument: true },
    ...(alias === canonical ? [] : [{ name: alias, letter, takesArgument: true }]),
  ]),
];

const COMMAND_OF_LETTER: Readonly<Record<string, ConntrackCommand>> = {
  L: 'list', I: 'create', D: 'delete', G: 'get', F: 'flush', E: 'event', V: 'version', h: 'help', C: 'count',
  S: 'stats', U: 'update', A: 'add',
};

const LONG_NAME_OF_COMMAND: Readonly<Record<ConntrackCommand, string>> = {
  list: 'dump', create: 'create', delete: 'delete', get: 'get', flush: 'flush', event: 'event', count: 'counter',
  stats: 'stats', update: 'update', add: 'add', version: 'version', help: 'help',
};

const OPTION_OF_LETTER: Readonly<Record<string, OptionName>> = {
  s: 'src', d: 'dst', r: 'reply-src', q: 'reply-dst', p: 'protonum', t: 'timeout', u: 'status', z: 'zero',
  e: 'event-mask', '[': 'tuple-src', ']': 'tuple-dst', '{': 'mask-src', '}': 'mask-dst', a: 'nat-range', m: 'mark',
  i: 'id', f: 'family', n: 'src-nat', g: 'dst-nat', o: 'output', c: 'secmark', b: 'buffer-size', j: 'any-nat',
  w: 'zone', l: 'label', '<': 'label-add', '>': 'label-del', '(': 'orig-zone', ')': 'reply-zone',
};

const OPTION_ORDER: readonly OptionName[] = [
  'src', 'dst', 'reply-src', 'reply-dst', 'protonum', 'timeout', 'status', 'zero', 'event-mask', 'tuple-src',
  'tuple-dst', 'mask-src', 'mask-dst', 'nat-range', 'mark', 'id', 'family', 'src-nat', 'dst-nat', 'output', 'secmark',
  'buffer-size', 'any-nat', 'zone', 'label', 'label-add', 'label-del', 'orig-zone', 'reply-zone',
];

const NO_OPTIONS: ReadonlySet<OptionName> = new Set<OptionName>();

const LEGAL_OPTIONS: Readonly<Record<ConntrackCommand, ReadonlySet<OptionName>>> = {
  list: new Set<OptionName>([
    'src', 'dst', 'reply-src', 'reply-dst', 'protonum', 'status', 'zero', 'mask-src', 'mask-dst', 'mark', 'family',
    'src-nat', 'dst-nat', 'output', 'secmark', 'any-nat', 'zone', 'label', 'orig-zone', 'reply-zone',
  ]),
  delete: new Set<OptionName>([
    'src', 'dst', 'reply-src', 'reply-dst', 'protonum', 'timeout', 'status', 'mask-src', 'mask-dst', 'mark', 'id',
    'family', 'src-nat', 'dst-nat', 'output', 'zone', 'label', 'orig-zone', 'reply-zone',
  ]),
  flush: new Set<OptionName>(['family']),
  help: new Set<OptionName>(['protonum']),
  count: NO_OPTIONS, stats: NO_OPTIONS, version: NO_OPTIONS,
  create: NO_OPTIONS, get: NO_OPTIONS, event: NO_OPTIONS, update: NO_OPTIONS, add: NO_OPTIONS,
};

const PORT_OPTIONS: readonly ProtocolOptionName[] = [
  'sport', 'dport', 'reply-port-src', 'reply-port-dst', 'mask-port-src', 'mask-port-dst', 'tuple-port-src', 'tuple-port-dst',
];

const KEY_OPTIONS: readonly ProtocolOptionName[] = [
  'srckey', 'dstkey', 'reply-key-src', 'reply-key-dst', 'mask-key-src', 'mask-key-dst', 'tuple-key-src', 'tuple-key-dst',
];

const STATE_PROTOCOL_OPTIONS: readonly ProtocolOptionName[] = [...PORT_OPTIONS, 'state'];

const PROTOCOL_OPTIONS_OF: Readonly<Record<number, readonly ProtocolOptionName[]>> = {
  [IP_PROTO_TCP]: STATE_PROTOCOL_OPTIONS,
  [IP_PROTO_UDP]: PORT_OPTIONS,
  [IP_PROTO_UDPLITE]: PORT_OPTIONS,
  [IP_PROTO_SCTP]: STATE_PROTOCOL_OPTIONS,
  [IP_PROTO_DCCP]: STATE_PROTOCOL_OPTIONS,
  [IP_PROTO_ICMP]: ['icmp-type', 'icmp-code', 'icmp-id'],
  [IP_PROTO_ICMPV6]: ['icmp-type', 'icmp-code', 'icmp-id'],
  [IP_PROTO_GRE]: KEY_OPTIONS,
};

const LEGAL_PROTOCOL_OPTIONS: ReadonlySet<ProtocolOptionName> = new Set<ProtocolOptionName>([
  'sport', 'dport', 'reply-port-src', 'reply-port-dst', 'state', 'icmp-type', 'icmp-code', 'icmp-id',
  'srckey', 'dstkey', 'reply-key-src', 'reply-key-dst',
]);

const PROTOCOL_BY_NAME: Readonly<Record<string, number>> = {
  tcp: IP_PROTO_TCP, udp: IP_PROTO_UDP, udplite: IP_PROTO_UDPLITE, sctp: IP_PROTO_SCTP, dccp: IP_PROTO_DCCP, icmp: IP_PROTO_ICMP,
  icmpv6: IP_PROTO_ICMPV6, gre: IP_PROTO_GRE,
};

const TCP_STATE_NAMES: ReadonlyMap<string, TcpConntrackState> = new Map<string, TcpConntrackState>([
  ['NONE', 'NONE'], ['SYN_SENT', 'SYN_SENT'], ['SYN_RECV', 'SYN_RECV'], ['ESTABLISHED', 'ESTABLISHED'],
  ['FIN_WAIT', 'FIN_WAIT'], ['CLOSE_WAIT', 'CLOSE_WAIT'], ['LAST_ACK', 'LAST_ACK'], ['TIME_WAIT', 'TIME_WAIT'],
  ['CLOSE', 'CLOSE'], ['SYN_SENT2', 'SYN_SENT2'], ['LISTEN', 'SYN_SENT2'],
]);

const STATUS_BITS: readonly (readonly [string, number])[] = [
  ['ASSURED', 1 << 2], ['SEEN_REPLY', 1 << 1], ['UNSET', 0], ['FIXED_TIMEOUT', 1 << 10], ['EXPECTED', 1 << 0],
  ['OFFLOAD', 1 << 14], ['HW_OFFLOAD', 1 << 15],
];

export const STATUS_SEEN_REPLY = 1 << 1;
export const STATUS_ASSURED = 1 << 2;

const UNBUILT_COMMAND: Readonly<Partial<Record<ConntrackCommand, string>>> = {
  create: 'the creation of flow entries', add: 'the creation of flow entries', update: 'the update of flow entries',
  get: 'the lookup of one flow entry', event: 'the stream of flow events',
};

const UNBUILT_OPTION: Readonly<Partial<Record<OptionName, string>>> = {
  timeout: 'a flow timeout', 'event-mask': 'an event mask', 'tuple-src': 'expectation tuples',
  'tuple-dst': 'expectation tuples', 'nat-range': 'a NAT range', id: 'flow identifiers',
  'src-nat': 'the filtering of source NAT', 'dst-nat': 'the filtering of destination NAT', 'any-nat': 'the filtering of NAT',
  secmark: 'security marks', label: 'connection labels', 'label-add': 'connection labels', 'label-del': 'connection labels',
};

const UNBUILT_PROTOCOL_OPTION: Readonly<Partial<Record<ProtocolOptionName, string>>> = {
  'mask-port-src': 'port masks', 'mask-port-dst': 'port masks', 'tuple-port-src': 'expectation tuples',
  'tuple-port-dst': 'expectation tuples', 'mask-key-src': 'key masks', 'mask-key-dst': 'key masks',
  'tuple-key-src': 'expectation tuples', 'tuple-key-dst': 'expectation tuples',
};

const OUTPUT_TYPES: readonly string[] = ['xml', 'extended', 'timestamp', 'id', 'ktimestamp', 'labels', 'userspace', 'save'];

function refused(output: string, exitCode: number): ConntrackParse {
  return { kind: 'refused', refusal: { output, exitCode } };
}

function parameterProblem(message: string): ConntrackParse {
  return refused(`${CONNTRACK_VERSION}: ${message}\n${TRY_HELP}`, PARAMETER_PROBLEM);
}

function unbuilt(what: string): ConntrackParse {
  return refused(`${CONNTRACK_VERSION}: this simulator cannot build ${what}`, OTHER_PROBLEM);
}

function tableOf(word: string): ConntrackTable | null {
  const named: readonly ConntrackTable[] = ['expect', 'conntrack', 'dying', 'unconfirmed'];
  return named.find((name) => name.startsWith(word)) ?? null;
}

function protocolOf(text: string): number | null {
  const named = PROTOCOL_BY_NAME[text.toLowerCase()];
  if (named !== undefined) return named;
  return /^\d+$/.test(text) && Number(text) <= 255 ? Number(text) : null;
}

function parseAddress(text: string): { address: IPAddress | IPv6Address; family: 4 | 6; prefix: number | null | 'invalid' } | null {
  const slash = text.indexOf('/');
  const bare = slash < 0 ? text : text.slice(0, slash);
  const v4 = inetAton(bare);
  const v6 = v4 === null ? IPv6Address.tryParse(bare) : null;
  const address = v4 ?? v6;
  if (address === null) return null;
  const family = v4 === null ? 6 : 4;
  if (slash < 0) return { address, family, prefix: null };
  const prefix = strtol(text.slice(slash + 1));
  if (prefix.value < 0 || prefix.rest !== '' || prefix.value > (family === 4 ? 32 : 128)) return { address, family, prefix: 'invalid' };
  return { address, family, prefix: prefix.value };
}

function parseStatus(text: string): BitFilter | { readonly bad: string } {
  const parts = text.split(',');
  let value = 0;
  let mask = 0;
  for (let index = 0; index < parts.length; index++) {
    const negated = parts[index].startsWith('!');
    const name = negated ? parts[index].slice(1) : parts[index];
    if (!negated && name.startsWith('UNREPLIED')) {
      mask |= STATUS_SEEN_REPLY;
      continue;
    }
    const entry = name === '' ? undefined : STATUS_BITS.find(([candidate]) => candidate.toLowerCase().startsWith(name.toLowerCase()));
    if (entry === undefined) return { bad: parts.slice(index).join(',') };
    if (negated) mask |= entry[1];
    else value |= entry[1];
  }
  return { value, mask: mask === 0 ? value : mask };
}

function parseMark(text: string): BitFilter {
  const value = strtol(text, 0);
  const mask = value.rest.startsWith('/') ? strtol(value.rest.slice(1), 0).value >>> 0 : 0xffffffff;
  return { value: value.value >>> 0, mask };
}

function resolveOutput(name: string): string | undefined {
  return name === '' ? undefined : OUTPUT_TYPES.find((candidate) => candidate.startsWith(name.toLowerCase()));
}

function emptyFilter(): ConntrackFilter {
  return {
    family: null, protocol: null, addresses: new Map(), masks: new Map(), status: null, mark: null, zones: new Map(),
    protocolValues: new Map(), tcpState: null,
  };
}

export function parseConntrack(args: readonly string[]): ConntrackParse {
  let command: ConntrackCommand | null = null;
  let tableWord: string | null = null;
  let expectTable = false;
  let family: 4 | 6 | null = null;
  let protocol: number | null = null;
  let extendedOutput = false;
  let status: BitFilter | null = null;
  let mark: BitFilter | null = null;
  let tcpState: TcpConntrackState | null = null;
  const given = new Set<OptionName>();
  const addresses = new Map<AddressRole, AddressFilter>();
  const masks = new Map<'mask-src' | 'mask-dst', IPAddress | IPv6Address>();
  const zones = new Map<'zone' | 'orig-zone' | 'reply-zone', number>();
  const protocolValues = new Map<ProtocolOptionName, number>();
  const protocolGiven = new Map<ProtocolOptionName, string>();

  const takeFamily = (next: 4 | 6): boolean => {
    if (family !== null && family !== next) return false;
    family = next;
    return true;
  };

  for (const item of shortOptions(args, OPTSTRING, LONG_OPTIONS)) {
    if (item.kind === 'operand') {
      if (expectTable) tableWord = item.value;
      expectTable = false;
      continue;
    }
    expectTable = false;
    if (item.kind === 'invalid') return parameterProblem(`unknown option \`-${item.letter}'`);
    if (item.kind === 'unrecognized') return parameterProblem(`unknown option \`${item.token}'`);
    if (item.kind === 'needless-argument') return parameterProblem(`unknown option \`--${item.long}'`);
    if (item.kind === 'missing-argument') {
      return parameterProblem(`option \`${item.long === undefined ? `-${item.letter}` : `--${item.long}`}' requires an argument`);
    }
    const { letter } = item;
    const value = item.argument ?? '';
    const commandOfLetter = COMMAND_OF_LETTER[letter];
    if (commandOfLetter !== undefined) {
      if (command !== null) return parameterProblem('Invalid commands combination');
      command = commandOfLetter;
      expectTable = true;
      continue;
    }
    const protocolEntry = PROTOCOL_LETTERS.find(([candidate]) => candidate === letter);
    if (protocolEntry !== undefined) {
      const option = protocolEntry[1] as ProtocolOptionName;
      const known = protocol === null ? undefined : PROTOCOL_OPTIONS_OF[protocol];
      if (known === undefined || !known.includes(option)) return parameterProblem(`unknown option \`--${item.long}'`);
      protocolGiven.set(option, item.long ?? protocolEntry[1]);
      if (option === 'state') {
        if (protocol === IP_PROTO_SCTP || protocol === IP_PROTO_DCCP) return unbuilt('the states of SCTP and DCCP');
        const state = TCP_STATE_NAMES.get(value);
        if (state === undefined) return parameterProblem(`unknown TCP state \`${value}'`);
        tcpState = state;
      } else {
        protocolValues.set(option, strtol(value).value & (option === 'icmp-type' || option === 'icmp-code' ? 0xff : 0xffff));
      }
      continue;
    }
    const option = OPTION_OF_LETTER[letter];
    if (option === undefined) return parameterProblem(`unknown option \`-${letter}'`);
    given.add(option);
    switch (option) {
      case 'src': case 'dst': case 'reply-src': case 'reply-dst': {
        const parsed = parseAddress(value);
        if (parsed === null) return parameterProblem(`Invalid IP address \`${value}'`);
        if (!takeFamily(parsed.family)) return parameterProblem('mismatched address family');
        if (parsed.prefix === 'invalid') return parameterProblem('Invalid netmask');
        if (parsed.prefix !== null && (option === 'reply-src' || option === 'reply-dst')) {
          return parameterProblem(`CIDR notation unavailable for \`--${option}'`);
        }
        addresses.set(option, { address: parsed.address, prefix: parsed.prefix });
        break;
      }
      case 'mask-src': case 'mask-dst': {
        const parsed = parseAddress(value);
        if (parsed === null) return parameterProblem(`Invalid IP address \`${value}'`);
        if (parsed.prefix === 'invalid') return parameterProblem('Invalid netmask');
        if (!takeFamily(parsed.family)) return parameterProblem('mismatched address family');
        masks.set(option, parsed.address);
        break;
      }
      case 'protonum': {
        const number = protocolOf(value);
        if (number === null) return parameterProblem(`\`${value}' unsupported protocol`);
        protocol = number;
        break;
      }
      case 'family':
        if (value.startsWith('ipv4')) {
          if (!takeFamily(4)) return parameterProblem('mismatched address family');
        } else if (value.startsWith('ipv6')) {
          if (!takeFamily(6)) return parameterProblem('mismatched address family');
        } else {
          return parameterProblem(`\`${value}' unsupported protocol`);
        }
        break;
      case 'status': {
        const parsed = parseStatus(value);
        if ('bad' in parsed) return parameterProblem(`Bad parameter \`${parsed.bad}'`);
        status = parsed;
        break;
      }
      case 'mark':
        mark = parseMark(value);
        break;
      case 'zone': case 'orig-zone': case 'reply-zone':
        zones.set(option, strtol(value, 0).value & 0xffff);
        break;
      case 'output': {
        const names = value.split(',');
        const bad = names.findIndex((name) => resolveOutput(name) === undefined);
        if (bad >= 0) return parameterProblem(`Bad parameter \`${names.slice(bad).join(',')}'`);
        const resolved = names.map((name) => resolveOutput(name) as string);
        const unsupported = resolved.find((name) => name !== 'extended' && name !== 'userspace');
        if (unsupported !== undefined) return unbuilt(`the output type ${unsupported}`);
        extendedOutput = resolved.includes('extended');
        break;
      }
      default:
        break;
    }
  }

  if (command === null) return { kind: 'parsed', parsed: { command: 'help', table: 'conntrack', filter: emptyFilter(), extendedOutput: false } };

  let table: ConntrackTable = 'conntrack';
  if (tableWord !== null) {
    const resolved = tableOf(tableWord);
    if (resolved === null) return parameterProblem(`unknown type \`${tableWord}'`);
    table = resolved;
  }
  if (table === 'dying' || table === 'unconfirmed') {
    if (command !== 'list') return parameterProblem("Can't do that command with tables `dying' and `unconfirmed'");
  } else if (table === 'expect' && (command === 'update' || command === 'add')) {
    return parameterProblem(`Can't do --${LONG_NAME_OF_COMMAND[command]} on expectations`);
  }

  for (const option of OPTION_ORDER) {
    if (given.has(option) && !LEGAL_OPTIONS[command].has(option)) {
      return parameterProblem(`Illegal option \`--${option}' with this command`);
    }
  }
  for (const [option, typed] of protocolGiven) {
    if (command !== 'list' && command !== 'delete') return parameterProblem(`Illegal option \`--${typed}' with this command`);
    if (!LEGAL_PROTOCOL_OPTIONS.has(option)) return parameterProblem(`Illegal option \`--${typed}' with this command`);
  }

  const unbuiltCommand = UNBUILT_COMMAND[command];
  if (unbuiltCommand !== undefined) return unbuilt(unbuiltCommand);
  if (command === 'help' && given.has('protonum')) return unbuilt('the help of a protocol extension');
  for (const option of OPTION_ORDER) {
    const reason = given.has(option) ? UNBUILT_OPTION[option] : undefined;
    if (reason !== undefined) return unbuilt(reason);
  }
  for (const option of protocolGiven.keys()) {
    const reason = UNBUILT_PROTOCOL_OPTION[option];
    if (reason !== undefined) return unbuilt(reason);
  }

  return {
    kind: 'parsed',
    parsed: {
      command, table, extendedOutput,
      filter: { family, protocol, addresses, masks, status, mark, zones, protocolValues, tcpState },
    },
  };
}
