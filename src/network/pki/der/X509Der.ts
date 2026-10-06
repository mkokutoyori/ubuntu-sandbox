import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import { sha1 } from '@/crypto/hash';
import { IPAddress, IPv6Address } from '@/network/core/types';
import type { PkiPublicKey } from '../PkiKeyPair';
import type { X509Certificate, X509CertificateFields } from '../X509Certificate';
import {
  der, children, concatBytes, contextTag, DerError, expectTag, integerMagnitude, integerValue, oidValue,
  parseDer, timeValue, bitStringBytes, unsignedIntegerBytes, TAG, type DerNode,
} from './Asn1';
import { encodeName, decodeName } from './DistinguishedName';

export const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  crlDistributionPoints: '2.5.29.31',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  ocsp: '1.3.6.1.5.5.7.48.1',
  caIssuers: '1.3.6.1.5.5.7.48.2',
  extensionRequest: '1.2.840.113549.1.9.14',
  crlNumber: '2.5.29.20',
  reasonCode: '2.5.29.21',
} as const;

export const EXTENDED_KEY_USAGE_OIDS: Readonly<Record<string, string>> = {
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  OCSPSigning: '1.3.6.1.5.5.7.3.9',
  anyExtendedKeyUsage: '2.5.29.37.0',
};

const KEY_USAGE_ORDER = [
  'digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement',
  'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly',
] as const;

export type Extensions = NonNullable<X509CertificateFields['extensions']>;
type SignatureAlgorithm = X509CertificateFields['signatureAlgorithm'];

export function canonicalSerial(text: string): string {
  const digits = text.replace(/^0x/i, '').replace(/^0+/, '').toLowerCase();
  if (digits.length < 16) return digits.padStart(16, '0');
  return digits.length % 2 === 1 ? `0${digits}` : digits;
}

export function sameSerial(a: string, b: string): boolean {
  return canonicalSerial(a) === canonicalSerial(b);
}

function serialInteger(text: string): Uint8Array {
  return unsignedIntegerBytes(hexToBytes(canonicalSerial(text)));
}

export function algorithmIdentifier(algorithm: SignatureAlgorithm): Uint8Array {
  return algorithm === 'ecdsa-with-SHA256'
    ? der.sequence(der.oid(OID.ecdsaWithSHA256))
    : der.sequence(der.oid(OID.sha256WithRSAEncryption), der.null());
}

export function algorithmFrom(node: DerNode): SignatureAlgorithm {
  const oid = oidValue(children(node)[0]);
  if (oid === OID.sha256WithRSAEncryption) return 'sha256WithRSAEncryption';
  if (oid === OID.ecdsaWithSHA256) return 'ecdsa-with-SHA256';
  throw new DerError(`unsupported signature algorithm ${oid}`);
}

export function encodeSubjectPublicKeyInfo(key: PkiPublicKey): Uint8Array {
  const parts = key.material.split(':');
  if (parts[0] === 'rsa-pub' && parts.length >= 3) {
    const exponent = parts[2].length % 2 === 1 ? `0${parts[2]}` : parts[2];
    const rsaKey = der.sequence(unsignedIntegerBytes(hexToBytes(parts[1])), unsignedIntegerBytes(hexToBytes(exponent)));
    return der.sequence(der.sequence(der.oid(OID.rsaEncryption), der.null()), der.bitString(rsaKey));
  }
  if (parts[0] === 'ec-pub' && parts[1]?.length === 130) {
    return der.sequence(der.sequence(der.oid(OID.ecPublicKey), der.oid(OID.prime256v1)), der.bitString(hexToBytes(parts[1])));
  }
  throw new DerError('public key has no DER form');
}

export function decodeSubjectPublicKeyInfo(node: DerNode): PkiPublicKey {
  expectTag(node, TAG.SEQUENCE, 'SubjectPublicKeyInfo');
  const [algorithm, bits] = children(node);
  const oid = oidValue(children(algorithm)[0]);
  const body = bitStringBytes(bits).bytes;
  if (oid === OID.rsaEncryption) {
    const [modulus, exponent] = children(parseDer(body));
    return { algorithm: 'rsa', material: `rsa-pub:${bytesToHex(integerMagnitude(modulus))}:${integerValue(exponent).toString(16)}` };
  }
  if (oid === OID.ecPublicKey) return { algorithm: 'ecdsa', material: `ec-pub:${bytesToHex(body)}` };
  throw new DerError(`unsupported public key algorithm ${oid}`);
}

