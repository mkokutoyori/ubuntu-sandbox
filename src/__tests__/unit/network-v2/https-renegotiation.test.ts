/**
 * Une renégociation lancée par le SERVEUR en plein échange HTTPS (RFC 5746) : le serveur reçoit une requête pour un chemin qui exige un
 * certificat client (l'équivalent d'Apache `SSLVerifyClient require` dans un `<Directory>`), envoie un HelloRequest, mène une poignée de
 * main demandant le certificat, puis seulement répond à la requête retenue. `HttpsClientSession` suit le HelloRequest au milieu de
 * l'échange : l'ancien code ne gardait que le dernier segment reçu et ne répondait jamais.
 *
 * MESURÉ avant correctif : sans le suivi du HelloRequest par le client, la requête sur le chemin protégé n'obtenait aucune réponse
 * (« Empty reply from server ») ou était servie sans certificat client. Avant correctif (git stash de src/network) 3 cas sur 5 tombent (la configuration de renégociation était ignorée, le
 * chemin protégé était servi sans certificat) ; le témoin (chemin public) et la continuité sur un chemin public après
 * renégociation passent dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { createRequest, createResponse } from '@/network/http/semantics/types';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const NOW = Date.now();
const PORT = 8444;

function topology() {
  const server = new LinuxPC('linux-pc', 'RSRV');
  const client = new LinuxPC('linux-pc', 'RCLI');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.98.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.98.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

function lab(withClientCertificate: boolean) {
  const { server, client } = topology();
  const ca = CertificateAuthority.generate('CN=reneg-ca', { now: NOW });
  const serverCert = ca.issueCertificate({ subject: 'CN=example.test', subjectAltNames: ['example.test'], notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const clientCert = ca.issueCertificate({ subject: 'CN=alice', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const trust = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const seen: string[] = [];
  const srv = new HttpsServerSession(server.getTcpStack(), PORT, {
    serverCert: serverCert.cert, serverPrivateKey: serverCert.privateKey, protocols: ['1.2'], verifier: trust,
    renegotiateForClientCertificate: (request) => (request.target ?? '').startsWith('/secure'),
  }, (request, peer) => {
    seen.push(`${request.target}:${peer?.tls?.clientCertificate?.subject ?? '-'}`);
    const response = createResponse(200, 'OK');
    response.body = new TextEncoder().encode(`path=${request.target} client=${peer?.tls?.clientCertificate?.subject ?? 'none'}`);
    return response;
  });
  srv.start();
  const session = new HttpsClientSession(client.getTcpStack(), '192.168.98.10', PORT, {
    verifier: trust, serverName: 'example.test', versions: ['1.2'],
    ...(withClientCertificate ? { clientCert: clientCert.cert, clientPrivateKey: clientCert.privateKey } : {}),
  } as never);
  return { session, seen };
}

const body = (result: { response?: { body: Uint8Array | null } }): string =>
  new TextDecoder().decode(result.response?.body ?? new Uint8Array(0));

describe('renégociation déclenchée par le serveur dans HttpsClientSession', () => {
  it('témoin : un chemin public est servi sans renégociation', () => {
    const { session } = lab(true);
    const result = session.send(createRequest('GET', '/public'));
    expect(result.ok).toBe(true);
    expect(body(result)).toContain('client=none');
    expect(session.handshake!.renegotiations).toBe(0);
  });

  it('un chemin protégé : HelloRequest, poignée de main avec certificat client, puis réponse', () => {
    const { session, seen } = lab(true);
    const result = session.send(createRequest('GET', '/secure/report'));
    expect(result.ok).toBe(true);
    expect(body(result)).toContain('client=CN=alice');
    expect(session.handshake!.renegotiations).toBe(1);
    expect(seen).toEqual(['/secure/report:CN=alice']);
  });

  it('un second accès au chemin protégé ne renégocie plus', () => {
    const { session } = lab(true);
    session.send(createRequest('GET', '/secure/a'));
    const second = session.send(createRequest('GET', '/secure/b'));
    expect(body(second)).toContain('client=CN=alice');
    expect(session.handshake!.renegotiations).toBe(1);
  });

  it('la connexion renégociée continue de servir un chemin public sous les nouvelles clés', () => {
    const { session } = lab(true);
    session.send(createRequest('GET', '/secure/a'));
    const next = session.send(createRequest('GET', '/public'));
    expect(next.ok).toBe(true);
    expect(body(next)).toContain('path=/public');
  });

  it('sans certificat client, la renégociation échoue et le chemin protégé n\'est pas servi', () => {
    const { session, seen } = lab(false);
    const result = session.send(createRequest('GET', '/secure/report'));
    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
