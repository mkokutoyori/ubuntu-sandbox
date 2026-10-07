/**
 * Parité avec le CODE SOURCE d'OpenSSL 3.0.13 (clone local, `ssl/ssl_ciph.c`,
 * `ssl/s3_lib.c`, `ssl/ssl_cert.c`, `crypto/x509/x509_vfy.c`,
 * `apps/ciphers.c`) : table des suites, algorithme de tri et de règles,
 * niveau de sécurité (`@SECLEVEL`), force de clé RSA
 * (`ossl_ifc_ffc_compute_security_bits`) et signature ECDSA/SHA-1 de
 * ServerKeyExchange avant TLS 1.2 (RFC 4492 §5.4, RFC 2246).
 *
 * MESURÉ avant correctif : la liste des suites était écrite à la main et
 * classée par intuition ; `@SECLEVEL` était refusé, les clés RSA de 512 bits
 * passaient partout et les suites ECDSA-CBC-SHA étaient interdites en
 * 1.0/1.1 faute de signature ECDSA/SHA-1.
 *
 * Avant correctif (stash des sources suivies ; les modules nouveaux non
 * suivis restent en place), 10 des 13 cas tombent. Les trois témoins
 * passent dans les deux états : TLS 1.0 au niveau 1 par défaut, une clé de
 * 1024 bits au niveau 1, et la signature ECDSA/SHA-256 de TLS 1.2.
 */
import { decodeHandshakeMessage, encodeHandshakeMessage } from '@/network/tls/messages';
import { decodeLegacyMessages, encodeLegacyBundle } from '@/network/tls/legacy/legacyMessages';
import { serverKeyExchangeParametersBytes } from '@/network/tls/wire/LegacyHandshakeCodec';
import type { KeyExchangeParams } from '@/network/tls/legacy/legacyMessages';
import { describe, it, expect } from 'vitest';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { createCipherList } from '@/network/tls/legacy/cipherString';
import { ffcSecurityBits, keySecurityBits } from '@/network/tls/legacy/securityPolicy';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { materialToP256Public } from '@/crypto/ecc';
import { bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

const NOW = Date.now();

function lab(
  client: Partial<TlsClientConfig>, server: Partial<TlsServerConfig>,
  options: { ecdsa?: boolean; keyBits?: number } = {},
) {
  const ca = CertificateAuthority.generate('CN=Root', { now: NOW, algorithm: options.ecdsa ? 'ecdsa' : 'rsa', keyBits: options.keyBits });
  const leaf = ca.issueCertificate({
    subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: ['srv.lab'], keyBits: options.keyBits,
  } as never);
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return {
    leaf,
    server: new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, ...server }),
    client: new TlsClientSession({ verifier, serverName: 'srv.lab', ...client }),
  };
}

function drive(client: TlsClientSession, server: TlsServerSession): { up: TlsRecord[][]; down: TlsRecord[][] } {
  const up: TlsRecord[][] = []; const down: TlsRecord[][] = [];
  let outgoing: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 6 && outgoing !== null && outgoing.length > 0; i++) {
    up.push([...outgoing]);
    const reply = server.handle(outgoing);
    if (reply === null || reply.length === 0) break;
    down.push([...reply]);
    outgoing = client.handle(reply);
  }
  return { up, down };
}

describe('table des suites et algorithme de ssl_ciph.c', () => {
  const names = (rule: string) => {
    const list = createCipherList(rule);
    return list.ok ? list.ciphers.map((c) => c.name) : [];
  };

  it('l\'ordre de DEFAULT est celui de `openssl ciphers` 3.0 (ECDHE+AEAD, ChaCha après GCM, 1.2 avant l\'héritage)', () => {
    expect(names('DEFAULT').slice(0, 9)).toEqual([
      'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384', 'DHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305', 'DHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'DHE-RSA-AES128-GCM-SHA256',
    ]);
  });

  it('les suites CCM sont NOT_DEFAULT : ALL les contient, DEFAULT non', () => {
    expect(names('ALL')).toContain('AES128-CCM');
    expect(names('DEFAULT')).not.toContain('AES128-CCM');
    expect(names('AESCCM')).toContain('ECDHE-ECDSA-AES256-CCM8');
  });

  it('SECLEVEL n\'accepte qu\'un chiffre de 0 à 5 (`ssl_cipher_process_rulestr`)', () => {
    const ok = createCipherList('DEFAULT:@SECLEVEL=3');
    expect(ok.ok && ok.securityLevel).toBe(3);
    expect(createCipherList('DEFAULT:@SECLEVEL=9').ok).toBe(false);
    expect(createCipherList('DEFAULT:@SECLEVEL=22').ok).toBe(false);
  });

  it('un mot à caractère interdit est une commande invalide, un mot inconnu est ignoré', () => {
    const bad = createCipherList('DEFAULT:#');
    expect(bad.ok === false && bad.error).toBe('error:0A000118:SSL routines::invalid command');
    expect(names('DEFAULT:NOSUCHWORD').length).toBe(names('DEFAULT').length);
  });
});

