/**
 * AES-128-GCM réel sur les enregistrements TLS 1.3 (RFC 8446 §5.2/§5.3,
 * §7.3).
 *
 * Étage 2 : la protection était un XOR de flux
 * (`dns/transport/SimulatedTls`) — réversible sans clé pour qui connaît
 * deux textes clairs, et surtout SANS AUTHENTIFICATION, donc un
 * enregistrement modifié en vol se déchiffrait en silence. Le vrai
 * AES-GCM existait déjà dans `crypto/cipher/aesGcm.ts` ; ce qui manquait
 * était la dérivation qui en produit une clé et un nonce, et elle
 * dépendait de l'étage 1 (le calendrier rendait des chaînes, pas des
 * octets).
 *
 * Ce que le changement apporte de VISIBLE et pas seulement de plus juste :
 * un octet retourné dans un enregistrement est maintenant DÉTECTÉ. C'est
 * l'objet même d'un AEAD, et c'est ce que le XOR ne pouvait pas offrir.
 */

import { aesGcmEncrypt, aesGcmDecrypt, AES_GCM_TAG_SIZE } from '@/crypto/cipher';
import { hkdfExpandLabel, toBytes } from './hkdf';
import type { TlsRecord } from './recordLayer';
import { CONTENT_TYPE_CODE } from './types';

/** AES_128_GCM_SHA256, la suite obligatoire du §9.1. */
export const RECORD_KEY_LEN = 16;
export const RECORD_IV_LEN = 12;

export interface RecordKeys {
  readonly key: Uint8Array;
  readonly iv: Uint8Array;
}

/**
 * §7.3 : `key = HKDF-Expand-Label(secret, "key", "", key_length)` et
 * `iv = HKDF-Expand-Label(secret, "iv", "", iv_length)`. Les deux sortent
 * du MÊME secret de trafic, et ne se confondent pas parce que
 * l'étiquette et la longueur entrent l'une et l'autre dans le calcul.
 */
export function deriveRecordKeys(trafficSecret: string): RecordKeys {
  const secret = toBytes(trafficSecret);
  return {
    key: hkdfExpandLabel(secret, 'key', new Uint8Array(0), RECORD_KEY_LEN),
    iv: hkdfExpandLabel(secret, 'iv', new Uint8Array(0), RECORD_IV_LEN),
  };
}

/**
 * §5.3 : le numéro de séquence, sur 64 bits en gros-boutien, est complété
 * à gauche à la taille de l'IV puis XORé avec lui. Il n'est JAMAIS
 * transmis — les deux bouts le comptent — ce qui est aussi ce qui rend
 * un enregistrement rejoué indéchiffrable.
 */
export function perRecordNonce(iv: Uint8Array, seq: number): Uint8Array {
  const nonce = Uint8Array.from(iv);
  let reste = seq;
  for (let i = 0; i < 8; i++) {
    nonce[nonce.length - 1 - i] ^= reste & 0xff;
    reste = Math.floor(reste / 256);
  }
  return nonce;
}

/**
 * §5.2 : les données additionnelles authentifiées sont l'en-tête de
 * l'enregistrement tel qu'il part sur le fil — type, version héritée, et
 * la longueur du CHIFFRÉ, étiquette comprise. Les inclure est ce qui
 * empêche de changer le type annoncé d'un enregistrement sans que le
 * déchiffrement échoue.
 */
export function recordAad(record: TlsRecord, ciphertextLength: number): Uint8Array {
  // `contentType` est un nom (`'application_data'`), pas le code du fil :
  // le passer tel quel donnait zéro pour tous les types, et le type
  // n'était donc plus authentifié du tout.
  return Uint8Array.from([
    CONTENT_TYPE_CODE[record.contentType],
    (record.legacyVersion >> 8) & 0xff,
    record.legacyVersion & 0xff,
    (ciphertextLength >> 8) & 0xff,
    ciphertextLength & 0xff,
  ]);
}

/** Chiffre le fragment d'un enregistrement et lui accole son étiquette. */
export function sealRecord(keys: RecordKeys, seq: number, record: TlsRecord): TlsRecord {
  const aad = recordAad(record, record.fragment.length + AES_GCM_TAG_SIZE);
  const { ciphertext, tag } = aesGcmEncrypt(
    keys.key, perRecordNonce(keys.iv, seq), aad, record.fragment,
  );
  const fragment = new Uint8Array(ciphertext.length + tag.length);
  fragment.set(ciphertext, 0);
  fragment.set(tag, ciphertext.length);
  return { ...record, fragment };
}

/**
 * L'inverse, et il peut ÉCHOUER : `null` quand l'étiquette ne colle pas.
 * C'est la différence de nature avec le XOR, où toute suite d'octets se
 * « déchiffrait ».
 */
export function openRecord(keys: RecordKeys, seq: number, record: TlsRecord): TlsRecord | null {
  if (record.fragment.length < AES_GCM_TAG_SIZE) return null;
  const coupe = record.fragment.length - AES_GCM_TAG_SIZE;
  const aad = recordAad(record, record.fragment.length);
  const clair = aesGcmDecrypt(
    keys.key,
    perRecordNonce(keys.iv, seq),
    aad,
    record.fragment.subarray(0, coupe),
    record.fragment.subarray(coupe),
  );
  return clair === null ? null : { ...record, fragment: clair };
}
