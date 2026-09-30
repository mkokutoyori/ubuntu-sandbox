import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { BOOTP_TAGS } from './TcpdumpBootpTags';

export interface BootpOption {
  readonly code: number;
  readonly data: readonly number[];
}

export interface BootpInfo {
  readonly op: number;
  readonly htype: number;
  readonly hlen: number;
  readonly hops: number;
  readonly xid: number;
  readonly secs: number;
  readonly flags: number;
  readonly ciaddr: string;
  readonly yiaddr: string;
  readonly siaddr: string;
  readonly giaddr: string;
  readonly chaddr: string;
  readonly sname: string;
  readonly file: string;
  readonly options: readonly BootpOption[];
}

const FIXED_HEADER = 236;
const MAGIC_COOKIE = [0x63, 0x82, 0x53, 0x63];

function address(bytes: readonly number[], at: number): string {
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

function mac(bytes: readonly number[], at: number, length: number): string {
  return bytes.slice(at, at + length).map(byte => byte.toString(16).padStart(2, '0')).join(':');
}

function text(bytes: readonly number[], at: number, width: number): string {
  let out = '';
  for (let i = 0; i < width && bytes[at + i] !== 0; i++) out += String.fromCharCode(bytes[at + i]);
  return out;
}

export function decodeBootp(packet: DHCPPacket): BootpInfo | null {
  let bytes: number[];
  try { bytes = [...packet.serialize()]; } catch { return null; }
  if (bytes.length < FIXED_HEADER + 4 || MAGIC_COOKIE.some((value, index) => bytes[FIXED_HEADER + index] !== value)) return null;
  const options: BootpOption[] = [];
  for (let at = FIXED_HEADER + 4; at < bytes.length;) {
    const code = bytes[at++];
    if (code === 0) continue;
    if (code === 255) { options.push({ code, data: [] }); break; }
    const length = bytes[at++];
    options.push({ code, data: bytes.slice(at, at + length) });
    at += length;
  }
  return {
    op: bytes[0], htype: bytes[1], hlen: bytes[2], hops: bytes[3],
    xid: ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0,
    secs: (bytes[8] << 8) | bytes[9], flags: (bytes[10] << 8) | bytes[11],
    ciaddr: address(bytes, 12), yiaddr: address(bytes, 16), siaddr: address(bytes, 20), giaddr: address(bytes, 24),
    chaddr: mac(bytes, 28, bytes[2] || 6),
    sname: text(bytes, 44, 64), file: text(bytes, 108, 128), options,
  };
}

const MESSAGE_TYPES: Readonly<Record<number, string>> = {
  1: 'Discover', 2: 'Offer', 3: 'Request', 4: 'Decline', 5: 'ACK', 6: 'NACK', 7: 'Release', 8: 'Inform',
  10: 'LeaseQuery', 11: 'LeaseUnassigned', 12: 'LeaseUnknown', 13: 'LeaseActive',
};

const HARDWARE_TYPES: Readonly<Record<number, string>> = { 1: 'ether', 6: 'ieee802', 7: 'arcnet' };
const OVERLOAD: Readonly<Record<number, string>> = { 1: 'file', 2: 'sname', 3: 'file+sname' };
const NETBIOS_NODE: Readonly<Record<number, string>> = { 1: 'b-node', 2: 'p-node', 4: 'm-node', 8: 'h-node' };
const AGENT_SUBOPTIONS: Readonly<Record<number, string>> = { 1: 'Circuit-ID', 2: 'Remote-ID', 6: 'Subscriber-ID' };

function ascii(data: readonly number[]): string {
  return data.map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`)).join('');
}

function unsigned(data: readonly number[], at: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + data[at + i];
  return value;
}

function special(tag: number, data: readonly number[]): string {
  switch (tag) {
    case 46: return data.length < 1 ? '[length < 1 byte]' : (NETBIOS_NODE[data[0]] ?? '');
    case 52: return data.length < 1 ? '[length < 1 byte]' : (OVERLOAD[data[0]] ?? '');
    case 61: {
      if (data.length < 1) return '[length < 1 byte]';
      if (data[0] === 0) return `"${ascii(data.slice(1))}"`;
      const kind = HARDWARE_TYPES[data[0]] ?? `hardware-type ${data[0]},`;
      return `${kind} ${data.slice(1).map(byte => byte.toString(16).padStart(2, '0')).join(':')}`;
    }
    case 81: {
      if (data.length < 3) return '[length < 3 bytes]';
      const flags = [[1, 'S'], [2, 'O'], [4, 'E'], [8, 'N']].filter(([bit]) => (data[0] & (bit as number)) !== 0).map(([, name]) => name).join('');
      let out = data[0] & 0x0f ? `[${flags}] ` : '';
      if (data[1] || data[2]) out += `${data[1]}/${data[2]} `;
      return `${out}"${ascii(data.slice(3))}"`;
    }
    case 82: {
      let out = '';
      for (let at = 0; at + 2 <= data.length;) {
        const sub = data[at];
        const length = data[at + 1];
        at += 2;
        const name = AGENT_SUBOPTIONS[sub] ?? 'Unknown';
        if (length > data.length - at) return `${out}\n\t      ${name} SubOption ${sub}, length ${length}: length goes past end of option`;
        out += `\n\t      ${name} SubOption ${sub}, length ${length}: ${ascii(data.slice(at, at + length))}`;
        at += length;
      }
      return out;
    }
    case 121:
    case 249: {
      if (data.length < 5) return '[length < 5 bytes]';
      const routes: string[] = [];
      for (let at = 0; at < data.length;) {
        const width = data[at++];
        const octets = Math.ceil(width / 8);
        if (width > 32 || data.length - at < octets + 4) return `${routes.join(',')}[Mask width (${width}) > 32]`;
        let destination = width === 0 ? 'default' : data.slice(at, at + octets).join('.') + '.0'.repeat(4 - octets) + `/${width}`;
        at += octets;
        destination = `(${destination}:${address(data, at)})`;
        at += 4;
        routes.push(destination);
      }
      return routes.join(',');
    }
    case 77: {
      let out = '';
      let instance = 1;
      for (let at = 0; at < data.length; instance++) {
        const length = data[at++];
        out += `\n\t      instance#${instance}: "${ascii(data.slice(at, at + length))}", length ${length}`;
        at += length;
      }
      return out;
    }
    case 108: return data.length === 4 ? String(unsigned(data, 0, 4)) : '[length != 4 bytes]';
    default: return `[unknown special tag ${tag}, size ${data.length}]`;
  }
}

