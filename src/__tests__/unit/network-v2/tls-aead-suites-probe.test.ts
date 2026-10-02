/**
 * Les suites AEAD de TLS sont réelles et le calendrier de clés suit RFC 8446
 * §7.1 : TLS_AES_256_GCM_SHA384 (HKDF-SHA384), TLS_CHACHA20_POLY1305_SHA256
 * (RFC 8439, RFC 8446 §5.2), TLS_AES_128_CCM[_8]_SHA256 (RFC 8446 §B.4), et
 * en TLS 1.2 ECDHE-*-CHACHA20-POLY1305 (RFC 7905) et *-AES*-CCM[8]
 * (RFC 6655). L'oracle est `node:crypto` : un second calendrier de clés
 * écrit dans ce fichier, et le déchiffrement des enregistrements par
 * l'implémentation de node.
 *
 * MESURÉ avant correctif : seule AES-128-GCM protégeait réellement un
 * enregistrement — les quatre autres suites 1.3 étaient NÉGOCIABLES mais
 * chiffrées en AES-128-GCM —, HKDF était câblé sur SHA-256 et
 * `Derive-Secret(., "derived", "")` recevait un contexte VIDE là où le
 * §7.1 impose le condensé de la chaîne vide.
 *
 * Avant correctif, 16 des 16 cas tombent (mesuré par `git stash` des sources
 * suivies : les six cas TLS 1.2 passaient pour une mauvaise raison — la
 * `cipherList` était ignorée — jusqu'à ce qu'ils vérifient la suite
 * négociée). Aucun témoin : le calendrier de clés lui-même est ce qui
 * était faux, et la suite AES-128-GCM-SHA256 en dépend aussi.
 */
import { describe, it, expect } from 'vitest';
import { createHmac, createHash, createDecipheriv } from 'node:crypto';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { deriveKeySchedule } from '@/network/tls/keySchedule';
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import { legacySuiteByOpensslName } from '@/network/tls/legacy/legacyCipherSuites';

const NOW = Date.now();

function lab(client: Partial<TlsClientConfig>, server: Partial<TlsServerConfig>, ecdsa = false) {
  const ca = CertificateAuthority.generate('CN=Root', { now: NOW, algorithm: ecdsa ? 'ecdsa' : 'rsa' });
  const leaf = ca.issueCertificate({ subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: ['srv.lab'] } as never);
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return {
    server: new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, ...server }),
    client: new TlsClientSession({ verifier, serverName: 'srv.lab', ...client }),
  };
}

function drive(client: TlsClientSession, server: TlsServerSession): void {
  let up: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 6 && up !== null && up.length > 0; i++) {
    const down = server.handle(up);
    if (down === null || down.length === 0) break;
    up = client.handle(down);
  }
}

function roundTrip(client: TlsClientSession, server: TlsServerSession): { wire: TlsRecord; sealedBy: string } {
  const request = encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes('GET / HTTP/1.1'));
  expect(bytesToUtf8(decryptApplicationData(server.clientTraffic(), 0, request.records).plaintext)).toBe('GET / HTTP/1.1');
  const reply = encryptApplicationData(server.serverTraffic(), 0, utf8ToBytes('200 OK'));
  expect(bytesToUtf8(decryptApplicationData(client.serverTraffic(), 0, reply.records).plaintext)).toBe('200 OK');
  return { wire: request.records[0], sealedBy: client.negotiatedCipherSuite ?? '' };
}