export function subjectKeyIdentifierOf(key: PkiPublicKey): string {
  const spki = children(parseDer(encodeSubjectPublicKeyInfo(key)));
  return keyIdentifierText(sha1(bitStringBytes(spki[1]).bytes));
}

export function keyIdentifierBytes(text: string): Uint8Array {
  const hex = text.replace(/:/g, '');
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new DerError(`key identifier is not hexadecimal: ${text}`);
  return hexToBytes(hex);
}

function keyIdentifierText(bytes: Uint8Array): string {
  return (bytesToHex(bytes).toUpperCase().match(/../g) ?? []).join(':');
}

function ipBytes(text: string): Uint8Array | null {
  const v4 = IPAddress.tryParse(text);
  if (v4) return Uint8Array.from(v4.getOctets());
  const v6 = IPv6Address.tryParse(text);
  if (!v6) return null;
  const out: number[] = [];
  for (const hextet of v6.getHextets()) out.push(hextet >> 8, hextet & 0xff);
  return Uint8Array.from(out);
}

function ipText(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join('.');
  const hextets: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) hextets.push((bytes[i] << 8) | bytes[i + 1]);
  return new IPv6Address(hextets).toString();
}

function generalName(entry: string): Uint8Array {
  const prefixed = /^(DNS|IP|email|URI):(.*)$/s.exec(entry);
  if (prefixed) {
    const [, kind, value] = prefixed;
    if (kind === 'DNS') return der.implicit(2, utf8ToBytes(value));
    if (kind === 'email') return der.implicit(1, utf8ToBytes(value));
    if (kind === 'URI') return der.implicit(6, utf8ToBytes(value));
    const octets = ipBytes(value);
    if (!octets) throw new DerError(`invalid IP address ${value}`);
    return der.implicit(7, octets);
  }
  const octets = ipBytes(entry);
  return octets ? der.implicit(7, octets) : der.implicit(2, utf8ToBytes(entry));
}

function generalNameText(node: DerNode): string {
  const number = node.tag & 0x1f;
  if (number === 2) return `DNS:${bytesToUtf8(node.content)}`;
  if (number === 1) return `email:${bytesToUtf8(node.content)}`;
  if (number === 6) return `URI:${bytesToUtf8(node.content)}`;
  if (number === 7) return `IP:${ipText(node.content)}`;
  throw new DerError(`unsupported GeneralName type ${number}`);
}

function keyUsageBits(usage: readonly string[]): Uint8Array {
  let highest = -1;
  const flags = new Array<boolean>(KEY_USAGE_ORDER.length).fill(false);
  for (const name of usage) {
    const index = KEY_USAGE_ORDER.indexOf(name as typeof KEY_USAGE_ORDER[number]);
    if (index < 0) throw new DerError(`unknown key usage ${name}`);
    flags[index] = true;
    highest = Math.max(highest, index);
  }
  const length = Math.max(1, Math.ceil((highest + 1) / 8));
  const bytes = new Uint8Array(length);
  flags.forEach((set, index) => { if (set) bytes[index >> 3] |= 0x80 >> (index & 7); });
  const unused = highest < 0 ? 0 : length * 8 - (highest + 1);
  return der.bitString(bytes, unused);
}

export function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return der.sequence(der.oid(oid), ...(critical ? [der.boolean(true)] : []), der.octetString(value));
}

