import { ed25519Sign, ed25519Verify } from '@/crypto/ecc/ed25519';
import { p256Sign, p256Verify, P256_FIELD_BYTES } from '@/crypto/ecc/p256';
import { rsaSign, rsaVerify, type RsaSignatureHash } from '@/crypto/rsa/rsa';
import {
  sshPublicKeyFromBlob,
  type SshPrivateKey,
  type SshPublicKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import { SSH_CONNECTION_SERVICE, SSH_MSG_USERAUTH_REQUEST } from '../transport/SshMessageNumbers';

export function userauthSignatureAlgorithm(key: SshPublicKey): string {
  return key.algorithm === 'ssh-rsa' ? 'rsa-sha2-256' : key.algorithm;
}

const RSA_SIGNATURE_HASHES: Readonly<Record<string, RsaSignatureHash>> = {
  'rsa-sha2-512': 'sha512',
  'rsa-sha2-256': 'sha256',
  'ssh-rsa': 'sha1',
};

export function signatureAlgorithmsFor(key: SshPublicKey): readonly string[] {
  return key.algorithm === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256'] : [key.algorithm];
}

export function hostKeySignatureAlgorithmsFor(key: SshPublicKey): readonly string[] {
  return key.algorithm === 'ssh-rsa' ? Object.keys(RSA_SIGNATURE_HASHES) : [key.algorithm];
}

export function userauthSignedData(
  sessionId: Uint8Array, user: string, algorithm: string, publicKeyBlob: Uint8Array,
): Uint8Array {
  return new SshWriter()
    .writeBytes(sessionId)
    .writeByte(SSH_MSG_USERAUTH_REQUEST)
    .writeString(user)
    .writeString(SSH_CONNECTION_SERVICE)
    .writeString('publickey')
    .writeByte(1)
    .writeString(algorithm)
    .writeBytes(publicKeyBlob)
    .toBytes();
}

function rawSignature(key: SshPrivateKey, algorithm: string, data: Uint8Array): Uint8Array {
  if (key.algorithm === 'ssh-ed25519') return ed25519Sign(key.seed, data);
  if (key.algorithm === 'ssh-rsa') return rsaSign({ n: key.n, e: key.e, d: key.d }, data, RSA_SIGNATURE_HASHES[algorithm]);
  const { r, s } = p256Sign(key.d, data);
  return new SshWriter().writeMpint(r).writeMpint(s).toBytes();
}

export function signUserauth(key: SshPrivateKey, data: Uint8Array): Uint8Array {
  return signWithAlgorithm(key, userauthSignatureAlgorithm(key), data);
}

export function signWithAlgorithm(key: SshPrivateKey, algorithm: string, data: Uint8Array): Uint8Array {
  return new SshWriter()
    .writeString(algorithm)
    .writeBytes(rawSignature(key, algorithm, data))
    .toBytes();
}

function bigIntFromBytes(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function verifyRaw(key: SshPublicKey, algorithm: string, data: Uint8Array, signature: Uint8Array): boolean {
  if (key.algorithm === 'ssh-ed25519') return ed25519Verify(key.publicKey, data, signature);
  if (key.algorithm === 'ssh-rsa') return rsaVerify({ n: key.n, e: key.e }, data, signature, RSA_SIGNATURE_HASHES[algorithm]);
  const reader = new SshReader(signature);
  const r = reader.readMpint();
  const s = reader.readMpint();
  if (reader.remaining !== 0) return false;
  const q = {
    x: bigIntFromBytes(key.q.subarray(1, 1 + P256_FIELD_BYTES)),
    y: bigIntFromBytes(key.q.subarray(1 + P256_FIELD_BYTES)),
  };
  return p256Verify(q, data, { r, s });
}

export function verifyUserauthSignature(
  publicKeyBlob: Uint8Array, algorithm: string, signatureBlob: Uint8Array, data: Uint8Array,
): boolean {
  const key = sshPublicKeyFromBlob(publicKeyBlob);
  if (key === null || !hostKeySignatureAlgorithmsFor(key).includes(algorithm)) return false;
  try {
    const reader = new SshReader(signatureBlob);
    if (reader.readString() !== algorithm) return false;
    const signature = reader.readBytes();
    if (reader.remaining !== 0) return false;
    return verifyRaw(key, algorithm, data, signature);
  } catch {
    return false;
  }
}
