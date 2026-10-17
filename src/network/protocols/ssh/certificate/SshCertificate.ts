import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import {
  keygenBlobDigest,
  sshPublicKeyBlob,
  sshPublicKeyFromBlob,
  type SshPrivateKey,
  type SshPublicKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { signWithAlgorithm, verifyUserauthSignature } from '../auth/UserauthSignature';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import { matchesPatternList } from '../client/SshClientConfigFile';
import { formatAbsoluteTime, type ZoneOffset } from '../keygen/AbsoluteTime';

export const SSH_CERT_TYPE_USER = 1;
export const SSH_CERT_TYPE_HOST = 2;
export const CERT_FOREVER = 0xffffffffffffffffn;

const CERT_SUFFIX = '-cert-v01@openssh.com';
const NONCE_BYTES = 32;

export interface CertificateOption {
  readonly name: string;
  readonly value: string | null;
}

export interface SshCertificate {
  readonly algorithm: string;
  readonly nonce: Uint8Array;
  readonly subject: SshPublicKey;
  readonly serial: bigint;
  readonly type: number;
  readonly keyId: string;
  readonly principals: readonly string[];
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly critical: readonly CertificateOption[];
  readonly extensions: readonly CertificateOption[];
  readonly reserved: Uint8Array;
  readonly caKey: SshPublicKey;
  readonly signedBytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly signatureType: string;
  readonly blob: Uint8Array;
}

export interface CertificateRequest {
  readonly subject: SshPublicKey;
  readonly serial: bigint;
  readonly type: number;
  readonly keyId: string;
  readonly principals: readonly string[];
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly critical: readonly CertificateOption[];
  readonly extensions: readonly CertificateOption[];
}

export function certificateAlgorithmOf(keyAlgorithm: string): string {
  return `${keyAlgorithm}${CERT_SUFFIX}`;
}

export function plainAlgorithmOf(certificateAlgorithm: string): string | null {
  return certificateAlgorithm.endsWith(CERT_SUFFIX) ? certificateAlgorithm.slice(0, -CERT_SUFFIX.length) : null;
}

export function isCertificateAlgorithm(algorithm: string): boolean {
  return plainAlgorithmOf(algorithm) !== null;
}

function optionsBytes(options: readonly CertificateOption[]): Uint8Array {
  const writer = new SshWriter();
  for (const option of options) {
    writer.writeString(option.name);
    writer.writeBytes(option.value === null ? new Uint8Array(0) : new SshWriter().writeString(option.value).toBytes());
  }
  return writer.toBytes();
}

function parseOptions(bytes: Uint8Array): CertificateOption[] {
  const reader = new SshReader(bytes);
  const options: CertificateOption[] = [];
  while (reader.remaining > 0) {
    const name = reader.readString();
    const data = reader.readBytes();
    options.push({ name, value: data.length === 0 ? null : new SshReader(data).readString() });
  }
  return options;
}

function subjectFields(subject: SshPublicKey): Uint8Array {
  const blob = sshPublicKeyBlob(subject);
  const reader = new SshReader(blob);
  reader.readBytes();
  return reader.readRaw(reader.remaining);
}

function subjectFromFields(algorithm: string, fields: Uint8Array): SshPublicKey | null {
  const blob = new SshWriter().writeString(algorithm).writeRaw(fields).toBytes();
  return sshPublicKeyFromBlob(blob);
}

export function certificateSignatureAlgorithm(caKey: SshPublicKey, requested?: string): string {
  if (caKey.algorithm !== 'ssh-rsa') return caKey.algorithm;
  return requested === 'rsa-sha2-256' || requested === 'ssh-rsa' ? requested : 'rsa-sha2-512';
}

function body(request: CertificateRequest, nonce: Uint8Array, caKey: SshPublicKey): Uint8Array {
  const writer = new SshWriter()
    .writeString(certificateAlgorithmOf(request.subject.algorithm))
    .writeBytes(nonce)
    .writeRaw(subjectFields(request.subject))
    .writeBigUint64(request.serial)
    .writeUint32(request.type)
    .writeString(request.keyId);
  const principals = new SshWriter();
  for (const principal of request.principals) principals.writeString(principal);
  writer
    .writeBytes(principals.toBytes())
    .writeBigUint64(request.validAfter)
    .writeBigUint64(request.validBefore)
    .writeBytes(optionsBytes(request.critical))
    .writeBytes(optionsBytes(request.extensions))
    .writeBytes(new Uint8Array(0))
    .writeBytes(sshPublicKeyBlob(caKey));
  return writer.toBytes();
}

export type CertificateSigner = (data: Uint8Array, algorithm: string) => Uint8Array | null;

export function certify(
  request: CertificateRequest, caKey: SshPrivateKey, signatureAlgorithm: string | undefined, random: (count: number) => Uint8Array,
): SshCertificate {
  const certificate = certifyWith(request, caKey, signatureAlgorithm, random, (data, algorithm) => signWithAlgorithm(caKey, algorithm, data));
  if (certificate === null) throw new RangeError('certificate signing failed');
  return certificate;
}

export function certifyWith(
  request: CertificateRequest, caKey: SshPublicKey, signatureAlgorithm: string | undefined, random: (count: number) => Uint8Array,
  sign: CertificateSigner,
): SshCertificate | null {
  const nonce = random(NONCE_BYTES);
  const signed = body(request, nonce, caKey);
  const signature = sign(signed, certificateSignatureAlgorithm(caKey, signatureAlgorithm));
  if (signature === null) return null;
  const blob = new SshWriter().writeRaw(signed).writeBytes(signature).toBytes();
  const parsed = parseCertificateBlob(blob);
  if (parsed === null) throw new RangeError('certificate encoding failed');
  return parsed;
}

export function parseCertificateBlob(blob: Uint8Array): SshCertificate | null {
  try {
    const reader = new SshReader(blob);
    const algorithm = reader.readString();
    const plain = plainAlgorithmOf(algorithm);
    if (plain === null) return null;
    const nonce = reader.readBytes();
    const fieldStart = blob.length - reader.remaining;
    let subject: SshPublicKey | null = null;
    if (plain === 'ssh-rsa') {
      reader.readBytes();
      reader.readBytes();
    } else if (plain === 'ssh-ed25519') {
      reader.readBytes();
    } else {
      reader.readBytes();
      reader.readBytes();
    }
    const fieldEnd = blob.length - reader.remaining;
    subject = subjectFromFields(plain, blob.slice(fieldStart, fieldEnd));
    if (subject === null) return null;
    const serial = reader.readBigUint64();
    const type = reader.readUint32();
    const keyId = reader.readString();
    const principalReader = new SshReader(reader.readBytes());
    const principals: string[] = [];
    while (principalReader.remaining > 0) principals.push(principalReader.readString());
    const validAfter = reader.readBigUint64();
    const validBefore = reader.readBigUint64();
    const critical = parseOptions(reader.readBytes());
    const extensions = parseOptions(reader.readBytes());
    const reserved = reader.readBytes();
    const caKey = sshPublicKeyFromBlob(reader.readBytes());
    if (caKey === null) return null;
    const signedEnd = blob.length - reader.remaining;
    const signature = reader.readBytes();
    if (reader.remaining !== 0) return null;
    return {
      algorithm, nonce, subject, serial, type, keyId, principals, validAfter, validBefore, critical, extensions, reserved,
      caKey, signedBytes: blob.slice(0, signedEnd), signature, signatureType: new SshReader(signature).readString(), blob,
    };
  } catch {
    return null;
  }
}

export function certificateLine(certificate: SshCertificate, comment: string): string {
  return `${certificate.algorithm} ${bytesToBase64(certificate.blob)}${comment === '' ? '' : ` ${comment}`}`;
}

export function parseCertificateLine(text: string): { certificate: SshCertificate; comment: string } | null {
  const [algorithm, encoded, ...rest] = text.trim().split(/\s+/);
  if (algorithm === undefined || encoded === undefined || !isCertificateAlgorithm(algorithm)) return null;
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(encoded);
  } catch {
    return null;
  }
  const certificate = parseCertificateBlob(blob);
  return certificate === null || certificate.algorithm !== algorithm ? null : { certificate, comment: rest.join(' ') };
}

