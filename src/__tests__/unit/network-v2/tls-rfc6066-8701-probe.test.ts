/**
 * RFC 6066 (server_name §3, max_fragment_length §4, status_request §8) et
 * RFC 8701 (GREASE) sur la pile TLS, en 1.3 comme en ≤ 1.2.
 *
 * MESURÉ avant correctif : le serveur ignorait le nom demandé et présentait
 * toujours le même certificat ; ni status_request (agrafage OCSP signé) ni
 * max_fragment_length n'existaient ; aucune valeur GREASE n'était émise et
 * rien ne vérifiait qu'un serveur n'en sélectionne pas une.
 *
 * Avant correctif, 22 des 26 cas tombent ; les quatre qui passent dans les
 * deux états sont des témoins : le certificat par défaut sans nom demandé,
 * « un client sans GREASE n'en émet pas » et « sans status_request, le
 * serveur n'agrafe rien » (en 1.3 et en 1.2).
 */
import { splitHandshakeMessages } from '@/network/tls/wire/Tls13HandshakeCodec';
import { HANDSHAKE_TYPE } from '@/network/tls/wire/TlsRegistry';
import { decodeHandshakeMessage, encodeHandshakeMessage } from '@/network/tls/messages';
import { decodeLegacyMessages, encodeLegacyBundle } from '@/network/tls/legacy/legacyMessages';
import type { ServerHello } from '@/network/tls/messages';
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { OcspResponder } from '@/network/pki/OcspResponder';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';

const NOW = Date.now();
const ca = CertificateAuthority.generate('CN=Root', { now: NOW });
const issue = (name: string) => ca.issueCertificate({ subject: `CN=${name}`, notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: [name] } as never);
const a = issue('a.lab'); const b = issue('b.lab');
const verifier = () => new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

type Tamper = (records: readonly TlsRecord[], direction: 'up' | 'down') => readonly TlsRecord[];

function connect(client: Partial<TlsClientConfig>, server: Partial<TlsServerConfig>, tamper?: Tamper, useA = true) {
  const credential = useA ? a : b;
  const s = new TlsServerSession({ serverCert: credential.cert, serverPrivateKey: credential.privateKey, ...server });
  const c = new TlsClientSession({ verifier: verifier(), ...client });
  const up: TlsRecord[][] = []; const down: TlsRecord[][] = [];
  let out: readonly TlsRecord[] | null = c.start();
  for (let i = 0; i < 6 && out !== null && out.length > 0; i++) {
    if (tamper) out = tamper(out, 'up');
    up.push([...out]);
    let reply: readonly TlsRecord[] | null = s.handle(out);
    if (reply === null || reply.length === 0) break;
    if (tamper) reply = tamper(reply, 'down');
    down.push([...reply]);
    out = c.handle(reply);
  }
  return { client: c, server: s, up, down };
}

