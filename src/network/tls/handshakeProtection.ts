import { deriveRecordKeys, sealRecord, openRecord } from './recordProtection';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from './recordLayer';
import type { CipherSuite } from './types';

export interface SealedFlight {
  readonly records: TlsRecord[];
  readonly nextSeq: number;
}

export interface OpenedFlight {
  readonly contentType: ReturnType<typeof reassembleRecords>['contentType'];
  readonly plaintext: Uint8Array;
  readonly nextSeq: number;
}

export function sealFlight(
  secret: string, suite: CipherSuite, startSeq: number, plaintext: Uint8Array, maxFragment?: number,
): SealedFlight {
  const keys = deriveRecordKeys(secret, suite);
  let seq = startSeq;
  const records = fragmentAsRecords('handshake', plaintext, true, maxFragment).map((record) => sealRecord(keys, seq++, record));
  return { records, nextSeq: seq };
}

export function isChangeCipherSpecRecord(record: TlsRecord): boolean {
  return record.contentType === 'change_cipher_spec' && record.fragment.length === 1 && record.fragment[0] === 1;
}

export function withoutChangeCipherSpec(records: readonly TlsRecord[]): TlsRecord[] {
  return records.filter((record) => !isChangeCipherSpecRecord(record));
}

export function openFlight(
  secret: string, suite: CipherSuite, startSeq: number, records: readonly TlsRecord[],
): OpenedFlight | null {
  const keys = deriveRecordKeys(secret, suite);
  let seq = startSeq;
  const opened: TlsRecord[] = [];
  for (const record of records) {
    const plain = openRecord(keys, seq++, record);
    if (plain === null) return null;
    opened.push(plain);
  }
  const { contentType, plaintext } = reassembleRecords(opened, true);
  return { contentType, plaintext, nextSeq: seq };
}

export const COMPATIBILITY_CHANGE_CIPHER_SPEC: TlsRecord = {
  contentType: 'change_cipher_spec', legacyVersion: 0x0303, fragment: Uint8Array.of(1),
};

export interface LeadingHandshake {
  readonly plaintext: Uint8Array;
  readonly consumed: number;
}

export function openLeadingHandshake(
  secret: string, suite: CipherSuite, startSeq: number, records: readonly TlsRecord[],
): LeadingHandshake | null {
  const keys = deriveRecordKeys(secret, suite);
  const parts: Uint8Array[] = [];
  for (let index = 0; index < records.length; index++) {
    const plain = openRecord(keys, startSeq + index, records[index]);
    if (plain === null) return index === 0 ? null : { plaintext: concatParts(parts), consumed: index };
    const { contentType, plaintext } = reassembleRecords([{ ...plain, contentType: 'application_data' }], true);
    if (contentType !== 'handshake') return index === 0 ? null : { plaintext: concatParts(parts), consumed: index };
    parts.push(plaintext);
  }
  return { plaintext: concatParts(parts), consumed: records.length };
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
