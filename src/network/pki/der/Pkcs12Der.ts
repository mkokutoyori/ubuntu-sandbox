import { SHA256, sha256 } from '@/crypto/hash';
import { hmac } from '@/crypto/mac/hmac';
import type { PkiPrivateKey } from '../PkiKeyPair';
import type { X509Certificate } from '../X509Certificate';
import { der, children, parseDer, oidValue, integerValue, concatBytes, contextTag, DerError, type DerNode } from './Asn1';
import { encodeCertificate, decodeCertificate } from './X509Der';
import { encodePrivateKeyPkcs8, decodePrivateKeyPkcs8 } from './KeyDer';
import { pbes2Seal, pbes2Open, type KeyEncryptionCipher } from './EncryptedKeyDer';

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const OID_SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2';
const OID_X509_CERTIFICATE = '1.2.840.113549.1.9.22.1';
const OID_FRIENDLY_NAME = '1.2.840.113549.1.9.20';
const OID_LOCAL_KEY_ID = '1.2.840.113549.1.9.21';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';

const MAC_ITERATIONS = 2048;
const MAC_SALT_LENGTH = 8;
const KDF_BLOCK = 64;
const KDF_OUTPUT = 32;
const KDF_ID_MAC = 3;

export interface Pkcs12Contents {
  readonly certificates: readonly X509Certificate[];
  readonly key?: PkiPrivateKey;
  readonly friendlyName?: string;
}

export type Pkcs12Result = { readonly contents: Pkcs12Contents } | { readonly error: 'bad-password' | 'malformed' };

function bmpPassword(password: string): Uint8Array {
  const out = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i++) {
    out[2 * i] = password.charCodeAt(i) >> 8;
    out[2 * i + 1] = password.charCodeAt(i) & 0xff;
  }
  return out;
}

function repeatToMultiple(bytes: Uint8Array, block: number): Uint8Array {
  if (bytes.length === 0) return new Uint8Array(0);
  const length = block * Math.ceil(bytes.length / block);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = bytes[i % bytes.length];
  return out;
}

