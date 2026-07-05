import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { bytesToHex, type PacketProtectionKeys } from './types';

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
