import type { NtpPacket, NtpMode, NtpLeapIndicator, NtpVersion, NtpExtensionField } from './types';
import { joinTimestamp, splitTimestamp, type NtpTimestamp } from './timestamp';

export const NTP_HEADER_BYTES = 48;
export const NTP_MIN_EXTENSION_BYTES = 16;
export const NTP_MIN_LAST_EXTENSION_BYTES = 28;
export const NTP_MAX_LEGACY_MAC_BYTES = 24;

const MODE_NUMBER: Record<NtpMode, number> = {
  'symmetric-active': 1,
  'symmetric-passive': 2,
  client: 3,
  server: 4,
  broadcast: 5,
};
const MODE_BY_NUMBER: Readonly<Record<number, NtpMode>> = {
  1: 'symmetric-active',
  2: 'symmetric-passive',
  3: 'client',
  4: 'server',
  5: 'broadcast',
};

export function ntpModeNumber(mode: NtpMode): number {
  return MODE_NUMBER[mode];
}

export function durationToShortFormat(ms: number): number {
  const value = Math.round((Math.max(0, ms) / 1000) * 0x10000);
  return Math.min(0xffffffff, value) >>> 0;
}

export function shortFormatToDuration(value: number): number {
  return (value / 0x10000) * 1000;
}

export function referenceIdentifierBytes(refIdentifier: string, stratum: number): Uint8Array {
  const out = new Uint8Array(4);
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(refIdentifier);
  if (dotted) {
    for (let i = 0; i < 4; i++) out[i] = parseInt(dotted[i + 1], 10) & 0xff;
    return out;
  }
  const text = refIdentifier.replace(/^\.|\.$/g, '');
  if (stratum >= 2 && !dotted && text.length > 0) return hashedReferenceIdentifier(text);
  for (let i = 0; i < 4; i++) out[i] = i < text.length ? text.charCodeAt(i) & 0xff : 0;
  return out;
}

function hashedReferenceIdentifier(text: string): Uint8Array {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return new Uint8Array([h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]);
}

