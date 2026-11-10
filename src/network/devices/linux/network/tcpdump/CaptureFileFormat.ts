import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import {
  decodePcap, encodePcapHeader, encodePcapRecord, linkTypeName, linkTypeNumber, type PcapRecord, type PcapWriteRecord,
} from '@/network/capture/pcap/PcapFile';
import { decodeCapturedBytes, type CaptureDirection, type CaptureFrame } from './CaptureFrame';
import {
  bsdEtherTypeOf, bsdFamilyHeaderBytes, bsdFamilyOf, bsdOriginalLength, isBsdLink, type BsdLinkType,
} from './TcpdumpBsdLink';
import {
  SLL2_HEADER_LENGTH, SLL_HEADER_LENGTH, cookedInterfacesOf, cookedLength, cookedRecordBytes, type CookedInterfaces,
} from './TcpdumpFormat';

export interface CapturedInterface {
  name: string;
  index: number;
  mac: string | null;
}

export interface CaptureFileHeader {
  linkType: string;
  snaplen: number;
  interfaces: readonly CapturedInterface[];
  nanosecond?: boolean;
}

export interface CaptureFile {
  header: CaptureFileHeader & { linkTypeNumber: number; linkTypeKnown: boolean; nanosecond: boolean };
  frames: CaptureFrame[];
  failure: string | null;
}

export type CaptureFileRead =
  | { kind: 'unreadable'; message: string }
  | { kind: 'file'; file: CaptureFile };

export interface CaptureFileContext {
  interfaces: readonly CapturedInterface[];
}

const DEFAULT_HEADER: CaptureFileHeader = { linkType: 'EN10MB', snaplen: 262144, interfaces: [] };
const ETHERNET_LINK_TYPE = 'EN10MB';
const ETHERNET_HEADER_BYTES = 14;
const COOKED_PACKET_TYPE = { host: 0, broadcast: 1, multicast: 2, otherHost: 3, outgoing: 4 } as const;
const BROADCAST_MAC = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const MULTICAST_MAC = [0x01, 0x00, 0x5e, 0x00, 0x00, 0x00];
const UNKNOWN_MAC = [0, 0, 0, 0, 0, 0];
const NO_ETHERTYPE = 0xffff;
const OTHER_HOST_MAC = [0x02, 0, 0, 0, 0, 0xff];

function micros(frame: CaptureFrame): number {
  return Math.floor(frame.atMicros ?? frame.at.getTime() * 1000);
}

function recordOf(frame: CaptureFrame, header: CaptureFileHeader, cooked: CookedInterfaces | null): PcapWriteRecord {
  const microsecond = micros(frame);
  const wholeMicros = frame.subsecondMicros ?? microsecond % 1_000_000;
  const subsecond = header.nanosecond === true ? wholeMicros * 1000 + (frame.atSubMicroNanos ?? 0) : wholeMicros;
  const bsd = isBsdLink(header.linkType);
  const bytes = bsd ? [...(frame.linkBytes ?? []), ...frame.raw.slice(frame.rawLinkOffset)]
    : cooked === null ? frame.raw : cookedRecordBytes(frame, cooked);
  const originalLength = bsd ? bsdOriginalLength(frame) : cooked === null ? frame.length : cookedLength(frame, cooked);
  const padded = bytes.length >= originalLength ? bytes : [...bytes, ...new Array<number>(originalLength - bytes.length).fill(0)];
  return {
    seconds: Math.floor(microsecond / 1_000_000),
    subsecond,
    originalLength,
    data: Uint8Array.from(padded.slice(0, header.snaplen)),
  };
}

export class CaptureFileBuffer {
  private text: string;
  private readonly cooked: CookedInterfaces | null;

  constructor(private readonly header: CaptureFileHeader = DEFAULT_HEADER) {
    this.cooked = cookedInterfacesOf(header.linkType, header.interfaces);
    this.text = bytesToFileText(encodePcapHeader({
      linkType: linkTypeNumber(header.linkType) ?? 1, snaplen: header.snaplen, nanosecond: header.nanosecond === true,
    }));
  }

  append(frame: CaptureFrame): void {
    this.text += bytesToFileText(encodePcapRecord(recordOf(frame, this.header, this.cooked)));
  }

  content(): string {
    return this.text;
  }
}

