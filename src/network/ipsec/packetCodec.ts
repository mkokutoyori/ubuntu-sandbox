/**
 * Lossless (de)serialization of an IPv4Packet to bytes, so ESP can encrypt the
 * genuine inner packet and rebuild it after decryption.
 *
 * The packet model is plain interface data except for the address value
 * objects (IPAddress / MACAddress / SubnetMask). Those define `toJSON()`, so a
 * normal replacer only sees the post-toJSON string — we therefore inspect the
 * original value via `this[key]` (the holder bound by JSON.stringify) to tag
 * the instance, and a reviver reconstructs it. Everything else round-trips.
 */

import { IPAddress, MACAddress, SubnetMask, type IPv4Packet } from '../core/types';
import { utf8ToBytes, bytesToUtf8 } from '@/crypto';

interface TaggedClass {
  readonly __c: 'IP' | 'MAC' | 'MASK';
  readonly v: string;
}

/** Serialize a packet to UTF-8 JSON bytes. */
export function encodePacket(pkt: IPv4Packet): Uint8Array {
  return utf8ToBytes(JSON.stringify(pkt, replacer));
}

/** Reconstruct a packet from bytes produced by {@link encodePacket}. */
export function decodePacket(bytes: Uint8Array): IPv4Packet {
  return JSON.parse(bytesToUtf8(bytes), reviver) as IPv4Packet;
}

function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const orig = this[key];
  if (orig instanceof IPAddress) return { __c: 'IP', v: orig.toString() } satisfies TaggedClass;
  if (orig instanceof MACAddress) return { __c: 'MAC', v: orig.toString() } satisfies TaggedClass;
  if (orig instanceof SubnetMask) return { __c: 'MASK', v: orig.toString() } satisfies TaggedClass;
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__c' in value) {
    const t = value as TaggedClass;
    if (t.__c === 'IP') return new IPAddress(t.v);
    if (t.__c === 'MAC') return new MACAddress(t.v);
    if (t.__c === 'MASK') return new SubnetMask(t.v);
  }
  return value;
}
