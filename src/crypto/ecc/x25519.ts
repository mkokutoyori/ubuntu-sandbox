/**
 * X25519 réel (RFC 7748) — l'échange de clés de Curve25519.
 *
 * Étage 3. Le secret partagé de TLS était
 * `simulatedDigest(aléa_client | aléa_serveur | part_client | part_serveur)` :
 * les deux bouts tombaient bien d'accord, et un tiers connaissant les
 * quatre valeurs PUBLIQUES tombait d'accord avec eux — c'est-à-dire
 * l'exact contraire de ce qu'un échange de clés existe pour faire.
 *
 * Ici l'arithmétique est faite sur `bigint` modulo 2^255 - 19 plutôt que
 * sur des membres de 25/26 bits. C'est plus lent que les implémentations
 * de production et ce n'est pas à temps constant — donc inutilisable pour
 * protéger quoi que ce soit de réel — mais c'est JUSTE : les vecteurs de
 * la RFC 7748 §5.2 et §6.1 passent, et une multiplication scalaire coûte
 * environ deux millisecondes, ce qui laisse une poignée de main
 * imperceptible.
 */

import {
  bigIntToLittleEndian, invert25519 as invert, littleEndianToBigInt, mod25519 as mod,
} from './curve25519Field';

/** (486662 - 2) / 4, la constante `a24` de la RFC §5. */
const A24 = 121665n;

export const X25519_KEY_LEN = 32;

/**
 * Le « clamping » du §5 : les trois bits de poids faible à zéro pour que
 * le scalaire soit multiple du cofacteur, le bit 255 à zéro et le bit 254
 * à un pour fixer la position du bit de tête. Il n'est pas décoratif —
 * sans lui, une clé sur huit fuirait un bit du secret.
 */
export function clampScalar(scalar: Uint8Array): Uint8Array {
  const k = Uint8Array.from(scalar);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  return k;
}

/**
 * L'échelle de Montgomery du §5. `swap` conditionne l'échange des deux
 * points comme le pseudo-code de la RFC, bit de scalaire par bit de
 * scalaire, du poids fort au poids faible.
 */
export function x25519(scalar: Uint8Array, uCoordinate: Uint8Array): Uint8Array {
  const k = littleEndianToBigInt(clampScalar(scalar));
  const u = Uint8Array.from(uCoordinate);
  // §5 : le bit de poids fort de la coordonnée reçue est ignoré.
  u[31] &= 127;
  const x1 = mod(littleEndianToBigInt(u));

  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
  for (let t = 254; t >= 0; t--) {
    const bit = (k >> BigInt(t)) & 1n;
    swap ^= bit;
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    swap = bit;

    const a = mod(x2 + z2), aa = mod(a * a);
    const b = mod(x2 - z2), bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3), d = mod(x3 - z3);
    const da = mod(d * a), cb = mod(c * b);
    x3 = mod((da + cb) * (da + cb));
    z3 = mod(x1 * mod((da - cb) * (da - cb)));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + A24 * e));
  }
  if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }

  return bigIntToLittleEndian(mod(x2 * invert(z2)), X25519_KEY_LEN);
}

/** Le point de base du §4.1 : u = 9. */
export const X25519_BASE: Uint8Array = (() => {
  const b = new Uint8Array(X25519_KEY_LEN);
  b[0] = 9;
  return b;
})();

/** La clé publique d'un scalaire : sa multiplication par le point de base. */
export function x25519Base(scalar: Uint8Array): Uint8Array {
  return x25519(scalar, X25519_BASE);
}

/**
 * Un résultat tout à zéro signale un point d'ordre faible (§6.1) : la RFC
 * laisse le choix de l'ignorer, TLS 1.3 (RFC 8446 §7.4.2) impose de
 * l'ABANDONNER, parce qu'il donnerait un secret partagé que l'attaquant
 * connaît d'avance.
 */
export function isAllZero(bytes: Uint8Array): boolean {
  let diff = 0;
  for (const b of bytes) diff |= b;
  return diff === 0;
}