export function encodeExtensionSequence(extensions: Extensions): Uint8Array | null {
  const critical = new Set(extensions.criticalExtensions ?? []);
  const out: Uint8Array[] = [];
  if (extensions.basicConstraints) {
    const { cA, pathLenConstraint } = extensions.basicConstraints;
    out.push(extension(OID.basicConstraints, critical.has('basicConstraints'), der.sequence(
      ...(cA ? [der.boolean(true)] : []),
      ...(pathLenConstraint !== undefined ? [der.integer(BigInt(pathLenConstraint))] : []),
    )));
  }
  if (extensions.keyUsage) out.push(extension(OID.keyUsage, critical.has('keyUsage'), keyUsageBits(extensions.keyUsage)));
  if (extensions.extKeyUsage) {
    const oids = extensions.extKeyUsage.map((name) => {
      const oid = EXTENDED_KEY_USAGE_OIDS[name] ?? (/^\d+(\.\d+)+$/.test(name) ? name : null);
      if (oid === null) throw new DerError(`unknown extended key usage ${name}`);
      return der.oid(oid);
    });
    out.push(extension(OID.extKeyUsage, critical.has('extendedKeyUsage') || critical.has('extKeyUsage'), der.sequence(...oids)));
  }
  if (extensions.subjectAltName) {
    out.push(extension(OID.subjectAltName, critical.has('subjectAltName'), der.sequence(...extensions.subjectAltName.map(generalName))));
  }
  if (extensions.subjectKeyIdentifier !== undefined) {
    out.push(extension(OID.subjectKeyIdentifier, critical.has('subjectKeyIdentifier'), der.octetString(keyIdentifierBytes(extensions.subjectKeyIdentifier))));
  }
  if (extensions.authorityKeyIdentifier) {
    const { keyid, issuer, serial } = extensions.authorityKeyIdentifier;
    out.push(extension(OID.authorityKeyIdentifier, critical.has('authorityKeyIdentifier'), der.sequence(
      ...(keyid !== undefined ? [der.implicit(0, keyIdentifierBytes(keyid))] : []),
      ...(issuer !== undefined ? [der.implicit(1, der.explicit(4, encodeName(issuer)), true)] : []),
      ...(serial !== undefined ? [der.implicit(2, hexToBytes(canonicalSerial(serial)))] : []),
    )));
  }
  if (extensions.crlDistributionPoints) {
    const points = extensions.crlDistributionPoints.map((uri) => der.sequence(
      der.explicit(0, der.explicit(0, der.implicit(6, utf8ToBytes(uri)))),
    ));
    out.push(extension(OID.crlDistributionPoints, critical.has('crlDistributionPoints'), der.sequence(...points)));
  }
  if (extensions.authorityInfoAccess) {
    const entries = extensions.authorityInfoAccess.map((a) => der.sequence(
      der.oid(a.method === 'OCSP' ? OID.ocsp : OID.caIssuers), der.implicit(6, utf8ToBytes(a.uri)),
    ));
    out.push(extension(OID.authorityInfoAccess, critical.has('authorityInfoAccess'), der.sequence(...entries)));
  }
  return out.length === 0 ? null : der.sequence(...out);
}

function encodeExtensions(extensions: Extensions): Uint8Array | null {
  const sequence = encodeExtensionSequence(extensions);
  return sequence === null ? null : der.explicit(3, sequence);
}

export function decodeExtensionSequence(sequence: DerNode): Extensions {
  const result: { -readonly [K in keyof Extensions]: Extensions[K] } = {};
  const critical: string[] = [];
  for (const entry of children(sequence)) {
    const parts = children(entry);
    const oid = oidValue(parts[0]);
    const isCritical = parts.length === 3 && parts[1].content[0] !== 0;
    const value = parseDer(parts[parts.length - 1].content);
    const mark = (name: string): void => { if (isCritical) critical.push(name); };
    switch (oid) {
      case OID.basicConstraints: {
        let cA = false;
        let pathLenConstraint: number | undefined;
        for (const field of children(value)) {
          if (field.tag === TAG.BOOLEAN) cA = field.content[0] !== 0;
          else pathLenConstraint = Number(integerValue(field));
        }
        result.basicConstraints = pathLenConstraint === undefined ? { cA } : { cA, pathLenConstraint };
        mark('basicConstraints');
        break;
      }
      case OID.keyUsage: {
        const { bytes } = bitStringBytes(value);
        result.keyUsage = KEY_USAGE_ORDER.filter((_, index) => (bytes[index >> 3] ?? 0) & (0x80 >> (index & 7)));
        mark('keyUsage');
        break;
      }
      case OID.extKeyUsage: {
        result.extKeyUsage = children(value).map((node) => {
          const dotted = oidValue(node);
          return Object.entries(EXTENDED_KEY_USAGE_OIDS).find(([, o]) => o === dotted)?.[0] ?? dotted;
        });
        mark('extendedKeyUsage');
        break;
      }
      case OID.subjectAltName:
        result.subjectAltName = children(value).map(generalNameText);
        mark('subjectAltName');
        break;
      case OID.subjectKeyIdentifier:
        result.subjectKeyIdentifier = keyIdentifierText(value.content);
        mark('subjectKeyIdentifier');
        break;
      case OID.authorityKeyIdentifier: {
        const akid: { keyid?: string; issuer?: string; serial?: string } = {};
        for (const field of children(value)) {
          const number = field.tag & 0x1f;
          if (number === 0) akid.keyid = keyIdentifierText(field.content);
          else if (number === 1) akid.issuer = decodeName(children(children(field)[0])[0]);
          else if (number === 2) akid.serial = bytesToHex(field.content);
        }
        result.authorityKeyIdentifier = akid;
        mark('authorityKeyIdentifier');
        break;
      }
      case OID.crlDistributionPoints:
        result.crlDistributionPoints = children(value).map((point) => bytesToUtf8(children(children(children(point)[0])[0])[0].content));
        mark('crlDistributionPoints');
        break;
      case OID.authorityInfoAccess:
        result.authorityInfoAccess = children(value).map((access) => {
          const [method, location] = children(access);
          return { method: oidValue(method) === OID.ocsp ? 'OCSP' as const : 'caIssuers' as const, uri: bytesToUtf8(location.content) };
        });
        mark('authorityInfoAccess');
        break;
      default:
        break;
    }
  }
  if (critical.length > 0) result.criticalExtensions = critical;
  return result;
}

