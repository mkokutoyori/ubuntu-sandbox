import { IPv6Address } from '../../../core/types';
import { parseAclPortSpec, isAclPortOperator, type AclPortSpec } from './AclSyntax';

export const IPV6_PROTOCOL_ANY = -1;

export const IPV6_PROTOCOL_KEYWORDS: Readonly<Record<string, number>> = {
  ipv6: IPV6_PROTOCOL_ANY,
  hbh: 0,
  tcp: 6,
  udp: 17,
  esp: 50,
  ahp: 51,
  icmp: 58,
  pcp: 108,
  sctp: 132,
};

const IPV6_NUMBER_TO_KEYWORD: ReadonlyMap<number, string> = new Map(
  Object.entries(IPV6_PROTOCOL_KEYWORDS)
    .filter(([, n]) => n !== IPV6_PROTOCOL_ANY)
    .map(([name, n]) => [n, name]),
);

export function parseIpv6Protocol(token: string): string | null {
  const lower = token.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(IPV6_PROTOCOL_KEYWORDS, lower)) return lower;
  if (!/^\d+$/.test(lower)) return null;
  const value = parseInt(lower, 10);
  if (value < 0 || value > 255) return null;
  return IPV6_NUMBER_TO_KEYWORD.get(value) ?? lower;
}

export function ipv6ProtocolMatches(entryProtocol: string, nextHeader: number): boolean {
  if (entryProtocol === 'ipv6') return true;
  if (/^\d+$/.test(entryProtocol)) return nextHeader === parseInt(entryProtocol, 10);
  const wanted = IPV6_PROTOCOL_KEYWORDS[entryProtocol];
  return wanted !== undefined && wanted === nextHeader;
}

export function ipv6ProtocolCarriesPorts(protocol: string | undefined): boolean {
  return protocol === 'tcp' || protocol === 'udp' || protocol === 'sctp';
}

export const ICMPV6_MESSAGE_KEYWORDS: Readonly<Record<string, { type: string; code?: number }>> = {
  'nd-na': { type: 'neighbor-advertisement' },
  'nd-ns': { type: 'neighbor-solicitation' },
  'router-advertisement': { type: 'router-advertisement' },
  'router-solicitation': { type: 'router-solicitation' },
  'echo-request': { type: 'echo-request' },
  'echo-reply': { type: 'echo-reply' },
  'packet-too-big': { type: 'packet-too-big' },
  'unreachable': { type: 'destination-unreachable' },
  'no-route': { type: 'destination-unreachable', code: 0 },
  'no-admin': { type: 'destination-unreachable', code: 1 },
  'beyond-scope': { type: 'destination-unreachable', code: 2 },
  'address-unreachable': { type: 'destination-unreachable', code: 3 },
  'port-unreachable': { type: 'destination-unreachable', code: 4 },
  'time-exceeded': { type: 'time-exceeded' },
  'hop-limit': { type: 'time-exceeded', code: 0 },
};

export const IPV6_TCP_FLAG_NAMES = ['ack', 'fin', 'psh', 'rst', 'syn', 'urg'] as const;
export type Ipv6TcpFlagName = typeof IPV6_TCP_FLAG_NAMES[number];

export function isIpv6TcpFlagName(token: string): token is Ipv6TcpFlagName {
  return (IPV6_TCP_FLAG_NAMES as readonly string[]).includes(token.toLowerCase());
}

export interface Ipv6AceOptions {
  action: 'permit' | 'deny';
  protocol: string;
  srcPrefix?: string;
  srcPrefixLength?: number;
  srcPortSpec?: AclPortSpec;
  dstPrefix?: string;
  dstPrefixLength?: number;
  dstPortSpec?: AclPortSpec;
  icmpType?: string;
  icmpCode?: number;
  tcpFlags?: string[];
  tcpEstablished?: boolean;
  dscp?: number;
  flowLabel?: number;
  fragments?: boolean;
  routing?: boolean;
  undeterminedTransport?: boolean;
  log?: boolean;
  logInput?: boolean;
  reflect?: string;
  timeRange?: string;
  sequence?: number;
  sequenceConfigured?: boolean;
}

export type Ipv6AceParse =
  | { status: 'ok'; opts: Ipv6AceOptions }
  | { status: 'refused'; incomplete: boolean; token?: string };

interface PrefixParse {
  prefix: string;
  prefixLength?: number;
  consumed: number;
}

function parsePrefixOperand(args: string[], offset: number): PrefixParse | null {
  const token = args[offset];
  if (token === undefined) return null;
  const lower = token.toLowerCase();
  if (lower === 'any') return { prefix: 'any', consumed: 1 };
  if (lower === 'host') {
    const address = args[offset + 1];
    if (address === undefined || !isIpv6Literal(address)) return null;
    return { prefix: address, prefixLength: 128, consumed: 2 };
  }
  const slash = token.indexOf('/');
  if (slash === -1) return null;
  const prefix = token.substring(0, slash);
  const lengthText = token.substring(slash + 1);
  if (!/^\d+$/.test(lengthText) || !isIpv6Literal(prefix)) return null;
  const length = parseInt(lengthText, 10);
  if (length < 0 || length > 128) return null;
  return { prefix, prefixLength: length, consumed: 1 };
}