export function verifyCertificateSignature(certificate: SshCertificate): boolean {
  return verifyUserauthSignature(
    sshPublicKeyBlob(certificate.caKey), certificate.signatureType, certificate.signature, certificate.signedBytes,
  );
}

export function certificateTypeName(certificate: SshCertificate): string {
  if (certificate.type === SSH_CERT_TYPE_USER) return 'user';
  return certificate.type === SSH_CERT_TYPE_HOST ? 'host' : 'unknown';
}

export interface AuthorityQuery {
  readonly wantHost: boolean;
  readonly requirePrincipal: boolean;
  readonly wildcardPattern: boolean;
  readonly verifyTime: bigint;
  readonly name?: string;
}

export function certificateAuthorityRefusal(certificate: SshCertificate, query: AuthorityQuery): string | null {
  if (query.wantHost) {
    if (certificate.type !== SSH_CERT_TYPE_HOST) return 'Certificate invalid: not a host certificate';
  } else if (certificate.type !== SSH_CERT_TYPE_USER) {
    return 'Certificate invalid: not a user certificate';
  }
  if (query.verifyTime < certificate.validAfter) return 'Certificate invalid: not yet valid';
  if (query.verifyTime >= certificate.validBefore) return 'Certificate invalid: expired';
  if (certificate.principals.length === 0) {
    return query.requirePrincipal ? 'Certificate lacks principal list' : null;
  }
  if (query.name === undefined) return null;
  const matches = certificate.principals.some((principal) => query.wildcardPattern
    ? matchesPatternList(query.name!, principal, false)
    : principal === query.name);
  return matches ? null : 'Certificate invalid: name is not a listed principal';
}

export function certificateOption(options: readonly CertificateOption[], name: string): CertificateOption | undefined {
  return options.find((option) => option.name === name);
}

export function formatCertificateValidity(certificate: SshCertificate, zoneOffset: ZoneOffset): string {
  if (certificate.validAfter === 0n && certificate.validBefore === CERT_FOREVER) return 'forever';
  const from = certificate.validAfter === 0n ? '' : formatAbsoluteTime(Number(certificate.validAfter), zoneOffset);
  const to = certificate.validBefore === CERT_FOREVER ? '' : formatAbsoluteTime(Number(certificate.validBefore), zoneOffset);
  if (certificate.validAfter === 0n) return `before ${to}`;
  if (certificate.validBefore === CERT_FOREVER) return `after ${from}`;
  return `from ${from} to ${to}`;
}

export function describeHostCertificate(certificate: SshCertificate, zoneOffset: ZoneOffset): string {
  const fingerprint = keygenBlobDigest(bytesToBase64(certificate.blob), 'sha256');
  const authority = keygenBlobDigest(bytesToBase64(sshPublicKeyBlob(certificate.caKey)), 'sha256');
  return `${certificate.algorithm} ${fingerprint}, serial ${certificate.serial} ID "${certificate.keyId}" `
    + `CA ${certificate.caKey.algorithm} ${authority} valid ${formatCertificateValidity(certificate, zoneOffset)}`;
}