export function serializeCaptureFile(
  frames: readonly CaptureFrame[], header: CaptureFileHeader = DEFAULT_HEADER,
): string {
  const buffer = new CaptureFileBuffer(header);
  for (const frame of frames) buffer.append(frame);
  return buffer.content();
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

interface Instant {
  at: Date;
  atMicros: number;
  atSubMicroNanos: number;
  subsecondMicros?: number;
}

function instantOf(record: PcapRecord, nanosecond: boolean): Instant {
  const microsecond = Math.floor(nanosecond ? record.subsecond / 1000 : record.subsecond);
  const beyondSecond = microsecond >= 1_000_000;
  return {
    at: new Date(record.seconds * 1000 + (beyondSecond ? 0 : Math.floor(microsecond / 1000))),
    atMicros: record.seconds * 1_000_000 + (beyondSecond ? 0 : microsecond),
    atSubMicroNanos: nanosecond ? record.subsecond % 1000 : 0,
    ...(beyondSecond ? { subsecondMicros: microsecond } : {}),
  };
}

function stamped(frame: CaptureFrame | null, instant: Instant): CaptureFrame | null {
  if (frame !== null) {
    frame.atSubMicroNanos = instant.atSubMicroNanos;
    if (instant.subsecondMicros !== undefined) frame.subsecondMicros = instant.subsecondMicros;
  }
  return frame;
}

function truncatedLinkFrame(record: PcapRecord, instant: Instant): CaptureFrame {
  const frame = decodeCapturedBytes(new Uint8Array(ETHERNET_HEADER_BYTES), record.originalLength, '', 'in', instant.at, instant.atMicros)!;
  frame.raw = Array.from(record.data);
  frame.truncatedLink = true;
  return frame;
}

function cookedFrame(
  record: PcapRecord, version: 1 | 2, instant: Instant, context: CaptureFileContext,
): CaptureFrame | null {
  const headerBytes = version === 1 ? SLL_HEADER_LENGTH : SLL2_HEADER_LENGTH;
  if (record.data.length < headerBytes) return null;
  const data = record.data;
  const packetType = version === 1 ? u16(data, 0) : data[10];
  const addressLength = version === 1 ? u16(data, 4) : data[11];
  const addressAt = version === 1 ? 6 : 12;
  const protocol = version === 1 ? u16(data, 14) : u16(data, 0);
  const ifindex = version === 2 ? u32(data, 4) : undefined;
  const iface = ifindex === undefined ? '' : context.interfaces.find((entry) => entry.index === ifindex)?.name ?? '?';
  const own = context.interfaces.find((entry) => entry.name === iface)?.mac ?? null;
  const ownBytes = own === null ? UNKNOWN_MAC : own.split(':').map((part) => parseInt(part, 16));
  const destination = packetType === COOKED_PACKET_TYPE.broadcast ? BROADCAST_MAC
    : packetType === COOKED_PACKET_TYPE.multicast ? MULTICAST_MAC
      : packetType === COOKED_PACKET_TYPE.otherHost ? OTHER_HOST_MAC
        : packetType === COOKED_PACKET_TYPE.host ? ownBytes : UNKNOWN_MAC;
  const source = addressLength === 6 ? Array.from(data.subarray(addressAt, addressAt + 6)) : UNKNOWN_MAC;
  const ethernet = Uint8Array.from([...destination, ...source, protocol >> 8, protocol & 0xff, ...data.subarray(headerBytes)]);
  const direction: CaptureDirection = packetType === COOKED_PACKET_TYPE.outgoing ? 'out' : 'in';
  const frame = decodeCapturedBytes(
    ethernet, Math.max(ETHERNET_HEADER_BYTES, record.originalLength - headerBytes + ETHERNET_HEADER_BYTES),
    iface, direction, instant.at, instant.atMicros,
  );
  if (frame === null) return null;
  frame.linkType = version === 1 ? 'LINUX_SLL' : 'LINUX_SLL2';
  if (ifindex !== undefined) frame.ifindex = ifindex;
  return frame;
}

function loopbackFrame(record: PcapRecord, linkType: BsdLinkType, instant: Instant): CaptureFrame | null {
  const headerBytes = bsdFamilyHeaderBytes(linkType);
  if (record.data.length < headerBytes || (linkType === 'RAW' && record.data.length === 0)) {
    const cut = truncatedLinkFrame(record, instant);
    cut.linkType = linkType;
    cut.bsdFamily = 0;
    cut.linkBytes = [];
    cut.rawLinkOffset = 0;
    cut.length = record.originalLength + ETHERNET_HEADER_BYTES;
    return cut;
  }
  const family = linkType === 'RAW' ? 0 : bsdFamilyOf(linkType, record.data);
  const network = record.data.subarray(headerBytes);
  const etherType = bsdEtherTypeOf(linkType, family, network.length === 0 ? null : network[0]);
  const ethernet = Uint8Array.from([...UNKNOWN_MAC, ...UNKNOWN_MAC, (etherType ?? NO_ETHERTYPE) >> 8, (etherType ?? NO_ETHERTYPE) & 0xff, ...network]);
  const wireLength = Math.max(ETHERNET_HEADER_BYTES, record.originalLength - headerBytes + ETHERNET_HEADER_BYTES);
  const frame = decodeCapturedBytes(ethernet, wireLength, '', 'in', instant.at, instant.atMicros);
  if (frame === null) return null;
  frame.linkType = linkType;
  frame.bsdFamily = family;
  frame.linkBytes = Array.from(record.data.subarray(0, headerBytes));
  if (linkType === 'RAW' && etherType === null) frame.rawIpVersion = network[0] >> 4;
  return frame;
}

function invalidHeaderText(record: PcapRecord): string | null {
  const reasons: string[] = [];
  if (record.capturedLength === 0) reasons.push('caplen==0');
  if (record.originalLength === 0) reasons.push('len==0');
  else if (record.originalLength < record.capturedLength) reasons.push(`len(${record.originalLength}) < caplen(${record.capturedLength})`);
  return reasons.length === 0 ? null : `[Invalid header: ${reasons.join(', ')}]`;
}

function frameOf(
  record: PcapRecord, linkType: string | null, nanosecond: boolean, context: CaptureFileContext,
): CaptureFrame | null {
  const instant = instantOf(record, nanosecond);
  const invalid = invalidHeaderText(record);
  if (invalid !== null) {
    const stub = truncatedLinkFrame(record, instant);
    stub.invalidHeader = invalid;
    return stamped(stub, instant);
  }
  if (linkType === 'LINUX_SLL') return stamped(cookedFrame(record, 1, instant, context), instant);
  if (linkType === 'LINUX_SLL2') return stamped(cookedFrame(record, 2, instant, context), instant);
  if (linkType !== null && isBsdLink(linkType)) return stamped(loopbackFrame(record, linkType, instant), instant);
  if (linkType !== ETHERNET_LINK_TYPE) return null;
  return stamped(
    decodeCapturedBytes(record.data, record.originalLength, '', 'in', instant.at, instant.atMicros) ?? truncatedLinkFrame(record, instant),
    instant,
  );
}

const LEGACY_CAPTURE_FILE_FORMAT = 'ubuntu-sandbox-capture-v1';

interface LegacyCaptureFile extends Partial<CaptureFileHeader> {
  format: typeof LEGACY_CAPTURE_FILE_FORMAT;
  frames: readonly CaptureFrame[];
}

function legacyJsonCapture(content: string): CaptureFileRead | null {
  if (!content.startsWith('{')) return null;
  let parsed: Partial<LegacyCaptureFile> | null;
  try {
    parsed = JSON.parse(content) as Partial<LegacyCaptureFile> | null;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.format !== LEGACY_CAPTURE_FILE_FORMAT || !Array.isArray(parsed.frames)) return null;
  return {
    kind: 'file',
    file: {
      header: {
        linkType: parsed.linkType ?? DEFAULT_HEADER.linkType,
        snaplen: parsed.snaplen ?? DEFAULT_HEADER.snaplen,
        interfaces: parsed.interfaces ?? [],
        linkTypeNumber: linkTypeNumber(parsed.linkType ?? DEFAULT_HEADER.linkType) ?? 1,
        linkTypeKnown: true,
        nanosecond: false,
      },
      frames: parsed.frames.map((frame) => ({ ...frame, at: new Date(frame.at) })),
      failure: null,
    },
  };
}

export function deserializeCaptureFile(content: string, context: CaptureFileContext = { interfaces: [] }): CaptureFileRead {
  const legacy = legacyJsonCapture(content);
  if (legacy !== null) return legacy;
  const read = decodePcap(fileTextToBytes(content));
  if (read.kind === 'unreadable') return { kind: 'unreadable', message: read.message };
  const name = linkTypeName(read.header.linkType);
  const linkType = name ?? String(read.header.linkType);
  const frames: CaptureFrame[] = [];
  for (const record of read.records) {
    const frame = frameOf(record, name, read.header.nanosecond, context);
    if (frame !== null) frames.push(frame);
  }
  return {
    kind: 'file',
    file: {
      header: {
        linkType, snaplen: read.snapshot, interfaces: context.interfaces,
        linkTypeNumber: read.header.linkType, linkTypeKnown: name !== null, nanosecond: read.header.nanosecond,
      },
      frames,
      failure: read.failure,
    },
  };
}