function isIpv6Literal(token: string): boolean {
  try {
    new IPv6Address(token);
    return true;
  } catch {
    return false;
  }
}

function parseByteValue(token: string | undefined, max = 255): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  const value = parseInt(token, 10);
  return value >= 0 && value <= max ? value : null;
}

export function parseIpv6Ace(
  action: 'permit' | 'deny',
  args: string[],
  sequence?: number,
): Ipv6AceParse {
  const refuse = (index: number): Ipv6AceParse =>
    index >= args.length
      ? { status: 'refused', incomplete: true }
      : { status: 'refused', incomplete: false, token: args[index] };

  if (args.length === 0) return { status: 'refused', incomplete: true };

  const protocol = parseIpv6Protocol(args[0]);
  if (protocol === null) return refuse(0);
  let i = 1;

  const src = parsePrefixOperand(args, i);
  if (!src) return refuse(i);
  i += src.consumed;

  const opts: Ipv6AceOptions = {
    action,
    protocol,
    srcPrefix: src.prefix,
    srcPrefixLength: src.prefixLength,
  };
  if (sequence !== undefined) {
    opts.sequence = sequence;
    opts.sequenceConfigured = true;
  }

  if (i < args.length && isAclPortOperator(args[i].toLowerCase())) {
    if (!ipv6ProtocolCarriesPorts(protocol)) return refuse(i);
    const spec = parseAclPortSpec(args, i);
    if (!spec) return refuse(i + 1);
    opts.srcPortSpec = spec.spec;
    i += spec.consumed;
  }

  const dst = parsePrefixOperand(args, i);
  if (!dst) return refuse(i);
  i += dst.consumed;
  opts.dstPrefix = dst.prefix;
  opts.dstPrefixLength = dst.prefixLength;

  if (i < args.length && isAclPortOperator(args[i].toLowerCase())) {
    if (!ipv6ProtocolCarriesPorts(protocol)) return refuse(i);
    const spec = parseAclPortSpec(args, i);
    if (!spec) return refuse(i + 1);
    opts.dstPortSpec = spec.spec;
    i += spec.consumed;
  }

  while (i < args.length) {
    const token = args[i].toLowerCase();

    if (protocol === 'icmp' && Object.prototype.hasOwnProperty.call(ICMPV6_MESSAGE_KEYWORDS, token)) {
      const message = ICMPV6_MESSAGE_KEYWORDS[token];
      opts.icmpType = message.type;
      if (message.code !== undefined) opts.icmpCode = message.code;
      i++;
      continue;
    }

    if (protocol === 'icmp' && /^\d+$/.test(token)) {
      const type = parseByteValue(token);
      if (type === null) return refuse(i);
      opts.icmpType = String(type);
      const code = parseByteValue(args[i + 1]);
      if (code !== null) { opts.icmpCode = code; i += 2; continue; }
      i++;
      continue;
    }

    if (protocol === 'tcp' && token === 'established') {
      opts.tcpEstablished = true;
      i++;
      continue;
    }

    if (protocol === 'tcp' && isIpv6TcpFlagName(token)) {
      (opts.tcpFlags ??= []).push(token);
      i++;
      continue;
    }

    if (token === 'dscp') {
      const value = parseByteValue(args[i + 1], 63);
      if (value === null) return refuse(i + 1);
      opts.dscp = value;
      i += 2;
      continue;
    }

    if (token === 'flow-label') {
      const value = parseByteValue(args[i + 1], 0xfffff);
      if (value === null) return refuse(i + 1);
      opts.flowLabel = value;
      i += 2;
      continue;
    }

    if (token === 'fragments') { opts.fragments = true; i++; continue; }
    if (token === 'routing') { opts.routing = true; i++; continue; }
    if (token === 'undetermined-transport') {
      if (action !== 'deny') return refuse(i);
      opts.undeterminedTransport = true;
      i++;
      continue;
    }
    if (token === 'log') { opts.log = true; i++; continue; }
    if (token === 'log-input') { opts.logInput = true; i++; continue; }

    if (token === 'reflect') {
      if (action !== 'permit') return refuse(i);
      const name = args[i + 1];
      if (name === undefined) return { status: 'refused', incomplete: true };
      opts.reflect = name;
      i += 2;
      continue;
    }

    if (token === 'time-range') {
      const name = args[i + 1];
      if (name === undefined) return { status: 'refused', incomplete: true };
      opts.timeRange = name;
      i += 2;
      continue;
    }

    if (token === 'sequence') {
      const value = args[i + 1];
      if (value === undefined) return { status: 'refused', incomplete: true };
      if (!/^\d+$/.test(value)) return refuse(i + 1);
      const parsed = parseInt(value, 10);
      if (parsed < 1 || parsed > 4294967295) return refuse(i + 1);
      opts.sequence = parsed;
      opts.sequenceConfigured = true;
      i += 2;
      continue;
    }

    return refuse(i);
  }

  return { status: 'ok', opts };
}
