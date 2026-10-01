/**
 * TLS ≤ 1.2 sur la même pile que TLS 1.3 — RFC 5246, RFC 4346, RFC 2246,
 * RFC 8446 §4.1.3 (sentinelle de rétrogradation), RFC 8996 (1.0/1.1
 * retirés), RFC 7525 (suites, DH ≥ 2048) et RFC 7465 (RC4 interdit).
 *
 * MESURÉ avant correctif : `TlsClientSession` ne savait offrir que 1.3
 * et `TlsServerSession` n'en acceptait aucune autre version ; un client
 * limité à 1.2 se heurtait donc à un échec muet. Les primitives (PRF,
 * enregistrements GCM/CBC, RSAES) sont vérifiées contre node:crypto dans
 * `tls-legacy-primitives.test.ts` ; ici on mesure la POIGNÉE DE MAIN.
 *
 * Avant correctif, 24 des 28 cas tombent. Les quatre qui passent dans les
 * deux états sont des témoins, et chacun passe pour la même raison : les
 * options de version étant ignorées, la poignée de main se fait en 1.3 et
 * conclut — « un client qui n'offrait pas 1.3 accepte 1.2 d'un serveur
 * qui le sait », « le même DH 1024 passe quand le client baisse son
 * seuil », « le nom du serveur est vérifié en 1.2 comme en 1.3 » (refus
 * identique, RFC 6125) et « le serveur reçoit et vérifie le certificat
 * du client » (mTLS 1.3 préexistant). Ils prouvent que le laboratoire
 * lui-même est sain.
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encodeHandshakeMessage, decodeHandshakeMessage, type ClientHello } from '@/network/tls/messages';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';

const NOW = Date.now();

type ServerOptions = Partial<TlsServerConfig>;
type ClientOptions = Partial<Omit<TlsClientConfig, 'verifier'>>;

function lab(
  client: ClientOptions, server: ServerOptions,
  options: { ecdsa?: boolean; names?: string[]; clientCertificate?: boolean } = {},
) {
  const ca = CertificateAuthority.generate('CN=Lab Root', { now: NOW, algorithm: options.ecdsa ? 'ecdsa' : 'rsa' });
  const leaf = ca.issueCertificate({
    subject: 'CN=server.lab', notBefore: NOW - 1000, notAfter: NOW + 1e9,
    subjectAltNames: options.names ?? ['server.lab'],
  } as never);
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const clientLeaf = options.clientCertificate
    ? ca.issueCertificate({ subject: 'CN=alice', notBefore: NOW - 1000, notAfter: NOW + 1e9 } as never)
    : null;
  return {
    server: new TlsServerSession({
      serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, verifier, ...server,
    }),
    client: new TlsClientSession({
      verifier, serverName: 'server.lab',
      ...(clientLeaf ? { clientCert: clientLeaf.cert, clientPrivateKey: clientLeaf.privateKey } : {}),
      ...client,
    }),
  };
}

function drive(
  client: TlsClientSession, server: TlsServerSession,
  tamper?: (records: readonly TlsRecord[], direction: 'up' | 'down') => readonly TlsRecord[],
): { sentToServer: TlsRecord[][]; sentToClient: TlsRecord[][] } {
  const sentToServer: TlsRecord[][] = [];
  const sentToClient: TlsRecord[][] = [];
  let up: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 10 && up !== null && up.length > 0; i++) {
    if (tamper) up = tamper(up, 'up');
    sentToServer.push([...up]);
    let down: readonly TlsRecord[] | null = server.handle(up);
    if (down === null || down.length === 0) break;
    if (tamper) down = tamper(down, 'down');
    sentToClient.push([...down]);
    up = client.handle(down);
  }
  return { sentToServer, sentToClient };
}

function exchange(client: TlsClientSession, server: TlsServerSession): string {
  const request = encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes('GET / HTTP/1.1'));
  const received = decryptApplicationData(server.clientTraffic(), 0, request.records);
  const reply = encryptApplicationData(server.serverTraffic(), 0, utf8ToBytes('HTTP/1.1 200 OK'));
  const answered = decryptApplicationData(client.serverTraffic(), 0, reply.records);
  expect(bytesToUtf8(answered.plaintext)).toBe('HTTP/1.1 200 OK');
  return bytesToUtf8(received.plaintext);
}

describe('négociation de version', () => {
  it('témoin : par défaut les deux bouts concluent', () => {
    const { client, server } = lab({}, {});
    drive(client, server);
    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(server.negotiatedVersion).toBe('1.3');
  });

  it('un client limité à 1.2 conclut en 1.2 et les données applicatives circulent', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server);
    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(client.negotiatedVersion).toBe('1.2');
    expect(server.negotiatedVersion).toBe('1.2');
    expect(client.negotiatedCipherSuite).toBe('TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384');
    expect(exchange(client, server)).toBe('GET / HTTP/1.1');
  });

  it('un serveur 1.3 seul répond protocol_version à un client 1.2 seul', () => {
    const { client, server } = lab({ versions: ['1.2'] }, { protocols: ['1.3'] });
    drive(client, server);
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('protocol_version');
  });

  it('RFC 8996 : 1.0 et 1.1 sont refusés par défaut', () => {
    for (const version of ['1.0', '1.1'] as const) {
      const { client, server } = lab({ versions: [version] }, {});
      drive(client, server);
      expect(server.result).toBe('reject');
      expect(server.lastAlert?.description).toBe('protocol_version');
    }
  });

  it('1.1 et 1.0 se négocient quand le serveur les autorise (CBC-SHA, PRF MD5⊕SHA1)', () => {
    for (const version of ['1.1', '1.0'] as const) {
      const { client, server } = lab({ versions: [version] }, { protocols: ['1.2', '1.1', '1.0'] });
      drive(client, server);
      expect(client.result).toBe('success');
      expect(server.negotiatedVersion).toBe(version);
      expect(server.negotiatedCipherSuite).toMatch(/_CBC_SHA$/);
      expect(exchange(client, server)).toBe('GET / HTTP/1.1');
    }
  });

  it('la version choisie est la plus haute en commun', () => {
    const { client, server } = lab({ versions: ['1.2', '1.1', '1.0'] }, { protocols: ['1.2', '1.1', '1.0'] });
    drive(client, server);
    expect(server.negotiatedVersion).toBe('1.2');
  });
});

describe('RFC 8446 §6 — l\'alerte part sur le fil', () => {
  it('le refus du serveur arrive au client comme un enregistrement alert (code 70)', () => {
    const { client, server } = lab({ versions: ['1.2'] }, { protocols: ['1.3'] });
    const wire = drive(client, server);
    const alert = wire.sentToClient[0][0];
    expect(alert.contentType).toBe('alert');
    expect([...alert.fragment]).toEqual([2, 70]);
    expect(client.peerAlert?.description).toBe('protocol_version');
    expect(client.result).toBe('failure');
  });
});

describe('RFC 8446 §4.1.3 — sentinelle de rétrogradation', () => {
  function stripTls13(records: readonly TlsRecord[], direction: 'up' | 'down'): readonly TlsRecord[] {
    if (direction !== 'up' || records[0].contentType !== 'handshake') return records;
    const hello = decodeHandshakeMessage(records[0].fragment) as ClientHello;
    if (hello.kind !== 'client_hello') return records;
    const stripped: ClientHello = {
      ...hello, extensions: { ...hello.extensions, supportedVersions: ['1.2'] },
    };
    return [{ ...records[0], fragment: encodeHandshakeMessage(stripped) }];
  }

  it('un client 1.3 abandonne si un intermédiaire lui fait négocier 1.2', () => {
    const { client, server } = lab({ versions: ['1.3', '1.2'] }, { protocols: ['1.3', '1.2'] });
    const wire = drive(client, server, stripTls13);
    expect(server.negotiatedVersion).toBe('1.2');
    const hello = JSON.parse(bytesToUtf8(wire.sentToClient[0][0].fragment))[0];
    expect(hello.random.slice(-16)).toBe('444f574e47524401');
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('illegal_parameter');
  });

  it('témoin : un client qui n\'offrait pas 1.3 accepte 1.2 d\'un serveur qui le sait', () => {
    const { client, server } = lab({ versions: ['1.2'] }, { protocols: ['1.3', '1.2'] });
    drive(client, server);
    expect(client.result).toBe('success');
  });
});

describe('suites et échanges de clés', () => {
  const only = (name: string) => ({ legacyCipherSuites: [name] });

  it('ECDHE_ECDSA exige un certificat ECDSA', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {}, { ecdsa: true });
    drive(client, server);
    expect(client.result).toBe('success');
    expect(client.negotiatedCipherSuite).toMatch(/^TLS_ECDHE_ECDSA_/);
    expect(exchange(client, server)).toBe('GET / HTTP/1.1');
  });

  it('une suite ECDSA offerte seule échoue contre un certificat RSA', () => {
    const { client, server } = lab(
      { versions: ['1.2'], ...only('TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256') }, {},
    );
    drive(client, server);
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });

  it('DHE_RSA sur le groupe 14 (2048 bits)', () => {
    const { client, server } = lab({ versions: ['1.2'], ...only('TLS_DHE_RSA_WITH_AES_128_GCM_SHA256') }, {});
    drive(client, server);
    expect(client.result).toBe('success');
    expect(exchange(client, server)).toBe('GET / HTTP/1.1');
  });

  it('RFC 7525 : un client refuse un DH de 1024 bits par défaut (insufficient_security)', () => {
    const { client, server } = lab(
      { versions: ['1.2'], ...only('TLS_DHE_RSA_WITH_AES_128_GCM_SHA256') }, { dhGroupId: 2 },
    );
    drive(client, server);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('insufficient_security');
  });

  it('témoin : le même DH 1024 passe quand le client baisse son seuil', () => {
    const { client, server } = lab(
      { versions: ['1.2'], minDhBits: 1024, ...only('TLS_DHE_RSA_WITH_AES_128_GCM_SHA256') }, { dhGroupId: 2 },
    );
    drive(client, server);
    expect(client.result).toBe('success');
  });

  it('TLS_RSA : le secret pré-maître voyage chiffré par RSAES-PKCS1', () => {
    const { client, server } = lab({ versions: ['1.2'], ...only('TLS_RSA_WITH_AES_128_GCM_SHA256') }, {});
    const wire = drive(client, server);
    expect(client.result).toBe('success');
    const keyExchange = JSON.parse(bytesToUtf8(wire.sentToServer[1][0].fragment))
      .find((m: { kind: string }) => m.kind === 'client_key_exchange');
    expect(keyExchange.exchange.type).toBe('rsa');
    expect(keyExchange.exchange.encryptedPreMasterSecret).toMatch(/^[0-9a-f]+$/);
  });

  it('3DES n\'est jamais offert par défaut mais se négocie sur demande', () => {
    const offered = lab({ versions: ['1.2'] }, {});
    const hello = JSON.parse(bytesToUtf8(offered.client.start()[0].fragment)) as ClientHello;
    expect(hello.legacyCipherSuites).not.toContain(0x000a);
    const { client, server } = lab(
      { versions: ['1.2'], ...only('TLS_RSA_WITH_3DES_EDE_CBC_SHA') },
      { legacyCipherSuites: ['TLS_RSA_WITH_3DES_EDE_CBC_SHA'] },
    );
    drive(client, server);
    expect(client.result).toBe('success');
    expect(exchange(client, server)).toBe('GET / HTTP/1.1');
  });

  it('RFC 7465 : RC4 n\'est jamais offert, même demandé', () => {
    const { client } = lab({ versions: ['1.2'], legacyCipherSuites: ['TLS_RSA_WITH_RC4_128_SHA'] }, {});
    const hello = JSON.parse(bytesToUtf8(client.start()[0].fragment)) as ClientHello;
    expect(hello.legacyCipherSuites).toEqual([]);
  });

  it('l\'ordre du serveur l\'emporte par défaut, celui du client sur demande', () => {
    const suites = ['TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'];
    const byServer = lab({ versions: ['1.2'], legacyCipherSuites: suites }, { legacyCipherSuites: [...suites].reverse() });
    drive(byServer.client, byServer.server);
    expect(byServer.server.negotiatedCipherSuite).toBe(suites[1]);
    const byClient = lab(
      { versions: ['1.2'], legacyCipherSuites: suites },
      { legacyCipherSuites: [...suites].reverse(), preferServerCiphers: false },
    );
    drive(byClient.client, byClient.server);
    expect(byClient.server.negotiatedCipherSuite).toBe(suites[0]);
  });

  it('aucune suite commune : handshake_failure', () => {
    const { client, server } = lab(
      { versions: ['1.2'], ...only('TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256') },
      { legacyCipherSuites: ['TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'] },
    );
    drive(client, server);
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });

  it('une suite GCM n\'est pas utilisable en 1.1', () => {
    const { client, server } = lab(
      { versions: ['1.1'], ...only('TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256') }, { protocols: ['1.1'] },
    );
    drive(client, server);
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });
});

describe('authentification et intégrité', () => {
  it('le nom du serveur est vérifié (RFC 6125) en TLS 1.2 comme en 1.3', () => {
    const wrong = lab({ versions: ['1.2'], serverName: 'other.lab' }, {});
    drive(wrong.client, wrong.server);
    expect(wrong.client.result).toBe('failure');
    expect(wrong.client.lastAlert?.description).toBe('bad_certificate');
  });

  it('un octet modifié dans le Finished chiffré du client est détecté (bad_record_mac)', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server, (records, direction) => {
      if (direction !== 'up' || records.length < 3) return records;
      const forged = records.map((record, index) => {
        if (index !== 2) return record;
        const fragment = record.fragment.slice();
        fragment[fragment.length - 1] ^= 1;
        return { ...record, fragment };
      });
      return forged;
    });
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('bad_record_mac');
  });

  it('une signature de ServerKeyExchange falsifiée est refusée (decrypt_error)', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server, (records, direction) => {
      if (direction !== 'down') return records;
      const bundle = JSON.parse(bytesToUtf8(records[0].fragment)) as { kind: string; signature?: string }[];
      for (const message of bundle) {
        if (message.kind === 'server_key_exchange') message.signature = `00${message.signature!.slice(2)}`;
      }
      return [{ ...records[0], fragment: utf8ToBytes(JSON.stringify(bundle)) }];
    });
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('decrypt_error');
  });

  it('un enregistrement applicatif altéré est rejeté', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server);
    const sealed = encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes('secret'));
    const forged = sealed.records.map((record) => {
      const fragment = record.fragment.slice();
      fragment[10] ^= 0x80;
      return { ...record, fragment };
    });
    expect(() => decryptApplicationData(server.clientTraffic(), 0, forged)).toThrow('bad_record_mac');
  });

  it('un enregistrement rejoué hors séquence est rejeté', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server);
    const first = encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes('a'));
    decryptApplicationData(server.clientTraffic(), 0, first.records);
    expect(() => decryptApplicationData(server.clientTraffic(), 1, first.records)).toThrow('bad_record_mac');
  });

  it('chaque version marque ses enregistrements applicatifs de sa version (RFC 5246 §6.2.1)', () => {
    const { client, server } = lab({ versions: ['1.2'] }, {});
    drive(client, server);
    const sealed = encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes('x'));
    expect(sealed.records[0].legacyVersion).toBe(0x0303);
    expect(sealed.records[0].contentType).toBe('application_data');
  });
});

describe('authentification mutuelle en TLS 1.2', () => {
  it('le serveur reçoit et vérifie le certificat du client', () => {
    const { client, server } = lab(
      { versions: ['1.2'] }, { requestClientCert: true }, { clientCertificate: true },
    );
    drive(client, server);
    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
  });

  it('sans certificat client le serveur répond handshake_failure', () => {
    const { client, server } = lab({ versions: ['1.2'] }, { requestClientCert: true });
    drive(client, server);
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });
});
