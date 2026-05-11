/**
 * OSPF — Fletcher-16 LSA checksum (RFC 2328 Appendix C.1).
 *
 * Extracted from `OSPFEngine.ts` to keep the engine focused on protocol
 * orchestration and to make the pure serialisation/checksum logic
 * independently testable.
 */

import type {
  LSA, RouterLSA, NetworkLSA, SummaryLSA, ExternalLSA, NSSAExternalLSA,
} from './types';

/**
 * Convert a dotted-decimal IP string to a 4-byte array.
 * Returns [0,0,0,0] for invalid input.
 */
function ipToBytes(ip: string): number[] {
  const parts = ip.split('.');
  if (parts.length !== 4) return [0, 0, 0, 0];
  return parts.map(n => parseInt(n, 10) & 0xFF);
}

/**
 * Serialize an LSA to a byte array starting from offset 2 of the LSA header
 * (i.e. skipping the 2-byte lsAge field), with the checksum field zeroed.
 * This is the byte sequence over which Fletcher-16 is computed.
 */
function serializeLSAForChecksum(lsa: LSA): number[] {
  const bytes: number[] = [];

  bytes.push(lsa.options & 0xFF);
  bytes.push(lsa.lsType & 0xFF);
  bytes.push(...ipToBytes(lsa.linkStateId));
  bytes.push(...ipToBytes(lsa.advertisingRouter));

  const seq = lsa.lsSequenceNumber >>> 0;
  bytes.push(
    (seq >>> 24) & 0xFF, (seq >>> 16) & 0xFF,
    (seq >>> 8) & 0xFF, seq & 0xFF,
  );

  bytes.push(0, 0); // checksum: 2 bytes (zeroed)

  const len = lsa.length ?? 24;
  bytes.push((len >>> 8) & 0xFF, len & 0xFF);

  if (lsa.lsType === 1) {
    const r = lsa as RouterLSA;
    bytes.push(r.flags & 0xFF, 0);
    bytes.push((r.numLinks >>> 8) & 0xFF, r.numLinks & 0xFF);
    for (const link of r.links) {
      bytes.push(...ipToBytes(link.linkId));
      bytes.push(...ipToBytes(link.linkData));
      bytes.push(link.type & 0xFF, link.numTOS & 0xFF);
      bytes.push((link.metric >>> 8) & 0xFF, link.metric & 0xFF);
    }
  } else if (lsa.lsType === 2) {
    const n = lsa as NetworkLSA;
    bytes.push(...ipToBytes(n.networkMask));
    for (const r of n.attachedRouters) {
      bytes.push(...ipToBytes(r));
    }
  } else if (lsa.lsType === 3 || lsa.lsType === 4) {
    const s = lsa as SummaryLSA;
    bytes.push(...ipToBytes(s.networkMask));
    bytes.push(0);
    bytes.push((s.metric >>> 16) & 0xFF, (s.metric >>> 8) & 0xFF, s.metric & 0xFF);
  } else if (lsa.lsType === 5 || lsa.lsType === 7) {
    const e = lsa as ExternalLSA | NSSAExternalLSA;
    bytes.push(...ipToBytes(e.networkMask));
    bytes.push(e.metricType === 2 ? 0x80 : 0x00);
    bytes.push((e.metric >>> 16) & 0xFF, (e.metric >>> 8) & 0xFF, e.metric & 0xFF);
    bytes.push(...ipToBytes(e.forwardingAddress));
    const tag = e.externalRouteTag >>> 0;
    bytes.push((tag >>> 24) & 0xFF, (tag >>> 16) & 0xFF, (tag >>> 8) & 0xFF, tag & 0xFF);
  }

  return bytes;
}

/**
 * Compute the Fletcher-16 checksum of an LSA (RFC 2328 §12.4.7).
 * The lsAge field is excluded; the checksum field is treated as zero.
 * Returns the 16-bit checksum as (C0 << 8) | C1.
 */
export function computeOSPFLSAChecksum(lsa: LSA): number {
  const bytes = serializeLSAForChecksum(lsa);
  let c0 = 0, c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) % 255;
    c1 = (c1 + c0) % 255;
  }
  const result = ((c0 & 0xFF) << 8) | (c1 & 0xFF);
  // Avoid returning 0x0000 (treated as "unset") — remap to a sentinel
  return result !== 0 ? result : 0xFFFF;
}

/**
 * Verify the stored checksum of an LSA matches the computed value.
 * An LSA with checksum 0 is always considered invalid (not yet computed).
 */
export function verifyOSPFLSAChecksum(lsa: LSA): boolean {
  if (lsa.checksum === 0) return false;
  return lsa.checksum === computeOSPFLSAChecksum(lsa);
}