function oracleExpandLabel(hash: 'sha256' | 'sha384', secret: Buffer, label: string, context: Buffer, length: number): Buffer {
  const info = Buffer.concat([
    Buffer.from([length >> 8, length & 0xff]),
    Buffer.from([`tls13 ${label}`.length]), Buffer.from(`tls13 ${label}`),
    Buffer.from([context.length]), context,
  ]);
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
    previous = createHmac(hash, secret).update(Buffer.concat([previous, info, Buffer.from([counter])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

describe('calendrier de clés RFC 8446 §7.1 contre un second calendrier (node:crypto)', () => {
  for (const hash of ['sha256', 'sha384'] as const) {
    it(`${hash} : tous les secrets sont ceux de l'oracle`, () => {
      const length = hash === 'sha256' ? 32 : 48;
      const transcripts = {
        clientHello: createHash(hash).update('ch').digest('hex'), serverHello: createHash(hash).update('sh').digest('hex'),
        serverFinished: createHash(hash).update('sf').digest('hex'), clientFinished: createHash(hash).update('cf').digest('hex'),
      };
      const dhe = createHash(hash).update('dhe').digest('hex');
      const ours = deriveKeySchedule(transcripts, undefined, dhe, hash);

      const empty = createHash(hash).update('').digest();
      const zero = Buffer.alloc(length);
      const early = createHmac(hash, Buffer.alloc(length)).update(zero).digest();
      const derived1 = oracleExpandLabel(hash, early, 'derived', empty, length);
      const handshake = createHmac(hash, derived1).update(Buffer.from(dhe, 'hex')).digest();
      const derived2 = oracleExpandLabel(hash, handshake, 'derived', empty, length);
      const master = createHmac(hash, derived2).update(zero).digest();
      const secret = (from: Buffer, label: string, transcript: string): string =>
        oracleExpandLabel(hash, from, label, Buffer.from(transcript, 'hex'), length).toString('hex');

      expect(ours.handshakeSecret).toBe(handshake.toString('hex'));
      expect(ours.masterSecret).toBe(master.toString('hex'));
      expect(ours.clientHandshakeTrafficSecret).toBe(secret(handshake, 'c hs traffic', transcripts.serverHello));
      expect(ours.serverApplicationTrafficSecret).toBe(secret(master, 's ap traffic', transcripts.serverFinished));
      expect(ours.resumptionMasterSecret).toBe(secret(master, 'res master', transcripts.clientFinished));
    });
  }
});

describe('suites TLS 1.3', () => {
  const nodeCipher: Readonly<Record<string, { algorithm: string; key: number; tag: number }>> = {
    TLS_AES_128_GCM_SHA256: { algorithm: 'aes-128-gcm', key: 16, tag: 16 },
    TLS_AES_256_GCM_SHA384: { algorithm: 'aes-256-gcm', key: 32, tag: 16 },
    TLS_CHACHA20_POLY1305_SHA256: { algorithm: 'chacha20-poly1305', key: 32, tag: 16 },
    TLS_AES_128_CCM_SHA256: { algorithm: 'aes-128-ccm', key: 16, tag: 16 },
    TLS_AES_128_CCM_8_SHA256: { algorithm: 'aes-128-ccm', key: 16, tag: 8 },
  };

  for (const suite of Object.keys(nodeCipher)) {
    it(`${suite} : négociée, et l'enregistrement se lit avec l'AEAD de node`, () => {
      const { client, server } = lab(
        { cipherSuites: [suite as never] },
        { tls13Ciphersuites: suite },
      );
      drive(client, server);
      expect(client.result).toBe('success');
      expect(client.negotiatedCipherSuite).toBe(suite);
      const { wire } = roundTrip(client, server);

      const spec = nodeCipher[suite];
      const hash = suite.endsWith('SHA384') ? 'sha384' : 'sha256';
      const traffic = client.clientTraffic() as { secret: string };
      const secret = Buffer.from(traffic.secret, 'hex');
      const key = oracleExpandLabel(hash, secret, 'key', Buffer.alloc(0), spec.key);
      const iv = oracleExpandLabel(hash, secret, 'iv', Buffer.alloc(0), 12);
      const nonce = Buffer.from(iv);
      nonce[11] ^= 0;
      const body = wire.fragment.subarray(0, wire.fragment.length - spec.tag);
      const tag = wire.fragment.subarray(wire.fragment.length - spec.tag);
      const aad = Buffer.from([23, 0x03, 0x03, wire.fragment.length >> 8, wire.fragment.length & 0xff]);
      const decipher = createDecipheriv(spec.algorithm as 'aes-128-gcm', key, nonce, { authTagLength: spec.tag } as never);
      decipher.setAuthTag(Buffer.from(tag));
      (decipher as unknown as { setAAD(a: Buffer, o?: object): void }).setAAD(aad, { plaintextLength: body.length });
      const plain = Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()]);
      expect(plain.subarray(0, plain.length - 1).toString()).toBe('GET / HTTP/1.1');
    });
  }

  it('par défaut le serveur choisit TLS_AES_256_GCM_SHA384 (liste par défaut d\'OpenSSL)', () => {
    const { client, server } = lab({}, {});
    drive(client, server);
    expect(client.negotiatedCipherSuite).toBe('TLS_AES_256_GCM_SHA384');
  });

  it('les suites CCM ne se négocient que si on les configure (NOT_DEFAULT)', () => {
    const { client, server } = lab({ cipherSuites: ['TLS_AES_128_CCM_SHA256'] }, {});
    drive(client, server);
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });

  it('preferServerCiphers=false : l\'ordre du client l\'emporte', () => {
    const { client, server } = lab(
      { cipherSuites: ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'] },
      { preferServerCiphers: false, tls13Ciphersuites: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384' },
    );
    drive(client, server);
    expect(client.negotiatedCipherSuite).toBe('TLS_AES_256_GCM_SHA384');
  });
});

describe('suites TLS 1.2 AEAD', () => {
  const cases: [string, boolean][] = [
    ['ECDHE-RSA-CHACHA20-POLY1305', false],
    ['DHE-RSA-CHACHA20-POLY1305', false],
    ['ECDHE-ECDSA-CHACHA20-POLY1305', true],
    ['AES128-CCM', false],
    ['DHE-RSA-AES256-CCM8', false],
    ['ECDHE-ECDSA-AES128-CCM', true],
  ];
  for (const [name, ecdsa] of cases) {
    it(`${name} en TLS 1.2 : poignée de main complète et échange de données`, () => {
      const { client, server } = lab({ versions: ['1.2'], cipherList: name }, { cipherList: name }, ecdsa);
      drive(client, server);
      expect(client.result).toBe('success');
      expect(server.negotiatedVersion).toBe('1.2');
      expect(server.negotiatedCipherSuite).toBe(legacySuiteByOpensslName(name)!.name);
      roundTrip(client, server);
    });
  }
});
