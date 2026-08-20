import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { extractSecret, expandLabel } from '@/network/tls/keySchedule';
import { CONTENT_TYPE_CODE, CONTENT_TYPE_FROM_CODE } from '@/network/tls/types';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { bytesToHex, type PacketProtectionKeys, type PacketNumberSpace } from './types';

// RFC 9001 §5.2 — the Initial salt is a per-QUIC-version constant (not a
// per-connection secret), used only to derive Initial packet protection
// keys from the client's chosen destination connection ID. This is the
// registered salt for QUIC version 1.
const INITIAL_SALT_V1 = '38762cf7f55934b34d179ae6a4c80cadccbb7f0a';

export interface InitialSecrets {
  readonly client: string;
  readonly server: string;
}

/** RFC 9001 §5.2 — both endpoints derive the same pair of Initial secrets from the salt and the client's first destination connection ID. */
export function deriveInitialSecrets(clientDestConnectionId: string): InitialSecrets {
  const initialSecret = extractSecret(INITIAL_SALT_V1, clientDestConnectionId);
  return {
    client: expandLabel(initialSecret, 'client in', ''),
    server: expandLabel(initialSecret, 'server in', ''),
  };
}

/**
 * RFC 9001 §5.1 — per packet-number-space protection keys, derived from
 * whichever traffic secret applies to that space and direction (Initial
 * secrets above for the Initial space; `TlsClientSession`/
 * `TlsServerSession`'s `client/serverHandshakeTrafficSecret` for the
 * Handshake space; `client/serverApplicationTrafficSecret` for the
 * 1-RTT/application space) — this function is the *only* place in
 * `src/network/quic/` that imports from `src/network/tls/`.
 */
export function deriveQuicKeys(space: PacketNumberSpace, trafficSecret: string): PacketProtectionKeys {
  return {
    space,
    key: expandLabel(trafficSecret, 'quic key', ''),
    iv: expandLabel(trafficSecret, 'quic iv', ''),
    headerProtectionKey: expandLabel(trafficSecret, 'quic hp', ''),
  };
}

// RFC 9000 §5.1/§5.4 (simulated) — body encryption reuses the project's
// established "simulated crypto" convention (SimulatedTls.ts,
// EapTlsHandshake.ts): an XOR keystream, not real AEAD. Header protection
// is modeled as a genuinely separate operation, as the RFC requires —
// not a single blanket encryption of the whole packet.
function bodyKeystreamByte(keys: PacketProtectionKeys, packetNumber: number, index: number): number {
  const combined = keys.key + keys.iv;
  const position = packetNumber * 7 + index;
  return (combined.charCodeAt(position % combined.length) + position) & 0xff;
}

export function protectBody(keys: PacketProtectionKeys, packetNumber: number, plaintext: Uint8Array): Uint8Array {
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) out[i] = plaintext[i] ^ bodyKeystreamByte(keys, packetNumber, i);
  return out;
}

export function unprotectBody(keys: PacketProtectionKeys, packetNumber: number, ciphertext: Uint8Array): Uint8Array {
  // XOR is self-inverse.
  return protectBody(keys, packetNumber, ciphertext);
}

/** Derives the 5-byte header protection mask from a sample of the (already-encrypted) body, per RFC 9000 §5.4.1. */
export function computeHeaderProtectionMask(keys: PacketProtectionKeys, sample: Uint8Array): Uint8Array {
  const digest = simulatedDigest(keys.headerProtectionKey + bytesToHex(sample));
  const mask = new Uint8Array(5);
  for (let i = 0; i < 5; i++) mask[i] = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  return mask;
}

export interface ProtectedHeader {
  maskedFirstByte: number;
  maskedPacketNumber: Uint8Array;
}

