import type { CaptureFrame } from './CaptureFrame';
import type { TcpdumpOptions } from './TcpdumpCli';

export function banner(opt: TcpdumpOptions): string[] {
  const lines: string[] = [];
  if (opt.verbose === 0) {
    lines.push('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode');
  }
  lines.push(
    `listening on ${opt.iface}, link-type ${opt.linkType} (Ethernet), capture size ${opt.snaplen} bytes`,
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

function tcpFlagToken(frame: CaptureFrame): string {
  const f = frame.tcpFlags;
  if (!f) return '.';
  let s = '';
  if (f.syn) s += 'S';
  if (f.fin) s += 'F';
  if (f.rst) s += 'R';
  if (f.psh) s += 'P';
  if (f.urg) s += 'U';
  if (f.ack) s += '.';
  return s === '' ? '.' : s;
}

function endpoint(ip: string | undefined, port: number | undefined): string {
  if (ip === undefined) return '?';
  return port === undefined ? ip : `${ip}.${port}`;
}

function l4Detail(frame: CaptureFrame, opt: TcpdumpOptions): string {
  if (frame.l4 === 'icmp') {
    const phrase = ICMP_PHRASE[frame.icmpType ?? ''] ?? frame.icmpType ?? 'unknown';
    if (opt.quiet) return `ICMP ${phrase}, length ${frame.payloadLength ?? 0}`;
    if (frame.icmpType === 'echo-request' || frame.icmpType === 'echo-reply') {
      return `ICMP ${phrase}, id ${frame.icmpId ?? 0}, seq ${frame.icmpSeq ?? 0}, length ${frame.payloadLength ?? 0}`;
    }
    return `ICMP ${phrase}, length ${frame.payloadLength ?? 0}`;
  }
  if (frame.l4 === 'tcp') {
    if (opt.quiet) return `tcp ${frame.payloadLength ?? 0}`;
    const ack = frame.tcpFlags?.ack ? `, ack ${frame.tcpAck ?? 0}` : '';
    return `Flags [${tcpFlagToken(frame)}], seq ${frame.tcpSeq ?? 0}${ack}, win ${frame.tcpWindow ?? 0}, length ${frame.payloadLength ?? 0}`;
  }
  if (frame.l4 === 'udp') {
    return `UDP, length ${frame.payloadLength ?? 0}`;
  }
  if (frame.l4 === 'icmp6') {
    return `ICMP6, length ${frame.payloadLength ?? 0}`;
  }
  return `length ${frame.payloadLength ?? frame.length}`;
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

function ipLine(frame: CaptureFrame, opt: TcpdumpOptions): string {
  const withPort = frame.l4 === 'tcp' || frame.l4 === 'udp';
  const src = endpoint(frame.srcIp, withPort ? frame.srcPort : undefined);
  const dst = endpoint(frame.dstIp, withPort ? frame.dstPort : undefined);
  const detail = l4Detail(frame, opt);
  if (opt.verbose > 0) {
    const header = `IP (tos 0x0, ttl ${frame.ttl ?? 0}, id ${frame.ipId ?? 0}, offset 0, flags [none], `
      + `proto ${ipProtoName(frame)} (${frame.ipProtocol ?? 0}), length ${frame.ipTotalLength ?? frame.length})`;
    return `${header}\n    ${src} > ${dst}: ${detail}`;
  }
  return `IP ${src} > ${dst}: ${detail}`;
}

function ethPrefix(frame: CaptureFrame): string {
  const typeName = frame.l3 === 'arp' ? 'ARP' : frame.l3 === 'ipv6' ? 'IPv6' : 'IPv4';
  const typeHex = frame.l3 === 'arp' ? '0x0806' : frame.l3 === 'ipv6' ? '0x86dd' : '0x0800';
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
    body = opt.linkLevel ? `${frame.srcMac} > ${frame.dstMac}, ${arpLine(frame)}` : arpLine(frame);
  } else if (frame.l3 === 'ipv4') {
    body = opt.linkLevel ? `${ethPrefix(frame)}${ipLine(frame, opt)}` : ipLine(frame, opt);
  } else if (frame.l3 === 'ipv6') {
    const detail = l4Detail(frame, opt);
    const line = `IP6 ${frame.srcIp} > ${frame.dstIp}: ${detail}`;
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