describe.each([['1.3', ['1.3'] as const], ['1.2', ['1.2'] as const]])('TLS %s', (_label, versions) => {
  describe('server_name (RFC 6066 §3)', () => {
    const sni = [{ cert: b.cert, privateKey: b.privateKey }];

    it('le certificat présenté est celui du nom demandé', () => {
      const { client } = connect({ versions: [...versions], serverName: 'b.lab' }, { sniCredentials: sni });
      expect(client.result).toBe('success');
      expect(client.peerCertificate?.subject).toBe('CN=b.lab');
    });

    it('un nom inconnu : certificat par défaut (le client, lui, vérifie le nom)', () => {
      const { client } = connect({ versions: [...versions], serverName: 'c.lab' }, { sniCredentials: sni });
      expect(client.peerCertificate?.subject).toBe('CN=a.lab');
      expect(client.result).toBe('failure');
      expect(client.lastAlert?.description).toBe('bad_certificate');
    });

    it('rejectUnknownServerName : alerte fatale unrecognized_name (112)', () => {
      const { server, down } = connect(
        { versions: [...versions], serverName: 'c.lab' }, { sniCredentials: sni, rejectUnknownServerName: true },
      );
      expect(server.lastAlert?.description).toBe('unrecognized_name');
      expect([...down[0][0].fragment]).toEqual([2, 112]);
    });
  });

  describe('status_request, agrafage OCSP signé (RFC 6066 §8)', () => {
    const responder = new OcspResponder(ca);
    const staple = (): OcspResponseMessage => responder.respond(a.cert, NOW);

    it('un agrafe valide : accepté', () => {
      const { client } = connect({ versions: [...versions], requestOcspStaple: true }, { ocspStaple: staple() });
      expect(client.result).toBe('success');
    });

    it('un certificat révoqué agrafé : certificate_revoked', () => {
      const bad = issue('r.lab');
      ca.revoke(bad.cert.serialNumber, NOW);
      const response = new OcspResponder(ca).respond(bad.cert, NOW);
      const s = new TlsServerSession({ serverCert: bad.cert, serverPrivateKey: bad.privateKey, ocspStaple: response });
      const c = new TlsClientSession({ verifier: verifier(), versions: [...versions], requestOcspStaple: true });
      const flight = s.handle(c.start());
      c.handle(flight!);
      expect(c.lastAlert?.description).toBe('certificate_revoked');
    });

    it('une signature d\'agrafe altérée : bad_certificate_status_response (113)', () => {
      const forged: OcspResponseMessage = { ...staple(), signature: 'rsa:00' };
      const { client } = connect({ versions: [...versions], requestOcspStaple: true }, { ocspStaple: forged });
      expect(client.lastAlert?.description).toBe('bad_certificate_status_response');
    });

    it('un agrafe périmé est refusé', () => {
      const stale = responder.respond(a.cert, NOW - 10 * 24 * 3600 * 1000, 1000);
      const { client } = connect({ versions: [...versions], requestOcspStaple: true }, { ocspStaple: stale });
      expect(client.lastAlert?.description).toBe('bad_certificate_status_response');
    });

    it('requireOcspStaple sans agrafe : refus ; requestOcspStaple seul : accepté', () => {
      const strict = connect({ versions: [...versions], requireOcspStaple: true }, {});
      expect(strict.client.lastAlert?.description).toBe('bad_certificate_status_response');
      const lax = connect({ versions: [...versions], requestOcspStaple: true }, {});
      expect(lax.client.result).toBe('success');
    });

    it('sans status_request, le serveur n\'agrafe rien', () => {
      const { down } = connect({ versions: [...versions] }, { ocspStaple: staple() });
      const types = down.filter((flight) => flight[0]?.contentType === 'handshake').flatMap((flight) => splitHandshakeMessages(flight[0].fragment).map((m) => m.type));
      expect(types.length).toBeGreaterThan(0);
      expect(types).not.toContain(HANDSHAKE_TYPE.certificateStatus);
    });
  });

  describe('max_fragment_length (RFC 6066 §4)', () => {
    function carry(client: TlsClientSession, server: TlsServerSession, size: number) {
      const sealed = encryptApplicationData(client.clientTraffic(), 0, new Uint8Array(size).fill(65));
      const opened = decryptApplicationData(server.clientTraffic(), 0, sealed.records);
      expect(opened.plaintext.length).toBe(size);
      return sealed.records;
    }

    it('512 négocié : les enregistrements applicatifs ne dépassent pas 512 octets de clair', () => {
      const { client, server } = connect({ versions: [...versions], maxFragmentLength: 512 }, { acceptMaxFragmentLength: true });
      expect(client.negotiatedMaxFragmentLength).toBe(512);
      expect(server.negotiatedMaxFragmentLength).toBe(512);
      const records = carry(client, server, 3000);
      expect(records.length).toBeGreaterThanOrEqual(6);
      expect(Math.max(...records.map((r) => r.fragment.length))).toBeLessThanOrEqual(512 + 64);
    });

    it('serveur qui ne l\'accepte pas : 16384 par enregistrement', () => {
      const { client, server } = connect({ versions: [...versions], maxFragmentLength: 512 }, {});
      expect(client.negotiatedMaxFragmentLength).toBeNull();
      expect(carry(client, server, 3000).length).toBe(1);
    });
  });
});

describe('GREASE (RFC 8701)', () => {
  it('témoin : sans nom demandé le serveur présente son certificat par défaut', () => {
    const { client } = connect({ versions: ['1.3'] }, { sniCredentials: [{ cert: b.cert, privateKey: b.privateKey }] });
    expect(client.peerCertificate?.subject).toBe('CN=a.lab');
  });

  it('un client GREASE émet des valeurs réservées dans chaque liste, et la poignée de main conclut', () => {
    for (const versions of [['1.3'], ['1.2']] as const) {
      const { client, up } = connect({ versions: [...versions], grease: true }, {});
      expect(client.result).toBe('success');
      const hello = decodeHandshakeMessage(up[0][0].fragment) as unknown as { legacyCipherSuites: number[]; extensions: { supportedGroups: string[]; signatureAlgorithms: string[] } };
      expect(hello.legacyCipherSuites[0]).toBe(0x0a0a);
      expect(hello.extensions.supportedGroups[0]).toBe('grease_0a0a');
      expect(hello.extensions.signatureAlgorithms[0]).toBe('grease_0a0a');
    }
  });

  it('un client sans GREASE n\'en émet pas', () => {
    const { up } = connect({ versions: ['1.2'] }, {});
    expect(JSON.stringify(decodeHandshakeMessage(up[0][0].fragment))).not.toContain('grease');
  });

  it('un serveur qui sélectionne une valeur GREASE est refusé (illegal_parameter)', () => {
    const tamper: Tamper = (records, direction) => {
      if (direction !== 'down' || records[0].contentType !== 'handshake') return records;
      const hello = decodeHandshakeMessage(records[0].fragment) as ServerHello;
      return [{ ...records[0], fragment: encodeHandshakeMessage({ ...hello, cipherSuite: 'TLS_GREASE_0A0A' as ServerHello['cipherSuite'] }) }, ...records.slice(1)];
    };
    const { client } = connect({ versions: ['1.3'], grease: true }, {}, tamper);
    expect(client.lastAlert?.description).toBe('illegal_parameter');
  });
});
