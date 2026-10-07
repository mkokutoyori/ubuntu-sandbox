import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { materialToPublicKey, bitLength } from '@/crypto/rsa';
import type { PkiPublicKey } from '@/network/pki/PkiKeyPair';
import type { X509Certificate, X509CertificateFields } from '@/network/pki/X509Certificate';
import { opensslDistinguishedName } from '@/network/pki/der/DistinguishedName';

type Extensions = NonNullable<X509CertificateFields['extensions']>;

function colonHex(bytes: Uint8Array, perLine: number, indent: string): string[] {
  const pairs = bytesToHex(bytes).match(/../g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += perLine) {
    const chunk = pairs.slice(i, i + perLine).join(':');
    lines.push(`${indent}${chunk}${i + perLine < pairs.length ? ':' : ''}`);
  }
  return lines;
}

function signedMagnitude(hex: string): Uint8Array {
  const bytes = hexToBytes(hex.length % 2 === 1 ? `0${hex}` : hex);
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const magnitude = bytes.slice(start);
  if (magnitude[0] & 0x80) return Uint8Array.of(0, ...magnitude);
  return magnitude;
}

export function publicKeyTextLines(key: PkiPublicKey): string[] {
  const rsa = materialToPublicKey(key.material);
  if (rsa) {
    return [
      '        Subject Public Key Info:',
      '            Public Key Algorithm: rsaEncryption',
      `                Public-Key: (${bitLength(rsa.n)} bit)`,
      '                Modulus:',
      ...colonHex(signedMagnitude(rsa.n.toString(16)), 15, '                    '),
      `                Exponent: ${rsa.e} (0x${rsa.e.toString(16)})`,
    ];
  }
  const point = /^ec-pub:([0-9a-fA-F]+)$/.exec(key.material);
  if (point) {
    return [
      '        Subject Public Key Info:',
      '            Public Key Algorithm: id-ecPublicKey',
      '                Public-Key: (256 bit)',
      '                pub:',
      ...colonHex(hexToBytes(point[1]), 15, '                    '),
      '                ASN1 OID: prime256v1',
      '                NIST CURVE: P-256',
    ];
  }
  return ['        Subject Public Key Info:', `            Public Key Algorithm: ${key.algorithm}`];
}

export function signatureTextLines(algorithm: string, signature: string): string[] {
  const bytes = signature === '' ? new Uint8Array(0) : hexToBytes(signature.slice(signature.indexOf(':') + 1));
  return [`    Signature Algorithm: ${algorithm}`, '    Signature Value:', ...colonHex(bytes, 18, '        ')];
}

function generalNameText(entry: string): string {
  return entry.replace(/^IP:/, 'IP Address:');
}

export function requestedExtensionLines(ext: Extensions | undefined, indent: string): string[] {
  const critical = new Set(ext?.criticalExtensions ?? []);
  const mark = (name: string): string => (critical.has(name) ? ' critical' : '');
  const lines: string[] = [];
  if (ext?.basicConstraints) {
    lines.push(`${indent}X509v3 Basic Constraints:${mark('basicConstraints')}`);
    lines.push(`${indent}    CA:${ext.basicConstraints.cA ? 'TRUE' : 'FALSE'}${ext.basicConstraints.pathLenConstraint !== undefined ? `, pathlen:${ext.basicConstraints.pathLenConstraint}` : ''}`);
  }
  if (ext?.keyUsage && ext.keyUsage.length > 0) {
    lines.push(`${indent}X509v3 Key Usage:${mark('keyUsage')}`, `${indent}    ${ext.keyUsage.join(', ')}`);
  }
  if (ext?.extKeyUsage && ext.extKeyUsage.length > 0) {
    lines.push(`${indent}X509v3 Extended Key Usage:${mark('extendedKeyUsage')}`, `${indent}    ${ext.extKeyUsage.join(', ')}`);
  }
  if (ext?.subjectAltName && ext.subjectAltName.length > 0) {
    lines.push(`${indent}X509v3 Subject Alternative Name:${critical.has('subjectAltName') ? ' critical' : ' '}`, `${indent}    ${ext.subjectAltName.map(generalNameText).join(', ')}`);
  }
  return lines;
}

export function certificateRequestText(csr: {
  readonly subject: string; readonly publicKey: PkiPublicKey; readonly extensions?: Extensions;
  readonly signatureAlgorithm: string; readonly signature: string;
}): string[] {
  const requested = requestedExtensionLines(csr.extensions, '                ');
  return [
    'Certificate Request:',
    '    Data:',
    '        Version: 1 (0x0)',
    `        Subject: ${opensslDistinguishedName(csr.subject)}`,
    ...publicKeyTextLines(csr.publicKey),
    '        Attributes:',
    ...(requested.length > 0 ? ['            Requested Extensions:', ...requested] : ['            (none)', '            Requested Extensions:']),
    ...signatureTextLines(csr.signatureAlgorithm, csr.signature),
  ];
}

export function peerChainLines(chain: readonly X509Certificate[], formatDate: (ms: number) => string): string[] {
  const lines: string[] = [];
  chain.forEach((cert, depth) => {
    const rsa = materialToPublicKey(cert.publicKey.material);
    const keyText = rsa ? `rsaEncryption, ${bitLength(rsa.n)} (bit)` : `id-ecPublicKey, 256 (bit)`;
    const sigalg = cert.signatureAlgorithm === 'ecdsa-with-SHA256' ? 'ecdsa-with-SHA256' : 'RSA-SHA256';
    lines.push(` ${depth} s:${opensslDistinguishedName(cert.subject)}`, `   i:${opensslDistinguishedName(cert.issuer)}`,
      `   a:PKEY: ${keyText}; sigalg: ${sigalg}`,
      `   v:NotBefore: ${formatDate(cert.notBefore)}; NotAfter: ${formatDate(cert.notAfter)}`);
  });
  return lines;
}

export function opensslHexDump(bytes: Uint8Array, indent: string): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += i < row.length ? `${bytesToHex(row.slice(i, i + 1))}${i === 7 ? '-' : ' '}` : '   ';
    }
    const ascii = Array.from(row, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${indent}${offset.toString(16).padStart(4, '0')} - ${hex}  ${ascii}`);
  }
  return lines;
}
