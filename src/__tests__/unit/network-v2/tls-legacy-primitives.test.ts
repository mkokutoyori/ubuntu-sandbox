/**
 * Primitives de TLS 1.0 à 1.2 (RFC 2246 §5, RFC 4346 §6.2.3.2, RFC 5246 §5, §6.2.3) comparées
 * à un oracle indépendant : node:crypto, qui sert ici de référence et n'entre
 * jamais dans le code livré. Module neuf, donc tous les cas échouent avant par
 * absence du module ; le témoin « un octet retourné est détecté » prouve que
 * l'ouverture ne rend pas n'importe quoi.
 */
import { describe, it, expect } from 'vitest';
import { createHmac, createCipheriv, createDecipheriv, publicEncrypt, generateKeyPairSync, constants } from 'node:crypto';
import { tlsPrf, deriveKeyBlock, LegacyRecordProtection } from '@/network/tls/legacy/legacyCrypto';
import { legacySuiteByName } from '@/network/tls/legacy/legacyCipherSuites';
import { rsaDecryptPkcs1, rsaEncryptPkcs1, type RsaPrivateKey } from '@/crypto/rsa';
import type { TlsRecord } from '@/network/tls/recordLayer';

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

function oraclePHash(algorithm: string, secret: Buffer, seed: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  let a = seed;
  let produced = 0;
  while (produced < length) {
    a = createHmac(algorithm, secret).update(a).digest();
    const block = createHmac(algorithm, secret).update(Buffer.concat([a, seed])).digest();
    out.push(block);
    produced += block.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

describe('PRF', () => {
  const secret = bytes('9bbe436ba940f017b17652849a71db35');
  const seed = bytes('a0ba9f936cda311827a6f796ffd5198c');
  it('TLS 1.2 SHA-256 suit P_hash (oracle node:crypto)', () => {
    const expected = oraclePHash('sha256', Buffer.from(secret), Buffer.concat([Buffer.from('test label'), Buffer.from(seed)]), 100);
    expect(Buffer.from(tlsPrf('1.2', 'SHA256', secret, 'test label', seed, 100)).toString('hex')).toBe(expected.toString('hex'));
  });
  it('TLS 1.2 SHA-384 suit P_hash (oracle node:crypto)', () => {
    const expected = oraclePHash('sha384', Buffer.from(secret), Buffer.concat([Buffer.from('test label'), Buffer.from(seed)]), 100);
    expect(Buffer.from(tlsPrf('1.2', 'SHA384', secret, 'test label', seed, 100)).toString('hex')).toBe(expected.toString('hex'));
  });
  it('TLS 1.0/1.1 : P_MD5(S1) xor P_SHA1(S2), moitiés du secret (RFC 2246 §5)', () => {
    const labelSeed = Buffer.concat([Buffer.from('test label'), Buffer.from(seed)]);
    const s = Buffer.from(secret);
    const half = Math.ceil(s.length / 2);
    const md5 = oraclePHash('md5', s.subarray(0, half), labelSeed, 80);
    const sha1 = oraclePHash('sha1', s.subarray(s.length - half), labelSeed, 80);
    const expected = Buffer.from(md5.map((b, i) => b ^ sha1[i]));
    expect(Buffer.from(tlsPrf('1.0', 'SHA256', secret, 'test label', seed, 80)).toString('hex')).toBe(expected.toString('hex'));
  });
  it('un secret de longueur impaire partage son octet central entre les moitiés', () => {
    const odd = bytes('0102030405');
    const labelSeed = Buffer.concat([Buffer.from('x'), Buffer.from(seed)]);
    const md5 = oraclePHash('md5', Buffer.from(odd.subarray(0, 3)), labelSeed, 16);
    const sha1 = oraclePHash('sha1', Buffer.from(odd.subarray(2)), labelSeed, 16);
    expect(Buffer.from(tlsPrf('1.1', 'SHA256', odd, 'x', seed, 16)).toString('hex'))
      .toBe(Buffer.from(md5.map((b, i) => b ^ sha1[i])).toString('hex'));
  });
});

function record(text: string): TlsRecord {
  return { contentType: 'application_data', legacyVersion: 0x0303, fragment: new TextEncoder().encode(text) };
}

function pair(name: string, version: '1.0' | '1.1' | '1.2') {
  const suite = legacySuiteByName(name)!;
  const master = new Uint8Array(48).map((_, i) => i);
  const block = deriveKeyBlock(version, suite, master, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  return {
    writer: new LegacyRecordProtection(version, suite, block.client),
    reader: new LegacyRecordProtection(version, suite, block.client),
    block,
  };
}

describe('protection des enregistrements', () => {
  it('AES-128-GCM : le chiffré est celui de node:crypto (nonce sel || numéro, AAD RFC 5246 §6.2.3.3)', () => {
    const { writer, block } = pair('TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', '1.2');
    const sealed = writer.seal(5, record('bonjour'));
    const explicit = Buffer.from([0, 0, 0, 0, 0, 0, 0, 5]);
    const aad = Buffer.from([0, 0, 0, 0, 0, 0, 0, 5, 23, 3, 3, 0, 7]);
    const cipher = createCipheriv('aes-128-gcm', Buffer.from(block.client.encKey), Buffer.concat([Buffer.from(block.client.fixedIv), explicit]));
    cipher.setAAD(aad);
    const expected = Buffer.concat([explicit, cipher.update('bonjour'), cipher.final(), cipher.getAuthTag()]);
    expect(Buffer.from(sealed.fragment).toString('hex')).toBe(expected.toString('hex'));
  });

  for (const [name, version, algorithm] of [
    ['TLS_RSA_WITH_AES_128_CBC_SHA', '1.2', 'aes-128-cbc'],
    ['TLS_RSA_WITH_AES_256_CBC_SHA', '1.1', 'aes-256-cbc'],
    ['TLS_RSA_WITH_3DES_EDE_CBC_SHA', '1.2', 'des-ede3-cbc'],
  ] as const) {
    it(`${name} en TLS ${version} : l'ouverture rend le clair et le déchiffrement de node:crypto s'accorde`, () => {
      const { writer, reader, block } = pair(name, version);
      const sealed = writer.seal(3, record('Hello CBC with some more bytes to cross a block'));
      expect(reader.open(3, sealed)!.fragment).toEqual(record('Hello CBC with some more bytes to cross a block').fragment);
      const blockSize = algorithm === 'des-ede3-cbc' ? 8 : 16;
      const iv = Buffer.from(sealed.fragment.subarray(0, blockSize));
      const decipher = createDecipheriv(algorithm, Buffer.from(block.client.encKey), iv);
      decipher.setAutoPadding(false);
      const raw = Buffer.concat([decipher.update(Buffer.from(sealed.fragment.subarray(blockSize))), decipher.final()]);
      const padLength = raw[raw.length - 1];
      expect(raw.subarray(0, 'Hello CBC with some more bytes to cross a block'.length).toString()).toBe('Hello CBC with some more bytes to cross a block');
      expect(raw.subarray(raw.length - padLength - 1).every((b) => b === padLength)).toBe(true);
    });
  }

  it('TLS 1.0 : le vecteur d’initialisation s’enchaîne d’un enregistrement au suivant (BEAST, RFC 4346 §1)', () => {
    const { writer, reader } = pair('TLS_RSA_WITH_AES_128_CBC_SHA', '1.0');
    const first = writer.seal(0, record('aaaa'));
    const second = writer.seal(1, record('bbbb'));
    expect(first.fragment.length % 16).toBe(0);
    expect(reader.open(0, first)!.fragment).toEqual(record('aaaa').fragment);
    expect(reader.open(1, second)!.fragment).toEqual(record('bbbb').fragment);
  });

  it('témoin : un octet retourné, ou un mauvais numéro de séquence, est détecté', () => {
    for (const name of ['TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_RSA_WITH_AES_128_CBC_SHA256']) {
      const { writer, reader } = pair(name, '1.2');
      const sealed = writer.seal(9, record('secret'));
      const tampered = { ...sealed, fragment: sealed.fragment.slice() };
      tampered.fragment[tampered.fragment.length - 1] ^= 1;
      expect(reader.open(9, tampered)).toBeNull();
      expect(reader.open(10, sealed)).toBeNull();
    }
  });
});

describe('RSAES-PKCS1-v1_5', () => {
  it('chiffre pour la clé publique d’un oracle et déchiffre ce que node:crypto chiffre', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwk = privateKey.export({ format: 'jwk' }) as { n: string; e: string; d: string };
    const big = (b64: string) => BigInt(`0x${Buffer.from(b64, 'base64url').toString('hex')}`);
    const priv: RsaPrivateKey = { n: big(jwk.n), e: big(jwk.e), d: big(jwk.d) };
    const message = bytes('0303' + 'ab'.repeat(46));
    const fromOracle = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(message));
    expect(rsaDecryptPkcs1(priv, Uint8Array.from(fromOracle))).toEqual(message);
    const ours = rsaEncryptPkcs1({ n: priv.n, e: priv.e }, message);
    expect(rsaDecryptPkcs1(priv, ours)).toEqual(message);
    ours[ours.length - 1] ^= 1;
    expect(rsaDecryptPkcs1(priv, ours)).not.toEqual(message);
  });
});