export function referenceIdentifierText(bytes: Uint8Array, stratum: number): string {
  if (stratum >= 2) return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  let text = '';
  for (let i = 0; i < 4 && bytes[i] !== 0; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function writeTimestamp(view: DataView, position: number, timestamp: NtpTimestamp): void {
  const { seconds, fraction } = splitTimestamp(timestamp);
  view.setUint32(position, seconds);
  view.setUint32(position + 4, fraction);
}

export function encodeNtpHeader(packet: NtpPacket): Uint8Array {
  const out = new Uint8Array(NTP_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, ((packet.leapIndicator & 0x3) << 6) | ((packet.version & 0x7) << 3) | (MODE_NUMBER[packet.mode] & 0x7));
  view.setUint8(1, packet.stratum & 0xff);
  view.setUint8(2, packet.poll & 0xff);
  view.setInt8(3, packet.precision);
  view.setUint32(4, durationToShortFormat(packet.rootDelay));
  view.setUint32(8, durationToShortFormat(packet.rootDispersion));
  out.set(referenceIdentifierBytes(packet.refIdentifier ?? '', packet.stratum), 12);
  writeTimestamp(view, 16, packet.refTimestamp);
  writeTimestamp(view, 24, packet.origTimestamp);
  writeTimestamp(view, 32, packet.rxTimestamp);
  writeTimestamp(view, 40, packet.txTimestamp);
  return out;
}

export function encodeExtensionFields(fields: readonly NtpExtensionField[] | undefined): Uint8Array {
  if (!fields || fields.length === 0) return new Uint8Array(0);
  const parts = fields.map((field) => {
    const body = field.value;
    const padded = Math.max(NTP_MIN_EXTENSION_BYTES, 4 + Math.ceil(body.length / 4) * 4);
    const out = new Uint8Array(padded);
    const view = new DataView(out.buffer);
    view.setUint16(0, field.type);
    view.setUint16(2, padded);
    out.set(body, 4);
    return out;
  });
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.length; }
  return joined;
}

export function signedOctets(packet: NtpPacket): Uint8Array {
  const header = encodeNtpHeader(packet);
  const extensions = encodeExtensionFields(packet.extensions);
  const out = new Uint8Array(header.length + extensions.length);
  out.set(header, 0);
  out.set(extensions, header.length);
  return out;
}

export function encodeNtpPacket(packet: NtpPacket): Uint8Array {
  const signed = signedOctets(packet);
  if (packet.keyId === undefined) return signed;
  const digest = packet.mac ? hexToBytes(packet.mac) : new Uint8Array(0);
  const out = new Uint8Array(signed.length + 4 + digest.length);
  out.set(signed, 0);
  new DataView(out.buffer).setUint32(signed.length, packet.keyId >>> 0);
  out.set(digest, signed.length + 4);
  return out;
}

export type NtpDecodeFailure = 'short' | 'format' | 'version' | 'mode';

export type NtpDecodeResult =
  | { readonly ok: true; readonly packet: NtpPacket }
  | { readonly ok: false; readonly reason: NtpDecodeFailure };

function readTimestamp(view: DataView, position: number): NtpTimestamp {
  return joinTimestamp(view.getUint32(position), view.getUint32(position + 4));
}

export function decodeNtpPacket(bytes: Uint8Array): NtpDecodeResult {
  if (bytes.length < NTP_HEADER_BYTES) return { ok: false, reason: 'short' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = view.getUint8(0);
  const version = (first >> 3) & 0x7;
  if (version < 1 || version > 4) return { ok: false, reason: 'version' };
  const mode = MODE_BY_NUMBER[first & 0x7];
  if (mode === undefined) return { ok: false, reason: 'mode' };
  let position = NTP_HEADER_BYTES;
  const extensions: NtpExtensionField[] = [];
  if (version >= 4) {
    while (bytes.length - position >= NTP_MIN_LAST_EXTENSION_BYTES) {
      const length = view.getUint16(position + 2);
      if (length < NTP_MIN_EXTENSION_BYTES || length % 4 !== 0 || position + length > bytes.length) return { ok: false, reason: 'format' };
      extensions.push({ type: view.getUint16(position), value: bytes.slice(position + 4, position + length) });
      position += length;
    }
  }
  const remaining = bytes.length - position;
  let keyId: number | undefined;
  let mac: string | undefined;
  if (remaining === 4) {
    keyId = view.getUint32(position);
  } else if (remaining === 20 || remaining === 24 || remaining === 36) {
    keyId = view.getUint32(position);
    mac = bytesToHex(bytes.slice(position + 4, bytes.length));
  } else if (remaining !== 0) {
    return { ok: false, reason: 'format' };
  }
  const stratum = view.getUint8(1);
  const packet: NtpPacket = {
    type: 'ntp',
    leapIndicator: ((first >> 6) & 0x3) as NtpLeapIndicator,
    version: version as NtpVersion,
    mode,
    stratum,
    poll: view.getUint8(2),
    precision: view.getInt8(3),
    rootDelay: shortFormatToDuration(view.getUint32(4)),
    rootDispersion: shortFormatToDuration(view.getUint32(8)),
    refIdentifier: referenceIdentifierText(bytes.slice(12, 16), stratum),
    refTimestamp: readTimestamp(view, 16),
    origTimestamp: readTimestamp(view, 24),
    rxTimestamp: readTimestamp(view, 32),
    txTimestamp: readTimestamp(view, 40),
    signedBytes: bytes.slice(0, position),
  };
  if (extensions.length > 0) packet.extensions = extensions;
  if (keyId !== undefined) packet.keyId = keyId;
  if (mac !== undefined) packet.mac = mac;
  return { ok: true, packet };
}

export function isCryptoNak(packet: NtpPacket): boolean {
  return packet.keyId === 0 && packet.mac === undefined;
}

export function isKissOfDeath(packet: NtpPacket): boolean {
  return packet.leapIndicator === 3 && packet.stratum === 0;
}
