import { DHCPPacket } from '@/network/dhcp/DHCPPacket';

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
  readonly options: readonly BootpOption[];
}

const FIXED_HEADER = 236;
const MAGIC_COOKIE = [0x63, 0x82, 0x53, 0x63];

const OPTION_NAMES: Readonly<Record<number, string>> = {
  1: 'Subnet-Mask', 2: 'Time-Zone', 3: 'Default-Gateway', 4: 'Time-Server', 6: 'Domain-Name-Server',
  12: 'Hostname', 15: 'Domain-Name', 26: 'MTU', 28: 'Broadcast-Address', 42: 'NTP', 43: 'Vendor-Option',
  44: 'Netbios-Name-Server', 50: 'Requested-IP', 51: 'Lease-Time', 53: 'DHCP-Message', 54: 'Server-ID',
  55: 'Parameter-Request', 56: 'Message', 57: 'Max-DHCP-Message', 58: 'RN', 59: 'RB', 60: 'Vendor-Class',
  61: 'Client-ID', 66: 'TFTP-Server-Name', 67: 'BF', 82: 'Relay-Agent-Information',
};

const MESSAGE_TYPES: Readonly<Record<number, string>> = {
  1: 'Discover', 2: 'Offer', 3: 'Request', 4: 'Decline', 5: 'ACK', 6: 'NACK', 7: 'Release', 8: 'Inform',
};

const ADDRESS_LIST = new Set([1, 3, 4, 6, 28, 42, 44, 50, 54]);
const TEXT = new Set([12, 15, 56, 60, 66, 67]);
const UINT32 = new Set([51, 58, 59]);

function address(bytes: readonly number[], at: number): string {
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

function mac(bytes: readonly number[], at: number, length: number): string {
  return bytes.slice(at, at + length).map(byte => byte.toString(16).padStart(2, '0')).join(':');
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
    chaddr: mac(bytes, 28, bytes[2] || 6), options,
  };
}

function optionValue(option: BootpOption): string {
  const { code, data } = option;
  if (code === 53) return MESSAGE_TYPES[data[0]] ?? String(data[0]);
  if (ADDRESS_LIST.has(code) && data.length % 4 === 0) {
    const list: string[] = [];
    for (let at = 0; at < data.length; at += 4) list.push(address(data, at));
    return list.join(',');
  }
  if (UINT32.has(code) && data.length === 4) return String(((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0);
  if ((code === 57 || code === 26) && data.length === 2) return String((data[0] << 8) | data[1]);
  if (code === 55) return data.map(item => OPTION_NAMES[item] ?? `Unknown (${item})`).join(', ');
  if (TEXT.has(code)) return `"${String.fromCharCode(...data)}"`;
  if (code === 61 && data.length === 7 && data[0] === 1) return `ether ${mac(data, 1, 6)}`;
  if (data.length === 0) return '';
  return `0x${data.map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function bootpText(info: BootpInfo, verbose: number, length: number): string {
  const op = info.op === 1 ? 'Request' : info.op === 2 ? 'Reply' : `unknown (0x${info.op.toString(16).padStart(2, '0')})`;
  const from = info.op === 1 && info.htype === 1 && info.hlen === 6 ? ` from ${info.chaddr}` : '';
  let line = `BOOTP/DHCP, ${op}${from}, length ${length}`;
  if (verbose === 0) return line;
  if (info.hops) line += `, hops ${info.hops}`;
  if (info.xid) line += `, xid 0x${info.xid.toString(16)}`;
  if (info.secs) line += `, secs ${info.secs}`;
  line += `, Flags [${info.flags & 0x8000 ? 'Broadcast' : 'none'}] (0x${info.flags.toString(16).padStart(4, '0')})`;
  const indent = '\n\t  ';
  if (info.ciaddr !== '0.0.0.0') line += `${indent}Client-IP ${info.ciaddr}`;
  if (info.yiaddr !== '0.0.0.0') line += `${indent}Your-IP ${info.yiaddr}`;
  if (info.siaddr !== '0.0.0.0') line += `${indent}Server-IP ${info.siaddr}`;
  if (info.giaddr !== '0.0.0.0') line += `${indent}Gateway-IP ${info.giaddr}`;
  if (info.htype === 1 && info.hlen === 6) line += `${indent}Client-Ethernet-Address ${info.chaddr}`;
  line += `${indent}Vendor-rfc1048 Extensions${indent}  Magic Cookie 0x63825363`;
  for (const option of info.options) {
    if (option.code === 255) { line += `${indent}  END (255)`; continue; }
    const name = OPTION_NAMES[option.code] ?? `Unknown`;
    line += `${indent}  ${name} (${option.code}), length ${option.data.length}: ${optionValue(option)}`;
  }
  return line;
}
