import { SHA1, SHA256, SHA384, SHA512, type HashAlgorithm } from '@/crypto/hash';
import { pbkdf2 } from '@/crypto/kdf';
import { aesCbcEncrypt, aesCbcDecrypt } from '@/crypto/cipher';
import { utf8ToBytes } from '@/crypto/encoding';
import type { PkiPrivateKey } from '../PkiKeyPair';
import { der, children, parseDer, integerValue, oidValue, DerError } from './Asn1';
import { encodePrivateKeyPkcs8, decodePrivateKeyPkcs8 } from './KeyDer';

const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const AES_CBC_OIDS: Readonly<Record<string, number>> = {
  '2.16.840.1.101.3.4.1.2': 16,
  '2.16.840.1.101.3.4.1.22': 24,
  '2.16.840.1.101.3.4.1.42': 32,
};
const PRF_OIDS: Readonly<Record<string, HashAlgorithm>> = {
  '1.2.840.113549.2.7': SHA1,
  '1.2.840.113549.2.9': SHA256,
  '1.2.840.113549.2.10': SHA384,
  '1.2.840.113549.2.11': SHA512,
};
const OID_AES_256_CBC = '2.16.840.1.101.3.4.1.42';
const OID_HMAC_SHA256 = '1.2.840.113549.2.9';
const DEFAULT_ITERATIONS = 2048;
const SALT_LENGTH = 16;
const IV_LENGTH = 16;
const AES_256_KEY_LENGTH = 32;

export function encryptPrivateKeyPkcs8(
  key: PkiPrivateKey, passphrase: string, random: (length: number) => Uint8Array, iterations = DEFAULT_ITERATIONS,
): Uint8Array {
  const salt = random(SALT_LENGTH);
  const iv = random(IV_LENGTH);
  const derived = pbkdf2(SHA256, utf8ToBytes(passphrase), salt, iterations, AES_256_KEY_LENGTH);
  const encrypted = aesCbcEncrypt(derived, iv, encodePrivateKeyPkcs8(key));
  return der.sequence(
    der.sequence(
      der.oid(OID_PBES2),
      der.sequence(
        der.sequence(der.oid(OID_PBKDF2), der.sequence(der.octetString(salt), der.integer(BigInt(iterations)), der.sequence(der.oid(OID_HMAC_SHA256), der.null()))),
        der.sequence(der.oid(OID_AES_256_CBC), der.octetString(iv)),
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
    const keyLength = AES_CBC_OIDS[oidValue(cipherOid)];
    if (keyLength === undefined || prf === undefined) throw new DerError('unsupported cipher or PRF');
    const derived = pbkdf2(prf, utf8ToBytes(passphrase), salt, iterations, keyLength);
    return decodePrivateKeyPkcs8(aesCbcDecrypt(derived, iv.content, data.content));
  } catch {
    return null;
  }
}
