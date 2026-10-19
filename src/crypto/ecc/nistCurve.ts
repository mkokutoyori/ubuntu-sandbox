import type { HashAlgorithm } from '../hash';
import { hmac } from '@/crypto/mac';

export interface CurvePoint { readonly x: bigint; readonly y: bigint }

export interface CurveSignature { readonly r: bigint; readonly s: bigint }

export interface NistCurveParameters {
  readonly name: 'nistp256' | 'nistp384' | 'nistp521';
  readonly p: bigint;
  readonly order: bigint;
  readonly b: bigint;
  readonly gx: bigint;
  readonly gy: bigint;
  readonly orderBits: number;
  readonly hash: HashAlgorithm;
}

type Jacobian = readonly [bigint, bigint, bigint];

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function invMod(a: bigint, m: bigint): bigint {
  let [g, x] = [m, 0n];
  let [u, y] = [mod(a, m), 1n];
  while (u !== 0n) {
    const q = g / u;
    [g, u] = [u, g - q * u];
    [x, y] = [y, x - q * y];
  }
  return mod(x, m);
}

export function bytesToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const octet of bytes) n = (n << 8n) | BigInt(octet);
  return n;
}

export function bigToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export class NistCurve {
  readonly name: NistCurveParameters['name'];
  readonly order: bigint;
  readonly fieldBytes: number;
  readonly hash: HashAlgorithm;
  private readonly p: bigint;
  private readonly b: bigint;
  private readonly orderBits: number;
  private readonly base: Jacobian;
  private readonly infinity: Jacobian = [0n, 0n, 0n];

  constructor(parameters: NistCurveParameters) {
    this.name = parameters.name;
    this.p = parameters.p;
    this.order = parameters.order;
    this.b = parameters.b;
    this.orderBits = parameters.orderBits;
    this.hash = parameters.hash;
    this.fieldBytes = Math.ceil(parameters.orderBits / 8);
    this.base = [parameters.gx, parameters.gy, 1n];
  }

  private double(point: Jacobian): Jacobian {
    const { p } = this;
    const [x, y, z] = point;
    if (y === 0n) return this.infinity;
    const a = mod(y * y, p);
    const b = mod(4n * x * a, p);
    const c = mod(8n * a * a, p);
    const zz = mod(z * z, p);
    const d = mod(3n * mod(x - zz, p) * mod(x + zz, p), p);
    const x3 = mod(d * d - 2n * b, p);
    return [x3, mod(d * (b - x3) - c, p), mod(2n * y * z, p)];
  }

  private add(p1: Jacobian, p2: Jacobian): Jacobian {
    const { p } = this;
    const [x1, y1, z1] = p1;
    const [x2, y2, z2] = p2;
    if (z1 === 0n) return p2;
    if (z2 === 0n) return p1;
    const z1z1 = mod(z1 * z1, p);
    const z2z2 = mod(z2 * z2, p);
    const u1 = mod(x1 * z2z2, p);
    const u2 = mod(x2 * z1z1, p);
    const s1 = mod(y1 * z2 * z2z2, p);
    const s2 = mod(y2 * z1 * z1z1, p);
    if (u1 === u2) return s1 === s2 ? this.double(p1) : this.infinity;
    const h = mod(u2 - u1, p);
    const i = mod(mod(2n * h, p) * mod(2n * h, p), p);
    const j = mod(h * i, p);
    const r = mod(2n * (s2 - s1), p);
    const v = mod(u1 * i, p);
    const x3 = mod(r * r - j - 2n * v, p);
    return [
      x3,
      mod(r * (v - x3) - 2n * s1 * j, p),
      mod(mod(mod((z1 + z2) * (z1 + z2), p) - z1z1 - z2z2, p) * h, p),
    ];
  }

  private multiply(k: bigint, point: Jacobian): Jacobian {
    let result = this.infinity;
    let addend = point;
    let e = k;
    while (e > 0n) {
      if (e & 1n) result = this.add(result, addend);
      addend = this.double(addend);
      e >>= 1n;
    }
    return result;
  }

  private toAffine(point: Jacobian): CurvePoint | null {
    const [x, y, z] = point;
    if (z === 0n) return null;
    const zi = invMod(z, this.p);
    const zi2 = mod(zi * zi, this.p);
    return { x: mod(x * zi2, this.p), y: mod(y * zi2 * zi, this.p) };
  }

  isOnCurve(q: CurvePoint): boolean {
    const { p } = this;
    if (q.x < 0n || q.x >= p || q.y < 0n || q.y >= p) return false;
    return mod(q.y * q.y, p) === mod(q.x * q.x * q.x - 3n * q.x + this.b, p);
  }

  publicKey(privateScalar: bigint): CurvePoint {
    const q = this.toAffine(this.multiply(mod(privateScalar, this.order), this.base));
    if (q === null) throw new RangeError(`${this.name}: private scalar yields the point at infinity`);
    return q;
  }

  private bitsToInt(bytes: Uint8Array): bigint {
    const value = bytesToBig(bytes);
    const excess = bytes.length * 8 - this.orderBits;
    return excess > 0 ? value >> BigInt(excess) : value;
  }

  nonce(privateScalar: bigint, messageHash: Uint8Array): bigint {
    const drbgHash = this.hash;
    const hm = (key: Uint8Array, ...parts: Uint8Array[]): Uint8Array => {
      let total = 0;
      for (const part of parts) total += part.length;
      const message = new Uint8Array(total);
      let at = 0;
      for (const part of parts) { message.set(part, at); at += part.length; }
      return hmac(drbgHash, key, message);
    };
    const x = bigToBytes(privateScalar, this.fieldBytes);
    const h1 = bigToBytes(mod(this.bitsToInt(messageHash), this.order), this.fieldBytes);
    let v = new Uint8Array(drbgHash.digestSize).fill(1);
    let k = new Uint8Array(drbgHash.digestSize).fill(0);
    k = hm(k, v, Uint8Array.from([0]), x, h1); v = hm(k, v);
    k = hm(k, v, Uint8Array.from([1]), x, h1); v = hm(k, v);
    for (;;) {
      let stream = new Uint8Array(0);
      while (stream.length * 8 < this.orderBits) {
        v = hm(k, v);
        const grown = new Uint8Array(stream.length + v.length);
        grown.set(stream);
        grown.set(v, stream.length);
        stream = grown;
      }
      const candidate = this.bitsToInt(stream);
      if (candidate >= 1n && candidate < this.order) return candidate;
      k = hm(k, v, Uint8Array.from([0]));
      v = hm(k, v);
    }
  }

  signDigest(privateScalar: bigint, digest: Uint8Array): CurveSignature {
    const d = mod(privateScalar, this.order);
    const z = mod(this.bitsToInt(digest), this.order);
    for (;;) {
      const k = this.nonce(d, digest);
      const point = this.toAffine(this.multiply(k, this.base));
      if (point === null) continue;
      const r = mod(point.x, this.order);
      if (r === 0n) continue;
      const s = mod(invMod(k, this.order) * (z + r * d), this.order);
      if (s === 0n) continue;
      return { r, s };
    }
  }

  verifyDigest(q: CurvePoint, digest: Uint8Array, signature: CurveSignature): boolean {
    const { r, s } = signature;
    if (r <= 0n || r >= this.order || s <= 0n || s >= this.order) return false;
    if (!this.isOnCurve(q)) return false;
    const z = mod(this.bitsToInt(digest), this.order);
    const w = invMod(s, this.order);
    const point = this.toAffine(this.add(
      this.multiply(mod(z * w, this.order), this.base),
      this.multiply(mod(r * w, this.order), [q.x, q.y, 1n]),
    ));
    return point !== null && mod(point.x, this.order) === r;
  }

  sign(privateScalar: bigint, message: Uint8Array): CurveSignature {
    return this.signDigest(privateScalar, this.hash.digest(message));
  }

  verify(q: CurvePoint, message: Uint8Array, signature: CurveSignature): boolean {
    return this.verifyDigest(q, this.hash.digest(message), signature);
  }

  ecdh(privateScalar: bigint, peer: CurvePoint): Uint8Array | null {
    if (!this.isOnCurve(peer)) return null;
    const point = this.toAffine(this.multiply(mod(privateScalar, this.order), [peer.x, peer.y, 1n]));
    return point === null ? null : bigToBytes(point.x, this.fieldBytes);
  }

  generatePrivateScalar(random: (count: number) => Uint8Array): bigint {
    for (;;) {
      const candidate = this.bitsToInt(random(this.fieldBytes));
      if (candidate >= 1n && candidate < this.order) return candidate;
    }
  }

  encodePoint(q: CurvePoint): Uint8Array {
    const out = new Uint8Array(1 + 2 * this.fieldBytes);
    out[0] = 0x04;
    out.set(bigToBytes(q.x, this.fieldBytes), 1);
    out.set(bigToBytes(q.y, this.fieldBytes), 1 + this.fieldBytes);
    return out;
  }

  decodePoint(encoded: Uint8Array): CurvePoint | null {
    if (encoded.length !== 1 + 2 * this.fieldBytes || encoded[0] !== 0x04) return null;
    const point = {
      x: bytesToBig(encoded.slice(1, 1 + this.fieldBytes)),
      y: bytesToBig(encoded.slice(1 + this.fieldBytes)),
    };
    return this.isOnCurve(point) ? point : null;
  }
}
