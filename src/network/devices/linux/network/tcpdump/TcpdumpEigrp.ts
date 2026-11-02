import { hexPrintLines } from './TcpdumpHex';

type AddressName = (address: string) => string;

const HEADER_BYTES = 20;
const TLV_HEADER_BYTES = 4;
const SUPPORTED_VERSION = 2;
const TRUNCATED = ' [|eigrp]';
const TLV_INDENT = '\n\t    ';

const OPCODES: Readonly<Record<number, string>> = { 1: 'Update', 3: 'Query', 4: 'Reply', 5: 'Hello', 6: 'IPX SAP', 7: 'Probe' };

const HEADER_FLAGS: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'Init'], [0x02, 'Conditionally Received'], [0x04, 'Restart'], [0x08, 'End-of-Table'],
];

const TLV_NAMES: Readonly<Record<number, string>> = {
  0x0001: 'General Parameters', 0x0002: 'Authentication', 0x0003: 'Sequence', 0x0004: 'Software Version',
  0x0005: 'Next Multicast Sequence', 0x0102: 'IP Internal routes', 0x0103: 'IP External routes',
  0x0202: 'AppleTalk Internal routes', 0x0203: 'AppleTalk External routes', 0x0204: 'AppleTalk Cable setup',
  0x0302: 'IPX Internal routes', 0x0303: 'IPX External routes',
};

const EXTERNAL_PROTOCOLS: Readonly<Record<number, string>> = {
  1: 'IGRP', 2: 'EIGRP', 3: 'Static', 4: 'RIP', 5: 'Hello', 6: 'OSPF', 7: 'IS-IS', 8: 'EGP', 9: 'BGP', 10: 'IDRP', 11: 'Connected',
};

const GENERAL_PARAMETER_BYTES = 8;
const SOFTWARE_VERSION_BYTES = 4;
const IP_INTERNAL_FIXED_BYTES = 22;
const IP_EXTERNAL_FIXED_BYTES = 42;

class Truncated extends Error {}

