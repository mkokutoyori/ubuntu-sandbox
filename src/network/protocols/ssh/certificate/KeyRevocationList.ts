import { sha1, sha256 } from '@/crypto/hash';
import { bytesToBase64, bytesToHex } from '@/crypto/encoding';
import {
  keygenBlobDigest, sshPublicKeyBlob, sshPublicKeyFromBlob, type SshPublicKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { verifyUserauthSignature } from '../auth/UserauthSignature';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import type { SshCertificate } from './SshCertificate';

const KRL_MAGIC = new TextEncoder().encode('SSHKRL\n\0');
const KRL_FORMAT_VERSION = 1;

const SECTION_CERTIFICATES = 1;
const SECTION_EXPLICIT_KEY = 2;
const SECTION_FINGERPRINT_SHA1 = 3;
const SECTION_SIGNATURE = 4;
const SECTION_FINGERPRINT_SHA256 = 5;
const CERT_SERIAL_LIST = 0x20;
const CERT_SERIAL_RANGE = 0x21;
const CERT_SERIAL_BITMAP = 0x22;
const CERT_KEY_ID = 0x23;

export type KrlFailure = 'bad-magic' | 'invalid-format' | 'signature-invalid' | 'key-revoked';

export type KrlParse = { readonly ok: true; readonly krl: KeyRevocationList } | { readonly ok: false; readonly failure: KrlFailure; readonly logs: readonly string[] };

interface SerialRange {
  lo: bigint;
  hi: bigint;
}

interface CertificateRevocations {
  readonly caBlob: Uint8Array | null;
  serials: SerialRange[];
  keyIds: Set<string>;
}

function compareBlobs(first: Uint8Array, second: Uint8Array): number {
  const common = Math.min(first.length, second.length);
  for (let index = 0; index < common; index++) {
    if (first[index] !== second[index]) return first[index] < second[index] ? -1 : 1;
  }
  return first.length === second.length ? 0 : first.length < second.length ? -1 : 1;
}

function sameBlob(first: Uint8Array | null, second: Uint8Array | null): boolean {
  if (first === null || second === null) return first === second;
  return compareBlobs(first, second) === 0;
}

class BlobSet {
  private readonly blobs: Uint8Array[] = [];

  add(blob: Uint8Array): void {
    if (!this.has(blob)) this.blobs.push(blob);
  }

  has(blob: Uint8Array): boolean {
    return this.blobs.some((candidate) => compareBlobs(candidate, blob) === 0);
  }

  sorted(): Uint8Array[] {
    return [...this.blobs].sort(compareBlobs);
  }

  get size(): number {
    return this.blobs.length;
  }
}

function chooseNextState(
  currentState: number, contiguousRaw: bigint, final: boolean, lastGapRaw: bigint, nextGapRaw: bigint,
): { state: number; forceNewSection: boolean } {
  const cap = 1n << 31n;
  const contiguous = Number(contiguousRaw < cap ? contiguousRaw : cap);
  const lastGap = Number(lastGapRaw < cap ? lastGapRaw : cap);
  const nextGap = Number(nextGapRaw < cap ? nextGapRaw : cap);
  let costList = 0;
  let costBitmap = 0;
  let costBitmapRestart = 0;
  let costRange = 8;
  if (currentState === CERT_SERIAL_LIST) {
    costBitmapRestart = costBitmap = 8 + 64;
  } else if (currentState === CERT_SERIAL_BITMAP) {
    costList = 8;
    costBitmapRestart = 8 + 64;
  } else {
    costBitmapRestart = costBitmap = 8 + 64;
    costList = 8;
  }
  costList += 64 * contiguous + (final ? 0 : 8 + 64);
  costRange += 2 * 64 + (final ? 0 : 8 + 64);
  costBitmap += lastGap + contiguous + (final ? 0 : Math.min(nextGap, 8 + 64));
  costBitmapRestart += contiguous + (final ? 0 : Math.min(nextGap, 8 + 64));
  costList = Math.floor((costList + 7) / 8);
  costBitmap = Math.floor((costBitmap + 7) / 8);
  costBitmapRestart = Math.floor((costBitmapRestart + 7) / 8);
  costRange = Math.floor((costRange + 7) / 8);
  let state = CERT_SERIAL_BITMAP;
  let cost = costBitmap;
  let forceNewSection = false;
  if (costRange < cost) { state = CERT_SERIAL_RANGE; cost = costRange; }
  if (costList < cost) { state = CERT_SERIAL_LIST; cost = costList; }
  if (costBitmapRestart < cost) { state = CERT_SERIAL_BITMAP; forceNewSection = true; }
  return { state, forceNewSection };
}

export class KeyRevocationList {
  version = 0n;
  generatedDate = 0n;
  flags = 0n;
  comment = '';
  private readonly explicitKeys = new BlobSet();
  private readonly sha1Hashes = new BlobSet();
  private readonly sha256Hashes = new BlobSet();
  private readonly certificateGroups: CertificateRevocations[] = [];

  revokeKeyExplicit(key: SshPublicKey): void {
    this.explicitKeys.add(sshPublicKeyBlob(key));
  }

  revokeSha1(hash: Uint8Array): boolean {
    if (hash.length !== 20) return false;
    this.sha1Hashes.add(hash);
    return true;
  }

  revokeSha256(hash: Uint8Array): boolean {
    if (hash.length !== 32) return false;
    this.sha256Hashes.add(hash);
    return true;
  }

  private groupFor(authority: SshPublicKey | null): CertificateRevocations {
    const blob = authority === null ? null : sshPublicKeyBlob(authority);
    let group = this.certificateGroups.find((candidate) => sameBlob(candidate.caBlob, blob));
    if (group === undefined) {
      group = { caBlob: blob, serials: [], keyIds: new Set() };
      this.certificateGroups.push(group);
    }
    return group;
  }

  revokeSerialRange(authority: SshPublicKey | null, lo: bigint, hi: bigint): void {
    const group = this.groupFor(authority);
    const ranges = [...group.serials, { lo, hi }].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
    const merged: SerialRange[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range.lo <= last.hi + 1n) {
        if (range.hi > last.hi) last.hi = range.hi;
      } else {
        merged.push({ ...range });
      }
    }
    group.serials = merged;
  }

  revokeKeyId(authority: SshPublicKey | null, keyId: string): void {
    this.groupFor(authority).keyIds.add(keyId);
  }

  revokeKey(key: SshPublicKey | SshCertificate): void {
    if (!('subject' in key)) {
      this.revokeKeyExplicit(key);
      return;
    }
    if (key.serial === 0n) this.revokeKeyId(key.caKey, key.keyId);
    else this.revokeSerialRange(key.caKey, key.serial, key.serial);
  }

  private certificateRevoked(group: CertificateRevocations, certificate: SshCertificate): boolean {
    if (group.keyIds.has(certificate.keyId)) return true;
    if (certificate.serial === 0n) return false;
    return group.serials.some((range) => certificate.serial >= range.lo && certificate.serial <= range.hi);
  }

  private keyRevoked(key: SshPublicKey | SshCertificate): boolean {
    const plain = 'subject' in key ? key.subject : key;
    const blob = sshPublicKeyBlob(plain);
    if (this.sha1Hashes.has(sha1(blob)) || this.sha256Hashes.has(sha256(blob)) || this.explicitKeys.has(blob)) return true;
    if (!('subject' in key)) return false;
    const authority = sshPublicKeyBlob(key.caKey);
    const specific = this.certificateGroups.find((group) => sameBlob(group.caBlob, authority));
    if (specific !== undefined && this.certificateRevoked(specific, key)) return true;
    const wildcard = this.certificateGroups.find((group) => group.caBlob === null);
    return wildcard !== undefined && this.certificateRevoked(wildcard, key);
  }

  isRevoked(key: SshPublicKey | SshCertificate): boolean {
    if (this.keyRevoked(key)) return true;
    return 'subject' in key && this.keyRevoked(key.caKey);
  }

  toBytes(nowSeconds: number): Uint8Array {
    if (this.generatedDate === 0n) this.generatedDate = BigInt(nowSeconds);
    const out = new SshWriter()
      .writeRaw(KRL_MAGIC).writeUint32(KRL_FORMAT_VERSION)
      .writeBigUint64(this.version).writeBigUint64(this.generatedDate).writeBigUint64(this.flags)
      .writeBytes(new Uint8Array(0)).writeString(this.comment);
    for (const group of this.certificateGroups) {
      out.writeByte(SECTION_CERTIFICATES).writeBytes(this.certificateSection(group));
    }
    this.blobSection(out, SECTION_EXPLICIT_KEY, this.explicitKeys);
    this.blobSection(out, SECTION_FINGERPRINT_SHA1, this.sha1Hashes);
    this.blobSection(out, SECTION_FINGERPRINT_SHA256, this.sha256Hashes);
    return out.toBytes();
  }

  private blobSection(out: SshWriter, type: number, set: BlobSet): void {
    if (set.size === 0) return;
    const section = new SshWriter();
    for (const blob of set.sorted()) section.writeBytes(blob);
    out.writeByte(type).writeBytes(section.toBytes());
  }

  private certificateSection(group: CertificateRevocations): Uint8Array {
    const out = new SshWriter().writeBytes(group.caBlob ?? new Uint8Array(0)).writeBytes(new Uint8Array(0));
    let state = 0;
    let section = new SshWriter();
    let bitmapStart = 0n;
    let bitmap = 0n;
    let last = 0n;
    const finish = (): void => {
      if (state === 0) return;
      if (state === CERT_SERIAL_BITMAP) section.writeMpint(bitmap);
      out.writeByte(state).writeBytes(section.toBytes());
      section = new SshWriter();
    };
    group.serials.forEach((range, index) => {
      const next = group.serials[index + 1];
      const final = next === undefined;
      const gap = final ? 0n : next.lo - range.hi;
      const contiguous = 1n + (range.hi - range.lo);
      const choice = chooseNextState(state, contiguous, final, state === 0 ? 0n : range.lo - last, gap);
      if (state !== 0 && (choice.forceNewSection || choice.state !== state || state === CERT_SERIAL_RANGE)) finish();
      if (choice.state !== state || choice.forceNewSection) {
        state = choice.state;
        section = new SshWriter();
        if (state === CERT_SERIAL_BITMAP) {
          bitmapStart = range.lo;
          bitmap = 0n;
          section.writeBigUint64(bitmapStart);
        }
      }
      if (state === CERT_SERIAL_LIST) {
        for (let offset = 0n; offset < contiguous; offset++) section.writeBigUint64(range.lo + offset);
      } else if (state === CERT_SERIAL_RANGE) {
        section.writeBigUint64(range.lo).writeBigUint64(range.hi);
      } else {
        for (let offset = 0n; offset < contiguous; offset++) bitmap |= 1n << (range.lo + offset - bitmapStart);
      }
      last = range.hi;
    });
    finish();
    if (group.keyIds.size > 0) {
      out.writeByte(CERT_KEY_ID).writeBytes(cstringList([...group.keyIds].sort()));
    }
    return out.toBytes();
  }

  dump(zoneOffset: (atMs: number) => number): string[] {
    const stamp = new Date(Number(this.generatedDate) * 1000 + zoneOffset(Number(this.generatedDate) * 1000) * 60000)
      .toISOString().slice(0, 19).replace(/[-:]/g, '');
    const lines = [`# KRL version ${this.version}`, `# Generated at ${stamp}`];
    if (this.comment !== '') lines.push(`# Comment: ${this.comment}`);
    lines.push('');
    for (const blob of this.explicitKeys.sorted()) {
      const key = sshPublicKeyFromBlob(blob);
      if (key === null) continue;
      lines.push(`hash: SHA256:${keygenBlobDigest(bytesToBase64(blob), 'sha256')} # ${key.algorithm}`);
    }
    for (const hash of this.sha256Hashes.sorted()) lines.push(`hash: SHA256:${bytesToHex(hash)}`);
    for (const hash of this.sha1Hashes.sorted()) lines.push(`# hash SHA1:${bytesToHex(hash)}`);
    for (const group of this.certificateGroups) {
      lines.push('');
      const authority = group.caBlob === null ? null : sshPublicKeyFromBlob(group.caBlob);
      lines.push(authority === null || group.caBlob === null
        ? '# Wildcard CA'
        : `# CA key ${authority.algorithm} ${keygenBlobDigest(bytesToBase64(group.caBlob), 'sha256')}`);
      for (const range of group.serials) {
        lines.push(range.lo === range.hi ? `serial: ${range.lo}` : `serial: ${range.lo}-${range.hi}`);
      }
      for (const id of [...group.keyIds].sort()) lines.push(`id: ${id}`);
    }
    return lines;
  }

  static isKrl(bytes: Uint8Array): boolean {
    return bytes.length >= KRL_MAGIC.length && KRL_MAGIC.every((byte, index) => bytes[index] === byte);
  }

  static parse(bytes: Uint8Array): KrlParse {
    const logs: string[] = [];
    const failure = (kind: KrlFailure): KrlParse => ({ ok: false, failure: kind, logs });
    if (!KeyRevocationList.isKrl(bytes)) return failure('bad-magic');
    const krl = new KeyRevocationList();
    try {
      const reader = new SshReader(bytes.slice(KRL_MAGIC.length));
      if (reader.readUint32() !== KRL_FORMAT_VERSION) return failure('invalid-format');
      krl.version = reader.readBigUint64();
      krl.generatedDate = reader.readBigUint64();
      krl.flags = reader.readBigUint64();
      reader.readBytes();
      krl.comment = reader.readString();
      const sections: Array<{ type: number; body: Uint8Array }> = [];
      const signers: SshPublicKey[] = [];
      let signatureSeen = false;
      while (reader.remaining > 0) {
        const type = reader.readByte();
        const body = reader.readBytes();
        if (type !== SECTION_SIGNATURE) {
          if (signatureSeen) {
            logs.push('KRL contains non-signature section after signature');
            return failure('invalid-format');
          }
          sections.push({ type, body });
          continue;
        }
        signatureSeen = true;
        const signer = sshPublicKeyFromBlob(body);
        if (signer === null) return failure('invalid-format');
        const signedLength = bytes.length - reader.remaining;
        const signature = reader.readBytes();
        const algorithm = new SshReader(signature).readString();
        if (!verifyUserauthSignature(body, algorithm, signature, bytes.slice(0, signedLength))) return failure('signature-invalid');
        if (signers.some((known) => sameBlob(sshPublicKeyBlob(known), body))) {
          logs.push('KRL signed more than once with the same key');
          return failure('invalid-format');
        }
        signers.push(signer);
      }
      for (const section of sections) {
        const outcome = krl.load(section.type, section.body, logs);
        if (outcome !== null) return failure(outcome);
      }
      if (signers.length > 0 && signers.every((signer) => krl.isRevoked(signer))) {
        logs.push('All keys used to sign KRL were revoked');
        return failure('key-revoked');
      }
    } catch {
      return failure('invalid-format');
    }
    return { ok: true, krl };
  }

  private load(type: number, body: Uint8Array, logs: string[]): KrlFailure | null {
    const reader = new SshReader(body);
    if (type === SECTION_CERTIFICATES) return this.loadCertificates(reader, logs);
    const expected = type === SECTION_FINGERPRINT_SHA1 ? 20 : type === SECTION_FINGERPRINT_SHA256 ? 32 : 0;
    if (type !== SECTION_EXPLICIT_KEY && expected === 0) {
      logs.push(`Unsupported KRL section ${type}`);
      return 'invalid-format';
    }
    while (reader.remaining > 0) {
      const blob = reader.readBytes();
      if (expected !== 0 && blob.length !== expected) return 'invalid-format';
      if (type === SECTION_EXPLICIT_KEY) this.explicitKeys.add(blob);
      else if (type === SECTION_FINGERPRINT_SHA1) this.sha1Hashes.add(blob);
      else this.sha256Hashes.add(blob);
    }
    return null;
  }

  private loadCertificates(reader: SshReader, logs: string[]): KrlFailure | null {
    const authorityBlob = reader.readBytes();
    reader.readBytes();
    let authority: SshPublicKey | null = null;
    if (authorityBlob.length > 0) {
      authority = sshPublicKeyFromBlob(authorityBlob);
      if (authority === null) return 'invalid-format';
    }
    this.groupFor(authority);
    while (reader.remaining > 0) {
      const type = reader.readByte();
      const body = new SshReader(reader.readBytes());
      if (type === CERT_SERIAL_LIST) {
        while (body.remaining > 0) {
          const serial = body.readBigUint64();
          this.revokeSerialRange(authority, serial, serial);
        }
      } else if (type === CERT_SERIAL_RANGE) {
        this.revokeSerialRange(authority, body.readBigUint64(), body.readBigUint64());
      } else if (type === CERT_SERIAL_BITMAP) {
        const start = body.readBigUint64();
        const bitmap = body.readMpint();
        for (let bit = 0n; bitmap >> bit > 0n; bit++) {
          if (((bitmap >> bit) & 1n) === 1n) this.revokeSerialRange(authority, start + bit, start + bit);
        }
      } else if (type === CERT_KEY_ID) {
        while (body.remaining > 0) this.revokeKeyId(authority, readCString(body));
      } else {
        logs.push(`Unsupported KRL certificate section ${type}`);
        return 'invalid-format';
      }
      if (body.remaining > 0) {
        logs.push('KRL certificate section contains unparsed data');
        return 'invalid-format';
      }
    }
    return null;
  }
}

function cstringList(values: readonly string[]): Uint8Array {
  const writer = new SshWriter();
  for (const value of values) writer.writeString(value);
  return writer.toBytes();
}

function readCString(reader: SshReader): string {
  return reader.readString();
}
