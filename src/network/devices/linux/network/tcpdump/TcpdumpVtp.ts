import { hexPrintLines, nullPaddedText } from './TcpdumpHex';

type AddressName = (address: string) => string;

const HEADER_BYTES = 36;
const DOMAIN_BYTES = 32;
const TIMESTAMP_BYTES = 12;
const VLAN_INFO_FIXED_BYTES = 12;
const INVALID = ' (invalid)';
const TRUNCATED = ' [|vtp]';
const UNKNOWN_DATA_INDENT = '\n\t\t  ';

const MESSAGE_TYPES: Readonly<Record<number, string>> = { 1: 'Summary advertisement', 2: 'Subset advertisement', 3: 'Advertisement request', 4: 'Join message' };
const HEADER_FIELDS: Readonly<Record<number, string>> = { 1: 'Followers', 2: 'Seq number', 3: 'Rsvd', 4: 'Rsvd' };
const VLAN_TYPES: Readonly<Record<number, string>> = { 1: 'Ethernet', 2: 'FDDI', 3: 'TrCRF', 4: 'FDDI-net', 5: 'TrBRF' };
const VLAN_STATUS: Readonly<Record<number, string>> = { 0: 'Operational', 1: 'Suspended' };
const STP_TYPES: Readonly<Record<number, string>> = { 1: 'SRT', 2: 'SRB', 3: 'Auto' };
const TLV_NAMES: Readonly<Record<number, string>> = {
  1: 'Source-Routing Ring Number TLV', 2: 'Source-Routing Bridge Number TLV', 3: 'STP type TLV', 4: 'Parent VLAN TLV',
  5: 'Translationally bridged VLANs TLV', 6: 'Pruning TLV', 7: 'Bridge Type TLV', 8: 'Max ARP Hop Count TLV',
  9: 'Max STE Hop Count TLV', 10: 'Backup CRF Mode TLV',
};

class Truncated extends Error {}
class Invalid extends Error {}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function u16(bytes: readonly number[], at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}

function u32(bytes: readonly number[], at: number): number {
  return ((u8(bytes, at) << 24) | (u8(bytes, at + 1) << 16) | (u8(bytes, at + 2) << 8) | u8(bytes, at + 3)) >>> 0;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function check(bytes: readonly number[], at: number, length: number): void {
  if (length > 0) u8(bytes, at + length - 1);
}

function dotted(bytes: readonly number[], at: number, name: AddressName): string {
  u8(bytes, at + 3);
  return name(`${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`);
}

function vlanTlvValue(type: number, value: number): string | null {
  if (type === 9) return `, ${value}`;
  if (type === 6) return `, ${value === 1 ? 'Enabled' : 'Disabled'} (${value})`;
  if (type === 3) return `, ${STP_TYPES[value] ?? 'Unknown'} (${value})`;
  if (type === 7) return `, ${value === 1 ? 'SRB' : 'SRT'} (${value})`;
  if (type === 10) return `, ${value === 1 ? 'Backup' : 'Not backup'} (${value})`;
  return null;
}

function vlanTlvs(bytes: readonly number[], start: number, remaining: number, emit: (text: string) => void): void {
  let at = start;
  let left = remaining;
  while (left > 0) {
    if (left < 2) throw new Invalid();
    const type = u8(bytes, at);
    const words = u8(bytes, at + 1);
    emit(`\n\t\t${TLV_NAMES[type] ?? 'Unknown'} (0x${hex(type, 4)}) TLV`);
    if (left < words * 2 + 2) {
      emit(' (TLV goes past the end of the packet)');
      throw new Invalid();
    }
    check(bytes, at, words * 2 + 2);
    if (words !== 1) {
      emit(` (invalid TLV length ${words} != 1)`);
      throw new Invalid();
    }
    const known = vlanTlvValue(type, u16(bytes, at + 2));
    emit(known ?? hexPrintLines(bytes.slice(at, at + 4), UNKNOWN_DATA_INDENT));
    left -= 2 + words * 2;
    at += 2 + words * 2;
  }
}

function vlanInfos(bytes: readonly number[], start: number, length: number, emit: (text: string) => void): void {
  let at = start;
  while (at < length) {
    let left = u8(bytes, at);
    if (left === 0) break;
    check(bytes, at, left);
    if (left < VLAN_INFO_FIXED_BYTES) throw new Invalid();
    emit(`\n\tVLAN info status ${VLAN_STATUS[u8(bytes, at + 1)] ?? 'Unknown'}, type ${VLAN_TYPES[u8(bytes, at + 2)] ?? 'Unknown'}, VLAN-id ${u16(bytes, at + 4)}, MTU ${u16(bytes, at + 6)}, SAID 0x${hex(u32(bytes, at + 8), 8)}, Name `);
    const nameLength = u8(bytes, at + 3);
    left -= VLAN_INFO_FIXED_BYTES;
    at += VLAN_INFO_FIXED_BYTES;
    const padded = 4 * Math.floor((nameLength + 3) / 4);
    if (left < padded) throw new Invalid();
    emit(nullPaddedText(bytes.slice(at, at + nameLength)));
    left -= padded;
    at += padded;
    vlanTlvs(bytes, at, left, emit);
    at += left;
  }
}

function print(bytes: readonly number[], length: number, verbose: number, name: AddressName, emit: (text: string) => void): void {
  if (length < HEADER_BYTES) throw new Invalid();
  check(bytes, 0, HEADER_BYTES);
  const type = u8(bytes, 1);
  emit(`VTPv${u8(bytes, 0)}, Message ${MESSAGE_TYPES[type] ?? 'Unknown message type'} (0x${hex(type, 2)}), length ${length}`);
  if (verbose < 1) {
    check(bytes, 0, length);
    return;
  }
  emit('\n\tDomain name: ');
  const domainLength = u8(bytes, 3);
  if (domainLength < 1 || domainLength > DOMAIN_BYTES) {
    emit(` [invalid MgmtD Len ${domainLength}]`);
    throw new Invalid();
  }
  emit(nullPaddedText(bytes.slice(4, 4 + domainLength)));
  emit(`, ${HEADER_FIELDS[type] ?? 'Unknown'}: ${u8(bytes, 2)}`);
  let at = HEADER_BYTES;
  if (type === 1) {
    emit(`\n\t  Config Rev ${u32(bytes, at).toString(16)}, Updater ${dotted(bytes, at + 4, name)}`);
    at += 8;
    emit(`, Timestamp 0x${hex(u32(bytes, at), 8)} 0x${hex(u32(bytes, at + 4), 8)} 0x${hex(u32(bytes, at + 8), 8)}`);
    at += TIMESTAMP_BYTES;
    emit(`, MD5 digest: ${[0, 4, 8, 12].map((offset) => hex(u32(bytes, at + offset), 8)).join('')}`);
  } else if (type === 2) {
    emit(`, Config Rev ${u32(bytes, at).toString(16)}`);
    vlanInfos(bytes, at + 4, length, emit);
  } else if (type === 3) {
    emit(`\n\tStart value: ${u32(bytes, at)}`);
  }
}

export function vtpText(bytes: readonly number[], length: number, verbose: number, name: AddressName): string {
  let text = '';
  try {
    print(bytes, length, verbose, name, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof Truncated) return text + TRUNCATED;
    if (error instanceof Invalid) {
      text += INVALID;
      return length > bytes.length ? text + TRUNCATED : text;
    }
    throw error;
  }
  return text;
}
