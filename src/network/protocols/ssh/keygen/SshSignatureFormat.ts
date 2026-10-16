import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import { sha256, sha512 } from '@/crypto/hash';
import {
  sshPublicKeyBlob,
  sshPublicKeyFromBlob,
  type SshPrivateKey,
  type SshPublicKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { signWithAlgorithm, verifyUserauthSignature } from '../auth/UserauthSignature';
import { SshReader, SshWriter } from '../wire/SshDataTypes';

const MAGIC_PREAMBLE = 'SSHSIG';
const SIGNATURE_VERSION = 1;
const BEGIN_SIGNATURE = '-----BEGIN SSH SIGNATURE-----\n';
const END_SIGNATURE = '-----END SSH SIGNATURE-----';
const RSA_SIGN_ALGORITHM = 'rsa-sha2-512';
const RSA_SIGN_ALLOWED = ['rsa-sha2-512', 'rsa-sha2-256'];
const ARMOR_COLUMNS = 70;

export const SIGNATURE_HASH_DEFAULT = 'sha512';
const SIGNATURE_HASHES: Readonly<Record<string, (data: Uint8Array) => Uint8Array>> = { sha256, sha512 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SignatureOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

function failure(...errors: string[]): { readonly ok: false; readonly errors: readonly string[] } {
  return { ok: false, errors };
}

export function armorSignature(blob: Uint8Array): string {
  const encoded = bytesToBase64(blob);
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += ARMOR_COLUMNS) lines.push(encoded.slice(at, at + ARMOR_COLUMNS));
  return `${BEGIN_SIGNATURE}${lines.join('\n')}\n${END_SIGNATURE}\n`;
}

export function dearmorSignature(text: string): SignatureOutcome<Uint8Array> {
  if (!text.startsWith(BEGIN_SIGNATURE)) return failure("Couldn't parse signature: missing header");
  const body = text.slice(BEGIN_SIGNATURE.length);
  const footer = body.indexOf(`\n${END_SIGNATURE}`);
  if (footer < 0) return failure("Couldn't parse signature: missing footer");
  const encoded = body.slice(0, footer).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return failure('sshsig_dearmor: decode base64: invalid format', 'sig_verify: sshsig_armor: invalid format');
  }
  return { ok: true, value: base64ToBytes(encoded) };
}

function hashWith(algorithm: string, data: Uint8Array): SignatureOutcome<Uint8Array> {
  const digest = SIGNATURE_HASHES[algorithm];
  if (digest === undefined) {
    return failure(`sshsig_check_hashalg: unsupported hash algorithm "${algorithm.slice(0, 100)}"`);
  }
  return { ok: true, value: digest(data) };
}

function signedData(namespace: string, hashAlgorithm: string, digest: Uint8Array): Uint8Array {
  return new SshWriter()
    .writeRaw(encoder.encode(MAGIC_PREAMBLE))
    .writeString(namespace)
    .writeBytes(new Uint8Array(0))
    .writeString(hashAlgorithm)
    .writeBytes(digest)
    .toBytes();
}

export function signMessage(
  key: SshPrivateKey, hashAlgorithm: string | undefined, namespace: string, message: Uint8Array,
): SignatureOutcome<Uint8Array> {
  const algorithm = hashAlgorithm ?? SIGNATURE_HASH_DEFAULT;
  const digest = hashWith(algorithm, message);
  if (digest.ok === false) return failure(...digest.errors, 'sshsig_sign_fd: hash_file: signature algorithm not supported');
  const signatureAlgorithm = key.algorithm === 'ssh-rsa' ? RSA_SIGN_ALGORITHM : key.algorithm;
  const signature = signWithAlgorithm(key, signatureAlgorithm, signedData(namespace, algorithm, digest.value));
  const blob = new SshWriter()
    .writeRaw(encoder.encode(MAGIC_PREAMBLE))
    .writeUint32(SIGNATURE_VERSION)
    .writeBytes(sshPublicKeyBlob(key))
    .writeString(namespace)
    .writeBytes(new Uint8Array(0))
    .writeString(algorithm)
    .writeBytes(signature)
    .toBytes();
  return { ok: true, value: blob };
}

