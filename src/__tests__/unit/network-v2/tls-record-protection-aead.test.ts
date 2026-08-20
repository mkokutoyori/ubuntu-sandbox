/**
 * Les enregistrements TLS sont chiffrés ET authentifiés (RFC 8446 §5.2,
 * §5.3, §7.3).
 *
 * Ce que c'était : un XOR de flux. Il chiffrait, en un sens — mais il
 * n'authentifiait rien, et c'est la différence de NATURE que ce fichier
 * mesure. Sous un XOR, toute suite d'octets se « déchiffre » : retourner
 * un bit du chiffré retourne le même bit du clair, sans que personne le
 * sache. Sous AES-GCM, l'étiquette ne colle plus et l'enregistrement est
 * refusé.
 *
 * La primitive AES-GCM était déjà là et déjà éprouvée contre les vecteurs
 * du NIST (`unit/crypto/aesGcm.test.ts`) ; ce qui manquait était la
 * dérivation du §7.3 qui en produit une clé et un nonce, et elle
 * dépendait du HKDF réel de l'étage 1.
 */

import { describe, it, expect } from 'vitest';
import {
  encryptApplicationData, decryptApplicationData, BadRecordMacError,
} from '@/network/http/https/ApplicationDataCipher';
import {
  deriveRecordKeys, perRecordNonce, recordAad, RECORD_KEY_LEN, RECORD_IV_LEN,
} from '@/network/tls/recordProtection';
import { extractSecret, expandLabel } from '@/network/tls/keySchedule';
import { bytesToHex } from '@/crypto/encoding';

const secret = expandLabel(extractSecret('sel', 'materiel'), 's ap traffic', '');
const autreSecret = expandLabel(extractSecret('sel', 'autre'), 's ap traffic', '');
const clair = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: lab\r\n\r\n');

describe('§7.3 — la clé et le nonce sortent du secret de trafic', () => {
  it('aux longueurs d\'AES_128_GCM_SHA256', () => {
    const k = deriveRecordKeys(secret);
    expect(k.key).toHaveLength(RECORD_KEY_LEN);
    expect(k.iv).toHaveLength(RECORD_IV_LEN);
  });

  it('la clé n\'est pas le préfixe de l\'IV, ni l\'inverse', () => {
    // Les deux viennent du MÊME secret ; ce sont l'étiquette et la
    // longueur, entrant toutes deux dans HkdfLabel, qui les séparent.
    const k = deriveRecordKeys(secret);
    expect(bytesToHex(k.key)).not.toBe(bytesToHex(k.iv).slice(0, RECORD_KEY_LEN * 2));
  });

  it('deux secrets différents donnent deux clés différentes', () => {
    expect(bytesToHex(deriveRecordKeys(secret).key))
      .not.toBe(bytesToHex(deriveRecordKeys(autreSecret).key));
  });
});

describe('§5.3 — le nonce par enregistrement', () => {
  it('est l\'IV XORé au numéro de séquence, en gros-boutien', () => {
    const iv = new Uint8Array(12).fill(0);
    expect(Array.from(perRecordNonce(iv, 1)).slice(-2)).toEqual([0, 1]);
    expect(Array.from(perRecordNonce(iv, 256)).slice(-2)).toEqual([1, 0]);
  });

  it('et il change à chaque enregistrement', () => {
    const { iv } = deriveRecordKeys(secret);
    expect(bytesToHex(perRecordNonce(iv, 0))).not.toBe(bytesToHex(perRecordNonce(iv, 1)));
  });
});

describe('un aller-retour reste un aller-retour', () => {
  it('le texte clair revient intact', () => {
    const { records, nextSeq } = encryptApplicationData(secret, 0, clair);
    const rendu = decryptApplicationData(secret, 0, records);
    expect(new TextDecoder().decode(rendu.plaintext)).toBe(new TextDecoder().decode(clair));
    expect(rendu.nextSeq).toBe(nextSeq);
  });

  it('et le chiffré ne laisse pas voir le clair', () => {
    const { records } = encryptApplicationData(secret, 0, clair);
    const octets = new TextDecoder('latin1').decode(records[0].fragment);
    expect(octets).not.toContain('HTTP/1.1');
  });
});

describe('ce que le XOR ne pouvait pas faire : refuser', () => {
  it('un octet retourné est DÉTECTÉ', () => {
    const { records } = encryptApplicationData(secret, 0, clair);
    const abime = records.map((r, i) => {
      if (i !== 0) return r;
      const f = Uint8Array.from(r.fragment);
      f[0] ^= 0x01;
      return { ...r, fragment: f };
    });

    expect(() => decryptApplicationData(secret, 0, abime)).toThrow(BadRecordMacError);
  });

  it('l\'étiquette d\'authentification tronquée est refusée', () => {
    const { records } = encryptApplicationData(secret, 0, clair);
    const tronque = records.map((r, i) => (
      i === 0 ? { ...r, fragment: r.fragment.subarray(0, r.fragment.length - 1) } : r
    ));
    expect(() => decryptApplicationData(secret, 0, tronque)).toThrow(BadRecordMacError);
  });

  it('le mauvais secret est refusé', () => {
    const { records } = encryptApplicationData(secret, 0, clair);
    expect(() => decryptApplicationData(autreSecret, 0, records)).toThrow(BadRecordMacError);
  });

  it('le mauvais numéro de séquence aussi — un rejeu ne se déchiffre pas', () => {
    const { records } = encryptApplicationData(secret, 5, clair);
    expect(() => decryptApplicationData(secret, 0, records)).toThrow(BadRecordMacError);
  });

  it('changer le type annoncé de l\'enregistrement est refusé', () => {
    // Le type est dans les données additionnelles authentifiées (§5.2),
    // donc il n'est pas modifiable sans casser l'étiquette — même s'il
    // n'est chiffré nulle part.
    const { records } = encryptApplicationData(secret, 0, clair);
    const menti = records.map((r, i) => (i === 0 ? { ...r, contentType: 'alert' as const } : r));
    expect(() => decryptApplicationData(secret, 0, menti)).toThrow(BadRecordMacError);
  });
});

describe('les données additionnelles sont l\'en-tête du fil', () => {
  it('type, version héritée, longueur du chiffré', () => {
    const aad = recordAad(
      { contentType: 'application_data', legacyVersion: 0x0303, fragment: new Uint8Array(0) },
      0x1234,
    );
    expect(Array.from(aad)).toEqual([23, 0x03, 0x03, 0x12, 0x34]);
  });
});
