import type { CaptureFrame } from './CaptureFrame';
import type { TcpdumpOptions } from './TcpdumpCli';
import { hexAndAsciiLines } from './TcpdumpHex';

export type BsdLinkType = 'NULL' | 'LOOP' | 'RAW';

export const BSD_AF_INET = 2;
export const BSD_AF_ISO = 7;
export const BSD_AF_APPLETALK = 16;
export const BSD_AF_IPX = 23;
const BSD_AF_INET6 = [24, 28, 30] as const;

const AF_NAMES: ReadonlyMap<number, string> = new Map([
  [BSD_AF_INET, 'IPv4'], [BSD_AF_ISO, 'ISO'], [BSD_AF_APPLETALK, 'Appletalk'], [BSD_AF_IPX, 'IPX'],
  ...BSD_AF_INET6.map((family): [number, string] => [family, 'IPv6']),
]);

const UNSUPPORTED_PRINTERS: ReadonlyMap<number, string> = new Map([
  [BSD_AF_ISO, 'OSI'], [BSD_AF_APPLETALK, 'AppleTalk'], [BSD_AF_IPX, 'IPX'],
]);

const FAMILY_HEADER_BYTES = 4;
const RAW_IP_VERSION_4 = 4;
const RAW_IP_VERSION_6 = 6;
const IPV4_ETHERTYPE = 0x0800;
const IPV6_ETHERTYPE = 0x86dd;
const UPPER_HALF = 0xffff0000;

export function isBsdLink(linkType: string): linkType is BsdLinkType {
  return linkType === 'NULL' || linkType === 'LOOP' || linkType === 'RAW';
}

export function bsdFamilyHeaderBytes(linkType: BsdLinkType): number {
  return linkType === 'RAW' ? 0 : FAMILY_HEADER_BYTES;
}

function swapped(value: number): number {
  return (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | (value >>> 24)) >>> 0;
}

export function bsdFamilyOf(linkType: 'NULL' | 'LOOP', header: Uint8Array): number {
  const big = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
  if (linkType === 'LOOP') return big;
  const hostOrder = swapped(big);
  return (hostOrder & UPPER_HALF) !== 0 ? big : hostOrder;
}

export function bsdEtherTypeOf(linkType: BsdLinkType, family: number, firstByte: number | null): number | null {
  if (linkType === 'RAW') {
    const version = firstByte === null ? null : firstByte >> 4;
    return version === RAW_IP_VERSION_4 ? IPV4_ETHERTYPE : version === RAW_IP_VERSION_6 ? IPV6_ETHERTYPE : null;
  }
  if (family === BSD_AF_INET) return IPV4_ETHERTYPE;
  return (BSD_AF_INET6 as readonly number[]).includes(family) ? IPV6_ETHERTYPE : null;
}

export function unsupportedBsdPrinter(family: number): string | null {
  return UNSUPPORTED_PRINTERS.get(family) ?? null;
}

export function bsdOriginalLength(frame: CaptureFrame): number {
  return frame.length - 14 + (frame.linkBytes?.length ?? 0);
}

function familyHeader(frame: CaptureFrame, opt: TcpdumpOptions): string {
  const family = frame.bsdFamily ?? 0;
  const name = AF_NAMES.get(family);
  const label = opt.quiet ? (name ?? `Unknown AF ${family}`) : `AF ${name ?? 'Unknown'} (${family})`;
  return `${label}, length ${bsdOriginalLength(frame)}: `;
}

export function bsdLinkPrefix(frame: CaptureFrame, opt: TcpdumpOptions): string {
  if (!opt.linkLevel) return '';
  return frame.linkType === 'RAW' ? 'ip: ' : familyHeader(frame, opt);
}

export function bsdUnknownLine(frame: CaptureFrame, opt: TcpdumpOptions): string {
  if (frame.linkType === 'RAW') return `${opt.linkLevel ? 'ip: ' : ''}unknown ip ${frame.rawIpVersion ?? 0}`;
  const header = familyHeader(frame, opt);
  const suppressed = opt.quiet || opt.hex === 'hex' || opt.hex === 'hexascii';
  if (suppressed) return header;
  return `${header}${hexAndAsciiLines(Array.from(frame.raw.slice(frame.rawLinkOffset)), '\n\t')}`;
}
