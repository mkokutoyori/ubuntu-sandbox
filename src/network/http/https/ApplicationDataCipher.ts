/**
 * RFC 8446 §5.2/§5.3 — application-data protection, at the project's
 * established "simulated crypto" fidelity level: real record framing and
 * per-record sequence numbers, but the actual cipher is the deterministic
 * XOR keystream (`encryptBytes`/`decryptBytes`) already used by
 * `SimulatedTls.ts`/`EapTlsHandshake.ts`/QUIC's `packetProtection.ts` —
 * reused here rather than reimplemented, keyed by whichever direction's
 * traffic secret `TlsClientSession`/`TlsServerSession` expose publicly
 * (`clientApplicationTrafficSecret`/`serverApplicationTrafficSecret`,
 * PRD-TLS.md P9).
 */
import { encryptBytes, decryptBytes } from '@/network/dns/transport/SimulatedTls';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';

export interface EncryptedApplicationData {
  readonly records: TlsRecord[];
  /** Sequence number the peer must start decrypting from for its next receive. */
  readonly nextSeq: number;
}

/**
 * Wraps `plaintext` per §5.2 (content-type trailer via `fragmentAsRecords`'s
 * protected mode) then encrypts each resulting fragment independently,
 * consuming one sequence number per record.
 */
export function encryptApplicationData(trafficSecret: string, startSeq: number, plaintext: Uint8Array): EncryptedApplicationData {
  const records = fragmentAsRecords('application_data', plaintext, true);
  let seq = startSeq;
  const encrypted = records.map((record): TlsRecord => {
    const fragment = Uint8Array.from(encryptBytes(trafficSecret, seq, record.fragment));
    seq++;
    return { ...record, fragment };
  });
  return { records: encrypted, nextSeq: seq };
}

export interface DecryptedApplicationData {
  readonly plaintext: Uint8Array;
  readonly nextSeq: number;
}

/** Inverse of `encryptApplicationData`: decrypts each record then unwraps the §5.2 content-type trailer. */
export function decryptApplicationData(
  trafficSecret: string, startSeq: number, records: readonly TlsRecord[],
): DecryptedApplicationData {
  let seq = startSeq;
  const decrypted = records.map((record): TlsRecord => {
    const fragment = decryptBytes(trafficSecret, seq, [...record.fragment]);
    seq++;
    return { ...record, fragment };
  });
  const { plaintext } = reassembleRecords(decrypted, true);
  return { plaintext, nextSeq: seq };
}
