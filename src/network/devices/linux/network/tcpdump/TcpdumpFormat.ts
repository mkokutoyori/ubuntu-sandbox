import { bootpText } from './TcpdumpBootp';
import { ntpText } from './TcpdumpNtp';
import {
  icmpTimeExceededPhrase, icmpUnreachablePhrase, icmpv6ParameterProblemPhrase, icmpv6TimeExceededPhrase,
  icmpv6UnreachablePhrase,
} from '@/network/core/IcmpPhrase';
import type { CaptureFrame, Fragment6Info } from './CaptureFrame';
import type { TcpdumpOptions } from './TcpdumpCli';
import { cdpText } from './TcpdumpCdp';
import { ospfText } from './TcpdumpOspf';
import { ripText } from './TcpdumpRip';
import { asciiPrintLines, hexAndAsciiLines, hexPrintLines } from './TcpdumpHex';
import { icmp6Text } from './TcpdumpIcmp6';
import { domainText } from './TcpdumpDomain';
import { resetDataText, tcpApplicationText } from './TcpdumpTextProtocols';
import { tcpOptionsText, type RelativeSequenceBase, type TcpOptionsText } from './TcpdumpTcpOptions';
import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import {
  IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_IPV6_FRAGMENT, IP_PROTO_TCP, IP_PROTO_UDP,
} from '@/network/core/types';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export interface AddressNames {
  host(ip: string): string;
  service(port: number, protocol: 'tcp' | 'udp'): string;
  ether(mac: string): string;
  protocol?(number: number): string | null;
}

export interface CookedInterfaces {
  version: 1 | 2;
  index(iface: string): number;
  mac(iface: string): string | null;
}

export class TcpdumpRenderState {
  prev: CaptureFrame | null = null;
  first: CaptureFrame | null = null;
  count = 0;
  readonly conversations = new Map<string, { seq: number; ack: number }>();

  constructor(
    readonly names: AddressNames | null = null,
    readonly cooked: CookedInterfaces | null = null,
  ) {}

  host(ip: string): string {
    return this.names?.host(ip) ?? ip;
  }

  port(port: number, protocol: 'tcp' | 'udp' | 'other'): string {
    if (protocol === 'other' || this.names === null) return String(port);
    return this.names.service(port, protocol);
  }

  ether(mac: string): string {
    return this.names?.ether(mac) ?? mac;
  }
}

function expandedAddress(address: string): string {
  if (!address.includes(':')) {
    return address.split('.').map((o) => Number(o).toString(16).padStart(2, '0')).join('');
  }
  const [head, tail = ''] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const zeros = Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0');
  const groups = address.includes('::') ? [...headGroups, ...zeros, ...tailGroups] : headGroups;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

interface RelativeSeqAck extends RelativeSequenceBase {
  seq: number;
  ack: number;
}

function relativeSeqAck(
  frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState,
): RelativeSeqAck {
  const seq = frame.tcpSeq ?? 0;
  const ack = frame.tcpAck ?? 0;
  if (opt.absoluteSeq || !frame.tcpFlags?.ack) return { seq, ack, reverse: false, sequence: 0, acknowledgement: 0 };
  const sport = frame.srcPort ?? 0;
  const dport = frame.dstPort ?? 0;
  const src = frame.srcIp ?? '';
  const dst = frame.dstIp ?? '';
  const rev = sport > dport
    || (sport === dport && expandedAddress(src) > expandedAddress(dst));
  const key = rev ? `${dst}|${src}|${dport}|${sport}` : `${src}|${dst}|${sport}|${dport}`;
  const entry = state.conversations.get(key);
  if (entry === undefined || frame.tcpFlags.syn) {
    const created = rev ? { ack: seq, seq: (ack - 1) >>> 0 } : { seq, ack: (ack - 1) >>> 0 };
    state.conversations.set(key, created);
    return { seq, ack, reverse: rev, sequence: created.seq, acknowledgement: created.ack };
  }
  return rev
    ? { seq: (seq - entry.ack) >>> 0, ack: (ack - entry.seq) >>> 0, reverse: rev, sequence: entry.seq, acknowledgement: entry.ack }
    : { seq: (seq - entry.seq) >>> 0, ack: (ack - entry.ack) >>> 0, reverse: rev, sequence: entry.seq, acknowledgement: entry.ack };
}

const LINK_TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  EN10MB: 'Ethernet',
  DOCSIS: 'DOCSIS',
  LINUX_SLL: 'Linux cooked v1',
  LINUX_SLL2: 'Linux cooked v2',
};

export function linkTypeDescription(linkType: string): string {
  return LINK_TYPE_DESCRIPTIONS[linkType] ?? linkType;
}