function dataText(tag: number, format: string, data: readonly number[]): string {
  let kind = format;
  if (kind === '?') kind = data.length & 1 ? 'b' : data.length & 2 ? 's' : 'l';
  switch (kind) {
    case 'a': return `"${ascii(data)}"`;
    case 'i': case 'l': case 'L': {
      const items: string[] = [];
      for (let at = 0; at + 4 <= data.length; at += 4) {
        items.push(kind === 'i' ? address(data, at) : kind === 'L' ? String(unsigned(data, at, 4) | 0) : String(unsigned(data, at, 4)));
      }
      return items.join(',');
    }
    case 'p': {
      if (data.length < 8 || data.length % 8 !== 0) return `${data.length === 0 ? ' ' : ''}[length != N x 8 bytes]`;
      const pairs: string[] = [];
      for (let at = 0; at < data.length; at += 8) pairs.push(`(${address(data, at)}:${address(data, at + 4)})`);
      return pairs.join(',');
    }
    case 's': {
      const items: string[] = [];
      for (let at = 0; at + 2 <= data.length; at += 2) items.push(String(unsigned(data, at, 2)));
      return items.join(',');
    }
    case 'B': return data.length !== 1 ? '[length != 1 byte]' : data[0] === 0 ? 'N' : data[0] === 1 ? 'Y' : `${data[0]}?`;
    case 'x': return data.map(byte => byte.toString(16).padStart(2, '0')).join(':');
    case '$': return special(tag, data);
    default: return data.join('.');
  }
}

function optionLines(info: BootpInfo, verbose: number): string {
  let out = '\n\t  Vendor-rfc1048 Extensions\n\t    Magic Cookie 0x63825363';
  for (const option of info.options) {
    if (option.code === 255) return verbose >= 3 ? `${out}\n\t    END (255), length 0` : out;
    const [format, name] = BOOTP_TAGS[option.code] ?? ['?', 'Unknown'];
    const length = option.data.length;
    out += `\n\t    ${name} (${option.code}), length ${length}${length > 0 ? ': ' : ''}`;
    if (option.code === 53 && length === 1) { out += MESSAGE_TYPES[option.data[0]] ?? `Unknown (${option.data[0]})`; continue; }
    if (option.code === 55) {
      option.data.forEach((tag, index) => {
        out += index % 4 === 0 ? '\n\t      ' : ', ';
        out += `${(BOOTP_TAGS[tag] ?? ['?', 'Unknown'])[1]} (${tag})`;
      });
      continue;
    }
    if (length > 0) out += dataText(option.code, format === ' ' ? '?' : format, option.data);
  }
  return out;
}

export function bootpText(info: BootpInfo, verbose: number, length: number): string {
  const op = info.op === 1 ? 'Request' : info.op === 2 ? 'Reply' : `unknown (0x${info.op.toString(16).padStart(2, '0')})`;
  const from = info.op === 1 && info.htype === 1 && info.hlen === 6 ? ` from ${info.chaddr}` : '';
  let line = `BOOTP/DHCP, ${op}${from}, length ${length}`;
  if (verbose === 0) return line;
  if (info.htype !== 1) line += `, htype ${info.htype}`;
  if (info.htype !== 1 || info.hlen !== 6) line += `, hlen ${info.hlen}`;
  if (info.hops) line += `, hops ${info.hops}`;
  if (info.xid) line += `, xid 0x${info.xid.toString(16)}`;
  if (info.secs) line += `, secs ${info.secs}`;
  line += `, Flags [${info.flags & 0x8000 ? 'Broadcast' : 'none'}]`;
  if (verbose > 1) line += ` (0x${info.flags.toString(16).padStart(4, '0')})`;
  if (info.ciaddr !== '0.0.0.0') line += `\n\t  Client-IP ${info.ciaddr}`;
  if (info.yiaddr !== '0.0.0.0') line += `\n\t  Your-IP ${info.yiaddr}`;
  if (info.siaddr !== '0.0.0.0') line += `\n\t  Server-IP ${info.siaddr}`;
  if (info.giaddr !== '0.0.0.0') line += `\n\t  Gateway-IP ${info.giaddr}`;
  if (info.htype === 1 && info.hlen === 6) line += `\n\t  Client-Ethernet-Address ${info.chaddr}`;
  if (info.sname) line += `\n\t  sname "${info.sname}"`;
  if (info.file) line += `\n\t  file "${info.file}"`;
  return line + optionLines(info, verbose);
}
