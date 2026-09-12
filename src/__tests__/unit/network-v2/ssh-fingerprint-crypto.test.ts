/**
 * Migration guard: SshFingerprint must use a real SHA-256 digest (OpenSSH
 * `ssh-keygen -lf` format) rather than the historical FNV stand-in.
 *
 * L'intention d'origine est conservee — vecteur SHA-256 publie, forme,
 * determinisme, avalanche. Ce qui change, c'est l'ENTREE : ces cas
 * passaient des chaines quelconques (`abc`, `k`, `key-a`) parce que
 * `fromPublicKey` hachait le TEXTE base64 de la cle. OpenSSH hache les
 * OCTETS DECODES, et c'est ce que `ssh-keygen -l` fait deja dans ce depot
 * (`keygenDigest`) ; les deux vues se contredisaient sur une meme cle.
 *
 * Le vecteur publie survit et prouve desormais le decodage lui-meme :
 * `YWJj` est le base64 de « abc », donc son empreinte doit etre le
 * SHA-256 de « abc ».
 */

import { describe, it, expect } from 'vitest';
import { SshFingerprint } from '@/network/protocols/ssh/SshFingerprint';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';

const SHA256_DE_ABC = 'SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0';

describe('SshFingerprint — real SHA-256', () => {
  it('hache les OCTETS DECODES, pas le texte base64', () => {
    expect(SshFingerprint.fromPublicKey('YWJj').toString()).toBe(SHA256_DE_ABC);
    expect(SshFingerprint.fromPublicKey('abc').toString()).not.toBe(SHA256_DE_ABC);
  });

  it('accepte une ligne complete comme le champ seul', () => {
    expect(SshFingerprint.fromPublicKey('ssh-ed25519 YWJj commentaire').toString())
      .toBe(SHA256_DE_ABC);
  });

  it('keeps the SHA256:<base64> shape (43 chars, no padding)', () => {
    const fp = SshFingerprint.fromPublicKey(SshHostKey.generate('h1').publicKey).toString();
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fp).not.toContain('=');
  });

  it('is deterministic for the same key', () => {
    const blob = SshHostKey.generate('h1').publicKey;
    expect(SshFingerprint.fromPublicKey(blob).toString())
      .toBe(SshFingerprint.fromPublicKey(blob).toString());
  });

  it('avalanches: a one-character change flips most of the digest', () => {
    const a = SshFingerprint.fromPublicKey(SshHostKey.generate('key-a').publicKey).toString();
    const b = SshFingerprint.fromPublicKey(SshHostKey.generate('key-b').publicKey).toString();
    expect(a).not.toBe(b);
  });

  it('l empreinte d une cle d hote est celle que `ssh-keygen -l` annonce', () => {
    const cle = SshHostKey.generate('srv1');
    expect(cle.fingerprint.toString()).toBe(
      SshFingerprint.fromPublicKey(cle.publicKeyLine).toString());
  });
});
