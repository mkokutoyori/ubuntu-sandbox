import { PCAP_LINK_TYPES } from './PcapLinkTypes';

export const PCAP_MAGIC = 0xa1b2c3d4;
export const PCAP_MAGIC_NANOSECOND = 0xa1b23c4d;
export const PCAP_MAGIC_KUZNETSOV = 0xa1b2cd34;
export const PCAP_VERSION_MAJOR = 2;
export const PCAP_VERSION_MINOR = 4;
export const PCAP_FILE_HEADER_BYTES = 24;
export const PCAP_RECORD_HEADER_BYTES = 16;
export const PCAP_MAXIMUM_SNAPLEN = 262144;

const PATCHED_RECORD_HEADER_BYTES = 24;
const LINK_TYPE_MASK = 0x03ffffff;
const LINK_TYPE_EXTENSION_MASK = 0xfc000000;
const ETHERNET_LINK_TYPE = 1;
const COOKED_ETHERNET_BYTES = 14;
const DG_UX_VERSION_MAJOR = 543;
const INT32_MAX = 0x7fffffff;
const LINK_TYPE_MAXIMUM_SNAPLEN: ReadonlyMap<number, number> = new Map([
  [231, 128 * 1024 * 1024],
  [279, 8 * 1024 * 1024],
  [249, 1024 * 1024],
]);

export interface PcapFileHeader {
  readonly bigEndian: boolean;
  readonly nanosecond: boolean;
  readonly patched: boolean;
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly thisZone: number;
  readonly sigfigs: number;
  readonly snaplen: number;
  readonly linkType: number;
  readonly linkTypeExtension: number;
}

export interface PcapRecord {
  readonly seconds: number;
  readonly subsecond: number;
  readonly capturedLength: number;
  readonly originalLength: number;
  readonly data: Uint8Array;
}

export type PcapRead =
  | { readonly kind: 'unreadable'; readonly message: string }
  | {
    readonly kind: 'file';
    readonly header: PcapFileHeader;
    readonly snapshot: number;
    readonly records: readonly PcapRecord[];
    readonly failure: string | null;
  };

export interface PcapWriteHeader {
  readonly linkType: number;
  readonly snaplen: number;
  readonly nanosecond: boolean;
}

export interface PcapWriteRecord {
  readonly seconds: number;
  readonly subsecond: number;
  readonly originalLength: number;
  readonly data: Uint8Array;
}

const NAMES_BY_LINK_TYPE: ReadonlyMap<number, string> = new Map(PCAP_LINK_TYPES.map(([linkType, name]) => [linkType, name]));
const DESCRIPTIONS_BY_LINK_TYPE: ReadonlyMap<number, string> = new Map(PCAP_LINK_TYPES.map(([linkType, , description]) => [linkType, description]));
const LINK_TYPES_BY_NAME: ReadonlyMap<string, number> = new Map(PCAP_LINK_TYPES.map(([linkType, name]) => [name, linkType]));

export function linkTypeName(linkType: number): string | null {
  return NAMES_BY_LINK_TYPE.get(linkType) ?? null;
}

export function linkTypeDescriptionOf(linkType: number): string | null {
  return DESCRIPTIONS_BY_LINK_TYPE.get(linkType) ?? null;
}

export function linkTypeNumber(name: string): number | null {
  return LINK_TYPES_BY_NAME.get(name) ?? null;
}

function maximumSnaplenFor(linkType: number): number {
  return LINK_TYPE_MAXIMUM_SNAPLEN.get(linkType) ?? PCAP_MAXIMUM_SNAPLEN;
}

function adjustedSnapshot(linkType: number, snaplen: number): number {
  return snaplen === 0 || snaplen > INT32_MAX ? maximumSnaplenFor(linkType) : snaplen;
}

function unreadable(message: string): PcapRead {
  return { kind: 'unreadable', message };
}

function recognisedMagic(value: number): boolean {
  return value === PCAP_MAGIC || value === PCAP_MAGIC_KUZNETSOV || value === PCAP_MAGIC_NANOSECOND;
}

function lengthsAreSwapped(major: number, minor: number): 'always' | 'maybe' | 'never' {
  if (major === 2) {
    if (minor < 3) return 'always';
    return minor === 3 ? 'maybe' : 'never';
  }
  return major === DG_UX_VERSION_MAJOR ? 'always' : 'never';
}