function expectPreamble(reader: SshReader): SignatureOutcome<null> {
  const invalid = failure("Couldn't verify signature: invalid format");
  try {
    if (decoder.decode(reader.readRaw(MAGIC_PREAMBLE.length)) !== MAGIC_PREAMBLE) return invalid;
    const version = reader.readUint32();
    if (version > SIGNATURE_VERSION) {
      return failure(`Signature version ${version} is larger than supported version ${SIGNATURE_VERSION}`);
    }
  } catch {
    return invalid;
  }
  return { ok: true, value: null };
}

export interface SignatureSigner {
  readonly key: SshPublicKey;
  readonly blob: Uint8Array;
}

export function signerOfSignature(blob: Uint8Array): SignatureOutcome<SignatureSigner> {
  const reader = new SshReader(blob);
  const preamble = expectPreamble(reader);
  if (preamble.ok === false) return preamble;
  try {
    const keyBlob = reader.readBytes();
    const key = sshPublicKeyFromBlob(keyBlob);
    if (key === null) return failure('sshkey_froms: invalid format');
    return { ok: true, value: { key, blob: keyBlob } };
  } catch {
    return failure('sshkey_froms: incomplete message');
  }
}

function peekHashAlgorithm(blob: Uint8Array): SignatureOutcome<string> {
  const reader = new SshReader(blob);
  const preamble = expectPreamble(reader);
  if (preamble.ok === false) return preamble;
  try {
    reader.readBytes();
    reader.readBytes();
    reader.readBytes();
    const hashAlgorithm = reader.readString();
    reader.readBytes();
    return { ok: true, value: hashAlgorithm };
  } catch {
    return failure('sshsig_peek_hashalg: parse signature object: incomplete message');
  }
}

export function verifyMessage(
  blob: Uint8Array, message: Uint8Array, expectedNamespace: string,
): SignatureOutcome<SignatureSigner> {
  const peeked = peekHashAlgorithm(blob);
  if (peeked.ok === false) return peeked;
  const hashAlgorithm = peeked.value;
  const digest = hashWith(hashAlgorithm, message);
  if (digest.ok === false) return failure(...digest.errors, 'sshsig_verify_fd: hash_file: signature algorithm not supported');
  const reader = new SshReader(blob);
  const preamble = expectPreamble(reader);
  if (preamble.ok === false) return preamble;
  let signer: SignatureSigner;
  let namespace: string;
  let signatureHash: string;
  let signature: Uint8Array;
  try {
    const keyBlob = reader.readBytes();
    const key = sshPublicKeyFromBlob(keyBlob);
    if (key === null) return failure('sshsig_wrap_verify: parse signature object: invalid format');
    signer = { key, blob: keyBlob };
    namespace = reader.readString();
    reader.readBytes();
    signatureHash = reader.readString();
    signature = reader.readBytes();
  } catch {
    return failure('sshsig_wrap_verify: parse signature object: incomplete message');
  }
  if (reader.remaining !== 0) return failure('Signature contains trailing data');
  if (namespace !== expectedNamespace) return failure("Couldn't verify signature: namespace does not match");
  if (signatureHash !== hashAlgorithm) return failure("Couldn't verify signature: hash algorithm mismatch");
  let signatureAlgorithm: string;
  try {
    signatureAlgorithm = new SshReader(signature).readString();
  } catch {
    return failure("Couldn't verify signature: unable to get signature type: incomplete message");
  }
  if (signer.key.algorithm === 'ssh-rsa' && !RSA_SIGN_ALLOWED.includes(signatureAlgorithm)) {
    return failure(`Couldn't verify signature: unsupported RSA signature algorithm ${signatureAlgorithm}`);
  }
  if (!verifyUserauthSignature(signer.blob, signatureAlgorithm, signature, signedData(expectedNamespace, hashAlgorithm, digest.value))) {
    return failure('Signature verification failed: incorrect signature');
  }
  return { ok: true, value: signer };
}
