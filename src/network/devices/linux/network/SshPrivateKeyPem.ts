import { aesCbcDecrypt, aesCbcEncrypt } from '@/crypto/cipher/aesCbc';
import { NIST_CURVES, type NistCurveName } from '@/crypto/ecc/nistCurves';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import { SHA1 } from '@/crypto/hash/sha1';
import { SHA256 } from '@/crypto/hash/sha256';
import { evpBytesToKey } from '@/crypto/kdf/evpBytesToKey';
import { pbkdf2 } from '@/crypto/kdf/pbkdf2';
import type { RandomBytes } from '@/crypto/rsa/rsa';
import { children, der, integerValue, oidValue, parseDer, readNode, type DerNode } from '@/network/pki/der/Asn1';
import type { EcdsaAlgorithm, PrivateKeyLoad, SshPrivateKey } from './SshKeygenMaterial';

export type PemPrivateFormat = 'PEM' | 'PKCS8';

const OID_RSA = '1.2.840.113549.1.1.1';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const OID_HMAC_SHA1 = '1.2.840.113549.2.7';
const OID_HMAC_SHA256 = '1.2.840.113549.2.9';

const PBKDF2_ITERATIONS = 2048;
const PBKDF2_SALT_BYTES = 8;
const TAG_EXPLICIT_0 = 0xa0;
const TAG_EXPLICIT_1 = 0xa1;
const TAG_OCTET_STRING = 0x04;
const TAG_SEQUENCE = 0x30;

interface CurveFacts {
  readonly algorithm: EcdsaAlgorithm;
  readonly curve: NistCurveName;
  readonly oid: string;
  readonly scalarBytes: number;
}

const CURVES: readonly CurveFacts[] = [
  { algorithm: 'ecdsa-sha2-nistp256', curve: 'nistp256', oid: '1.2.840.10045.3.1.7', scalarBytes: 32 },
  { algorithm: 'ecdsa-sha2-nistp384', curve: 'nistp384', oid: '1.3.132.0.34', scalarBytes: 48 },
  { algorithm: 'ecdsa-sha2-nistp521', curve: 'nistp521', oid: '1.3.132.0.35', scalarBytes: 66 },
];

const CBC_CIPHERS: Readonly<Record<string, { readonly name: string; readonly keyBytes: number }>> = {
  '2.16.840.1.101.3.4.1.2': { name: 'AES-128-CBC', keyBytes: 16 },
  '2.16.840.1.101.3.4.1.22': { name: 'AES-192-CBC', keyBytes: 24 },
  '2.16.840.1.101.3.4.1.42': { name: 'AES-256-CBC', keyBytes: 32 },
};

const DEK_CIPHERS: Readonly<Record<string, number>> = { 'AES-128-CBC': 16, 'AES-192-CBC': 24, 'AES-256-CBC': 32 };
const OID_AES_128_CBC = '2.16.840.1.101.3.4.1.2';

const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;

function bigIntBytes(value: bigint, length?: number): Uint8Array {
  const hex = value.toString(16);
  const padded = hex.padStart(Math.max(hex.length + (hex.length % 2), (length ?? 0) * 2), '0');
  return hexToBytes(padded);
}

function curveOfAlgorithm(algorithm: EcdsaAlgorithm): CurveFacts {
  return CURVES.find((facts) => facts.algorithm === algorithm)!;
}

function rsaPrivateKeyDer(key: Extract<SshPrivateKey, { algorithm: 'ssh-rsa' }>): Uint8Array {
  return der.sequence(
    der.integer(0n), der.integer(key.n), der.integer(key.e), der.integer(key.d), der.integer(key.p), der.integer(key.q),
    der.integer(key.d % (key.p - 1n)), der.integer(key.d % (key.q - 1n)), der.integer(key.iqmp),
  );
}

function ecPrivateKeyDer(key: Extract<SshPrivateKey, { q: Uint8Array; d: bigint }>, withParameters: boolean): Uint8Array {
  const facts = curveOfAlgorithm(key.algorithm);
  return der.sequence(
    der.integer(1n),
    der.octetString(bigIntBytes(key.d, facts.scalarBytes)),
    ...(withParameters ? [der.explicit(0, der.oid(facts.oid))] : []),
    der.explicit(1, der.bitString(key.q)),
  );
}

export function pemPrivateSupports(algorithm: string): boolean {
  return algorithm !== 'ssh-ed25519';
}

function pkcs8Der(key: SshPrivateKey): Uint8Array {
  if (key.algorithm === 'ssh-rsa') {
    return der.sequence(der.integer(0n), der.sequence(der.oid(OID_RSA), der.null()), der.octetString(rsaPrivateKeyDer(key)));
  }
  if (key.algorithm === 'ssh-ed25519') throw new RangeError('unknown or unsupported key type');
  const facts = curveOfAlgorithm(key.algorithm);
  return der.sequence(
    der.integer(0n), der.sequence(der.oid(OID_EC_PUBLIC_KEY), der.oid(facts.oid)), der.octetString(ecPrivateKeyDer(key, false)),
  );
}

