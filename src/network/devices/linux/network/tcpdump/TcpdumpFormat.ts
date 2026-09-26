import { icmpTimeExceededPhrase, icmpUnreachablePhrase } from '@/network/core/IcmpPhrase';
import type { CaptureFrame } from './CaptureFrame';
import type { TcpdumpOptions } from './TcpdumpCli';
import { decodeOptions } from '@/network/tcp/TcpOptionsCodec';
import { IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';

export interface AddressNames {
  host(ip: string): string;
  service(port: number, protocol: 'tcp' | 'udp'): string;
  ether(mac: string): string;
}

export interface CookedInterfaces {
  version: 1 | 2;
  index(iface: string): number;
  mac(iface: string): string | null;
}

export class TcpdumpRenderState {
  prev: Date | null = null;
  first: Date | null = null;
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

function relativeSeqAck(
  frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState,
): { seq: number; ack: number } {
  const seq = frame.tcpSeq ?? 0;
  const ack = frame.tcpAck ?? 0;
  if (opt.absoluteSeq || !frame.tcpFlags?.ack) return { seq, ack };
  const sport = frame.srcPort ?? 0;
  const dport = frame.dstPort ?? 0;
  const src = frame.srcIp ?? '';
  const dst = frame.dstIp ?? '';
  const rev = sport > dport
    || (sport === dport && expandedAddress(src) > expandedAddress(dst));
  const key = rev ? `${dst}|${src}|${dport}|${sport}` : `${src}|${dst}|${sport}|${dport}`;
  const entry = state.conversations.get(key);
  if (entry === undefined || frame.tcpFlags.syn) {
    state.conversations.set(key, rev
      ? { ack: seq, seq: (ack - 1) >>> 0 }
      : { seq, ack: (ack - 1) >>> 0 });
    return { seq, ack };
  }
  return rev
    ? { seq: (seq - entry.ack) >>> 0, ack: (ack - entry.seq) >>> 0 }
    : { seq: (seq - entry.seq) >>> 0, ack: (ack - entry.ack) >>> 0 };
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

function fraction(date: Date, nano: boolean): string {
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return nano ? `${ms}000000` : `${ms}000`;
}

function clockOf(date: Date, nano: boolean): string {
  return date.toTimeString().slice(0, 8) + '.' + fraction(date, nano);
}

function elapsed(deltaMs: number, nano: boolean): string {
  const whole = Math.floor(deltaMs / 1000);
  const hh = String(Math.floor(whole / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  const ms = String(deltaMs % 1000).padStart(3, '0');
  return ` ${hh}:${mm}:${ss}.${nano ? `${ms}000000` : `${ms}000`} `;
}

function timestamp(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const nano = opt.nanoPrecision;
  switch (opt.tsMode) {
    case 'none':
      return '';
    case 'epoch':
      return `${Math.floor(frame.at.getTime() / 1000)}.${fraction(frame.at, nano)} `;
    case 'delta': {
      const reference = state.prev ?? frame.at;
      return elapsed(Math.max(0, frame.at.getTime() - reference.getTime()), nano);
    }
    case 'since-first': {
      const reference = state.first ?? frame.at;
      return elapsed(Math.max(0, frame.at.getTime() - reference.getTime()), nano);
    }
    case 'datetime': {
      const d = frame.at;
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return `${date} ${clockOf(d, nano)} `;
    }
    default:
      return `${clockOf(frame.at, nano)} `;
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

/** Nested "IP (...)\n    src > dst: detail" block for the packet an ICMP error encapsulates (RFC 792), as real `tcpdump -v` renders it. */
function encapsulatedLines(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  if (opt.verbose <= 0 || frame.l4 !== 'icmp' || !frame.icmpOrig) return '';
  if (frame.icmpType !== 'time-exceeded' && frame.icmpType !== 'destination-unreachable') return '';
  const orig = frame.icmpOrig;
  const protoName = orig.l4 === 'tcp' ? 'TCP' : orig.l4 === 'udp' ? 'UDP' : orig.l4 === 'icmp' ? 'ICMP' : 'unknown';
  const df = (orig.ipFlags & 0x2) !== 0;
  const mf = (orig.ipFlags & 0x1) !== 0;
  const flagsToken = mf ? '+' : df ? 'DF' : 'none';
  const header = `\tIP (tos 0x${(orig.ipTos ?? 0).toString(16)}, ttl ${orig.ttl}, id ${orig.ipId}, offset 0, flags [${flagsToken}], `
    + `proto ${protoName} (${orig.protocol}), length ${orig.ipTotalLength})`;
  const transport = transportOf(orig.l4);
  const withPort = transport !== 'other';
  const src = endpoint(state, orig.srcIp, withPort ? orig.srcPort : undefined, transport);
  const dst = endpoint(state, orig.dstIp, withPort ? orig.dstPort : undefined, transport);
  const detail = orig.l4 === 'other' ? `ip-proto-${orig.protocol}` : `${protoName}, length ${orig.payloadLength ?? 0}`;
  return `\n${header}\n    ${src} > ${dst}: ${detail}`;
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

function udpChecksumToken(frame: CaptureFrame): string {
  if (frame.udpChecksum === undefined) return '';
  if (frame.udpChecksum === 0) return ', cksum 0x0000 (unverified)';
  const hex = frame.udpChecksum.toString(16).padStart(4, '0');
  return frame.udpChecksumOk ? `, cksum 0x${hex} (correct)` : `, cksum 0x${hex} (incorrect)`;
}

const DNS_RCODE_TEXT: Record<number, string> = {
  1: 'FormErr',
  2: 'ServFail',
  3: 'NXDomain',
  4: 'NotImp',
  5: 'Refused',
};

function dnsLine(frame: CaptureFrame, opt: TcpdumpOptions): string {
  const length = frame.payloadLength ?? 0;
  if (!frame.dnsQr) {
    const rd = frame.dnsRd ? '+' : '';
    return `${frame.dnsId}${rd} ${frame.dnsQtype}? ${frame.dnsQname} (${length})`;
  }
  const counts = frame.dnsCounts
    ? `${frame.dnsCounts.an}/${frame.dnsCounts.ns}/${frame.dnsCounts.ar}` : '0/0/0';
  const rcodeText = frame.dnsRcode ? DNS_RCODE_TEXT[frame.dnsRcode] : undefined;
  const rcodePart = rcodeText ? ` ${rcodeText}` : '';
  const showTtl = opt.verbose > 0;
  const answerList = (frame.dnsAnswers ?? []).map((a) => {
    const base = `${a.type}${a.data ? ` ${a.data}` : ''}`;
    return showTtl ? `${base} ttl ${a.ttl}` : base;
  }).join(', ');
  const tcPart = showTtl && frame.dnsTc ? ' (truncated, TC)' : '';
  const authorityList = showTtl ? (frame.dnsAuthority ?? []).map((a) => {
    const base = `${a.type}${a.data ? ` ${a.data}` : ''}`;
    return `${base} ttl ${a.ttl}`;
  }).join(', ') : '';
  const authorityPart = authorityList ? `; authority: ${authorityList}` : '';
  return `${frame.dnsId}${rcodePart} ${counts}${answerList ? ` ${answerList}` : ''}${tcPart}${authorityPart} (${length})`;
}

function tcpOptionsToken(frame: CaptureFrame): string {
  if (!frame.tcpOptions || frame.tcpOptions.length === 0) return '';
  const decoded = decodeOptions(frame.tcpOptions);
  const parts: string[] = [];
  if (decoded.mss !== undefined) parts.push(`mss ${decoded.mss}`);
  if (decoded.sackPermitted) parts.push('sackOK');
  if (decoded.timestamp) parts.push(`TS val ${decoded.timestamp.tsVal} ecr ${decoded.timestamp.tsEcr}`);
  if (decoded.windowScale !== undefined) parts.push(`wscale ${decoded.windowScale}`);
  if (decoded.sackBlocks && decoded.sackBlocks.length > 0) {
    const blocks = decoded.sackBlocks.map((b) => `${b.start}:${b.end}`).join(' ');
    parts.push(`sack ${decoded.sackBlocks.length} {${blocks}}`);
  }
  return parts.length > 0 ? `, options [${parts.join(',')}]` : '';
}

function l4Detail(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  if (frame.l4 === 'icmp') {
    let phrase: string;
    if (frame.icmpType === 'destination-unreachable') {
      phrase = icmpUnreachPhrase(frame, state);
    } else if (frame.icmpType === 'time-exceeded') {
      phrase = icmpTimeExceededText(frame);
    } else {
      phrase = ICMP_PHRASE[frame.icmpType ?? ''] ?? frame.icmpType ?? 'unknown';
    }
    if (opt.quiet) return `ICMP ${phrase}, length ${frame.payloadLength ?? 0}`;
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
    const { seq, ack } = relativeSeqAck(frame, opt, state);
    let seqText = '';
    if (opt.verbose > 1 || length > 0 || flags?.syn || flags?.fin || flags?.rst) {
      seqText = `, seq ${seq}${length > 0 ? `:${(seq + length) >>> 0}` : ''}`;
    }
    const ackText = flags?.ack ? `, ack ${ack}` : '';
    const options = tcpOptionsToken(frame);
    const urgent = flags?.urg ? `, urg ${frame.tcpUrgentPointer ?? 0}` : '';
    const base = `Flags [${tcpFlagToken(frame)}]${cksum}${seqText}${ackText}, win ${frame.tcpWindow ?? 0}${urgent}${options}, length ${length}`;
    if (frame.dnsQr !== undefined && (frame.payloadLength ?? 0) > 0) {
      return `${base}: ${dnsLine(frame, opt)}`;
    }
    return base;
  }
  if (frame.l4 === 'udp') {
    if (frame.dnsQr !== undefined) return dnsLine(frame, opt);
    const cksum = opt.verbose > 0 && !opt.skipChecksumCheck ? udpChecksumToken(frame) : '';
    return `UDP${cksum}, length ${frame.payloadLength ?? 0}`;
  }
  if (frame.l4 === 'icmp6') {
    const phrase = ICMP6_PHRASE[frame.icmpType ?? ''] ?? frame.icmpType ?? 'unknown';
    const length = `length ${frame.payloadLength ?? 0}`;
    if (opt.quiet) return `ICMP6, ${phrase}, ${length}`;
    if (frame.icmpType === 'echo-request' || frame.icmpType === 'echo-reply') {
      return `ICMP6, ${phrase}, id ${frame.icmpId ?? 0}, seq ${frame.icmpSeq ?? 0}, ${length}`;
    }
    if (frame.icmpType === 'neighbor-solicitation' && frame.ndpTarget) {
      return `ICMP6, ${phrase}, who has ${frame.ndpTarget}, ${length}`;
    }
    if (frame.icmpType === 'neighbor-advertisement' && frame.ndpTarget) {
      return `ICMP6, ${phrase}, tgt is ${frame.ndpTarget}, ${length}`;
    }
    return `ICMP6, ${phrase}, ${length}`;
  }
  // `print-ip.c:506` : « This isn't the first frag, so we're missing the
  // next level protocol header. print the ip addr and the protocol. »
  // Sous `-n`, le protocole se nomme par son numero.
  if ((frame.ipFragmentOffset ?? 0) > 0) {
    return `ip-proto-${frame.ipProtocol ?? 0}`;
  }
  return `length ${frame.payloadLength ?? frame.length}`;
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
const IP_PROTO_NAMES: Readonly<Record<number, string>> = {
  [IP_PROTO_ICMP]: 'ICMP', [IP_PROTO_TCP]: 'TCP', [IP_PROTO_UDP]: 'UDP',
};

function ipProtoName(frame: CaptureFrame): string {
  const byNumber = IP_PROTO_NAMES[frame.ipProtocol ?? -1];
  if (byNumber) return byNumber;
  if (frame.l4 === 'icmp') return 'ICMP';
  if (frame.l4 === 'tcp') return 'TCP';
  if (frame.l4 === 'udp') return 'UDP';
  return 'unknown';
}

function arpLine(frame: CaptureFrame, state: TcpdumpRenderState): string {
  const sender = state.host(frame.arpSenderIp ?? '');
  if (frame.arpOp === 'reply') {
    return `ARP, Reply ${sender} is-at ${state.ether(frame.arpSenderMac ?? '')}, length ${frame.length - frame.rawLinkOffset}`;
  }
  return `ARP, Request who-has ${state.host(frame.arpTargetIp ?? '')} tell ${sender}, length ${frame.length - frame.rawLinkOffset}`;
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
  if (frame.ipChecksumOk) return opt.verbose >= 2 ? ', ip sum ok' : '';
  const hex = (frame.ipChecksum ?? 0).toString(16).padStart(4, '0');
  return `, bad ip cksum 0x${hex}!`;
}

const ECN_SUFFIX: readonly string[] = ['', ',ECT(1)', ',ECT(0)', ',CE'];

function tosToken(frame: CaptureFrame): string {
  const tos = frame.ipTos ?? 0;
  return `tos 0x${tos.toString(16)}${ECN_SUFFIX[tos & 0x03]}`;
}

function ipLine(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const trunc = truncationMarker(frame, opt);
  const withPort = !trunc && (frame.l4 === 'tcp' || frame.l4 === 'udp');
  const src = endpoint(state, frame.srcIp, withPort ? frame.srcPort : undefined, transportOf(frame.l4));
  const dst = endpoint(state, frame.dstIp, withPort ? frame.dstPort : undefined, transportOf(frame.l4));
  const detail = trunc ?? l4Detail(frame, opt, state);
  if (opt.verbose > 0) {
    const offset = (frame.ipFragmentOffset ?? 0) * 8;
    const header = `IP (${tosToken(frame)}, ttl ${frame.ttl ?? 0}, id ${frame.ipId ?? 0}, offset ${offset}, flags [${ipFlagsToken(frame)}], `
      + `proto ${ipProtoName(frame)} (${frame.ipProtocol ?? 0}), length ${frame.ipTotalLength ?? frame.length}${ipChecksumSuffix(frame, opt)})`;
    return `${header}\n    ${src} > ${dst}: ${detail}${encapsulatedLines(frame, opt, state)}`;
  }
  return `IP ${src} > ${dst}: ${detail}`;
}

function ip6Line(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string {
  const trunc = truncationMarker(frame, opt);
  const withPort = !trunc && (frame.l4 === 'tcp' || frame.l4 === 'udp');
  const src = endpoint(state, frame.srcIp, withPort ? frame.srcPort : undefined, transportOf(frame.l4));
  const dst = endpoint(state, frame.dstIp, withPort ? frame.dstPort : undefined, transportOf(frame.l4));
  return `IP6 ${src} > ${dst}: ${trunc ?? l4Detail(frame, opt, state)}`;
}

function etherTypeOf(frame: CaptureFrame): { name: string; hex: string; value: number } {
  if (frame.l3 === 'arp') return { name: 'ARP', hex: '0x0806', value: 0x0806 };
  if (frame.l3 === 'ipv6') return { name: 'IPv6', hex: '0x86dd', value: 0x86dd };
  return { name: 'IPv4', hex: '0x0800', value: 0x0800 };
}

function ethPrefix(frame: CaptureFrame, state: TcpdumpRenderState): string {
  const type = etherTypeOf(frame);
  const addresses = `${state.ether(frame.srcMac)} > ${state.ether(frame.dstMac)}`;
  if (frame.vlanId !== undefined) {
    return `${addresses}, ethertype 802.1Q (0x8100), length ${frame.length}: `
      + `vlan ${frame.vlanId}, p ${frame.vlanPriority ?? 0}, ethertype ${type.name} (${type.hex}), `;
  }
  return `${addresses}, ethertype ${type.name} (${type.hex}), length ${frame.length}: `;
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
    return opt.linkLevel ? `${packetType.padStart(3, ' ')} ${state.ether(frame.srcMac)} ${detail}` : '';
  }
  const head = `${frame.iface.padEnd(5, ' ')} ${packetType.padEnd(3, ' ')} `;
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

export function hexDump(frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState): string[] {
  const network = Array.from(frame.raw.slice(frame.rawLinkOffset));
  const link = state.cooked !== null
    ? [...cookedHeader(frame, state.cooked), ...frame.raw.slice(frame.rawLinkOffset - vlanTagLength(frame), frame.rawLinkOffset)]
    : Array.from(frame.raw.slice(0, frame.rawLinkOffset));
  const bytes = (opt.hexLink ? [...link, ...network] : network).slice(0, opt.snaplen);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    let hex = '';
    for (let j = 0; j < chunk.length; j++) {
      hex += chunk[j].toString(16).padStart(2, '0');
      if (j % 2 === 1) hex += ' ';
    }
    hex = hex.trimEnd().padEnd(40, ' ');
    const offset = '0x' + i.toString(16).padStart(4, '0') + ':';
    if (opt.hex === 'hexascii') {
      const ascii = chunk.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
      lines.push(`\t${offset}  ${hex}  ${ascii}`);
    } else {
      lines.push(`\t${offset}  ${hex.trimEnd()}`);
    }
  }
  return lines;
}

export function formatFrame(
  frame: CaptureFrame, opt: TcpdumpOptions, state: TcpdumpRenderState,
): string {
  const ts = timestamp(frame, opt, state);
  state.prev = frame.at;
  state.first ??= frame.at;
  state.count++;
  const number = opt.packetNumbers ? `${String(state.count).padStart(5, ' ')}  ` : '';
  const cooked = state.cooked;
  const link = cooked !== null
    ? cookedPrefix(frame, opt, state, cooked)
    : opt.linkLevel ? ethPrefix(frame, state) : '';
  let body: string;
  if (frame.l3 === 'arp') {
    body = `${link}${arpLine(frame, state)}`;
  } else if (frame.l3 === 'ipv4') {
    body = `${link}${ipLine(frame, opt, state)}`;
  } else if (frame.l3 === 'ipv6') {
    body = `${link}${ip6Line(frame, opt, state)}`;
  } else {
    body = opt.linkLevel ? `${state.ether(frame.srcMac)} > ${state.ether(frame.dstMac)}, ethertype Unknown (0x${frame.etherType.toString(16)}), length ${frame.length}` : `unknown ethertype 0x${frame.etherType.toString(16)}`;
  }
  const lines = [`${number}${ts}${body}`];
  if (opt.hex !== 'none') lines.push(...hexDump(frame, opt, state));
  if (opt.ascii && frame.appPayload && frame.appPayload.length > 0) {
    const text = frame.appPayload.map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
    lines.push(text);
  }
  return lines.join('\n');
}
