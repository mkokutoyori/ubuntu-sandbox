/**
 * Trois exigences de la norme que la pile ne tenait pas :
 * RFC 7301 §3.2 (aucun protocole en commun → alerte fatale
 * `no_application_protocol`), RFC 8446 §5.2 (un enregistrement dont le
 * fragment dépasse 2^14 + 256 est refusé : `record_overflow`) et
 * RFC 8446 §4.6.1 (une durée de vie de ticket ne dépasse pas 7 jours).
 *
 * MESURÉ avant correctif : un client demandant `h2` à un serveur qui ne
 * parle que `http/1.1` concluait sans protocole, un fragment de 20000
 * octets était avalé et un ticket de 30 jours était gardé.
 *
 * Avant correctif, 3 des 6 cas tombent ; les trois témoins (ALPN en
 * commun, ALPN non demandé, ticket de 7200 s) passent dans les deux états.
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { fragmentAsRecords, type TlsRecord } from '@/network/tls/recordLayer';
import { encodeHandshakeMessage, type NewSessionTicket } from '@/network/tls/messages';

const NOW = Date.now();

function lab(clientAlpn: readonly string[] | undefined, serverAlpn: readonly string[]) {
  const ca = CertificateAuthority.generate('CN=ca', { now: NOW });
  const leaf = ca.issueCertificate({ subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return {
    server: new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, alpnProtocols: serverAlpn }),
    client: new TlsClientSession({ verifier, ...(clientAlpn ? { alpn: clientAlpn } : {}) }),
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

describe('RFC 7301 §3.2', () => {
  it('témoin : un protocole en commun est retenu', () => {
    const { client, server } = lab(['h2', 'http/1.1'], ['http/1.1']);
    drive(client, server);
    expect(server.negotiatedAlpnProtocol).toBe('http/1.1');
    expect(client.result).toBe('success');
  });

  it('témoin : un client qui ne demande aucun protocole conclut', () => {
    const { client, server } = lab(undefined, ['http/1.1']);
    drive(client, server);
    expect(client.result).toBe('success');
  });

  it('aucun protocole en commun : no_application_protocol, code 120 sur le fil', () => {
    const { client, server } = lab(['h2'], ['http/1.1']);
    const reply = server.handle(client.start());
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('no_application_protocol');
    expect([...reply![0].fragment]).toEqual([2, 120]);
  });
});

describe('RFC 8446 §5.2 — record_overflow', () => {
  it('un fragment de 20000 octets est refusé par le serveur', () => {
    const { server } = lab(undefined, []);
    const reply = server.handle([{ contentType: 'handshake', legacyVersion: 0x0303, fragment: new Uint8Array(20000) }]);
    expect(server.lastAlert?.description).toBe('record_overflow');
    expect([...reply![0].fragment]).toEqual([2, 22]);
  });
});

describe('RFC 8446 §4.6.1 — durée de vie des tickets', () => {
  function ticketAfterHandshake(lifetime: number): TlsClientSession {
    const { client, server } = lab(undefined, []);
    drive(client, server);
    const ticket: NewSessionTicket = {
      kind: 'new_session_ticket', ticketLifetime: lifetime, ticketAgeAdd: 'a', ticketNonce: 'n', ticket: 't', extensions: {},
    };
    client.receiveSessionTicket(fragmentAsRecords('handshake', encodeHandshakeMessage(ticket), true));
    return client;
  }

  it('témoin : un ticket de 7200 s est conservé', () => {
    expect(ticketAfterHandshake(7200).receivedTicket).not.toBeNull();
  });

  it('un ticket de 30 jours est ignoré', () => {
    expect(ticketAfterHandshake(30 * 86400).receivedTicket).toBeNull();
  });
});