export function banner(opt: TcpdumpOptions): string[] {
  const listening = `listening on ${opt.iface}, link-type ${opt.linkType} (${linkTypeDescription(opt.linkType)}), snapshot length ${opt.snaplen} bytes`;
  if (opt.verbose === 0 && opt.writeFile === null) {
    return ['tcpdump: verbose output suppressed, use -v[v]... for full protocol decode', listening];
  }
  return [`tcpdump: ${listening}`];
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

export function footer(captured: number, received: number): string[] {
  return [
    `${captured} packet${plural(captured)} captured`,
    `${received} packet${plural(received)} received by filter`,
    '0 packets dropped by kernel',
  ];
}

function microsOf(frame: CaptureFrame): number {
  return frame.atMicros ?? frame.at.getTime() * 1000;
}

function fraction(micros: number, nano: boolean): string {
  const us = String(micros % 1_000_000).padStart(6, '0');
  return nano ? `${us}000` : us;
}

function clockOf(frame: CaptureFrame, nano: boolean): string {
  return frame.at.toTimeString().slice(0, 8) + '.' + fraction(microsOf(frame), nano);
}

function elapsed(signedMicros: number, nano: boolean): string {
  const deltaMicros = Math.abs(signedMicros);
  const whole = Math.floor(deltaMicros / 1_000_000);
  const hh = String(Math.floor(whole / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${signedMicros < 0 ? '-' : ' '}${hh}:${mm}:${ss}.${fraction(deltaMicros, nano)} `;
}

function timestamp(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const nano = opt.nanoPrecision;
  switch (opt.tsMode) {
    case 'none':
      return '';
    case 'epoch':
      return `${Math.floor(microsOf(frame) / 1_000_000)}.${fraction(microsOf(frame), nano)} `;
    case 'delta': {
      const reference = state.prev ?? frame;
      return elapsed(microsOf(frame) - microsOf(reference), nano);
    }
    case 'since-first': {
      const reference = state.first ?? frame;
      return elapsed(microsOf(frame) - microsOf(reference), nano);
    }
    case 'datetime': {
      const d = frame.at;
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return `${date} ${clockOf(frame, nano)} `;
    }
    default:
      return `${clockOf(frame, nano)} `;
  }
}

const ICMP_PHRASE: Record<string, string> = {
  'echo-request': 'echo request',
  'echo-reply': 'echo reply',
  'destination-unreachable': 'destination unreachable',
  'time-exceeded': 'time exceeded',
  redirect: 'redirect',
};

const ICMP6_PHRASE: Record<string, string> = {
  'echo-request': 'echo request',
  'echo-reply': 'echo reply',
  'destination-unreachable': 'destination unreachable',
  'packet-too-big': 'packet too big',
  'time-exceeded': 'time exceeded',
  'parameter-problem': 'parameter problem',
  'router-solicitation': 'router solicitation',
  'router-advertisement': 'router advertisement',
  'neighbor-solicitation': 'neighbor solicitation',
  'neighbor-advertisement': 'neighbor advertisement',
};

function icmpUnreachPhrase(frame: CaptureFrame, state: TcpdumpRenderState): string {
  const orig = frame.icmpOrig;
  const transport = transportOf(orig?.l4);
  return icmpUnreachablePhrase({
    code: frame.icmpCode ?? 0,
    quotedDestination: state.host(orig?.dstIp ?? frame.srcIp ?? ''),
    quotedProtocol: orig?.protocol,
    quotedTransport: transport,
    quotedDestinationPort: orig?.dstPort === undefined ? undefined : state.port(orig.dstPort, transport),
    nextHopMtu: frame.icmpNextHopMtu,
  });
}

function icmpTimeExceededText(frame: CaptureFrame): string {
  return icmpTimeExceededPhrase(frame.icmpCode ?? 0);
}

const QUOTING_ICMP_TYPES = new Set(['destination-unreachable', 'source-quench', 'redirect', 'time-exceeded', 'parameter-problem']);

function encapsulatedLines(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  if (opt.verbose <= 0 || frame.l4 !== 'icmp' || frame.icmpOrig?.quoted === undefined) return '';
  if (!QUOTING_ICMP_TYPES.has(frame.icmpType ?? '')) return '';
  return `\n\t${ipLine(frame.icmpOrig.quoted, opt, state)}`;
}

/**
 * L'ordre est celui de `tcp_flag_values` (`print-tcp.c:105`), parcouru
 * tel quel par `bittok2str_nosep` : FIN, SYN, RST, PSH, ACK, URG, ECE,
 * CWR. Il n'est pas devinable — l'ACK se note `.` et se place AVANT
 * l'URG, et le FIN passe avant le SYN, ce qu'un segment portant les deux
 * rend visible. Aucun bit reconnu donne `none`, la chaine de repli que
 * `bittok2str_nosep` recoit ligne 273.
 */
const TCPDUMP_FLAG_ORDER: ReadonlyArray<[keyof NonNullable<CaptureFrame['tcpFlags']>, string]> = [
  ['fin', 'F'], ['syn', 'S'], ['rst', 'R'], ['psh', 'P'],
  ['ack', '.'], ['urg', 'U'], ['ece', 'E'], ['cwr', 'W'],
];

export function tcpFlagToken(frame: CaptureFrame): string {
  const f = frame.tcpFlags;
  if (!f) return 'none';
  let s = '';
  for (const [name, letter] of TCPDUMP_FLAG_ORDER) if (f[name]) s += letter;
  return s === '' ? 'none' : s;
}

function endpoint(
  state: TcpdumpRenderState, ip: string | undefined, port: number | undefined, protocol: 'tcp' | 'udp' | 'other',
): string {
  if (ip === undefined) return '?';
  const host = state.host(ip);
  return port === undefined ? host : `${host}.${state.port(port, protocol)}`;
}

function transportOf(l4: string | undefined): 'tcp' | 'udp' | 'other' {
  return l4 === 'tcp' || l4 === 'udp' ? l4 : 'other';
}

function tcpChecksumToken(frame: CaptureFrame): string {
  if (frame.tcpChecksum === undefined || frame.tcpChecksumOk === undefined) return '';
  const hex = frame.tcpChecksum.toString(16).padStart(4, '0');
  if (frame.tcpChecksumOk) return `, cksum 0x${hex} (correct)`;
  const expected = (frame.tcpChecksumComputed ?? 0).toString(16).padStart(4, '0');
  return `, cksum 0x${hex} (incorrect -> 0x${expected})`;
}

function udpSumToken(frame: CaptureFrame, verbose: number): string {
  if (verbose === 0 || frame.udpChecksum === undefined) return '';
  const hex = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;
  if (frame.l3 === 'ipv4') {
    if (verbose < 2) return '';
    if (frame.udpChecksum === 0) return '[no cksum] ';
  }
  if (frame.udpChecksumOk) return '[udp sum ok] ';
  return `[bad udp cksum ${hex(frame.udpChecksum)} -> ${hex(frame.udpChecksumComputed ?? 0)}!] `;
}

function tcpOptionsToken(frame: CaptureFrame, relative: RelativeSequenceBase): TcpOptionsText {
  const start = frame.rawLinkOffset + (frame.ipHeaderLen ?? 20);
  return tcpOptionsText(frame.raw.slice(start), relative);
}

function clockOfDay(milliseconds: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}:${pad(seconds % 60, 2)}.${pad(milliseconds % 1000, 3)}`;
}

const IPV6_FRAGMENT_HEADER_BYTES = 8;
const DNS_PORT = 53;
const RIP_PORT = 520;
const MDNS_PORT = 5353;
const UDP_HEADER_BYTES = 8;

function l4Detail(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState, fragmentedV6 = false): string {
  if (frame.l3 === 'ipv4' && frame.ipProtocol === OSPF_PROTOCOL && (frame.ipFragmentOffset ?? 0) === 0) {
    const start = frame.rawLinkOffset + (frame.ipHeaderLen ?? 20);
    const length = (frame.ipTotalLength ?? 0) - (frame.ipHeaderLen ?? 20);
    return ospfText(Array.from(frame.raw.slice(start, start + length)), length, opt.verbose, (address) => state.host(address));
  }
  if (frame.l4 === 'icmp') {
    let phrase: string;
    if (frame.icmpType === 'destination-unreachable') {
      phrase = icmpUnreachPhrase(frame, state);
    } else if (frame.icmpType === 'time-exceeded') {
      phrase = icmpTimeExceededText(frame);
    } else {
      phrase = ICMP_PHRASE[frame.icmpType ?? ''] ?? frame.icmpType ?? 'unknown';
    }
    if (frame.icmpType === 'timestamp-request') {
      return `ICMP time stamp query id ${frame.icmpId ?? 0} seq ${frame.icmpSeq ?? 0}, length ${frame.payloadLength ?? 0}`;
    }
    if (frame.icmpType === 'timestamp-reply') {
      const t = frame.icmpTimestamps ?? { originate: 0, receive: 0, transmit: 0 };
      return `ICMP time stamp reply id ${frame.icmpId ?? 0} seq ${frame.icmpSeq ?? 0}: org ${clockOfDay(t.originate)}, recv ${clockOfDay(t.receive)}, xmit ${clockOfDay(t.transmit)}, length ${frame.payloadLength ?? 0}`;
    }
    if (frame.icmpType === 'echo-request' || frame.icmpType === 'echo-reply') {
      return `ICMP ${phrase}, id ${frame.icmpId ?? 0}, seq ${frame.icmpSeq ?? 0}, length ${frame.payloadLength ?? 0}`;
    }
    return `ICMP ${phrase}, length ${frame.payloadLength ?? 0}`;
  }
  if (frame.l4 === 'tcp') {
    if (opt.quiet) return `tcp ${frame.payloadLength ?? 0}`;
    const cksum = opt.verbose > 0 && !opt.skipChecksumCheck ? tcpChecksumToken(frame) : '';
    const length = frame.payloadLength ?? 0;
    const flags = frame.tcpFlags;
    const relative = relativeSeqAck(frame, opt, state);
    const { seq, ack } = relative;
    let seqText = '';
    if (opt.verbose > 1 || length > 0 || flags?.syn || flags?.fin || flags?.rst) {
      seqText = `, seq ${seq}${length > 0 ? `:${(seq + length) >>> 0}` : ''}`;
    }
    const ackText = flags?.ack ? `, ack ${ack}` : '';
    const options = tcpOptionsToken(frame, relative);
    const urgent = flags?.urg ? `, urg ${frame.tcpUrgentPointer ?? 0}` : '';
    const head = `Flags [${tcpFlagToken(frame)}]${cksum}${seqText}${ackText}, win ${frame.tcpWindow ?? 0}${urgent}${options.text}`;
    if (options.bad) return head;
    const base = `${head}, length ${length}`;
    if (length === 0) return base;
    const headerBytes = (frame.raw[frame.rawLinkOffset + (frame.ipHeaderLen ?? 20) + 12] >> 4) * 4;
    const start = frame.rawLinkOffset + (frame.ipHeaderLen ?? 20) + headerBytes;
    const payload = frame.raw.slice(start, start + length);
    if (flags?.rst && opt.verbose > 0) return `${base}${resetDataText(payload, length)}`;
    if (frame.srcPort === DNS_PORT || frame.dstPort === DNS_PORT) {
      return `${base}${domainText(payload, length, { verbose: opt.verbose, overTcp: true, multicast: false })}`;
    }
    return base + (tcpApplicationText(frame.srcPort ?? 0, frame.dstPort ?? 0, payload, length, opt.verbose) ?? '');
  }
  if (frame.l4 === 'udp') {
    if (!opt.quiet && (frame.srcPort === DNS_PORT || frame.dstPort === DNS_PORT || frame.srcPort === MDNS_PORT || frame.dstPort === MDNS_PORT)) {
      const multicast = !(frame.srcPort === DNS_PORT || frame.dstPort === DNS_PORT);
      const length = frame.payloadLength ?? 0;
      const start = frame.rawLinkOffset + (frame.ipHeaderLen ?? 20) + UDP_HEADER_BYTES;
      const cksum = opt.skipChecksumCheck ? '' : udpSumToken(frame, opt.verbose);
      return `${cksum}${domainText(frame.raw.slice(start, start + length), length, { verbose: opt.verbose, overTcp: false, multicast })}`;
    }
    if (frame.bootp && !opt.quiet) return bootpText(frame.bootp, opt.verbose, frame.payloadLength ?? 0);
    if (!opt.quiet && frame.appPayload && (frame.srcPort === 123 || frame.dstPort === 123)) {
      return ntpText(frame.appPayload, opt.verbose, opt.skipChecksumCheck ? '' : udpSumToken(frame, opt.verbose));
    }
    if (!opt.quiet && frame.appPayload && (frame.srcPort === RIP_PORT || frame.dstPort === RIP_PORT)) {
      const cksum = opt.skipChecksumCheck ? '' : udpSumToken(frame, opt.verbose);
      return `${cksum}${ripText(frame.appPayload, frame.payloadLength ?? 0, opt.verbose)}`;
    }
    const cksum = opt.skipChecksumCheck ? '' : udpSumToken(frame, opt.verbose);
    return `${cksum}UDP, length ${frame.payloadLength ?? 0}`;
  }
  if (frame.l4 === 'icmp6') {
    const start = frame.rawLinkOffset + (frame.ipHeaderLen ?? 40) + (fragmentedV6 ? IPV6_FRAGMENT_HEADER_BYTES : 0);
    const length = (frame.ipTotalLength ?? 0) - (frame.ipHeaderLen ?? 40) - (fragmentedV6 ? IPV6_FRAGMENT_HEADER_BYTES : 0);
    return icmp6Text(frame.raw.slice(start, start + length), {
      verbose: opt.verbose, sourceIp: frame.srcIp ?? '', destinationIp: frame.dstIp ?? '', fragmented: fragmentedV6,
      host: (address) => state.host(address), port: (port, protocol) => state.port(port, protocol),
    });
  }
  // `print-ip.c:506` : « This isn't the first frag, so we're missing the
  // next level protocol header. print the ip addr and the protocol. »
  // Sous `-n`, le protocole se nomme par son numero.
  if ((frame.ipFragmentOffset ?? 0) > 0) {
    const named = opt.numeric ? null : state.names?.protocol?.(frame.ipProtocol ?? 0) ?? null;
    return named ?? `ip-proto-${frame.ipProtocol ?? 0}`;
  }
  return `length ${frame.payloadLength ?? frame.length}`;
}

function icmp6ErrorPhrase(frame: CaptureFrame, state: TcpdumpRenderState): string | null {
  const orig = frame.icmpOrig;
  const code = frame.icmpCode ?? 0;
  switch (frame.icmpType) {
    case 'destination-unreachable': {
      if (orig === undefined) return null;
      const transport = transportOf(orig.l4);
      return `destination unreachable, ${icmpv6UnreachablePhrase({
        code,
        quotedDestination: state.host(orig.dstIp),
        quotedSource: state.host(orig.srcIp),
        quotedProtocol: orig.protocol,
        quotedTransport: transport,
        quotedDestinationPort: orig.dstPort === undefined ? undefined : state.port(orig.dstPort, transport),
      })}`;
    }
    case 'packet-too-big':
      return `packet too big, mtu ${frame.icmpNextHopMtu ?? 0}`;
    case 'time-exceeded':
      return icmpv6TimeExceededPhrase(code, state.host(orig?.dstIp ?? frame.srcIp ?? ''));
    case 'parameter-problem':
      return icmpv6ParameterProblemPhrase(code, frame.icmpPointer ?? 0);
    default:
      return null;
  }
}

const L4_MIN_HEADER_BYTES: Partial<Record<CaptureFrame['l4'], number>> = { tcp: 20, udp: 8, icmp: 8 };

function truncationMarker(frame: CaptureFrame, opt: TcpdumpOptions): string | null {
  const needed = L4_MIN_HEADER_BYTES[frame.l4];
  if (needed === undefined) return null;
  const l4Start = frame.rawLinkOffset + (frame.ipHeaderLen ?? 0);
  const captured = opt.snaplen - l4Start;
  return captured < needed ? `[|${frame.l4}]` : null;
}

/**
 * Le nom vient du NUMERO de protocole de l'en-tete IP (`ipproto_string`),
 * pas de ce que la capture a su decoder : un fragment non initial reste
 * `proto TCP (6)` bien que son en-tete de transport soit ailleurs.
 */
const OSPF_PROTOCOL = 89;
const TRUNCATION_MARKER = /\[\|ospf2\]/;

const IP_PROTO_NAMES: Readonly<Record<number, string>> = {
  0: 'Options', [IP_PROTO_ICMP]: 'ICMP', 2: 'IGMP', 4: 'IPIP', [IP_PROTO_TCP]: 'TCP', 8: 'EGP', 9: 'IGRP', [IP_PROTO_UDP]: 'UDP',
  33: 'DCCP', 41: 'IPv6', 43: 'Routing', [IP_PROTO_IPV6_FRAGMENT]: 'Fragment', 46: 'RSVP', 47: 'GRE', 50: 'ESP', 51: 'AH',
  55: 'Mobile IP', [IP_PROTO_ICMPV6]: 'ICMPv6', 62: 'Mobile IP (old)', 88: 'EIGRP', [OSPF_PROTOCOL]: 'OSPF', 103: 'PIM',
  108: 'Compressed IP', 112: 'VRRP', 113: 'PGM', 132: 'SCTP', 135: 'Mobility', 143: 'Ethernet',
};

function ipProtoName(frame: CaptureFrame): string {
  const byNumber = IP_PROTO_NAMES[frame.ipProtocol ?? -1];
  if (byNumber) return byNumber;
  if (frame.l4 === 'icmp') return 'ICMP';
  if (frame.l4 === 'tcp') return 'TCP';
  if (frame.l4 === 'udp') return 'UDP';
  return 'unknown';
}

const ARP_HARDWARE_ADDRESS_BYTES = 6;
const ARP_PROTOCOL_ADDRESS_BYTES = 4;
const ZERO_MAC = '00:00:00:00:00:00';

function arpLine(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const sender = state.host(frame.arpSenderIp ?? '');
  const target = state.host(frame.arpTargetIp ?? '');
  const prefix = opt.linkLevel ? '' : 'ARP, ';
  const types = opt.verbose > 0
    ? `Ethernet (len ${ARP_HARDWARE_ADDRESS_BYTES}), IPv4 (len ${ARP_PROTOCOL_ADDRESS_BYTES}), `
    : '';
  const length = frame.length - frame.rawLinkOffset;
  if (frame.arpOp === 'reply') {
    return `${prefix}${types}Reply ${sender} is-at ${state.ether(frame.arpSenderMac ?? '')}, length ${length}`;
  }
  const targetMac = frame.arpTargetMac === undefined || frame.arpTargetMac === ZERO_MAC ? '' : ` (${state.ether(frame.arpTargetMac)})`;
  return `${prefix}${types}Request who-has ${target}${targetMac} tell ${sender}, length ${length}`;
}

function ipFlagsToken(frame: CaptureFrame): string {
  const flags = frame.ipFlags ?? 0;
  const df = (flags & 0x2) !== 0;
  const mf = (flags & 0x1) !== 0;
  if (mf) return '+';
  if (df) return 'DF';
  return 'none';
}

function ipChecksumSuffix(frame: CaptureFrame, opt: TcpdumpOptions): string {
  if (opt.skipChecksumCheck || frame.ipChecksumOk === undefined) return '';
  if (frame.ipChecksumOk) return '';
  const hex = (frame.ipChecksum ?? 0).toString(16).padStart(4, '0');
  return `, bad ip cksum 0x${hex}!`;
}

function tosToken(frame: CaptureFrame): string {
  const tos = frame.ipTos ?? 0;
  const ecn = EcnCodepoint.ofField(tos);
  return `tos 0x${tos.toString(16)}${ecn.capable ? `,${ecn}` : ''}`;
}

function ipLine(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const trunc = truncationMarker(frame, opt);
  const withPort = !trunc && (frame.l4 === 'tcp' || frame.l4 === 'udp');
  const src = endpoint(state, frame.srcIp, withPort ? frame.srcPort : undefined, transportOf(frame.l4));
  const dst = endpoint(state, frame.dstIp, withPort ? frame.dstPort : undefined, transportOf(frame.l4));
  const suppressed = opt.ultraQuiet && (frame.ipFragmentOffset ?? 0) > 0;
  const detail = suppressed ? '' : trunc ?? l4Detail(frame, opt, state);
  if (opt.verbose > 0) {
    const offset = (frame.ipFragmentOffset ?? 0) * 8;
    const header = `${opt.linkLevel ? '' : 'IP '}(${tosToken(frame)}, ttl ${frame.ttl ?? 0}, id ${frame.ipId ?? 0}, offset ${offset}, flags [${ipFlagsToken(frame)}], `
      + `proto ${ipProtoName(frame)} (${frame.ipProtocol ?? 0}), length ${frame.ipTotalLength ?? frame.length}${ipChecksumSuffix(frame, opt)})`;
    return suppressed ? `${header}\n    ` : `${header}\n    ${src} > ${dst}: ${detail}${encapsulatedLines(frame, opt, state)}`;
  }
  return suppressed ? `${opt.linkLevel ? '' : 'IP '}` : `${opt.linkLevel ? '' : 'IP '}${src} > ${dst}: ${detail}`;
}

function ip6FragmentLine(
  frame: CaptureFrame, fragment: Fragment6Info, opt: TcpdumpOptions, state: TcpdumpRenderState,
): string {
  const header = opt.verbose > 0 ? `${ip6VerboseHeader(frame)} ` : '';
  const identification = opt.verbose > 0 ? `0x${fragment.identification.toString(16).padStart(8, '0')}:` : '';
  const head = `${opt.linkLevel ? '' : 'IP6 '}${header}${endpoint(state, frame.srcIp, undefined, 'other')} > `
    + `${endpoint(state, frame.dstIp, undefined, 'other')}: `
    + `frag (${identification}${fragment.offsetBytes}|${fragment.length})`;
  if (fragment.inner === undefined) return head;
  const inner: CaptureFrame = { ...fragment.inner, raw: frame.raw, rawLinkOffset: frame.rawLinkOffset };
  const protocol = transportOf(inner.l4);
  const ports = inner.l4 === 'tcp' || inner.l4 === 'udp'
    ? `${state.port(inner.srcPort ?? 0, protocol)} > ${state.port(inner.dstPort ?? 0, protocol)}: `
    : '';
  return `${head} ${ports}${l4Detail(inner, { ...opt, skipChecksumCheck: true }, state, true)}`;
}

function ip6Line(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  if (frame.fragment6 !== undefined) return ip6FragmentLine(frame, frame.fragment6, opt, state);
  const trunc = truncationMarker(frame, opt);
  const withPort = !trunc && (frame.l4 === 'tcp' || frame.l4 === 'udp');
  const src = endpoint(state, frame.srcIp, withPort ? frame.srcPort : undefined, transportOf(frame.l4));
  const dst = endpoint(state, frame.dstIp, withPort ? frame.dstPort : undefined, transportOf(frame.l4));
  const header = opt.verbose > 0 ? `${ip6VerboseHeader(frame)} ` : '';
  return `${opt.linkLevel ? '' : 'IP6 '}${header}${src} > ${dst}: ${trunc ?? l4Detail(frame, opt, state)}`;
}

function ip6VerboseHeader(frame: CaptureFrame): string {
  const trafficClass = frame.ipTrafficClass ?? 0;
  const flowLabel = frame.ipFlowLabel ?? 0;
  const fields = [
    ...(trafficClass === 0 ? [] : [`class 0x${trafficClass.toString(16).padStart(2, '0')}`]),
    ...(flowLabel === 0 ? [] : [`flowlabel 0x${flowLabel.toString(16).padStart(5, '0')}`]),
    `hlim ${frame.ttl ?? 0}`,
    `next-header ${ipProtoName(frame)} (${frame.ipProtocol ?? 0}) payload length: ${(frame.ipTotalLength ?? 40) - 40}`,
  ];
  return `(${fields.join(', ')})`;
}

function etherTypeOf(frame: CaptureFrame): { name: string; hex: string; value: number } {
  if (frame.l3 === 'arp') return { name: 'ARP', hex: '0x0806', value: 0x0806 };
  if (frame.l3 === 'ipv6') return { name: 'IPv6', hex: '0x86dd', value: 0x86dd };
  return { name: 'IPv4', hex: '0x0800', value: 0x0800 };
}

function etherTypeText(name: string, hex: string, quiet: boolean): string {
  return quiet ? name : `ethertype ${name} (${hex})`;
}

const SNAP_HEADER_BYTES = 8;

function cdpLine(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const lengthField = (frame.raw[frame.rawLinkOffset - SNAP_HEADER_BYTES - 2] << 8) | frame.raw[frame.rawLinkOffset - SNAP_HEADER_BYTES - 1];
  const payload = Array.from(frame.raw.slice(frame.rawLinkOffset, frame.rawLinkOffset + lengthField - SNAP_HEADER_BYTES));
  const text = cdpText(payload, opt.verbose, (address) => state.host(address));
  if (!opt.linkLevel) return text;
  return `${state.ether(frame.srcMac)} > ${state.ether(frame.dstMac)}, 802.3, length ${lengthField}: `
    + 'LLC, dsap SNAP (0xaa) Individual, ssap SNAP (0xaa) Command, ctrl 0x03: '
    + `oui Cisco (0x00000c), pid CDP (0x2000), length ${payload.length}: ${text}`;
}

function ethPrefix(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const type = etherTypeOf(frame);
  const addresses = `${state.ether(frame.srcMac)} > ${state.ether(frame.dstMac)}`;
  if (frame.vlanId !== undefined) {
    return `${addresses}, ${etherTypeText('802.1Q', '0x8100', opt.quiet)}, length ${frame.length}: `
      + `vlan ${frame.vlanId}, p ${frame.vlanPriority ?? 0}, ${etherTypeText(type.name, type.hex, opt.quiet)}, `;
  }
  return `${addresses}, ${etherTypeText(type.name, type.hex, opt.quiet)}, length ${frame.length}: `;
}

const SLL_HEADER_LENGTH = 16;
const SLL2_HEADER_LENGTH = 20;
const SLL_PACKET_TYPE = { host: 0, broadcast: 1, multicast: 2, otherHost: 3, outgoing: 4 } as const;
const SLL_PACKET_TYPE_TEXT = ['In', 'B', 'M', 'P', 'Out'];

function cookedPacketType(frame: CaptureFrame, cooked: CookedInterfaces): number {
  if (frame.direction === 'out') return SLL_PACKET_TYPE.outgoing;
  const dst = frame.dstMac.toLowerCase();
  if (dst === 'ff:ff:ff:ff:ff:ff') return SLL_PACKET_TYPE.broadcast;
  if ((parseInt(dst.slice(0, 2), 16) & 0x01) === 1) return SLL_PACKET_TYPE.multicast;
  const own = cooked.mac(frame.iface)?.toLowerCase();
  return own !== undefined && own !== dst ? SLL_PACKET_TYPE.otherHost : SLL_PACKET_TYPE.host;
}

function cookedPrefix(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState, cooked: CookedInterfaces): string {
  const packetType = SLL_PACKET_TYPE_TEXT[cookedPacketType(frame, cooked)];
  const type = etherTypeOf(frame);
  const inner = `ethertype ${type.name} (${type.hex}), `;
  const detail = opt.quiet ? '' : frame.vlanId !== undefined
    ? `ethertype 802.1Q (0x8100), length ${cookedLength(frame, cooked)}: vlan ${frame.vlanId}, p ${frame.vlanPriority ?? 0}, ${inner}`
    : `${inner.slice(0, -2)}, length ${cookedLength(frame, cooked)}: `;
  if (cooked.version === 1) {
    return opt.linkLevel ? `${padToWidth(packetType, 3, 'right')} ${state.ether(frame.srcMac)} ${detail}` : '';
  }
  const head = `${padToWidth(frame.iface, 5)} ${padToWidth(packetType, 3)} `;
  if (!opt.linkLevel) return head;
  return `${head}ifindex ${cooked.index(frame.iface)} ${state.ether(frame.srcMac)} ${detail}`;
}

function cookedLength(frame: CaptureFrame, cooked: CookedInterfaces): number {
  const header = cooked.version === 1 ? SLL_HEADER_LENGTH : SLL2_HEADER_LENGTH;
  return frame.length - frame.rawLinkOffset + header + vlanTagLength(frame);
}

function vlanTagLength(frame: CaptureFrame): number {
  return frame.vlanId !== undefined ? 4 : 0;
}

function cookedHeader(frame: CaptureFrame, cooked: CookedInterfaces): number[] {
  const type = frame.vlanId !== undefined ? 0x8100 : etherTypeOf(frame).value;
  const mac = frame.srcMac.split(':').map((b) => parseInt(b, 16));
  const packetType = cookedPacketType(frame, cooked);
  if (cooked.version === 1) {
    return [0, packetType, 0, 1, 0, 6, ...mac, 0, 0, type >> 8, type & 0xff];
  }
  const index = cooked.index(frame.iface);
  return [
    type >> 8, type & 0xff, 0, 0,
    (index >>> 24) & 0xff, (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff,
    0, 1, packetType, 6,
    ...mac, 0, 0,
  ];
}

export function hexDump(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState, truncated = false): string[] {
  const network = Array.from(frame.raw.slice(frame.rawLinkOffset));
  const link = state.cooked !== null
    ? [...cookedHeader(frame, state.cooked), ...frame.raw.slice(frame.rawLinkOffset - vlanTagLength(frame), frame.rawLinkOffset)]
    : Array.from(frame.raw.slice(0, frame.rawLinkOffset));
  const withLink = opt.hexLink || truncated;
  const bytes = (withLink ? [...link, ...network] : network).slice(0, opt.snaplen);
  if (opt.hex === 'ascii') return bytes.length === 0 || (!withLink && network.length === 0) ? [] : asciiPrintLines(bytes).slice(1).split('\n');
  const text = opt.hex === 'hexascii' ? hexAndAsciiLines(bytes, '\n\t') : hexPrintLines(bytes, '\n\t');
  return text === '' ? [] : text.slice(1).split('\n');
}

export function formatFrame(
  frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState,
): string {
  const ts = timestamp(frame, opt, state);
  state.prev = frame;
  state.first ??= frame;
  state.count++;
  const number = opt.packetNumbers ? `${padToWidth(String(state.count), 5, 'right')}  ` : '';
  const cooked = state.cooked;
  const link = cooked !== null
    ? cookedPrefix(frame, opt, state, cooked)
    : opt.linkLevel ? ethPrefix(frame, opt, state) : '';
  let body: string;
  if (frame.l3 === 'arp') {
    body = `${link}${arpLine(frame, opt, state)}`;
  } else if (frame.l3 === 'ipv4') {
    body = `${link}${ipLine(frame, opt, state)}`;
  } else if (frame.l3 === 'ipv6') {
    body = `${link}${ip6Line(frame, opt, state)}`;
  } else if (frame.l3 === 'cdp') {
    body = cdpLine(frame, opt, state);
  } else {
    body = opt.linkLevel ? `${state.ether(frame.srcMac)} > ${state.ether(frame.dstMac)}, ${opt.quiet ? 'Unknown Ethertype' : 'ethertype Unknown'} (0x${frame.etherType.toString(16)}), length ${frame.length}` : `unknown ethertype 0x${frame.etherType.toString(16)}`;
  }
  const lines = [`${number}${ts}${body}`];
  if (opt.hex !== 'none') lines.push(...hexDump(frame, opt, state, TRUNCATION_MARKER.test(body)));
  return lines.join('\n');
}
