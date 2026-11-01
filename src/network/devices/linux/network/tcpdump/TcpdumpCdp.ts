import { hexPrintLines, printableByte } from './TcpdumpHex';

const HEADER_BYTES = 4;
const TLV_HEADER_BYTES = 4;
const DEVICE_ID = 0x01;
const MAX_TLV = 0x17;
const NLPID_IP = 0xcc;
const PROTOCOL_NLPID = 1;
const PROTOCOL_IEEE_802_2 = 2;

type Printer = (bytes: readonly number[], name: (address: string) => string) => string;

interface TlvInfo {
  readonly name: string;
  readonly printer: Printer | null;
  readonly minLength: number;
  readonly maxLength: number;
}

const CAPABILITIES: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'Router'], [0x02, 'Transparent Bridge'], [0x04, 'Source Route Bridge'], [0x08, 'L2 Switch'],
  [0x10, 'L3 capable'], [0x20, 'IGMP snooping'], [0x40, 'L1 capable'],
];

function u16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function characters(bytes: readonly number[]): string {
  return bytes.map(printableByte).join('');
}

const quoted: Printer = (bytes) => `'${characters(bytes)}'`;

const capability: Printer = (bytes) => {
  const value = u32(bytes, 0);
  const found = CAPABILITIES.filter(([bit]) => (value & bit) === bit).map(([, label]) => label);
  return `(0x${value.toString(16).padStart(8, '0')}): ${found.length === 0 ? 'none' : found.join(', ')}`;
};

const version: Printer = (bytes) => {
  let text = '\n\t  ';
  for (const byte of bytes) text += byte === 0x0a ? '\n\t  ' : printableByte(byte);
  return text;
};

const unsigned16: Printer = (bytes) => String(u16(bytes, 0));
const duplex: Printer = (bytes) => (bytes[0] !== 0 ? 'full' : 'half');
const mtu: Printer = (bytes) => `${u32(bytes, 0)} bytes`;
const hexByte: Printer = (bytes) => `0x${bytes[0].toString(16).padStart(2, '0')}`;

const power: Printer = (bytes) => {
  const value = bytes.length === 1 ? bytes[0] : bytes.length === 2 ? u16(bytes, 0) : (bytes[0] << 16) | u16(bytes, 1);
  return `${(value / 1000).toFixed(2)}W`;
};

const ata186: Printer = (bytes) => (bytes.length === 2
  ? `unknown 0x${u16(bytes, 0).toString(16).padStart(4, '0')}`
  : `app ${bytes[0]}, vlan ${u16(bytes, 1)}`);

const physicalLocation: Printer = (bytes) => {
  let text = `0x${bytes[0].toString(16).padStart(2, '0')}`;
  if (bytes.length > 1) text += `/${characters(bytes.slice(1))}`;
  return text;
};

const prefixes: Printer = (bytes) => {
  if (bytes.length % 5 !== 0) return ` [length ${bytes.length} is not a multiple of 5]`;
  let text = ` IPv4 Prefixes (${bytes.length / 5}):`;
  for (let at = 0; at < bytes.length; at += 5) text += ` ${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}/${bytes[at + 4]}`;
  return text;
};

const IPV6_SNAP = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x86, 0xdd];

