/**
 * TLS 1.3 (RFC 8446 §5) record layer — fragmentation independent of the
 * handshake messages it carries, plus the record-type obfuscation §5.4
 * requires once protection is active (every protected outer record is
 * labeled `application_data`; the real content type travels inside the
 * — here simulated — encrypted payload as a one-byte trailer).
 */
import {
  type ContentType, CONTENT_TYPE_CODE, CONTENT_TYPE_FROM_CODE,
  MAX_TLS_RECORD_LENGTH, TLS_LEGACY_RECORD_VERSION,
} from './types';

export interface TlsRecord {
  readonly contentType: ContentType;
  readonly legacyVersion: number;
  readonly fragment: Uint8Array;
}

export interface InnerPlaintext {
  readonly content: Uint8Array;
  readonly contentType: ContentType;
}

/**
 * RFC 8446 §5.1 — splits `plaintext` into records whose fragment never
 * exceeds `maxFragmentSize` (default: the RFC's 2^14 ceiling). Independent
 * of whatever message(s) the plaintext encodes — a single handshake
 * message may span many records, or several messages may share one.
 */
export function fragmentPlaintext(
  contentType: ContentType,
  plaintext: Uint8Array,
  maxFragmentSize: number = MAX_TLS_RECORD_LENGTH,
): TlsRecord[] {
  if (plaintext.length === 0) {
    return [{ contentType, legacyVersion: TLS_LEGACY_RECORD_VERSION, fragment: plaintext }];
  }
  const records: TlsRecord[] = [];
  for (let offset = 0; offset < plaintext.length; offset += maxFragmentSize) {
    records.push({
      contentType,
      legacyVersion: TLS_LEGACY_RECORD_VERSION,
      fragment: plaintext.slice(offset, offset + maxFragmentSize),
    });
  }
  return records;
}

/** Inverse of `fragmentPlaintext`: concatenates fragments back into one buffer. */
export function reassembleFragments(records: readonly TlsRecord[]): { contentType: ContentType; plaintext: Uint8Array } {
  if (records.length === 0) throw new Error('reassembleFragments: no records to reassemble');
  const contentType = records[0].contentType;
  for (const record of records) {
    if (record.contentType !== contentType) {
      throw new Error('reassembleFragments: records with mixed content types cannot belong to the same message');
    }
  }
  const total = records.reduce((sum, r) => sum + r.fragment.length, 0);
  const plaintext = new Uint8Array(total);
  let offset = 0;
  for (const record of records) {
    plaintext.set(record.fragment, offset);
    offset += record.fragment.length;
  }
  return { contentType, plaintext };
}

/** RFC 8446 §5.2 `TLSInnerPlaintext` — content followed by its real type (padding omitted). */
export function encodeInnerPlaintext(inner: InnerPlaintext): Uint8Array {
  const out = new Uint8Array(inner.content.length + 1);
  out.set(inner.content, 0);
  out[inner.content.length] = CONTENT_TYPE_CODE[inner.contentType];
  return out;
}

export function decodeInnerPlaintext(bytes: Uint8Array): InnerPlaintext {
  let end = bytes.length - 1;
  while (end >= 0 && bytes[end] === 0) end--;
  if (end < 0) throw new Error('decodeInnerPlaintext: no content-type trailer (empty or all padding)');
  const contentType = CONTENT_TYPE_FROM_CODE[bytes[end]];
  if (!contentType) throw new Error(`decodeInnerPlaintext: unknown content-type code ${bytes[end]}`);
  return { content: bytes.slice(0, end), contentType };
}

/**
 * Combines fragmentation with the §5.4 obfuscation rule: before protection
 * is active (e.g. the initial ClientHello), records carry their real
 * content type. Once `protectedMode` is true, the real type is wrapped
 * into an `InnerPlaintext` and every outer record is labeled
 * `application_data` instead — real (simulated) encryption of the wrapped
 * bytes is layered on top by session/key-schedule code in later phases,
 * not by this module.
 */
export function fragmentAsRecords(
  contentType: ContentType,
  plaintext: Uint8Array,
  protectedMode: boolean,
  maxFragmentSize: number = MAX_TLS_RECORD_LENGTH,
): TlsRecord[] {
  if (!protectedMode) return fragmentPlaintext(contentType, plaintext, maxFragmentSize);
  return fragmentPlaintext(contentType, plaintext, maxFragmentSize).map((record) => ({
    contentType: 'application_data' as const,
    legacyVersion: record.legacyVersion,
    fragment: encodeInnerPlaintext({ content: record.fragment, contentType }),
  }));
}

export function reassembleRecords(
  records: readonly TlsRecord[],
  protectedMode: boolean,
): { contentType: ContentType; plaintext: Uint8Array } {
  if (!protectedMode) return reassembleFragments(records);
  if (records.length === 0) throw new Error('reassembleRecords: no records to reassemble');
  const inners = records.map((record) => {
    if (record.contentType !== 'application_data') {
      throw new Error('reassembleRecords: a protected record must be outwardly labeled application_data');
    }
    return decodeInnerPlaintext(record.fragment);
  });
  const contentType = inners[0].contentType;
  if (inners.some((inner) => inner.contentType !== contentType)) {
    throw new Error('reassembleRecords: records with mixed content types cannot belong to the same message');
  }
  const plaintext = new Uint8Array(inners.reduce((sum, inner) => sum + inner.content.length, 0));
  let offset = 0;
  for (const inner of inners) { plaintext.set(inner.content, offset); offset += inner.content.length; }
  return { contentType, plaintext };
}

/**
 * Splits a flight into its leading run of records still labeled
 * `leadingType` (e.g. the unprotected `ServerHello`) and everything after
 * (e.g. the protected `application_data`-obfuscated bundle that follows it
 * once protection is active) — lets a single flight carry both an
 * unprotected and a protected message without the receiver needing to know
 * message boundaries ahead of time.
 */
export function splitLeadingContentType(
  records: readonly TlsRecord[],
  leadingType: ContentType,
): { leading: TlsRecord[]; rest: TlsRecord[] } {
  let i = 0;
  while (i < records.length && records[i].contentType === leadingType) i++;
  return { leading: records.slice(0, i), rest: records.slice(i) };
}
