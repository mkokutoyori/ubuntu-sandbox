import { SHA1, SHA256, SHA384, SHA512, type HashAlgorithm } from '@/crypto/hash';
import { pbkdf2 } from '@/crypto/kdf';
import { aesCbcEncrypt, aesCbcDecrypt, tripleDesCbcEncrypt, tripleDesCbcDecrypt } from '@/crypto/cipher';
import { utf8ToBytes } from '@/crypto/encoding';
import type { PkiPrivateKey } from '../PkiKeyPair';
import { der, children, parseDer, integerValue, oidValue, DerError } from './Asn1';
import { encodePrivateKeyPkcs8, decodePrivateKeyPkcs8 } from './KeyDer';

const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
export type KeyEncryptionCipher = 'aes-128-cbc' | 'aes-192-cbc' | 'aes-256-cbc' | 'des-ede3-cbc';

interface CipherSpec { readonly oid: string; readonly keyLength: number; readonly ivLength: number }

const CIPHER_SPECS: Readonly<Record<KeyEncryptionCipher, CipherSpec>> = {
  'aes-128-cbc': { oid: '2.16.840.1.101.3.4.1.2', keyLength: 16, ivLength: 16 },
  'aes-192-cbc': { oid: '2.16.840.1.101.3.4.1.22', keyLength: 24, ivLength: 16 },
  'aes-256-cbc': { oid: '2.16.840.1.101.3.4.1.42', keyLength: 32, ivLength: 16 },
  'des-ede3-cbc': { oid: '1.2.840.113549.3.7', keyLength: 24, ivLength: 8 },
};

function specByOid(oid: string): CipherSpec | undefined {
  return Object.values(CIPHER_SPECS).find((spec) => spec.oid === oid);
}

function cbcSeal(spec: CipherSpec, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (spec.ivLength === 16) return aesCbcEncrypt(key, iv, data);
  const pad = 8 - (data.length % 8);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data, 0);
  padded.fill(pad, data.length);
  return tripleDesCbcEncrypt(key, iv, padded);
}

function cbcOpen(spec: CipherSpec, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (spec.ivLength === 16) return aesCbcDecrypt(key, iv, data);
  const padded = tripleDesCbcDecrypt(key, iv, data);
  const pad = padded[padded.length - 1];
  if (pad === 0 || pad > 8) throw new DerError('bad padding');
  for (let i = padded.length - pad; i < padded.length; i++) if (padded[i] !== pad) throw new DerError('bad padding');
  return padded.subarray(0, padded.length - pad);
}
const PRF_OIDS: Readonly<Record<string, HashAlgorithm>> = {
  '1.2.840.113549.2.7': SHA1,
  '1.2.840.113549.2.9': SHA256,
  '1.2.840.113549.2.10': SHA384,
  '1.2.840.113549.2.11': SHA512,
};
const OID_HMAC_SHA256 = '1.2.840.113549.2.9';
const DEFAULT_ITERATIONS = 2048;
const SALT_LENGTH = 16;

export function encryptPrivateKeyPkcs8(
  key: PkiPrivateKey, passphrase: string, random: (length: number) => Uint8Array, iterations = DEFAULT_ITERATIONS,
  cipher: KeyEncryptionCipher = 'aes-256-cbc',
): Uint8Array {
  const spec = CIPHER_SPECS[cipher];
  const salt = random(SALT_LENGTH);
  const iv = random(spec.ivLength);
  const derived = pbkdf2(SHA256, utf8ToBytes(passphrase), salt, iterations, spec.keyLength);
  const encrypted = cbcSeal(spec, derived, iv, encodePrivateKeyPkcs8(key));
  return der.sequence(
    der.sequence(
      der.oid(OID_PBES2),
      der.sequence(
        der.sequence(der.oid(OID_PBKDF2), der.sequence(der.octetString(salt), der.integer(BigInt(iterations)), der.sequence(der.oid(OID_HMAC_SHA256), der.null()))),
        der.sequence(der.oid(spec.oid), der.octetString(iv)),
      ),
    ),
    der.octetString(encrypted),
  );
}

export function decryptPrivateKeyPkcs8(bytes: Uint8Array, passphrase: string): PkiPrivateKey | null {
  try {
    const [algorithm, data] = children(parseDer(bytes));
    const [scheme, parameters] = children(algorithm);
    if (oidValue(scheme) !== OID_PBES2) throw new DerError('unsupported encryption scheme');
    const [kdf, cipher] = children(parameters);
    const [kdfOid, kdfParameters] = children(kdf);
    if (oidValue(kdfOid) !== OID_PBKDF2) throw new DerError('unsupported key derivation');
    const fields = children(kdfParameters);
    const salt = fields[0].content;
    const iterations = Number(integerValue(fields[1]));
    const prfNode = fields.find((field) => field.tag === 0x30);
    const prf = prfNode ? PRF_OIDS[oidValue(children(prfNode)[0])] : SHA1;
    const [cipherOid, iv] = children(cipher);
    const spec = specByOid(oidValue(cipherOid));
    if (spec === undefined || prf === undefined) throw new DerError('unsupported cipher or PRF');
    const derived = pbkdf2(prf, utf8ToBytes(passphrase), salt, iterations, spec.keyLength);
    return decodePrivateKeyPkcs8(cbcOpen(spec, derived, iv.content, data.content));
  } catch {
    return null;
  }
}
