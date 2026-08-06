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

import { bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import type { X509Certificate } from './X509Certificate';
import type { PkiPrivateKey, PkiPublicKey } from './PkiKeyPair';
import { CertificateRevocationList, type CrlFields } from './CertificateRevocationList';

export type PemLabel =
  | 'CERTIFICATE'
  | 'PRIVATE KEY'
  | 'RSA PRIVATE KEY'
  | 'EC PRIVATE KEY'
  | 'ENCRYPTED PRIVATE KEY'
  | 'PUBLIC KEY'
  | 'CERTIFICATE REQUEST'
  | 'X509 CRL';

const LINE_WIDTH = 64;

/** Une demande de signature, telle que `openssl req -new` la produit. */
export interface CertificateRequest {
  readonly subject: string;
  readonly publicKey: PkiPublicKey;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly signature: string;
  readonly extensions?: Readonly<{ subjectAltName?: readonly string[] }>;
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

export function certToPem(cert: X509Certificate): string {
  return armour('CERTIFICATE', cert);
}

export function pemToCert(pem: string): X509Certificate | null {
  const o = unarmour(pem, 'CERTIFICATE') as X509Certificate | null;
  if (!o || typeof o.subject !== 'string' || typeof o.serialNumber !== 'string') return null;
  return o;
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
  const label: PemLabel = traditional
    ? (key.algorithm === 'ecdsa' ? 'EC PRIVATE KEY' : 'RSA PRIVATE KEY')
    : 'PRIVATE KEY';
  return armour(label, key);
}

export function pemToPrivateKey(pem: string): PkiPrivateKey | null {
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'] as const) {
    const o = unarmour(pem, label) as PkiPrivateKey | null;
    if (o && typeof o.material === 'string') return o;
  }
  return null;
}

export function publicKeyToPem(key: PkiPublicKey): string {
  return armour('PUBLIC KEY', key);
}

export function pemToPublicKey(pem: string): PkiPublicKey | null {
  const o = unarmour(pem, 'PUBLIC KEY') as PkiPublicKey | null;
  return o && typeof o.material === 'string' ? o : null;
}

// ─── Demandes de signature ──────────────────────────────────────────

export function csrToPem(csr: CertificateRequest): string {
  return armour('CERTIFICATE REQUEST', csr);
}

export function pemToCsr(pem: string): CertificateRequest | null {
  const o = unarmour(pem, 'CERTIFICATE REQUEST') as CertificateRequest | null;
  return o && typeof o.subject === 'string' ? o : null;
}

// ─── Liste de révocation ────────────────────────────────────────────

export function crlToPem(crl: CertificateRevocationList): string {
  return armour('X509 CRL', crl);
}

/**
 * Une CRL relue est une VRAIE `CertificateRevocationList`, signature
 * comprise, et non plus l'objet quelconque que ce module rendait.
 *
 * Le typage n'est pas cosmétique : tant que cette fonction rendait
 * `unknown`, aucun appelant ne pouvait demander `isValidSignature` ni
 * `contains`, donc aucune CRL de ce simulateur n'était opposable à quoi
 * que ce soit — `-gencrl` publiait une liste que personne ne pouvait
 * lire autrement que pour l'afficher.
 */
export function pemToCrl(pem: string): CertificateRevocationList | null {
  const o = unarmour(pem, 'X509 CRL') as (CrlFields & { signature?: string }) | null;
  if (!o || typeof o.issuer !== 'string' || !Array.isArray(o.revoked)) return null;
  return CertificateRevocationList.fromParsed({
    version: 2,
    issuer: o.issuer,
    thisUpdate: o.thisUpdate,
    nextUpdate: o.nextUpdate,
    signatureAlgorithm: o.signatureAlgorithm ?? 'sha256WithRSAEncryption',
    revoked: o.revoked,
  }, o.signature ?? '');
}