function traditionalDer(key: SshPrivateKey): { label: string; body: Uint8Array } {
  if (key.algorithm === 'ssh-rsa') return { label: 'RSA PRIVATE KEY', body: rsaPrivateKeyDer(key) };
  if (key.algorithm === 'ssh-ed25519') throw new RangeError('unknown or unsupported key type');
  return { label: 'EC PRIVATE KEY', body: ecPrivateKeyDer(key, true) };
}

function armour(label: string, body: Uint8Array, headers = ''): string {
  const encoded = bytesToBase64(body);
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 64) lines.push(encoded.slice(at, at + 64));
  return `-----BEGIN ${label}-----\n${headers}${lines.join('\n')}\n-----END ${label}-----\n`;
}

function encryptedPkcs8(plain: Uint8Array, passphrase: string, random: RandomBytes): Uint8Array {
  const salt = random(PBKDF2_SALT_BYTES);
  const iv = random(16);
  const key = pbkdf2(SHA256, utf8ToBytes(passphrase), salt, PBKDF2_ITERATIONS, 16);
  const scheme = der.sequence(
    der.oid(OID_PBES2),
    der.sequence(
      der.sequence(
        der.oid(OID_PBKDF2),
        der.sequence(der.octetString(salt), der.integer(BigInt(PBKDF2_ITERATIONS)), der.sequence(der.oid(OID_HMAC_SHA256), der.null())),
      ),
      der.sequence(der.oid(OID_AES_128_CBC), der.octetString(iv)),
    ),
  );
  return der.sequence(scheme, der.octetString(aesCbcEncrypt(key, iv, plain)));
}

export function pemSerializePrivate(
  key: SshPrivateKey, format: PemPrivateFormat, passphrase: string, random: RandomBytes,
): string {
  if (!pemPrivateSupports(key.algorithm)) throw new RangeError('unknown or unsupported key type');
  if (format === 'PKCS8') {
    return passphrase === ''
      ? armour('PRIVATE KEY', pkcs8Der(key))
      : armour('ENCRYPTED PRIVATE KEY', encryptedPkcs8(pkcs8Der(key), passphrase, random));
  }
  const { label, body } = traditionalDer(key);
  if (passphrase === '') return armour(label, body);
  const iv = random(16);
  const cipherKey = evpBytesToKey(utf8ToBytes(passphrase), iv.slice(0, 8), 16);
  const headers = `Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${bytesToHex(iv).toUpperCase()}\n\n`;
  return armour(label, aesCbcEncrypt(cipherKey, iv, body), headers);
}

function rsaFromPkcs1(body: Uint8Array): SshPrivateKey | null {
  const fields = children(parseDer(body));
  if (fields.length < 9) return null;
  const [, n, e, d, p, q, , , iqmp] = fields.map((field) => integerValue(field));
  return { algorithm: 'ssh-rsa', n, e, d, p, q, iqmp, comment: '' };
}

function ecFromSec1(body: Uint8Array, knownCurve: string | null): SshPrivateKey | null {
  const fields = children(parseDer(body));
  if (fields.length < 2 || fields[1].tag !== TAG_OCTET_STRING) return null;
  let curveOid = knownCurve;
  let publicPoint: Uint8Array | null = null;
  for (const field of fields.slice(2)) {
    if (field.tag === TAG_EXPLICIT_0) curveOid = oidValue(readNode(field.content).node);
    if (field.tag === TAG_EXPLICIT_1) publicPoint = readNode(field.content).node.content.slice(1);
  }
  const facts = CURVES.find((candidate) => candidate.oid === curveOid);
  if (facts === undefined) return null;
  let d = 0n;
  for (const byte of fields[1].content) d = (d << 8n) | BigInt(byte);
  const curve = NIST_CURVES[facts.curve];
  const q = publicPoint ?? curve.encodePoint(curve.publicKey(d));
  return { algorithm: facts.algorithm, q, d, comment: '' };
}

function fromPkcs8(body: Uint8Array): SshPrivateKey | null {
  const [, algorithm, privateKey] = children(parseDer(body));
  const [oid, parameters] = children(algorithm);
  const algorithmOid = oidValue(oid);
  const inner = privateKey.content;
  if (algorithmOid === OID_RSA) return rsaFromPkcs1(inner);
  if (algorithmOid === OID_EC_PUBLIC_KEY) return ecFromSec1(inner, oidValue(parameters));
  return null;
}

function fromTraditional(label: string, body: Uint8Array): SshPrivateKey | null {
  return label === 'RSA PRIVATE KEY' ? rsaFromPkcs1(body) : ecFromSec1(body, null);
}

type Decoded = { readonly kind: 'key'; readonly key: SshPrivateKey } | { readonly kind: 'invalid' };

