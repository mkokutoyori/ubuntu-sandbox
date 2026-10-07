/**
 * Un fichier du simulateur est une chaîne ; les octets qui ne sont pas de l'UTF-8 valide s'y
 * conservent sans perte par échappement (chaque octet invalide x devient U+DC00+x, la convention
 * « surrogateescape » de Python, PEP 383). Les octets qui forment de l'UTF-8 valide restent du texte.
 *
 * MESURÉ avant correctif : le système de fichiers remplaçait tout octet invalide par U+FFFD à la
 * lecture (« base64 -d » d'un DER donnait 3 caractères U+FFFD), si bien que xxd, sha256sum et openssl
 * enc ne pouvaient pas voir un fichier binaire. Avant correctif, les 5 cas tombent (la fonction
 * n'existait pas) ; le témoin (un texte accentué valide garde ses caractères) ne dépend pas de
 * l'échappement.
 */
import { describe, it, expect } from 'vitest';
import { bytesToFileText, fileTextToBytes, utf8ToBytes } from '@/crypto/encoding';

describe('octets ↔ texte de fichier', () => {
  it('chaque octet isolé survit à l\'aller-retour', () => {
    for (let value = 0; value < 256; value++) {
      const bytes = Uint8Array.of(value);
      expect(Array.from(fileTextToBytes(bytesToFileText(bytes)))).toEqual([value]);
    }
  });

  it('un tampon aléatoire de 4096 octets survit à l\'aller-retour, y compris les séquences UTF-8 tronquées', () => {
    let state = 12345;
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) { state = (state * 1103515245 + 12345) & 0x7fffffff; bytes[i] = state >> 8; }
    expect(Array.from(fileTextToBytes(bytesToFileText(bytes)))).toEqual(Array.from(bytes));
  });

  it('un DER réel (certificat) survit', () => {
    const der = Uint8Array.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01, 0x00, 0xff, 0x80, 0xc3, 0x28, 0xe2, 0x82]);
    expect(Array.from(fileTextToBytes(bytesToFileText(der)))).toEqual(Array.from(der));
  });

  it('les surrogates échappés ne se confondent pas avec un UTF-8 valide', () => {
    expect(bytesToFileText(Uint8Array.of(0xc3, 0xa9))).toBe('é');
    expect(bytesToFileText(Uint8Array.of(0xc3))).toBe('\udcc3');
    expect(Array.from(fileTextToBytes('\udcc3'))).toEqual([0xc3]);
  });

  it('une séquence surdimensionnée (C0 80) n\'est pas décodée en NUL', () => {
    expect(Array.from(fileTextToBytes(bytesToFileText(Uint8Array.of(0xc0, 0x80))))).toEqual([0xc0, 0x80]);
  });

  it('WITNESS — un texte accentué valide garde ses caractères et ses octets UTF-8', () => {
    const bytes = utf8ToBytes('Société Générale — 日本');
    expect(bytesToFileText(bytes)).toBe('Société Générale — 日本');
    expect(Array.from(fileTextToBytes('Société Générale — 日本'))).toEqual(Array.from(bytes));
  });
});
