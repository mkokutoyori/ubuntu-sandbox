/**
 * RFC 8446 §5.1 — byte-level wire serialization of a `TlsRecord`
 * (`src/network/tls/recordLayer.ts`), which today only models records as
 * structured JS objects (no `TLSPlaintext` framing exists anywhere in
 * `src/network/tls/`). Header layout: 1-byte `ContentType`, 2-byte
 * `legacy_record_version`, 2-byte big-endian `length`, then `length` bytes
 * of fragment — real framing, at the same simulated-crypto fidelity level
 * as the rest of the TLS/QUIC/HTTPS stack (the fragment bytes may already
 * be simulated ciphertext by the time they reach this module; this module
 * only ever deals in bytes, never encrypts/decrypts).
 */
import { CONTENT_TYPE_CODE, CONTENT_TYPE_FROM_CODE } from '@/network/tls/types';
import type { TlsRecord } from '@/network/tls/recordLayer';

const RECORD_HEADER_LENGTH = 5;
const MAX_FRAGMENT_LENGTH = 0xffff;

export function encodeRecord(record: TlsRecord): Uint8Array {
  const typeCode = CONTENT_TYPE_CODE[record.contentType];
  if (typeCode === undefined) throw new Error(`TlsRecordWire: unknown ContentType "${record.contentType}"`);
  if (record.fragment.length > MAX_FRAGMENT_LENGTH) {
    throw new Error(`TlsRecordWire: fragment length ${record.fragment.length} exceeds the 16-bit length field`);
  }
  const out = new Uint8Array(RECORD_HEADER_LENGTH + record.fragment.length);
  out[0] = typeCode;
  out[1] = (record.legacyVersion >> 8) & 0xff;
  out[2] = record.legacyVersion & 0xff;
  out[3] = (record.fragment.length >> 8) & 0xff;
  out[4] = record.fragment.length & 0xff;
  out.set(record.fragment, RECORD_HEADER_LENGTH);
  return out;
}

/** Concatenates the wire encoding of a whole flight (e.g. a ClientHello + subsequent protected records). */
export function encodeRecords(records: readonly TlsRecord[]): Uint8Array {
  const encoded = records.map(encodeRecord);
  const total = encoded.reduce((sum, e) => sum + e.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const e of encoded) {
    out.set(e, offset);
    offset += e.length;
  }
  return out;
}

export function decodeRecord(bytes: Uint8Array, offset: number): { record: TlsRecord; bytesConsumed: number } {
  if (bytes.length - offset < RECORD_HEADER_LENGTH) throw new Error('TlsRecordWire: truncated record header');
  const typeCode = bytes[offset];
  const contentType = CONTENT_TYPE_FROM_CODE[typeCode];
  if (!contentType) throw new Error(`TlsRecordWire: unknown ContentType code ${typeCode}`);
  const legacyVersion = (bytes[offset + 1] << 8) | bytes[offset + 2];
  const length = (bytes[offset + 3] << 8) | bytes[offset + 4];
  if (bytes.length - offset - RECORD_HEADER_LENGTH < length) throw new Error('TlsRecordWire: truncated record fragment');
  const fragment = bytes.slice(offset + RECORD_HEADER_LENGTH, offset + RECORD_HEADER_LENGTH + length);
  return { record: { contentType, legacyVersion, fragment }, bytesConsumed: RECORD_HEADER_LENGTH + length };
}

/** Splits a byte buffer carrying a whole flight back into its individual records. */
export function decodeRecords(bytes: Uint8Array): TlsRecord[] {
  const records: TlsRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const { record, bytesConsumed } = decodeRecord(bytes, offset);
    records.push(record);
    offset += bytesConsumed;
  }
  return records;
}

export interface TlsHandshakeSocket {
  onData(handler: (data: unknown) => void): () => void;
  write(data: string): unknown;
}

export interface TlsHandshakeDriver {
  start(): readonly TlsRecord[];
  handle(records: readonly TlsRecord[]): readonly TlsRecord[] | null;
  readonly result: 'success' | 'failure' | null;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export function runTlsHandshakeOverSocket(
  socket: TlsHandshakeSocket, tls: TlsHandshakeDriver,
): void {
  const unsubscribe = socket.onData((data) => {
    if (tls.result !== null) return;
    const incoming = decodeRecords(binaryStringToBytes(String(data)));
    const nextFlight = tls.handle(incoming);
    if (nextFlight && nextFlight.length > 0) {
      socket.write(bytesToBinaryString(encodeRecords(nextFlight)));
    }
  });
  const firstFlight = tls.start();
  socket.write(bytesToBinaryString(encodeRecords(firstFlight)));
  unsubscribe();
}
