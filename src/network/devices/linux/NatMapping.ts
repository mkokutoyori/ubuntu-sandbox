import { IP_PROTO_ICMP, IPAddress, PORT_BEARING_PROTOCOLS } from '../../core/types';
import type { ConnectionTuple } from './ConnectionTracker';
import type { NatRange } from './NatRange';

export type NatManipulation = 'source' | 'destination';

export interface NatWorld {
  taken(candidate: ConnectionTuple): boolean;
  mappedSources(current: ConnectionTuple): readonly ConnectionTuple[];
  randomOffset(): number;
}

const JHASH_INITVAL = 0xdeadbeef;
const MAX_ATTEMPTS = 128;


function rol32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export function jhash2(words: readonly number[], initval: number): number {
  let a = (JHASH_INITVAL + (words.length << 2) + initval) >>> 0;
  let b = a;
  let c = a;
  let index = 0;
  let remaining = words.length;
  while (remaining > 3) {
    a = (a + words[index]) >>> 0;
    b = (b + words[index + 1]) >>> 0;
    c = (c + words[index + 2]) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rol32(c, 4)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rol32(a, 6)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rol32(b, 8)) >>> 0; b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rol32(c, 16)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rol32(a, 19)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rol32(b, 4)) >>> 0; b = (b + a) >>> 0;
    remaining -= 3;
    index += 3;
  }
  if (remaining === 0) return c;
  if (remaining >= 3) c = (c + words[index + 2]) >>> 0;
  if (remaining >= 2) b = (b + words[index + 1]) >>> 0;
  a = (a + words[index]) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rol32(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rol32(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rol32(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rol32(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rol32(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rol32(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rol32(b, 24)) >>> 0;
  return c;
}

export function reciprocalScale(value: number, range: number): number {
  return Number((BigInt(value) * BigInt(range)) >> 32n);
}

function memoryWord(address: IPAddress): number {
  const [a, b, c, d] = address.getOctets();
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

function numeric(address: IPAddress): number {
  return address.toUint32();
}

function keyOf(tuple: ConnectionTuple, manipulation: NatManipulation): number | null {
  if (tuple.protocol === IP_PROTO_ICMP) return tuple.icmpId ?? 0;
  if (!PORT_BEARING_PROTOCOLS.has(tuple.protocol)) return null;
  return manipulation === 'source' ? tuple.srcPort : tuple.dstPort;
}

function withKey(tuple: ConnectionTuple, manipulation: NatManipulation, key: number): ConnectionTuple {
  if (tuple.protocol === IP_PROTO_ICMP) return { ...tuple, icmpId: key };
  return manipulation === 'source' ? { ...tuple, srcPort: key } : { ...tuple, dstPort: key };
}

function addressIn(tuple: ConnectionTuple, range: NatRange): boolean {
  if (range.addresses === null) return true;
  const source = numeric(IPAddress.tryParse(tuple.srcIP) as IPAddress);
  return source >= numeric(range.addresses.min) && source <= numeric(range.addresses.max);
}

function keyInRange(tuple: ConnectionTuple, manipulation: NatManipulation, range: NatRange): boolean {
  if (range.ports === null) return true;
  const key = keyOf(tuple, manipulation);
  return key === null || (key >= range.ports.min && key <= range.ports.max);
}

function withAddress(tuple: ConnectionTuple, manipulation: NatManipulation, address: IPAddress): ConnectionTuple {
  return manipulation === 'source' ? { ...tuple, srcIP: address.toString() } : { ...tuple, dstIP: address.toString() };
}

function bestAddress(tuple: ConnectionTuple, range: NatRange, manipulation: NatManipulation): ConnectionTuple {
  if (range.addresses === null) return tuple;
  const { min, max } = range.addresses;
  if (min.equals(max)) return withAddress(tuple, manipulation, min);
  const source = IPAddress.tryParse(tuple.srcIP) as IPAddress;
  const destination = IPAddress.tryParse(tuple.dstIP) as IPAddress;
  const hash = jhash2([memoryWord(source), 0, 0, 0], range.persistent ? 0 : memoryWord(destination));
  const distance = numeric(max) - numeric(min) + 1;
  return withAddress(tuple, manipulation, IPAddress.fromUint32(numeric(min) + reciprocalScale(hash, distance)));
}

function uniqueKey(tuple: ConnectionTuple, range: NatRange, manipulation: NatManipulation, world: NatWorld): ConnectionTuple {
  const key = keyOf(tuple, manipulation);
  if (key === null) return tuple;
  const icmp = tuple.protocol === IP_PROTO_ICMP;
  let min: number;
  let size: number;
  if (range.ports === null) {
    if (icmp) {
      min = 0;
      size = 65536;
    } else if (manipulation === 'destination') {
      return tuple;
    } else if (key < 1024) {
      if (key < 512) {
        min = 1;
        size = 511;
      } else {
        min = 600;
        size = 1023 - 600 + 1;
      }
    } else {
      min = 1024;
      size = 65535 - 1024 + 1;
    }
  } else {
    min = Math.min(range.ports.min, range.ports.max);
    size = Math.max(range.ports.min, range.ports.max) - min + 1;
  }
  let offset = range.ports?.base != null ? (key - range.ports.base) >>> 0 : world.randomOffset();
  let attempts = Math.min(size, MAX_ATTEMPTS);
  let candidate = tuple;
  for (;;) {
    for (let tried = 0; tried < attempts; tried++, offset = (offset + 1) >>> 0) {
      candidate = withKey(tuple, manipulation, min + (offset % size));
      if (!world.taken(candidate)) return candidate;
    }
    if (attempts >= size || attempts < 16) return candidate;
    attempts = Math.floor(attempts / 2);
    offset = world.randomOffset();
  }
}

export function uniqueTuple(current: ConnectionTuple, range: NatRange, manipulation: NatManipulation, world: NatWorld): ConnectionTuple {
  const randomAll = range.random || range.randomFully;
  if (manipulation === 'source' && !randomAll) {
    if (addressIn(current, range) && keyInRange(current, 'source', range)) {
      if (!world.taken(current)) return current;
    } else {
      const mapped = world.mappedSources(current).find((candidate) => addressIn(candidate, range) && keyInRange(candidate, 'source', range));
      if (mapped !== undefined && !world.taken(mapped)) return mapped;
    }
  }
  const tuple = bestAddress(current, range, manipulation);
  if (!randomAll) {
    if (range.ports !== null) {
      const key = keyOf(tuple, manipulation);
      const inside = key === null || (key >= range.ports.min && key <= range.ports.max);
      if (range.ports.base === null && inside && (range.ports.min === range.ports.max || !world.taken(tuple))) return tuple;
    } else if (!world.taken(tuple)) {
      return tuple;
    }
  }
  return uniqueKey(tuple, range, manipulation, world);
}
