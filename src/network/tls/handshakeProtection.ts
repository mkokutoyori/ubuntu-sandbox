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
