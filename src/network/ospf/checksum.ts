/**
 * OSPF — Fletcher-16 LSA checksum (RFC 2328 Appendix C.1).
 *
 * Extracted from `OSPFEngine.ts` to keep the engine focused on protocol
 * orchestration and to make the pure serialisation/checksum logic
 * independently testable.
 */

import type {
  LSA, RouterLSA, NetworkLSA, SummaryLSA, ExternalLSA, NSSAExternalLSA,
  OSPFv3LinkLSA, OSPFv3IntraAreaPrefixLSA, OSPFv3Prefix,
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

// ─── OSPFv3 LSA checksums (RFC 5340 §A.4.5) ──────────────────────────────
//
// OSPFv3 keeps the same Fletcher-16 algorithm as v2 (RFC 5340 §A.4.5
// explicitly references RFC 2328 Annex C), but the header layout and
// LSA bodies are different. The lsAge field is still excluded; the
// checksum field is treated as zero during computation.

/** UTF-8 / ASCII bytes of a string — used as a deterministic placeholder
 *  for IPv6 addresses and prefix strings, since the simulator's wire
 *  format keeps these as strings rather than packed octets. The exact
 *  bytes do not need to match a real OSPFv3 capture, only to vary with
 *  the content (the goal is meaningful integrity coverage, not on-wire
 *  interop). */
function strBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

function u16(n: number): number[] {
  return [(n >>> 8) & 0xFF, n & 0xFF];
}

function serializeV3Prefix(p: OSPFv3Prefix): number[] {
  return [
    p.prefixLen & 0xFF,
    p.prefixOptions & 0xFF,
    ...u16(p.metric & 0xFFFF),
    ...strBytes(p.prefix),
  ];
}

type OSPFv3LSAUnion = OSPFv3LinkLSA | OSPFv3IntraAreaPrefixLSA;

function serializeOSPFv3LSAForChecksum(lsa: OSPFv3LSAUnion): number[] {
  const bytes: number[] = [];
  // Common header (skipping lsAge, checksum zeroed) — RFC 5340 §A.4.2.
  bytes.push(...u16(lsa.lsType & 0xFFFF));
  // linkStateId/advertisingRouter are 4-byte fields; we hash the string
  // to a 32-bit integer so a same-string yields the same bytes and a
  // different string almost certainly differs.
  bytes.push(...u32(fnv32(lsa.linkStateId)));
  bytes.push(...u32(fnv32(lsa.advertisingRouter)));
  bytes.push(...u32(lsa.lsSequenceNumber >>> 0));
  bytes.push(0, 0); // checksum (zeroed)
  bytes.push(...u16(lsa.length & 0xFFFF));

  if (lsa.lsType === 0x0008) {
    const l = lsa as OSPFv3LinkLSA;
    bytes.push(l.priority & 0xFF, 0, 0, l.options & 0xFF);
    bytes.push(...strBytes(l.linkLocalAddress));
    bytes.push(...u32(l.prefixes.length));
    for (const p of l.prefixes) bytes.push(...serializeV3Prefix(p));
  } else if (lsa.lsType === 0x2009) {
    const i = lsa as OSPFv3IntraAreaPrefixLSA;
    bytes.push(...u16(i.numPrefixes & 0xFFFF));
    bytes.push(...u16(i.referencedLSType & 0xFFFF));
    bytes.push(...u32(fnv32(i.referencedLSId)));
    bytes.push(...u32(fnv32(i.referencedAdvRouter)));
    for (const p of i.prefixes) bytes.push(...serializeV3Prefix(p));
  }
  return bytes;
}

function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fletcher-16 over the OSPFv3 LSA, excluding lsAge and treating the
 * checksum field as zero. Same algorithm as OSPFv2 (RFC 5340 §A.4.5).
 * Returns 0xFFFF instead of 0x0000 so the value never collides with the
 * "unset" sentinel used by `verifyOSPFv3LSAChecksum`.
 */
export function computeOSPFv3LSAChecksum(lsa: OSPFv3LSAUnion): number {
  const bytes = serializeOSPFv3LSAForChecksum(lsa);
  let c0 = 0, c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) % 255;
    c1 = (c1 + c0) % 255;
  }
  const result = ((c0 & 0xFF) << 8) | (c1 & 0xFF);
  return result !== 0 ? result : 0xFFFF;
}

/** True when the LSA carries a non-zero checksum that matches the
 *  recomputed value. Like the v2 helper, 0 is treated as "not yet
 *  computed" rather than a valid value. */
export function verifyOSPFv3LSAChecksum(lsa: OSPFv3LSAUnion): boolean {
  if (lsa.checksum === 0) return false;
  return lsa.checksum === computeOSPFv3LSAChecksum(lsa);
}