function u16(bytes: readonly number[], at: number): number {
  if (at + 1 >= bytes.length) throw new Truncated();
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: readonly number[], at: number): number {
  if (at + 3 >= bytes.length) throw new Truncated();
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function u24(bytes: readonly number[], at: number): number {
  if (at + 2 >= bytes.length) throw new Truncated();
  return (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function dotted(bytes: readonly number[], at: number): string {
  u8(bytes, at + 3);
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

function flagNames(flags: number): string {
  const found = HEADER_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
  return found.length === 0 ? 'none' : found.join(', ');
}

function vector(bytes: readonly number[], at: number): string {
  return `\n\t      delay ${Math.floor(u32(bytes, at) / 100)} ms, bandwidth ${u32(bytes, at + 4)} Kbps, mtu ${u24(bytes, at + 8)}, hop ${u8(bytes, at + 11)}, reliability ${u8(bytes, at + 12)}, load ${u8(bytes, at + 13)}`;
}

function prefixText(bytes: readonly number[], at: number, name: AddressName): string | null {
  const bits = u8(bytes, at);
  if (bits > 32) return null;
  const octets = [0, 0, 0, 0];
  for (let i = 0; i < Math.ceil(bits / 8); i++) octets[i] = u8(bytes, at + 1 + i);
  return `${name(octets.join('.')).padStart(15, ' ')}/${bits}`;
}

function nexthopText(bytes: readonly number[], at: number, name: AddressName): string {
  return u32(bytes, at) === 0 ? 'self' : name(dotted(bytes, at));
}

function tlvBody(type: number, bytes: readonly number[], at: number, length: number, name: AddressName): string {
  const valueLength = length - TLV_HEADER_BYTES;
  const start = at + TLV_HEADER_BYTES;
  const tooShort = (needed: number): string => ` (too short, < ${TLV_HEADER_BYTES + needed})`;
  if (type === 0x0001) {
    if (valueLength < GENERAL_PARAMETER_BYTES) return tooShort(GENERAL_PARAMETER_BYTES);
    return `\n\t    holdtime: ${u16(bytes, start + 6)}s, k1 ${u8(bytes, start)}, k2 ${u8(bytes, start + 1)}, k3 ${u8(bytes, start + 2)}, k4 ${u8(bytes, start + 3)}, k5 ${u8(bytes, start + 4)}`;
  }
  if (type === 0x0004) {
    if (valueLength < SOFTWARE_VERSION_BYTES) return tooShort(SOFTWARE_VERSION_BYTES);
    return `\n\t    IOS version: ${u8(bytes, start)}.${u8(bytes, start + 1)}, EIGRP version ${u8(bytes, start + 2)}.${u8(bytes, start + 3)}`;
  }
  if (type === 0x0102) {
    if (valueLength < IP_INTERNAL_FIXED_BYTES) return tooShort(IP_INTERNAL_FIXED_BYTES);
    const prefix = prefixText(bytes, start + 20, name);
    if (prefix === null) return `\n\t    illegal prefix length ${u8(bytes, start + 20)}`;
    return `\n\t    IPv4 prefix: ${prefix}, nexthop: ${nexthopText(bytes, start, name)}${vector(bytes, start + 4)}`;
  }
  if (type === 0x0103) {
    if (valueLength < IP_EXTERNAL_FIXED_BYTES) return tooShort(IP_EXTERNAL_FIXED_BYTES);
    const prefix = prefixText(bytes, start + 40, name);
    if (prefix === null) return `\n\t    illegal prefix length ${u8(bytes, start + 40)}`;
    return `\n\t    IPv4 prefix: ${prefix}, nexthop: ${nexthopText(bytes, start, name)}`
      + `\n\t      origin-router ${name(dotted(bytes, start + 4))}, origin-as ${u32(bytes, start + 8)}, origin-proto ${EXTERNAL_PROTOCOLS[u8(bytes, start + 22)] ?? 'unknown'}, flags [0x${hex(u8(bytes, start + 23), 2)}], tag 0x${hex(u32(bytes, start + 12), 8)}, metric ${u32(bytes, start + 16)}`
      + vector(bytes, start + 24);
  }
  return '';
}

function unknownData(bytes: readonly number[], at: number, length: number): string {
  const available = Math.max(0, Math.min(length, bytes.length - at));
  return hexPrintLines(bytes.slice(at, at + available), TLV_INDENT);
}

function print(bytes: readonly number[], length: number, verbose: number, name: AddressName): string {
  const version = u8(bytes, 0);
  if (version !== SUPPORTED_VERSION) return `EIGRP version ${version} packet not supported`;
  const opcode = u8(bytes, 1);
  const opcodeName = OPCODES[opcode];
  if (verbose < 1) return `EIGRP ${opcodeName ?? `unknown (${opcode})`}, length: ${length}`;
  if (length < HEADER_BYTES) return `EIGRP ${opcodeName ?? `unknown (${opcode})`}, length: ${length} (too short, < ${HEADER_BYTES})`;
  let remaining = length - HEADER_BYTES;
  let text = `\n\tEIGRP v${version}, opcode: ${opcodeName ?? `unknown, type: ${opcode}`} (${opcode}), chksum: 0x${hex(u16(bytes, 2), 4)}, Flags: [${flagNames(u32(bytes, 4))}]`
    + `\n\tseq: 0x${hex(u32(bytes, 8), 8)}, ack: 0x${hex(u32(bytes, 12), 8)}, VRID: ${u16(bytes, 16)}, AS: ${u16(bytes, 18)}, length: ${remaining}`;
  let at = HEADER_BYTES;
  while (remaining > 0) {
    u16(bytes, at + 2);
    const tlvLength = u16(bytes, at + 2);
    const type = u16(bytes, at);
    if (tlvLength < TLV_HEADER_BYTES || tlvLength > remaining) return text + unknownData(bytes, at + TLV_HEADER_BYTES, remaining);
    text += `\n\t  ${TLV_NAMES[type] ?? 'Unknown'} TLV (0x${hex(type, 4)}), length: ${tlvLength}`;
    u8(bytes, at + tlvLength - 1);
    const body = tlvBody(type, bytes, at, tlvLength, name);
    const decoded = [0x0001, 0x0004, 0x0102, 0x0103].includes(type);
    if (decoded) text += body;
    else if (verbose <= 1) text += unknownData(bytes, at + TLV_HEADER_BYTES, tlvLength - TLV_HEADER_BYTES);
    if (verbose > 1) text += unknownData(bytes, at + TLV_HEADER_BYTES, tlvLength - TLV_HEADER_BYTES);
    at += tlvLength;
    remaining -= tlvLength;
  }
  return text;
}

export function eigrpText(payload: readonly number[], length: number, verbose: number, name: AddressName): string {
  try {
    return print(payload, length, verbose, name);
  } catch (error) {
    if (error instanceof Truncated) return TRUNCATED;
    throw error;
  }
}
