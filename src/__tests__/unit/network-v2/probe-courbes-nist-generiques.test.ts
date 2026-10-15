/**
 * Sonde des courbes NIST generiques (P-256, P-384, P-521) : cle publique, signature
 * deterministe RFC 6979 et verification, contre des vecteurs produits par une
 * bibliotheque independante (cryptography 50, ECDSA deterministic_signing).
 * Avant la correction : 0 cas sur 7 (le module nistCurves n'existait pas).
 * Temoins qui passent avec ou sans : aucun, le module est neuf.
 */
import { describe, it, expect } from 'vitest';
import { NIST_CURVES, type NistCurveName } from '@/crypto/ecc/nistCurves';
import { utf8ToBytes } from '@/crypto/encoding';

const VECTORS: Record<NistCurveName, { d: bigint; x: bigint; y: bigint; r: bigint; s: bigint }> = {
  nistp256: { d: 0xfd97e6aa9cfb3d6e31ab5dba43cbc873a8bbabc42bfb38c7e407ff06d40d203en, x: 0xd1cb29880496c13bdef2bbf3d4c2ea8142a33d759ab58c7185505f653ecfbbf7n, y: 0x8e1994b3dceabda2bb1d8cf612d48c45db828de7f634658d910a686caf0e3d54n, r: 0xa4565a1f09784af2c8c00b6a1cdcb9e7874ec92a6152cd2981f0ba9032645605n, s: 0x229fbd8ad35864bcd32a89fc61e9ae63146e36f0def79fea9e28b9c7a0609e0en },
  nistp384: { d: 0x92f7de3782608330ed8247c5a1a7ff8ea5b536296a394e6e97e780e74fb693c5d83d8e1f60114a870e966f08b7f6da3cn, x: 0x735d7a5e75d3534ccb0e8a796b50636522850723e4cf6a73c875df06dc75d3d629dcb3b407e00169dab01781415a67afn, y: 0x6b632a65ba676e46988477c53cace2e6b7735a6c6d0aae69b1cb9b777de19e8b985c1b871d4728ba5d363c74f477ea55n, r: 0xfca2789848fcad9f1d8cea9d07d0329a50e7452e7913ba942abce994fde0952ab2bbf40f7cef121b2cb034574e9b3e8an, s: 0xc1704797f8c0d9672880dc385f079ad087aa74c32bb8bf31f6b16a86633a7d3de46fd5bd0aa7986fd7fd24e3fab3a854n },
  nistp521: { d: 0x130a48b84ec56802222a22eebc4ed96babd559b89e09a09feb8381df6064896fe87254146c07738ff4db8d2efac6f6ed29a9234340f2f71c9c6cb8074d806aca0bn, x: 0x15c8a0ec7c1d9dc5615ebe06b6862b33b1bbf128acd90dad2e73dead026312f1ed7f2ff0932e38b7d4e194b355b994050839ce0f7cb1315b02105f13310e4692731n, y: 0xd9f62d21f619741a76f98d5110a3be00059ea1ca0e76a11ee5e8e2874b940d6cfc6f2c1e36e3bca8ffeef99998e7b2fc41964a742e138dfda2367a852f337c3a54n, r: 0x13e8e7a14d1022483951ff586e8be80b26716241a61d528f3e6140403de3b0afb47fa2aaa1e5a648a526ebdf5c0c9254771b0675fc9279153b67b790725f209b4b5n, s: 0xd7565dd52711fffd239e1accc3b338473ddd8dd7329a8d0499afd4cc565b2c6a0b0952afe36f72be5dc1931ec5f8a8c9c5cba880b6793f5cb7a49745854260c59en },
};
const MESSAGE = utf8ToBytes('ssh-keygen interop vector');

describe.each(Object.keys(NIST_CURVES) as NistCurveName[])('%s', (name) => {
  const curve = NIST_CURVES[name];
  const vector = VECTORS[name];

  it('derives the public point of a private scalar', () => {
    expect(curve.publicKey(vector.d)).toEqual({ x: vector.x, y: vector.y });
  });

  it('signs deterministically, exactly like an independent RFC 6979 implementation', () => {
    expect(curve.sign(vector.d, MESSAGE)).toEqual({ r: vector.r, s: vector.s });
  });

  it('verifies that signature and refuses a flipped message', () => {
    const q = { x: vector.x, y: vector.y };
    expect(curve.verify(q, MESSAGE, { r: vector.r, s: vector.s })).toBe(true);
    expect(curve.verify(q, utf8ToBytes('another'), { r: vector.r, s: vector.s })).toBe(false);
  });

  it('refuses a point that is not on the curve', () => {
    expect(curve.isOnCurve({ x: vector.x, y: vector.y })).toBe(true);
    expect(curve.isOnCurve({ x: vector.x, y: vector.y + 1n })).toBe(false);
  });
});

describe('the encoded point', () => {
  it('round-trips through the SEC 1 uncompressed form with the field size of each curve', () => {
    for (const name of Object.keys(NIST_CURVES) as NistCurveName[]) {
      const curve = NIST_CURVES[name];
      const q = curve.publicKey(VECTORS[name].d);
      const encoded = curve.encodePoint(q);
      expect(encoded.length).toBe(1 + 2 * ({ nistp256: 32, nistp384: 48, nistp521: 66 }[name]));
      expect(curve.decodePoint(encoded)).toEqual(q);
    }
  });
});