/**
 * Applies the header protection mask to the first byte's low bits (the
 * packet-number-length/reserved bits, §5.4.1) and to the packet number
 * bytes — deliberately independent of `protectBody`/`unprotectBody`: this
 * operation only needs a sample of the ciphertext, never the plaintext
 * or the body key itself, so it succeeds or fails without touching body
 * decryption at all (RFC 9000 §5.4, PRD-QUIC.md §6.3).
 */
export function protectHeader(keys: PacketProtectionKeys, firstByte: number, packetNumber: Uint8Array, sample: Uint8Array): ProtectedHeader {
  const mask = computeHeaderProtectionMask(keys, sample);
  const maskedFirstByte = firstByte ^ (mask[0] & 0x0f);
  const maskedPacketNumber = new Uint8Array(packetNumber.length);
  for (let i = 0; i < packetNumber.length; i++) maskedPacketNumber[i] = packetNumber[i] ^ mask[1 + i];
  return { maskedFirstByte, maskedPacketNumber };
}

export function unprotectHeader(keys: PacketProtectionKeys, maskedFirstByte: number, maskedPacketNumber: Uint8Array, sample: Uint8Array): ProtectedHeader {
  // XOR is self-inverse — same transform, named for the receive-side call site.
  const { maskedFirstByte: firstByte, maskedPacketNumber: packetNumber } = protectHeader(keys, maskedFirstByte, maskedPacketNumber, sample);
  return { maskedFirstByte: firstByte, maskedPacketNumber: packetNumber };
}

const CRYPTO_RECORD_HEADER_LENGTH = 5;

/**
 * RFC 9000 §19.6 / RFC 9001 §4 — a connection's CRYPTO stream carries the
 * TLS handshake byte stream, i.e. a sequence of RFC 8446 §5.1 TLS records.
 * This is the byte-level wire encoding `QuicConnection.ts` uses to place a
 * `TlsClientSession`/`TlsServerSession` flight into CRYPTO frame data
 * (same 5-byte record header as HTTP's own `TlsRecordWire.ts`, kept as a
 * separate, local copy rather than a cross-PRD import — each transport
 * owns its own adapter to the shared TLS engine).
 */
export function encodeTlsRecordsForCrypto(records: readonly TlsRecord[]): Uint8Array {
  const encoded = records.map((record) => {
    const typeCode = CONTENT_TYPE_CODE[record.contentType];
    const out = new Uint8Array(CRYPTO_RECORD_HEADER_LENGTH + record.fragment.length);
    out[0] = typeCode;
    out[1] = (record.legacyVersion >> 8) & 0xff;
    out[2] = record.legacyVersion & 0xff;
    out[3] = (record.fragment.length >> 8) & 0xff;
    out[4] = record.fragment.length & 0xff;
    out.set(record.fragment, CRYPTO_RECORD_HEADER_LENGTH);
    return out;
  });
  const total = encoded.reduce((sum, e) => sum + e.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const e of encoded) {
    out.set(e, offset);
    offset += e.length;
  }
  return out;
}

/** Inverse of `encodeTlsRecordsForCrypto` — decodes every complete record found in `bytes`. */
export function decodeTlsRecordsFromCrypto(bytes: Uint8Array): TlsRecord[] {
  const records: TlsRecord[] = [];
  let offset = 0;
  while (offset + CRYPTO_RECORD_HEADER_LENGTH <= bytes.length) {
    const typeCode = bytes[offset];
    const contentType = CONTENT_TYPE_FROM_CODE[typeCode];
    if (!contentType) break;
    const legacyVersion = (bytes[offset + 1] << 8) | bytes[offset + 2];
    const length = (bytes[offset + 3] << 8) | bytes[offset + 4];
    if (bytes.length < offset + CRYPTO_RECORD_HEADER_LENGTH + length) break;
    const fragment = bytes.slice(offset + CRYPTO_RECORD_HEADER_LENGTH, offset + CRYPTO_RECORD_HEADER_LENGTH + length);
    records.push({ contentType, legacyVersion, fragment });
    offset += CRYPTO_RECORD_HEADER_LENGTH + length;
  }
  return records;
}