function decodeExtensions(wrapper: DerNode): Extensions {
  return decodeExtensionSequence(children(wrapper)[0]);
}

export function encodeTbsCertificate(fields: X509CertificateFields): Uint8Array {
  const extensions = fields.extensions ? encodeExtensions(fields.extensions) : null;
  return der.sequence(
    der.explicit(0, der.integer(2n)),
    serialInteger(fields.serialNumber),
    algorithmIdentifier(fields.signatureAlgorithm),
    encodeName(fields.issuer),
    der.sequence(der.time(fields.notBefore), der.time(fields.notAfter)),
    encodeName(fields.subject),
    encodeSubjectPublicKeyInfo(fields.publicKey),
    ...(extensions ? [extensions] : []),
  );
}

export function signatureToDer(algorithm: SignatureAlgorithm, signature: string): Uint8Array {
  if (signature === '') return new Uint8Array(0);
  const colon = signature.indexOf(':');
  const body = hexToBytes(signature.slice(colon + 1));
  if (algorithm !== 'ecdsa-with-SHA256') return body;
  return der.sequence(unsignedIntegerBytes(body.slice(0, 32)), unsignedIntegerBytes(body.slice(32)));
}

export function signatureFromDer(algorithm: SignatureAlgorithm, bytes: Uint8Array): string {
  if (algorithm !== 'ecdsa-with-SHA256') return `rsa:${bytesToHex(bytes)}`;
  const [r, s] = children(parseDer(bytes));
  const pad = (value: Uint8Array): Uint8Array => concatBytes([new Uint8Array(32 - value.length), value]);
  return `ecdsa:${bytesToHex(pad(integerMagnitude(r)))}${bytesToHex(pad(integerMagnitude(s)))}`;
}

const RECEIVED_TBS = new WeakMap<object, Uint8Array>();

export function tbsBytesOf(cert: X509CertificateFields): Uint8Array {
  return RECEIVED_TBS.get(cert) ?? encodeTbsCertificate(cert);
}

export function encodeCertificate(cert: X509Certificate): Uint8Array {
  return der.sequence(
    tbsBytesOf(cert),
    algorithmIdentifier(cert.signatureAlgorithm),
    der.bitString(signatureToDer(cert.signatureAlgorithm, cert.signature)),
  );
}

export function decodeCertificate(bytes: Uint8Array): X509Certificate {
  const outer = expectTag(parseDer(bytes), TAG.SEQUENCE, 'Certificate');
  const [tbs, , signatureNode] = children(outer);
  const fields = children(tbs);
  let index = 0;
  if (fields[0].tag === contextTag(0, true)) index++;
  const serial = fields[index++];
  const algorithm = algorithmFrom(fields[index++]);
  const issuer = decodeName(fields[index++]);
  const [notBefore, notAfter] = children(fields[index++]);
  const subject = decodeName(fields[index++]);
  const publicKey = decodeSubjectPublicKeyInfo(fields[index++]);
  const wrapper = fields.slice(index).find((field) => field.tag === contextTag(3, true));
  const extensions = wrapper ? decodeExtensions(wrapper) : undefined;
  const decoded: X509Certificate = {
    version: 3,
    serialNumber: canonicalSerial(bytesToHex(integerMagnitude(serial))),
    subject,
    issuer,
    notBefore: timeValue(notBefore),
    notAfter: timeValue(notAfter),
    publicKey,
    signatureAlgorithm: algorithm,
    ...(extensions && Object.keys(extensions).length > 0 ? { extensions } : {}),
    signature: signatureFromDer(algorithm, bitStringBytes(signatureNode).bytes),
  };
  RECEIVED_TBS.set(decoded, tbs.raw);
  return decoded;
}

