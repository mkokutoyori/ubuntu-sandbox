/**
 * EAP-TLS (RFC 5216 §2.1) outer-tunnel wire codec — a "flight" is a real
 * RFC 8446 flight (`readonly TlsRecord[]`, `@/network/tls/recordLayer`)
 * produced by `TlsClientSession`/`TlsServerSession`; this module only
 * serializes/deserializes that array to/from the bytes
 * `EapTlsFragmentation.ts` chops into Type-Data fragments. Before the
 * `PRD-TLS.md` §2.1.14 migration this module also modeled the handshake
 * content itself (ad hoc client-hello/server-flight/client-flight/
 * server-finished messages, a simulated 2-RTT stand-in) — that's now the
 * real engine's job, so only the wire codec remains.
 */
import { utf8ToBytes, bytesToUtf8, bytesToHex, hexToBytes } from '@/crypto/encoding';
import type { TlsRecord } from '@/network/tls/recordLayer';
import type { ContentType } from '@/network/tls/types';

interface WireRecord {
  readonly contentType: ContentType;
  readonly legacyVersion: number;
  readonly fragmentHex: string;
}

/**
 * Serializes a TLS flight to bytes for RFC 5216 §2.1 fragmentation —
 * hex-encodes each record's `fragment` so it survives a JSON round trip
 * (a bare `Uint8Array` would not).
 */
export function encodeFlight(records: readonly TlsRecord[]): Uint8Array {
  const wire: WireRecord[] = records.map((r) => ({
    contentType: r.contentType, legacyVersion: r.legacyVersion, fragmentHex: bytesToHex(r.fragment),
  }));
  return utf8ToBytes(JSON.stringify(wire));
}

export function decodeFlight(bytes: Uint8Array): TlsRecord[] {
  const wire = JSON.parse(bytesToUtf8(bytes)) as WireRecord[];
  return wire.map((r) => ({ contentType: r.contentType, legacyVersion: r.legacyVersion, fragment: hexToBytes(r.fragmentHex) }));
}