function decode(build: () => SshPrivateKey | null): Decoded {
  try {
    const key = build();
    return key === null ? { kind: 'invalid' } : { kind: 'key', key };
  } catch {
    return { kind: 'invalid' };
  }
}

function pbes2Parameters(scheme: DerNode): { salt: Uint8Array; iterations: number; hashSha1: boolean; keyBytes: number; iv: Uint8Array } | null {
  const [oid, parameters] = children(scheme);
  if (oidValue(oid) !== OID_PBES2) return null;
  const [derivation, encryption] = children(parameters);
  const [derivationOid, derivationParameters] = children(derivation);
  if (oidValue(derivationOid) !== OID_PBKDF2) return null;
  const [salt, iterations, ...rest] = children(derivationParameters);
  const prf = rest.find((field) => field.tag === TAG_SEQUENCE);
  const prfOid = prf === undefined ? OID_HMAC_SHA1 : oidValue(children(prf)[0]);
  if (prfOid !== OID_HMAC_SHA1 && prfOid !== OID_HMAC_SHA256) return null;
  const [cipherOid, iv] = children(encryption);
  const cipher = CBC_CIPHERS[oidValue(cipherOid)];
  if (cipher === undefined) return null;
  return {
    salt: salt.content, iterations: Number(integerValue(iterations)), hashSha1: prfOid === OID_HMAC_SHA1,
    keyBytes: cipher.keyBytes, iv: iv.content,
  };
}

function loadEncryptedPkcs8(body: Uint8Array, passphrase: string): PrivateKeyLoad {
  let parameters: ReturnType<typeof pbes2Parameters>;
  let ciphertext: Uint8Array;
  try {
    const [scheme, encrypted] = children(parseDer(body));
    parameters = pbes2Parameters(scheme);
    ciphertext = encrypted.content;
  } catch {
    return { kind: 'invalid-format' };
  }
  if (parameters === null) return { kind: 'unsupported-cipher', cipher: 'pbes2' };
  if (passphrase === '') return { kind: 'encrypted', cipher: 'aes-cbc' };
  try {
    const key = pbkdf2(parameters.hashSha1 ? SHA1 : SHA256, utf8ToBytes(passphrase), parameters.salt, parameters.iterations, parameters.keyBytes);
    const decoded = decode(() => fromPkcs8(aesCbcDecrypt(key, parameters!.iv, ciphertext)));
    return decoded.kind === 'key' ? { kind: 'key', key: decoded.key } : { kind: 'wrong-passphrase' };
  } catch {
    return { kind: 'wrong-passphrase' };
  }
}

function loadTraditional(label: string, text: string, passphrase: string): PrivateKeyLoad {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const dek = lines.find((line) => line.startsWith('DEK-Info:'));
  const payload = lines.filter((line) => !line.includes(':')).join('');
  let body: Uint8Array;
  try {
    body = base64ToBytes(payload);
  } catch {
    return { kind: 'invalid-format' };
  }
  if (dek === undefined) {
    const decoded = decode(() => fromTraditional(label, body));
    return decoded.kind === 'key' ? { kind: 'key', key: decoded.key } : { kind: 'invalid-format' };
  }
  const [cipherName, ivHex = ''] = dek.slice('DEK-Info:'.length).trim().split(',');
  const keyBytes = DEK_CIPHERS[cipherName];
  if (keyBytes === undefined) return { kind: 'unsupported-cipher', cipher: cipherName };
  if (passphrase === '') return { kind: 'encrypted', cipher: cipherName.toLowerCase() };
  try {
    const iv = hexToBytes(ivHex);
    const key = evpBytesToKey(utf8ToBytes(passphrase), iv.slice(0, 8), keyBytes);
    const decoded = decode(() => fromTraditional(label, aesCbcDecrypt(key, iv, body)));
    return decoded.kind === 'key' ? { kind: 'key', key: decoded.key } : { kind: 'wrong-passphrase' };
  } catch {
    return { kind: 'wrong-passphrase' };
  }
}

export function pemLoadPrivate(material: string, passphrase: string): PrivateKeyLoad | null {
  const match = PRIVATE_KEY_BLOCK.exec(material);
  if (match === null) return null;
  const [, label, text] = match;
  if (label === 'ENCRYPTED PRIVATE KEY') {
    let body: Uint8Array;
    try {
      body = base64ToBytes(text.replace(/\s+/g, ''));
    } catch {
      return { kind: 'invalid-format' };
    }
    return loadEncryptedPkcs8(body, passphrase);
  }
  if (label === 'PRIVATE KEY') {
    try {
      const decoded = decode(() => fromPkcs8(base64ToBytes(text.replace(/\s+/g, ''))));
      return decoded.kind === 'key' ? { kind: 'key', key: decoded.key } : { kind: 'invalid-format' };
    } catch {
      return { kind: 'invalid-format' };
    }
  }
  return loadTraditional(label, text, passphrase);
}
