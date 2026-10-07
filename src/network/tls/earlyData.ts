import type { CipherSuite } from './types';
import type { Tls13Hash } from './hkdf';
import { extractSecret, expandLabel } from './keySchedule';
import { encodeHandshakeMessage, decodeHandshakeMessage } from './messages';
import { deriveRecordKeys, sealRecord, openRecord, type RecordKeys } from './recordProtection';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from './recordLayer';

export function earlyTrafficSecret(psk: string, clientHelloHash: string, hash: Tls13Hash): string {
  return expandLabel(extractSecret('', psk, hash), 'c e traffic', clientHelloHash, hash);
}

export function sealEarlyData(
  secret: string, suite: CipherSuite, plaintext: Uint8Array, startSequence: number,
): { readonly records: TlsRecord[]; readonly nextSequence: number } {
  const keys = deriveRecordKeys(secret, suite);
  let sequence = startSequence;
  const records = fragmentAsRecords('application_data', plaintext, true).map((record) => sealRecord(keys, sequence++, record));
  return { records, nextSequence: sequence };
}

export function sealEndOfEarlyData(secret: string, suite: CipherSuite, sequence: number): TlsRecord[] {
  const keys = deriveRecordKeys(secret, suite);
  const message = encodeHandshakeMessage({ kind: 'end_of_early_data' });
  return fragmentAsRecords('handshake', message, true).map((record, index) => sealRecord(keys, sequence + index, record));
}

export class EarlyDataReceiver {
  private readonly keys: RecordKeys;
  private sequence = 0;
  private data: Uint8Array = new Uint8Array(0);
  private ended = false;
  endOfEarlyDataRaw: Uint8Array | null = null;

  constructor(secret: string, suite: CipherSuite) {
    this.keys = deriveRecordKeys(secret, suite);
  }

  get plaintext(): Uint8Array {
    return this.data;
  }

  get finished(): boolean {
    return this.ended;
  }

  feed(records: readonly TlsRecord[]): TlsRecord[] {
    let index = 0;
    for (; index < records.length && !this.ended; index++) {
      const opened = openRecord(this.keys, this.sequence, records[index]);
      if (opened === null) break;
      this.sequence++;
      const inner = reassembleRecords([opened], true);
      if (inner.contentType === 'application_data') {
        const joined = new Uint8Array(this.data.length + inner.plaintext.length);
        joined.set(this.data); joined.set(inner.plaintext, this.data.length);
        this.data = joined;
      } else if (inner.contentType === 'handshake' && decodeHandshakeMessage(inner.plaintext).kind === 'end_of_early_data') {
        this.ended = true;
        this.endOfEarlyDataRaw = inner.plaintext;
      }
    }
    return records.slice(index);
  }
}
