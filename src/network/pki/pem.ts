/**
 * docs/PRD-OpenSSL.md §7 — le verrou : un certificat qui sait devenir un
 * FICHIER.
 *
 * Tout `src/network/pki/` manipulait des objets TypeScript et rien ne
 * savait les écrire ni les relire. C'est ce qui bloquait `openssl req`
 * (rien à écrire), `openssl x509 -in` (rien à lire),
 * `ssl_certificate` de nginx (rien à charger) et toute PKI de labo.
 *
 * L'armure est RÉELLE — étiquettes de la RFC 7468, base64 en colonnes
 * de 64 — parce que c'est elle que l'apprenant voit, que `cat` affiche
 * et sur laquelle porte l'exercice. La charge est le JSON canonique de
 * l'objet, PAS du DER : la signature étant simulée (même convention que
 * le reste de ce répertoire, « simulated crypto, real protocol shape »),
 * un DER exact ne serait de toute façon pas vérifiable par un vrai
 * openssl. Mieux vaut une charge honnêtement non-DER qu'un DER qui
 * prétendrait à une interopérabilité qu'il n'a pas.
 */

import {
  bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8, bytesToHex, hexToBytes,
} from '@/crypto/encoding';
import { aesCbcEncrypt, aesCbcDecrypt } from '@/crypto/cipher';
import { pbkdf2 } from '@/crypto/kdf';
import { SHA256 } from '@/crypto/hash';
import type { X509Certificate, X509CertificateFields } from './X509Certificate';
import { der, children, expectTag, integerValue, parseDer, TAG } from './der/Asn1';
import { encodeCrl, decodeCrl } from './der/CrlDer';
import { encodeCertificateRequest, decodeCertificateRequest } from './der/CsrDer';
import { encodeCertificate, decodeCertificate } from './der/X509Der';
import { encryptPrivateKeyPkcs8, decryptPrivateKeyPkcs8 } from './der/EncryptedKeyDer';
import {
  encodePrivateKeyPkcs8, decodePrivateKeyPkcs8, encodeRsaPrivateKeyPkcs1, decodeRsaPrivateKeyPkcs1,
  encodeEcPrivateKeySec1, decodeEcPrivateKeySec1, encodePublicKeySpki, decodePublicKeySpki,
} from './der/KeyDer';
import type { PkiPrivateKey, PkiPublicKey } from './PkiKeyPair';
import { CertificateRevocationList, type CrlFields } from './CertificateRevocationList';
import type { OcspRequestMessage, OcspResponseMessage } from './OcspWire';

export type PemLabel =
  | 'CERTIFICATE'
  | 'PRIVATE KEY'
  | 'RSA PRIVATE KEY'
  | 'EC PRIVATE KEY'
  | 'ENCRYPTED PRIVATE KEY'
  | 'PUBLIC KEY'
  | 'CERTIFICATE REQUEST'
  | 'NEW CERTIFICATE REQUEST'
  | 'X509 CRL'
  | 'OCSP REQUEST'
  | 'OCSP RESPONSE'
  | 'DH PARAMETERS';

const LINE_WIDTH = 64;

/** Une demande de signature, telle que `openssl req -new` la produit. */
export interface CertificateRequest {
  readonly subject: string;
  readonly publicKey: PkiPublicKey;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly signature: string;
  readonly extensions?: X509CertificateFields['extensions'];
}

function armour(label: PemLabel, payload: unknown): string {
  const b64 = bytesToBase64(utf8ToBytes(JSON.stringify(payload)));
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += LINE_WIDTH) lines.push(b64.slice(i, i + LINE_WIDTH));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Le corps d'un bloc, ou `null`. Trois échecs distincts et reconnus
 * comme tels (§7.3) : pas d'armure, une fin qui ne correspond pas au
 * début, un base64 ou un JSON corrompu. Aucun ne lève : c'est ce qui
 * permet à `openssl x509 -in` de rendre le message d'openssl plutôt que
 * de faire tomber le shell.
 */
function unarmour(pem: string, label: PemLabel): unknown | null {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const from = pem.indexOf(begin);
  if (from === -1) return null;
  const to = pem.indexOf(end, from);
  if (to === -1) return null;
  const body = pem.slice(from + begin.length, to).replace(/\s+/g, '');
  if (body.length === 0) return null;
  try {
    return JSON.parse(bytesToUtf8(base64ToBytes(body)));
  } catch {
    return null;
  }
}

// ─── Certificats ────────────────────────────────────────────────────

function armourBytes(label: PemLabel, bytes: Uint8Array): string {
  const b64 = bytesToBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += LINE_WIDTH) lines.push(b64.slice(i, i + LINE_WIDTH));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function unarmourBytes(pem: string, label: PemLabel): Uint8Array | null {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const from = pem.indexOf(begin);
  if (from === -1) return null;
  const to = pem.indexOf(end, from);
  if (to === -1) return null;
  const body = pem.slice(from + begin.length, to).replace(/\s+/g, '');
  if (body.length === 0) return null;
  try { return base64ToBytes(body); } catch { return null; }
}