function readHeader(view: DataView): PcapRead | { readonly header: PcapFileHeader; readonly snapshot: number } {
  const first = view.getUint32(0, true);
  const bigEndian = !recognisedMagic(first);
  const magic = bigEndian ? view.getUint32(0, false) : first;
  if (!recognisedMagic(magic)) return unreadable('unknown file format');
  if (view.byteLength < PCAP_FILE_HEADER_BYTES) {
    return unreadable(`truncated dump file; tried to read ${PCAP_FILE_HEADER_BYTES} file header bytes, only got ${view.byteLength - 4}`);
  }
  const little = !bigEndian;
  const versionMajor = view.getUint16(4, little);
  const versionMinor = view.getUint16(6, little);
  if (versionMajor < PCAP_VERSION_MAJOR) return unreadable('archaic pcap savefile format');
  const supported = (versionMajor === PCAP_VERSION_MAJOR && versionMinor <= PCAP_VERSION_MINOR)
    || (versionMajor === DG_UX_VERSION_MAJOR && versionMinor === 0);
  if (!supported) return unreadable(`unsupported pcap savefile version ${versionMajor}.${versionMinor}`);
  const linkField = view.getUint32(20, little);
  const linkType = linkField & LINK_TYPE_MASK;
  const patched = magic === PCAP_MAGIC_KUZNETSOV;
  const header: PcapFileHeader = {
    bigEndian,
    nanosecond: magic === PCAP_MAGIC_NANOSECOND,
    patched,
    versionMajor,
    versionMinor,
    thisZone: view.getInt32(8, little),
    sigfigs: view.getUint32(12, little),
    snaplen: view.getUint32(16, little),
    linkType,
    linkTypeExtension: (linkField & LINK_TYPE_EXTENSION_MASK) >>> 0,
  };
  let snapshot = adjustedSnapshot(linkType, header.snaplen);
  if (patched && linkType === ETHERNET_LINK_TYPE) {
    snapshot = snapshot <= INT32_MAX - COOKED_ETHERNET_BYTES ? snapshot + COOKED_ETHERNET_BYTES : INT32_MAX;
  }
  return { header, snapshot };
}

export function decodePcap(bytes: Uint8Array): PcapRead {
  if (bytes.length < 4) {
    return unreadable(`truncated dump file; tried to read 4 file header bytes, only got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opened = readHeader(view);
  if ('kind' in opened) return opened;
  const { header, snapshot } = opened;
  const little = !header.bigEndian;
  const recordHeaderBytes = header.patched ? PATCHED_RECORD_HEADER_BYTES : PCAP_RECORD_HEADER_BYTES;
  const swapMode = lengthsAreSwapped(header.versionMajor, header.versionMinor);
  const maximum = maximumSnaplenFor(header.linkType);
  const records: PcapRecord[] = [];
  let at = PCAP_FILE_HEADER_BYTES;
  const fail = (failure: string): PcapRead => ({ kind: 'file', header, snapshot, records, failure });

  while (at < bytes.length) {
    const remaining = bytes.length - at;
    if (remaining < recordHeaderBytes) {
      return fail(`truncated dump file; tried to read ${recordHeaderBytes} header bytes, only got ${remaining}`);
    }
    const seconds = view.getInt32(at, little);
    const subsecond = view.getInt32(at + 4, little);
    let capturedLength = view.getUint32(at + 8, little);
    let originalLength = view.getUint32(at + 12, little);
    if (swapMode === 'always' || (swapMode === 'maybe' && capturedLength > originalLength)) {
      [capturedLength, originalLength] = [originalLength, capturedLength];
    }
    at += recordHeaderBytes;

    if (capturedLength > maximum) {
      return fail(capturedLength > snapshot
        ? `invalid packet capture length ${capturedLength}, bigger than snaplen of ${snapshot}`
        : `invalid packet capture length ${capturedLength}, bigger than maximum of ${maximum}`);
    }

    const available = bytes.length - at;
    if (capturedLength > snapshot) {
      if (available < snapshot) {
        return fail(`truncated dump file; tried to read ${snapshot} captured bytes, only got ${available}`);
      }
      if (available < capturedLength) {
        return fail(`truncated dump file; tried to read ${capturedLength} captured bytes, only got ${available}`);
      }
      records.push({ seconds, subsecond, capturedLength: snapshot, originalLength, data: bytes.subarray(at, at + snapshot) });
      at += capturedLength;
      continue;
    }
    if (available < capturedLength) {
      return fail(`truncated dump file; tried to read ${capturedLength} captured bytes, only got ${available}`);
    }
    records.push({ seconds, subsecond, capturedLength, originalLength, data: bytes.subarray(at, at + capturedLength) });
    at += capturedLength;
  }
  return { kind: 'file', header, snapshot, records, failure: null };
}

export function encodePcapHeader(header: PcapWriteHeader): Uint8Array {
  const bytes = new Uint8Array(PCAP_FILE_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.nanosecond ? PCAP_MAGIC_NANOSECOND : PCAP_MAGIC, true);
  view.setUint16(4, PCAP_VERSION_MAJOR, true);
  view.setUint16(6, PCAP_VERSION_MINOR, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, header.snaplen >>> 0, true);
  view.setUint32(20, header.linkType >>> 0, true);
  return bytes;
}

export function encodePcapRecord(record: PcapWriteRecord): Uint8Array {
  const bytes = new Uint8Array(PCAP_RECORD_HEADER_BYTES + record.data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, record.seconds >>> 0, true);
  view.setUint32(4, record.subsecond >>> 0, true);
  view.setUint32(8, record.data.length, true);
  view.setUint32(12, record.originalLength >>> 0, true);
  bytes.set(record.data, PCAP_RECORD_HEADER_BYTES);
  return bytes;
}

export function encodePcap(header: PcapWriteHeader, records: readonly PcapWriteRecord[]): Uint8Array {
  const parts = [encodePcapHeader(header), ...records.map(encodePcapRecord)];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

export function recordNanoseconds(header: PcapFileHeader, record: PcapRecord): number {
  return header.nanosecond ? record.subsecond : record.subsecond * 1000;
}
