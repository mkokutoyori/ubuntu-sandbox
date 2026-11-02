import { FILE_LINK_TYPE_LABELS } from './PcapFileLabels';

const LABELS: ReadonlyMap<number, string> = new Map(FILE_LINK_TYPE_LABELS);
const LINK_TYPE_MASK = 0x03ffffff;

interface MagicKind {
  readonly littleEndian: boolean;
  readonly text: string;
  readonly masksLinkType: boolean;
}

const MAGICS: ReadonlyMap<number, MagicKind> = new Map([
  [0xa1b2c3d4, { littleEndian: false, text: 'microseconds ts (big-endian)', masksLinkType: false }],
  [0xd4c3b2a1, { littleEndian: true, text: 'microsecond ts (little-endian)', masksLinkType: true }],
  [0xa1b23c4d, { littleEndian: false, text: 'nanosecond ts (big-endian)', masksLinkType: false }],
  [0x4d3cb2a1, { littleEndian: true, text: 'nanosecond ts (little-endian)', masksLinkType: true }],
  [0xa1b2cd34, { littleEndian: false, text: 'microsecond ts, extensions (big-endian)', masksLinkType: false }],
  [0x34cdb2a1, { littleEndian: true, text: 'microsecond ts, extensions (little-endian)', masksLinkType: true }],
]);

export function describePcapFile(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = MAGICS.get(view.getUint32(0, false));
  if (kind === undefined) return null;
  const little = kind.littleEndian;
  let text = `pcap capture file, ${kind.text}`;
  if (bytes.length >= 6) text += ` - version ${view.getUint16(4, little)}`;
  if (bytes.length >= 8) text += `.${view.getUint16(6, little)}`;
  if (bytes.length >= 24) {
    const raw = view.getUint32(20, little);
    const linkType = kind.masksLinkType ? raw & LINK_TYPE_MASK : raw;
    text += ` (${LABELS.get(linkType) ?? `linktype#${linkType}`}`;
  }
  if (bytes.length >= 20) text += `, capture length ${view.getUint32(16, little)})`;
  return text;
}
