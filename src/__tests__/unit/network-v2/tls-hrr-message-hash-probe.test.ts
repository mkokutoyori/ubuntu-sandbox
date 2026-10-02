/**
 * RFC 8446 §4.4.1 : après un HelloRetryRequest, la transcription commence par
 * un message synthétique `message_hash` (type 254, longueur 3 octets = taille du
 * condensé, corps = Hash(ClientHello1)) qui REMPLACE le premier ClientHello.
 *
 * MESURÉ avant correctif : les deux côtés gardaient ClientHello1 en clair dans la
 * transcription — ils s'accordaient entre eux, mais Finished et les secrets de
 * trafic n'auraient égalé ceux d'aucune implémentation conforme.
 *
 * Avant correctif, 2 des 3 cas tombent (client et serveur). Le témoin passe
 * dans les deux états : sans HRR, la transcription commence bien par le
 * ClientHello lui-même.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

function lab(serverGroups: ('x25519' | 'secp256r1')[]) {
  const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, supportedGroups: serverGroups });
  const client = new TlsClientSession({ verifier, supportedGroups: ['x25519', 'secp256r1'] });
  const firstHello = client.start() as readonly TlsRecord[];
  const clientHello1 = reassembleRecords(firstHello, false).plaintext;
  let flight: readonly TlsRecord[] | null = firstHello;
  while (server.result === null && flight !== null) {
    const reply = server.handle(flight);
    if (reply === null) break;
    flight = client.handle(reply);
  }
  return { client, server, clientHello1 };
}

const digestFor = (suite: string | null, data: Uint8Array): Buffer =>
  createHash(suite?.endsWith('SHA384') ? 'sha384' : 'sha256').update(data).digest();

const transcriptOf = (session: unknown): Uint8Array[] => (session as { transcript: Uint8Array[] }).transcript;

describe('TLS 1.3 message_hash après HelloRetryRequest (RFC 8446 §4.4.1)', () => {
  it('serveur : la transcription commence par message_hash(ClientHello1)', () => {
    const { server, clientHello1 } = lab(['secp256r1']);
    expect(server.result).toBe('accept');
    const expected = digestFor(server.negotiatedCipherSuite, clientHello1);
    const head = transcriptOf(server)[0];
    expect(Array.from(head.slice(0, 4))).toEqual([254, 0, 0, expected.length]);
    expect(Buffer.from(head.slice(4)).equals(expected)).toBe(true);
  });

  it('client : même transcription', () => {
    const { client, clientHello1 } = lab(['secp256r1']);
    expect(client.result).toBe('success');
    const expected = digestFor(client.negotiatedCipherSuite, clientHello1);
    const head = transcriptOf(client)[0];
    expect(Array.from(head.slice(0, 4))).toEqual([254, 0, 0, expected.length]);
    expect(Buffer.from(head.slice(4)).equals(expected)).toBe(true);
  });

  it('témoin : sans HelloRetryRequest, la transcription commence par le ClientHello lui-même', () => {
    const { server, clientHello1 } = lab(['x25519']);
    expect(server.result).toBe('accept');
    expect(Buffer.from(transcriptOf(server)[0]).equals(Buffer.from(clientHello1))).toBe(true);
  });
});