describe('niveau de sécurité (ssl_cert.c)', () => {
  it('témoin : au niveau 1 par défaut TLS 1.0 se négocie contre un serveur qui l\'autorise', () => {
    const { client, server } = lab({ versions: ['1.0'] }, { protocols: ['1.0'] });
    drive(client, server);
    expect(client.result).toBe('success');
  });

  it('au niveau 3, 1.0 n\'est plus offert : le client échoue avant d\'écrire (protocol_version)', () => {
    const { client } = lab({ versions: ['1.0'], cipherList: 'DEFAULT:@SECLEVEL=3' }, {});
    expect(client.start()).toEqual([]);
    expect(client.lastAlert?.description).toBe('protocol_version');
  });

  it('au niveau 3, une suite sans confidentialité persistante n\'est plus offerte', () => {
    const { client } = lab({ versions: ['1.2'], cipherList: 'ALL:@SECLEVEL=3' }, {});
    const hello = decodeHandshakeMessage(client.start()[0].fragment) as unknown as { legacyCipherSuites: number[] };
    expect(hello.legacyCipherSuites).not.toContain(0x009c);
    expect(hello.legacyCipherSuites).toContain(0xc02f);
  });

  it('force de clé : 1024 bits = 80, 2048 = 112, 3072 = 128, 512 = 56', () => {
    expect([512, 1024, 2048, 3072, 4096, 7680, 15360].map(ffcSecurityBits)).toEqual([56, 80, 112, 128, 152, 192, 256]);
    expect(keySecurityBits(PkiKeyPair.generate('ecdsa').publicKey)).toBe(128);
  });

  it('témoin : une clé RSA de 1024 bits passe au niveau 1', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server);
    expect(client.result).toBe('success');
  });

  it('une clé de 512 bits est refusée au niveau 1 (ee key too small → bad_certificate), acceptée au niveau 0', () => {
    const strict = lab({ versions: ['1.2'] }, {}, { keyBits: 512 });
    drive(strict.client, strict.server);
    expect(strict.client.lastAlert?.description).toBe('bad_certificate');
    const lax = lab({ versions: ['1.2'], securityLevel: 0 }, { securityLevel: 0 }, { keyBits: 512 });
    drive(lax.client, lax.server);
    expect(lax.client.result).toBe('success');
  });

  it('la clé de la racine compte aussi (CA_KEY_TOO_SMALL) : feuille 2048 sous racine 1024 refusée au niveau 2', () => {
    const ca = CertificateAuthority.generate('CN=Weak Root', { now: NOW, keyBits: 1024 });
    const leaf = ca.issueCertificate({ subject: 'CN=l', notBefore: NOW - 1000, notAfter: NOW + 1e9, keyBits: 2048 } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    expect(verifier.verify(leaf.cert, undefined, [], undefined, 2)).toEqual({ ok: false, reason: 'weak-ca-key' });
    expect(verifier.verify(leaf.cert, undefined, [], undefined, 1).ok).toBe(true);
  });
});

describe('ServerKeyExchange ECDSA avant TLS 1.2 (RFC 4492 §5.4)', () => {
  function signedParts(version: '1.0' | '1.2') {
    const { client, server, leaf } = lab(
      { versions: [version], cipherList: 'ECDHE-ECDSA-AES128-SHA:ECDHE-ECDSA-AES128-GCM-SHA256' },
      { protocols: [version] }, { ecdsa: true },
    );
    const wire = drive(client, server);
    expect(client.result).toBe('success');
    const hello = decodeHandshakeMessage(wire.up[0][0].fragment) as unknown as { random: string };
    const bundle = decodeLegacyMessages(wire.down[0][0].fragment) as unknown as { kind: string; random?: string; params?: KeyExchangeParams; signature?: string }[];
    return {
      leaf, clientRandom: hello.random as string,
      serverRandom: bundle.find((m) => m.kind === 'legacy_server_hello')!.random!,
      ske: bundle.find((m) => m.kind === 'server_key_exchange')!,
    };
  }

  for (const [version, digest] of [['1.0', 'sha1'], ['1.2', 'sha256']] as const) {
    it(`TLS ${version} : la signature vérifie avec ${digest} dans node:crypto`, () => {
      const parts = signedParts(version);
      const q = materialToP256Public(parts.leaf.cert.publicKey.material)!;
      const toHex = (n: bigint): string => n.toString(16).padStart(64, '0');
      const key = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: Buffer.from(toHex(q.x), 'hex').toString('base64url'), y: Buffer.from(toHex(q.y), 'hex').toString('base64url') },
        format: 'jwk',
      });
      const signed = Buffer.concat([
        Buffer.from(parts.clientRandom, 'hex'), Buffer.from(parts.serverRandom, 'hex'),
        Buffer.from(serverKeyExchangeParametersBytes(parts.ske.params!)),
      ]);
      const signature = Buffer.from(hexToBytes(parts.ske.signature!.slice('ecdsa:'.length)));
      expect(nodeVerify(digest, signed, { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
      const other = digest === 'sha1' ? 'sha256' : 'sha1';
      expect(nodeVerify(other, signed, { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(false);
    });
  }
});