export function certToPem(cert: X509Certificate): string {
  return armourBytes('CERTIFICATE', encodeCertificate(cert));
}

export function pemToCert(pem: string): X509Certificate | null {
  const bytes = unarmourBytes(pem, 'CERTIFICATE');
  if (bytes === null) return null;
  try {
    if (bytes[0] === 0x7b) {
      const legacy = JSON.parse(bytesToUtf8(bytes)) as X509Certificate;
      return typeof legacy.subject === 'string' && typeof legacy.serialNumber === 'string' ? legacy : null;
    }
    return decodeCertificate(bytes);
  } catch {
    return null;
  }
}

/**
 * Un fichier peut porter plusieurs blocs — c'est ainsi qu'une chaîne
 * (`fullchain.pem`) arrive à `ssl_certificate` sur une vraie machine.
 * L'ordre du fichier est conservé, parce qu'il porte le sens : la
 * feuille d'abord, puis ses émetteurs.
 */
export function splitPemChain(pem: string): string[] {
  const blocs: string[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
  for (const m of pem.matchAll(re)) blocs.push(m[0]);
  return blocs;
}

export function pemToCertChain(pem: string): X509Certificate[] {
  const out: X509Certificate[] = [];
  for (const bloc of splitPemChain(pem)) {
    const c = pemToCert(bloc);
    if (c) out.push(c);
  }
  return out;
}

// ─── Clés ───────────────────────────────────────────────────────────

/**
 * `-----BEGIN PRIVATE KEY-----` est la forme PKCS#8, celle qu'openssl 3
 * écrit par défaut ; `RSA PRIVATE KEY` est la forme historique que
 * `genrsa -traditional` demande encore.
 */
export function privateKeyToPem(key: PkiPrivateKey, traditional = false): string {
  if (!traditional) return armourBytes('PRIVATE KEY', encodePrivateKeyPkcs8(key));
  return key.algorithm === 'ecdsa'
    ? armourBytes('EC PRIVATE KEY', encodeEcPrivateKeySec1(key.material))
    : armourBytes('RSA PRIVATE KEY', encodeRsaPrivateKeyPkcs1(key.material));
}

export function pemToPrivateKey(pem: string): PkiPrivateKey | null {
  const decoders: readonly [PemLabel, (bytes: Uint8Array) => PkiPrivateKey][] = [
    ['PRIVATE KEY', decodePrivateKeyPkcs8], ['RSA PRIVATE KEY', decodeRsaPrivateKeyPkcs1], ['EC PRIVATE KEY', decodeEcPrivateKeySec1],
  ];
  for (const [label, decode] of decoders) {
    const bytes = unarmourBytes(pem, label);
    if (bytes === null) continue;
    try {
      if (bytes[0] === 0x7b) {
        const legacy = JSON.parse(bytesToUtf8(bytes)) as PkiPrivateKey;
        if (typeof legacy.material === 'string') return legacy;
        continue;
      }
      return decode(bytes);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * PKCS#8 CHIFFRÉ (`-----BEGIN ENCRYPTED PRIVATE KEY-----`).
 *
 * L'étiquette existait dans `PemLabel` et rien ne l'écrivait : `openssl
 * pkcs8 -topk8` rendait toujours une clé EN CLAIR, y compris sans
 * `-nocrypt`, alors que c'est précisément le drapeau qui sert à demander
 * le clair. Un TP y apprenait donc le contraire de ce que la commande
 * enseigne.
 *
 * Le chiffrement est RÉEL — AES-256-CBC sur une clé dérivée par PBKDF2,
 * les deux déjà présents dans `src/crypto/` et déjà servis par
 * `openssl enc`. L'enveloppe porte le sel, le nombre d'itérations et
 * l'IV, comme un vrai `EncryptedPrivateKeyInfo` : sans eux la clé serait
 * indéchiffrable, et les inventer à la lecture reviendrait à ne pas
 * chiffrer.
 */
export function encryptedPrivateKeyToPem(
  key: PkiPrivateKey, passphrase: string, random: (n: number) => Uint8Array,
): string {
  return armourBytes('ENCRYPTED PRIVATE KEY', encryptPrivateKeyPkcs8(key, passphrase, random));
}

export function pemToEncryptedPrivateKey(pem: string, passphrase: string): PkiPrivateKey | null {
  const bytes = unarmourBytes(pem, 'ENCRYPTED PRIVATE KEY');
  return bytes === null ? null : decryptPrivateKeyPkcs8(bytes, passphrase);
}

/** Une armure de clé chiffrée est-elle présente ? */
export function pemToPrivateKeyWithPassphrase(pem: string, passphrase: string | null): PkiPrivateKey | null {
  if (!isEncryptedPrivateKeyPem(pem)) return pemToPrivateKey(pem);
  return passphrase === null ? null : pemToEncryptedPrivateKey(pem, passphrase);
}

export function isEncryptedPrivateKeyPem(pem: string): boolean {
  return pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');
}

export function publicKeyToPem(key: PkiPublicKey): string {
  return armourBytes('PUBLIC KEY', encodePublicKeySpki(key));
}

export function pemToPublicKey(pem: string): PkiPublicKey | null {
  const bytes = unarmourBytes(pem, 'PUBLIC KEY');
  if (bytes === null) return null;
  try {
    if (bytes[0] === 0x7b) {
      const legacy = JSON.parse(bytesToUtf8(bytes)) as PkiPublicKey;
      return typeof legacy.material === 'string' ? legacy : null;
    }
    return decodePublicKeySpki(bytes);
  } catch {
    return null;
  }
}

// ─── Demandes de signature ──────────────────────────────────────────

export function csrToPem(csr: CertificateRequest): string {
  return armourBytes('CERTIFICATE REQUEST', encodeCertificateRequest(csr));
}

export function pemToCsr(pem: string): CertificateRequest | null {
  const bytes = unarmourBytes(pem, 'CERTIFICATE REQUEST') ?? unarmourBytes(pem, 'NEW CERTIFICATE REQUEST');
  if (bytes === null) return null;
  try {
    if (bytes[0] === 0x7b) {
      const legacy = JSON.parse(bytesToUtf8(bytes)) as CertificateRequest;
      return typeof legacy.subject === 'string' ? legacy : null;
    }
    return decodeCertificateRequest(bytes);
  } catch {
    return null;
  }
}

// ─── Liste de révocation ────────────────────────────────────────────

export function crlToPem(crl: CertificateRevocationList): string {
  return armourBytes('X509 CRL', encodeCrl(crl));
}

export function pemToCrl(pem: string): CertificateRevocationList | null {
  const bytes = unarmourBytes(pem, 'X509 CRL');
  if (bytes === null) return null;
  try {
    if (bytes[0] === 0x7b) {
      const o = JSON.parse(bytesToUtf8(bytes)) as CrlFields & { signature?: string };
      if (typeof o.issuer !== 'string' || !Array.isArray(o.revoked)) return null;
      return CertificateRevocationList.fromParsed({
        version: 2,
        issuer: o.issuer,
        thisUpdate: o.thisUpdate,
        nextUpdate: o.nextUpdate,
        signatureAlgorithm: o.signatureAlgorithm ?? 'sha256WithRSAEncryption',
        revoked: o.revoked,
      }, o.signature ?? '');
    }
    const decoded = decodeCrl(bytes);
    return CertificateRevocationList.fromParsed(decoded.fields, decoded.signature, decoded.tbs);
  } catch {
    return null;
  }
}

export function ocspResponseToPem(response: OcspResponseMessage): string {
  return armour('OCSP RESPONSE', response);
}

export function pemToOcspResponse(pem: string): OcspResponseMessage | null {
  const o = unarmour(pem, 'OCSP RESPONSE') as OcspResponseMessage | null;
  if (!o || typeof o.status !== 'string' || !Array.isArray(o.singles)) return null;
  return o;
}

export function ocspRequestToPem(request: OcspRequestMessage): string {
  return armour('OCSP REQUEST', request);
}

export function pemToOcspRequest(pem: string): OcspRequestMessage | null {
  const o = unarmour(pem, 'OCSP REQUEST') as OcspRequestMessage | null;
  return o && Array.isArray(o.ids) ? o : null;
}

export interface DhParameters {
  readonly prime: bigint;
  readonly generator: bigint;
}

export function dhParametersToPem(parameters: DhParameters): string {
  return armourBytes('DH PARAMETERS', der.sequence(der.integer(parameters.prime), der.integer(parameters.generator)));
}

export function pemToDhParameters(pem: string): DhParameters | null {
  const bytes = unarmourBytes(pem, 'DH PARAMETERS');
  if (bytes === null) return null;
  try {
    if (bytes[0] === 0x7b) {
      const o = JSON.parse(bytesToUtf8(bytes)) as { p?: unknown; g?: unknown };
      if (typeof o.p !== 'string' || typeof o.g !== 'string' || !/^[0-9a-f]+$/.test(o.p) || !/^[0-9a-f]+$/.test(o.g)) return null;
      return { prime: BigInt(`0x${o.p}`), generator: BigInt(`0x${o.g}`) };
    }
    const [prime, generator] = children(expectTag(parseDer(bytes), TAG.SEQUENCE, 'DHParameter'));
    return { prime: integerValue(prime), generator: integerValue(generator) };
  } catch {
    return null;
  }
}
