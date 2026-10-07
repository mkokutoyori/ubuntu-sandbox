import type { CipherSuite } from './types';
import type { KeyUpdate } from './messages';
import { encodeHandshakeMessage, decodeHandshakeMessage } from './messages';
import { deriveRecordKeys, sealRecord, openRecord } from './recordProtection';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from './recordLayer';

export function sealKeyUpdate(
  secret: string, suite: CipherSuite, sequenceBase: number, sequence: number, requestUpdate: boolean,
): readonly TlsRecord[] {
  const keyUpdate: KeyUpdate = { kind: 'key_update', requestUpdate };
  const keys = deriveRecordKeys(secret, suite);
  return fragmentAsRecords('handshake', encodeHandshakeMessage(keyUpdate), true)
    .map((record, index) => sealRecord(keys, sequenceBase + sequence + index, record));
}

export function openKeyUpdate(
  secret: string, suite: CipherSuite, sequenceBase: number, sequence: number, records: readonly TlsRecord[],
): KeyUpdate | null {
  const keys = deriveRecordKeys(secret, suite);
  const opened: TlsRecord[] = [];
  for (const [index, record] of records.entries()) {
    const plain = openRecord(keys, sequenceBase + sequence + index, record);
    if (plain === null) return null;
    opened.push(plain);
  }
  const { contentType, plaintext } = reassembleRecords(opened, true);
  if (contentType !== 'handshake') return null;
  const message = decodeHandshakeMessage(plaintext);
  return message.kind === 'key_update' ? message : null;
}
