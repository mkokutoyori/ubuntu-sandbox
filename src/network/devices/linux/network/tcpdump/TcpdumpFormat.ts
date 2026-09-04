import type { CaptureFrame } from './CaptureFrame';
import type { TcpdumpOptions } from './TcpdumpCli';
import { decodeOptions } from '@/network/tcp/TcpOptionsCodec';

export function banner(opt: TcpdumpOptions): string[] {
  const lines: string[] = [];
  if (opt.verbose === 0) {
    lines.push('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode');
  }
  lines.push(
    `listening on ${opt.iface}, link-type ${opt.linkType} (Ethernet), snapshot length ${opt.snaplen} bytes`,
  );
  return lines;
}

export function footer(captured: number, received: number): string[] {
  return [
    `${captured} packet${captured === 1 ? '' : 's'} captured`,
    `${received} packets received by filter`,
    '0 packets dropped by kernel',
  ];
}

function micros(date: Date): string {
  return String(date.getMilliseconds()).padStart(3, '0') + '000';
}

function timeOfDay(date: Date): string {
  return date.toTimeString().slice(0, 8) + '.' + micros(date);
}

function timestamp(frame: CaptureFrame, opt: TcpdumpOptions, prev: Date | null): string {
  switch (opt.tsMode) {
    case 'none':
      return '';
    case 'epoch':
      return `${Math.floor(frame.at.getTime() / 1000)}.${micros(frame.at)} `;
    case 'delta': {
      const deltaMs = prev ? Math.max(0, frame.at.getTime() - prev.getTime()) : 0;
      const s = Math.floor(deltaMs / 1000);
      const hh = String(Math.floor(s / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${hh}:${mm}:${ss}.${String(deltaMs % 1000).padStart(3, '0')}000 `;
    }
    case 'datetime': {
      const d = frame.at;
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return `${date} ${timeOfDay(d)} `;
    }
    default:
      return `${timeOfDay(frame.at)} `;
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

function icmpUnreachPhrase(frame: CaptureFrame): string {
  const code = frame.icmpCode ?? 0;
  const target = frame.icmpOrig?.dstIp ?? frame.srcIp ?? '';
  switch (code) {
    case 0: return `${target} net unreachable`;
    case 1: return `${target} host unreachable`;
    case 2: return `${target} protocol ${frame.icmpOrig?.protocol ?? ''} unreachable`;
    case 3: {
      const port = frame.icmpOrig?.dstPort;
      return port !== undefined ? `${target} udp port ${port} unreachable` : `${target} unreachable`;
    }
    case 4: {
      const mtu = frame.icmpNextHopMtu;
      return mtu !== undefined ? `${target} unreachable - need to frag (mtu ${mtu})` : `${target} unreachable - need to frag`;
    }
    case 9: return `${target} net unreachable - admin prohibited`;
    case 10: return `${target} host unreachable - admin prohibited`;
    case 13: return `${target} unreachable - admin prohibited`;
    default: return `${target} unreachable`;
  }
}

function icmpTimeExceededPhrase(frame: CaptureFrame): string {
  return frame.icmpCode === 1 ? 'time exceeded reassembly' : 'time exceeded in-transit';
}

/** Nested "IP (...)\n    src > dst: detail" block for the packet an ICMP error encapsulates (RFC 792), as real `tcpdump -v` renders it. */
function encapsulatedLines(frame: CaptureFrame, opt: TcpdumpOptions): string {
  if (opt.verbose <= 0 || frame.l4 !== 'icmp' || !frame.icmpOrig) return '';
  if (frame.icmpType !== 'time-exceeded' && frame.icmpType !== 'destination-unreachable') return '';
  const orig = frame.icmpOrig;
  const protoName = orig.l4 === 'tcp' ? 'TCP' : orig.l4 === 'udp' ? 'UDP' : orig.l4 === 'icmp' ? 'ICMP' : 'unknown';
  const df = (orig.ipFlags & 0x2) !== 0;
  const mf = (orig.ipFlags & 0x1) !== 0;
  const flagsToken = mf ? '+' : df ? 'DF' : 'none';
  const header = `\tIP (tos 0x0, ttl ${orig.ttl}, id ${orig.ipId}, offset 0, flags [${flagsToken}], `
    + `proto ${protoName} (${orig.protocol}), length ${orig.ipTotalLength})`;
  const withPort = orig.l4 === 'tcp' || orig.l4 === 'udp';
  const src = withPort ? `${orig.srcIp}.${orig.srcPort}` : orig.srcIp;
  const dst = withPort ? `${orig.dstIp}.${orig.dstPort}` : orig.dstIp;
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

function endpoint(ip: string | undefined, port: number | undefined): string {
  if (ip === undefined) return '?';
  return port === undefined ? ip : `${ip}.${port}`;
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

function l4Detail(frame: CaptureFrame, opt: TcpdumpOptions): string {
  if (frame.l4 === 'icmp') {
    let phrase: string;
    if (frame.icmpType === 'destination-unreachable') {
      phrase = icmpUnreachPhrase(frame);
    } else if (frame.icmpType === 'time-exceeded') {
      phrase = icmpTimeExceededPhrase(frame);
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
    const cksum = opt.verbose > 0 ? tcpChecksumToken(frame) : '';
    const ack = frame.tcpFlags?.ack ? `, ack ${frame.tcpAck ?? 0}` : '';
    const options = tcpOptionsToken(frame);
    const base = `Flags [${tcpFlagToken(frame)}]${cksum}, seq ${frame.tcpSeq ?? 0}${ack}, win ${frame.tcpWindow ?? 0}${options}, length ${frame.payloadLength ?? 0}`;
    if (frame.dnsQr !== undefined && (frame.payloadLength ?? 0) > 0) {
      return `${base}: ${dnsLine(frame, opt)}`;
    }
    return base;
  }
  if (frame.l4 === 'udp') {
    if (frame.dnsQr !== undefined) return dnsLine(frame, opt);
    const cksum = opt.verbose > 0 ? udpChecksumToken(frame) : '';
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

function ipProtoName(frame: CaptureFrame): string {
  if (frame.l4 === 'icmp') return 'ICMP';
  if (frame.l4 === 'tcp') return 'TCP';
  if (frame.l4 === 'udp') return 'UDP';
  return 'unknown';
}

function arpLine(frame: CaptureFrame): string {
  if (frame.arpOp === 'reply') {
    return `ARP, Reply ${frame.arpSenderIp} is-at ${frame.arpSenderMac}, length ${frame.length - 14}`;
  }
  return `ARP, Request who-has ${frame.arpTargetIp} tell ${frame.arpSenderIp}, length ${frame.length - 14}`;
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
  if (frame.ipChecksumOk === undefined) return '';
  if (frame.ipChecksumOk) return opt.verbose >= 2 ? ', ip sum ok' : '';
  const hex = (frame.ipChecksum ?? 0).toString(16).padStart(4, '0');
  return `, bad ip cksum 0x${hex}!`;
}

function ipLine(frame: CaptureFrame, opt: TcpdumpOptions): string {
  const trunc = truncationMarker(frame, opt);
  const withPort = !trunc && (frame.l4 === 'tcp' || frame.l4 === 'udp');
  const src = endpoint(frame.srcIp, withPort ? frame.srcPort : undefined);
  const dst = endpoint(frame.dstIp, withPort ? frame.dstPort : undefined);
  const detail = trunc ?? l4Detail(frame, opt);
  if (opt.verbose > 0) {
    const offset = (frame.ipFragmentOffset ?? 0) * 8;
    const header = `IP (tos 0x0, ttl ${frame.ttl ?? 0}, id ${frame.ipId ?? 0}, offset ${offset}, flags [${ipFlagsToken(frame)}], `
      + `proto ${ipProtoName(frame)} (${frame.ipProtocol ?? 0}), length ${frame.ipTotalLength ?? frame.length}${ipChecksumSuffix(frame, opt)})`;
    return `${header}\n    ${src} > ${dst}: ${detail}${encapsulatedLines(frame, opt)}`;
  }
  return `IP ${src} > ${dst}: ${detail}`;
}

function ip6Line(frame: CaptureFrame, opt: TcpdumpOptions): string {
  const trunc = truncationMarker(frame, opt);
  const withPort = !trunc && (frame.l4 === 'tcp' || frame.l4 === 'udp');
  const src = endpoint(frame.srcIp, withPort ? frame.srcPort : undefined);
  const dst = endpoint(frame.dstIp, withPort ? frame.dstPort : undefined);
  return `IP6 ${src} > ${dst}: ${trunc ?? l4Detail(frame, opt)}`;
}

function ethPrefix(frame: CaptureFrame): string {
  const typeName = frame.l3 === 'arp' ? 'ARP' : frame.l3 === 'ipv6' ? 'IPv6' : 'IPv4';
  const typeHex = frame.l3 === 'arp' ? '0x0806' : frame.l3 === 'ipv6' ? '0x86dd' : '0x0800';
  if (frame.vlanId !== undefined) {
    return `${frame.srcMac} > ${frame.dstMac}, ethertype 802.1Q (0x8100), length ${frame.length}: `
      + `vlan ${frame.vlanId}, p ${frame.vlanPriority ?? 0}, ethertype ${typeName} (${typeHex}), `;
  }
  return `${frame.srcMac} > ${frame.dstMac}, ethertype ${typeName} (${typeHex}), length ${frame.length}: `;
}

export function hexDump(frame: CaptureFrame, opt: TcpdumpOptions): string[] {
  const start = opt.hexLink ? 0 : frame.rawLinkOffset;
  const bytes = frame.raw.slice(start, start + opt.snaplen);
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

export function formatFrame(frame: CaptureFrame, opt: TcpdumpOptions, prev: Date | null): string {
  const ts = timestamp(frame, opt, prev);
  let body: string;
  if (frame.l3 === 'arp') {
    body = opt.linkLevel ? `${ethPrefix(frame)}${arpLine(frame)}` : arpLine(frame);
  } else if (frame.l3 === 'ipv4') {
    body = opt.linkLevel ? `${ethPrefix(frame)}${ipLine(frame, opt)}` : ipLine(frame, opt);
  } else if (frame.l3 === 'ipv6') {
    const line = ip6Line(frame, opt);
    body = opt.linkLevel ? `${ethPrefix(frame)}${line}` : line;
  } else {
    body = opt.linkLevel ? `${frame.srcMac} > ${frame.dstMac}, ethertype Unknown (0x${frame.etherType.toString(16)}), length ${frame.length}` : `unknown ethertype 0x${frame.etherType.toString(16)}`;
  }
  const lines = [`${ts}${body}`];
  if (opt.hex !== 'none') lines.push(...hexDump(frame, opt));
  if (opt.ascii && frame.tcpPayload && frame.tcpPayload.length > 0) {
    const text = frame.tcpPayload.map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
    lines.push(text);
  }
  return lines.join('\n');
}
