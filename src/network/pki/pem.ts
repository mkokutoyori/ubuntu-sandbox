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
const PKCS8_ITERATIONS = 2048;
const PKCS8_KEY_LEN = 32;
const PKCS8_IV_LEN = 16;

interface EnveloppePkcs8 {
  readonly alg: 'aes-256-cbc';
  readonly kdf: 'pbkdf2-sha256';
  readonly iter: number;
  readonly salt: string;
  readonly iv: string;
  readonly data: string;
}

export function encryptedPrivateKeyToPem(
  key: PkiPrivateKey, passphrase: string, random: (n: number) => Uint8Array,
): string {
  const salt = random(16);
  const iv = random(PKCS8_IV_LEN);
  const cle = pbkdf2(SHA256, utf8ToBytes(passphrase), salt, PKCS8_ITERATIONS, PKCS8_KEY_LEN);
  const clair = utf8ToBytes(JSON.stringify(key));
  const enveloppe: EnveloppePkcs8 = {
    alg: 'aes-256-cbc',
    kdf: 'pbkdf2-sha256',
    iter: PKCS8_ITERATIONS,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    data: bytesToHex(aesCbcEncrypt(cle, iv, clair)),
  };
  return armour('ENCRYPTED PRIVATE KEY', enveloppe);
}

/**
 * `null` sur une mauvaise phrase de passe — et c'est le seul verdict
 * possible : le déchiffrement AES rend des octets quelconques dont le
 * dépaddage ou le JSON échouent. C'est aussi ce que fait un vrai
 * openssl, qui ne peut pas distinguer « mauvaise phrase » de « fichier
 * corrompu ».
 */
export function pemToEncryptedPrivateKey(pem: string, passphrase: string): PkiPrivateKey | null {
  const env = unarmour(pem, 'ENCRYPTED PRIVATE KEY') as EnveloppePkcs8 | null;
  if (!env || typeof env.salt !== 'string' || typeof env.iv !== 'string') return null;
  try {
    const cle = pbkdf2(
      SHA256, utf8ToBytes(passphrase), hexToBytes(env.salt),
      env.iter ?? PKCS8_ITERATIONS, PKCS8_KEY_LEN,
    );
    const clair = aesCbcDecrypt(cle, hexToBytes(env.iv), hexToBytes(env.data));
    const o = JSON.parse(bytesToUtf8(clair)) as PkiPrivateKey;
    return typeof o?.material === 'string' ? o : null;
  } catch {
    return null;
  }
}

/** Une armure de clé chiffrée est-elle présente ? */
export function isEncryptedPrivateKeyPem(pem: string): boolean {
  return pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');
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
