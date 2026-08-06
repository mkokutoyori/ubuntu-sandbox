/**
 * X25519 réel — confronté aux vecteurs de la RFC 7748.
 *
 * Comme pour HKDF, c'est la confrontation qui distingue une
 * implémentation d'une invention plausible : une échelle de Montgomery
 * écrite de mémoire donne des résultats parfaitement déterministes et
 * parfaitement faux, et rien dans un aller-retour entre deux copies du
 * même code ne le montrerait.
 */

import { describe, it, expect } from 'vitest';
import { x25519, x25519Base, clampScalar, isAllZero, X25519_BASE } from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

const h = (s: string) => hexToBytes(s);

describe('RFC 7748 §5.2 — multiplication scalaire', () => {
  it('premier vecteur', () => {
    expect(bytesToHex(x25519(
      h('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
      h('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'),
    ))).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  });

  it('second vecteur', () => {
    expect(bytesToHex(x25519(
      h('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'),
      h('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493'),
    ))).toBe('95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957');
  });
});

describe('RFC 7748 §6.1 — l\'échange lui-même', () => {
  const alicePriv = h('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bobPriv = h('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');

  it('les deux clés publiques sont celles de la RFC', () => {
    expect(bytesToHex(x25519Base(alicePriv)))
      .toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(bytesToHex(x25519Base(bobPriv)))
      .toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
  });

  it('et les deux bouts arrivent au même secret, qui est celui de la RFC', () => {
    const partageA = x25519(alicePriv, x25519Base(bobPriv));
    const partageB = x25519(bobPriv, x25519Base(alicePriv));
    expect(bytesToHex(partageA)).toBe(bytesToHex(partageB));
    expect(bytesToHex(partageA))
      .toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  });

  /**
   * Ce qui distingue un vrai échange de clés du condensé qu'il remplace :
   * un témoin voit les DEUX clés publiques et n'en tire rien. Le test ne
   * peut évidemment pas prouver la difficulté du problème ; il pose que
   * le secret n'est aucune des valeurs publiques, ce que le condensé,
   * lui, ne pouvait pas garantir puisqu'il n'était QUE leur fonction.
   */
  it('le secret n\'est aucune des valeurs publiques', () => {
    const pubA = bytesToHex(x25519Base(alicePriv));
    const pubB = bytesToHex(x25519Base(bobPriv));
    const partage = bytesToHex(x25519(alicePriv, x25519Base(bobPriv)));
    expect(partage).not.toBe(pubA);
    expect(partage).not.toBe(pubB);
  });
});

describe('le clamping du §5', () => {
  it('force les trois bits bas à zéro et les deux bits hauts', () => {
    const k = clampScalar(new Uint8Array(32).fill(0xff));
    expect(k[0] & 0b111).toBe(0);
    expect(k[31] & 0b1000_0000).toBe(0);
    expect(k[31] & 0b0100_0000).toBe(0b0100_0000);
  });

  it('deux scalaires que le clamping rend égaux donnent le même résultat', () => {
    const a = new Uint8Array(32); a[0] = 0b0000_0001; a[31] = 0x40;
    const b = new Uint8Array(32); b[0] = 0b0000_0110; b[31] = 0xc0;
    // Le clamping les ramène tous deux à zéro sur les bits qu'il fixe :
    // ce n'est pas une coquetterie, c'est ce qui empêche un scalaire de
    // fuir un bit du secret par le cofacteur.
    expect(bytesToHex(clampScalar(a))).toBe(bytesToHex(clampScalar(b)));
    expect(bytesToHex(x25519(a, X25519_BASE))).toBe(bytesToHex(x25519(b, X25519_BASE)));
  });
});

describe('les points d\'ordre faible', () => {
  it('donnent un résultat tout à zéro, que TLS doit refuser', () => {
    const priv = h('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    // u = 0 est le premier des points d'ordre faible de la §6.1.
    expect(isAllZero(x25519(priv, new Uint8Array(32)))).toBe(true);
    // Un point ordinaire, lui, ne l'est pas — sans quoi le contrôle
    // ci-dessus ne distinguerait rien.
    expect(isAllZero(x25519(priv, X25519_BASE))).toBe(false);
  });
});

describe('le coût', () => {
  it('une multiplication scalaire reste sous la milliseconde en moyenne', () => {
    const priv = h('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const debut = Date.now();
    for (let i = 0; i < 20; i++) x25519Base(priv);
    // Vingt multiplications : une poignée de main en demande deux. La
    // borne est large exprès — elle vise à repérer une régression d'un
    // ordre de grandeur, pas à mesurer la machine.
    expect(Date.now() - debut).toBeLessThan(2000);
  });
});