function pkcs12Kdf(password: Uint8Array, salt: Uint8Array, iterations: number, id: number, length: number): Uint8Array {
  const diversifier = new Uint8Array(KDF_BLOCK).fill(id);
  const mixed = concatBytes([repeatToMultiple(salt, KDF_BLOCK), repeatToMultiple(password, KDF_BLOCK)]);
  const out = new Uint8Array(Math.ceil(length / KDF_OUTPUT) * KDF_OUTPUT);
  for (let block = 0; block * KDF_OUTPUT < length; block++) {
    let digest = concatBytes([diversifier, mixed]);
    for (let round = 0; round < iterations; round++) digest = sha256(digest);
    out.set(digest, block * KDF_OUTPUT);
    const spread = repeatToMultiple(digest, KDF_BLOCK).subarray(0, KDF_BLOCK);
    for (let offset = 0; offset < mixed.length; offset += KDF_BLOCK) {
      let carry = 1;
      for (let i = KDF_BLOCK - 1; i >= 0; i--) {
        const sum = mixed[offset + i] + spread[i] + carry;
        mixed[offset + i] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return out.slice(0, length);
}

function bmpString(text: string): Uint8Array {
  const body = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    body[2 * i] = text.charCodeAt(i) >> 8;
    body[2 * i + 1] = text.charCodeAt(i) & 0xff;
  }
  return concatBytes([Uint8Array.of(0x1e, body.length), body]);
}

function attributes(friendlyName: string | undefined, localKeyId: Uint8Array): Uint8Array {
  const entries = [der.sequence(der.oid(OID_LOCAL_KEY_ID), der.set(der.octetString(localKeyId)))];
  if (friendlyName) entries.unshift(der.sequence(der.oid(OID_FRIENDLY_NAME), der.set(bmpString(friendlyName))));
  return der.set(...entries);
}

function contentInfo(type: string, content: Uint8Array): Uint8Array {
  return der.sequence(der.oid(type), der.explicit(0, content));
}

export function encodePkcs12(
  contents: Pkcs12Contents, password: string, random: (length: number) => Uint8Array,
  cipher: KeyEncryptionCipher = 'aes-256-cbc',
): Uint8Array {
  const localKeyId = random(20);
  const certificateBags = contents.certificates.map((certificate, index) => der.sequence(
    der.oid(OID_CERT_BAG),
    der.explicit(0, der.sequence(der.oid(OID_X509_CERTIFICATE), der.explicit(0, der.octetString(encodeCertificate(certificate))))),
    ...(index === 0 && contents.key ? [attributes(contents.friendlyName, localKeyId)] : []),
  ));
  const sealedCertificates = pbes2Seal(der.sequence(...certificateBags), password, random, MAC_ITERATIONS, cipher);
  const encryptedData = der.sequence(
    der.integer(0n),
    der.sequence(der.oid(OID_DATA), sealedCertificates.algorithm, der.implicit(0, sealedCertificates.ciphertext)),
  );
  const safes = [contentInfo(OID_ENCRYPTED_DATA, encryptedData)];
  if (contents.key) {
    const sealedKey = pbes2Seal(encodePrivateKeyPkcs8(contents.key), password, random, MAC_ITERATIONS, cipher);
    const shrouded = der.sequence(sealedKey.algorithm, der.octetString(sealedKey.ciphertext));
    const keyBag = der.sequence(der.oid(OID_SHROUDED_KEY_BAG), der.explicit(0, shrouded), attributes(contents.friendlyName, localKeyId));
    safes.push(contentInfo(OID_DATA, der.octetString(der.sequence(keyBag))));
  }
  const authenticatedSafe = der.sequence(...safes);
  const macSalt = random(MAC_SALT_LENGTH);
  const macKey = pkcs12Kdf(bmpPassword(password), macSalt, MAC_ITERATIONS, KDF_ID_MAC, KDF_OUTPUT);
  const digest = hmac(SHA256, macKey, authenticatedSafe);
  return der.sequence(
    der.integer(3n),
    contentInfo(OID_DATA, der.octetString(authenticatedSafe)),
    der.sequence(der.sequence(der.sequence(der.oid(OID_SHA256), der.null()), der.octetString(digest)), der.octetString(macSalt), der.integer(BigInt(MAC_ITERATIONS))),
  );
}

function explicitContent(info: DerNode): DerNode {
  const [, wrapper] = children(info);
  return children(wrapper)[0];
}

function readBags(safeContents: DerNode, into: { certificates: X509Certificate[]; key?: PkiPrivateKey; friendlyName?: string }, password: string): void {
  for (const bag of children(safeContents)) {
    const [bagId, wrapper, attrs] = children(bag);
    const value = children(wrapper)[0];
    if (oidValue(bagId) === OID_CERT_BAG) {
      const [, certificate] = children(value);
      into.certificates.push(decodeCertificate(children(certificate)[0].content));
    } else if (oidValue(bagId) === OID_SHROUDED_KEY_BAG) {
      const [algorithm, data] = children(value);
      into.key = decodePrivateKeyPkcs8(pbes2Open(algorithm, data.content, password));
    }
    if (attrs) {
      for (const attribute of children(attrs)) {
        const [id, set] = children(attribute);
        if (oidValue(id) === OID_FRIENDLY_NAME) {
          const raw = children(set)[0].content;
          let text = '';
          for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
          into.friendlyName = text;
        }
      }
    }
  }
}

export function decodePkcs12(bytes: Uint8Array, password: string): Pkcs12Result {
  try {
    const [version, authSafe, macData] = children(parseDer(bytes));
    if (integerValue(version) !== 3n) throw new DerError('unsupported PFX version');
    const safeBytes = explicitContent(authSafe).content;
    if (macData) {
      const [digestInfo, salt, iterationsNode] = children(macData);
      const iterations = iterationsNode ? Number(integerValue(iterationsNode)) : 1;
      const expected = children(digestInfo)[1].content;
      const key = pkcs12Kdf(bmpPassword(password), salt.content, iterations, KDF_ID_MAC, KDF_OUTPUT);
      const actual = hmac(SHA256, key, safeBytes);
      if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) return { error: 'bad-password' };
    }
    const collected: { certificates: X509Certificate[]; key?: PkiPrivateKey; friendlyName?: string } = { certificates: [] };
    for (const info of children(parseDer(safeBytes))) {
      const [type] = children(info);
      const body = explicitContent(info);
      if (oidValue(type) === OID_DATA) {
        readBags(parseDer(body.content), collected, password);
      } else if (oidValue(type) === OID_ENCRYPTED_DATA) {
        const [, encryptedInfo] = children(body);
        const [, algorithm, cipherText] = children(encryptedInfo);
        if (cipherText.tag !== contextTag(0, false)) throw new DerError('unsupported encrypted content');
        readBags(parseDer(pbes2Open(algorithm, cipherText.content, password)), collected, password);
      }
    }
    return { contents: collected };
  } catch {
    return { error: 'malformed' };
  }
}