function hex8(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function ipv6Text(bytes: readonly number[], at: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(u16(bytes, at + i).toString(16));
  return groups.join(':');
}

const addresses: Printer = (bytes, name) => {
  if (bytes.length < 4) return ' (not enough space for num)';
  let count = u32(bytes, 0);
  let at = 4;
  let left = bytes.length - 4;
  let text = '';
  while (count !== 0) {
    if (left < 2) return `${text} (not enough space for PT+PL)`;
    const protocolType = bytes[at];
    const protocolLength = bytes[at + 1];
    at += 2;
    left -= 2;
    if (left < protocolLength + 2) return `${text} (not enough space for P+AL)`;
    const addressLength = u16(bytes, at + protocolLength);
    if (protocolType === PROTOCOL_NLPID && protocolLength === 1 && bytes[at] === NLPID_IP && addressLength === 4) {
      at += protocolLength + 2;
      left -= protocolLength + 2;
      if (left < addressLength) return `${text} (not enough space for A)`;
      text += `IPv4 (${count}) ${name(`${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`)}`;
      at += addressLength;
      left -= addressLength;
    } else if (protocolType === PROTOCOL_IEEE_802_2 && protocolLength === 8
      && IPV6_SNAP.every((byte, index) => bytes[at + index] === byte) && addressLength === 16) {
      at += protocolLength + 2;
      left -= protocolLength + 2;
      if (left < addressLength) return `${text} (not enough space for A)`;
      text += `IPv6 (${count}) ${ipv6Text(bytes, at)}`;
      at += addressLength;
      left -= addressLength;
    } else {
      text += `pt=0x${hex8(protocolType)}, pl=${protocolLength}, pb=`;
      for (let i = 0; i < protocolLength; i++) text += ` ${hex8(bytes[at + i])}`;
      at += protocolLength + 2;
      left -= protocolLength + 2;
      text += `, al=${addressLength}, a=`;
      if (left < addressLength) return `${text} (not enough space for A)`;
      for (let i = 0; i < addressLength; i++) text += ` ${hex8(bytes[at + i])}`;
      at += addressLength;
      left -= addressLength;
    }
    count--;
    if (count !== 0) text += ' ';
  }
  return left !== 0 ? `${text} (${left} bytes of stray data)` : text;
};

const TLVS: Readonly<Record<number, TlvInfo>> = {
  0x01: { name: 'Device-ID', printer: quoted, minLength: -1, maxLength: -1 },
  0x02: { name: 'Address', printer: addresses, minLength: -1, maxLength: -1 },
  0x03: { name: 'Port-ID', printer: quoted, minLength: -1, maxLength: -1 },
  0x04: { name: 'Capability', printer: capability, minLength: 4, maxLength: 4 },
  0x05: { name: 'Version String', printer: version, minLength: -1, maxLength: -1 },
  0x06: { name: 'Platform', printer: quoted, minLength: -1, maxLength: -1 },
  0x07: { name: 'Prefixes', printer: prefixes, minLength: -1, maxLength: -1 },
  0x08: { name: 'Protocol-Hello option', printer: null, minLength: -1, maxLength: -1 },
  0x09: { name: 'VTP Management Domain', printer: quoted, minLength: -1, maxLength: -1 },
  0x0a: { name: 'Native VLAN ID', printer: unsigned16, minLength: 2, maxLength: 2 },
  0x0b: { name: 'Duplex', printer: duplex, minLength: 1, maxLength: 1 },
  0x0e: { name: 'ATA-186 VoIP VLAN assignment', printer: ata186, minLength: 3, maxLength: 3 },
  0x0f: { name: 'ATA-186 VoIP VLAN request', printer: ata186, minLength: 2, maxLength: 3 },
  0x10: { name: 'power consumption', printer: power, minLength: 1, maxLength: 3 },
  0x11: { name: 'MTU', printer: mtu, minLength: 4, maxLength: 4 },
  0x12: { name: 'AVVID trust bitmap', printer: hexByte, minLength: 1, maxLength: 1 },
  0x13: { name: 'AVVID untrusted ports CoS', printer: hexByte, minLength: 1, maxLength: 1 },
  0x14: { name: 'System Name', printer: quoted, minLength: -1, maxLength: -1 },
  0x15: { name: 'System Object ID (not decoded)', printer: null, minLength: -1, maxLength: -1 },
  0x16: { name: 'Management Addresses', printer: addresses, minLength: 4, maxLength: -1 },
  0x17: { name: 'Physical Location', printer: physicalLocation, minLength: 1, maxLength: -1 },
};

const INVALID = ' (invalid)';

export function cdpText(payload: readonly number[], verbose: number, name: (address: string) => string): string {
  const total = payload.length;
  if (total < HEADER_BYTES) return ` (packet length ${total} < ${HEADER_BYTES})${INVALID}`;
  let text = `CDPv${payload[0]}, ttl: ${payload[1]}s`;
  if (verbose > 0) text += `, checksum: 0x${u16(payload, 2).toString(16).padStart(4, '0')} (unverified), length ${total}`;
  let at = HEADER_BYTES;
  let left = total - HEADER_BYTES;
  while (left !== 0) {
    if (left < TLV_HEADER_BYTES) return `${text} (remaining packet length ${left} < ${TLV_HEADER_BYTES})${INVALID}`;
    const type = u16(payload, at);
    let length = u16(payload, at + 2);
    const info = type <= MAX_TLV ? TLVS[type] : undefined;
    const label = info?.name ?? 'unknown field type';
    if (length < TLV_HEADER_BYTES) {
      text += verbose > 0
        ? `\n\t${label} (0x${hex8(type)}), TLV length: ${length} byte${plural(length)} (too short)`
        : `, ${label} TLV length ${length} too short`;
      return text + INVALID;
    }
    if (length > left) return `${text} (TLV length ${length} > ${left})${INVALID}`;
    at += TLV_HEADER_BYTES;
    left -= TLV_HEADER_BYTES;
    length -= TLV_HEADER_BYTES;
    const value = payload.slice(at, at + length);
    if (verbose === 0 && type === DEVICE_ID) text += ', Device-ID ';
    else if (verbose > 0) text += `\n\t${label} (0x${hex8(type)}), value length: ${length} byte${plural(length)}: `;
    let covered = false;
    if (info !== undefined) {
      if ((info.minLength > 0 && length < info.minLength) || (info.maxLength > 0 && length > info.maxLength)) {
        text += ' (malformed TLV)';
      } else if (verbose > 0 || type === DEVICE_ID) {
        if (info.printer !== null) text += info.printer(value, name);
        covered = true;
      }
    }
    if (!covered) text += hexPrintLines(value, '\n\t  ');
    at += length;
    left -= length;
  }
  return verbose < 1 ? `${text}, length ${total}` : text;
}
