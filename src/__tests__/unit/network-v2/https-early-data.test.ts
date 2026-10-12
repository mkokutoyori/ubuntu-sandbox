/**
 * Les données précoces 0-RTT (RFC 8446 §2.3) au niveau HTTPS : un client qui reprend une session envoie sa requête dans le premier vol ;
 * le serveur HTTPS la reçoit à la fin de la poignée de main avec l'en-tête `Early-Data: 1` (RFC 8470 §5.1) et y répond ; si le serveur
 * refuse les données précoces, le client renvoie la requête comme donnée applicative normale (RFC 8446 §4.2.10) et obtient quand même
 * sa réponse, sans doublon.
 *
 * MESURÉ avant correctif : `HttpsServerSession` ne remettait jamais `receivedEarlyData` au gestionnaire, et les enregistrements envoyés par le
 * serveur juste après la poignée de main (la réponse à la requête précoce) étaient jetés par la pompe de poignée de main du client.
 * Avant correctif (git stash de src/network) 1 cas sur 3 tombe : l'acceptation avec en-tête et réponse. Les deux autres passent dans les
 * deux états : le refus avec renvoi (le client envoyait déjà sa requête normalement — témoin de non-régression) et l'absence d'option
 * (témoin : aucune donnée précoce sans demande).
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
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const NOW = Date.now();
let nextPort = 8450;

function lab(serverEarlyData: boolean) {
  const server = new LinuxPC('linux-pc', 'ESRV');
  const client = new LinuxPC('linux-pc', 'ECLI');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.97.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.97.20'), mask);
  const ca = CertificateAuthority.generate('CN=early-ca', { now: NOW });
  const leaf = ca.issueCertificate({ subject: 'CN=example.test', subjectAltNames: ['example.test'], notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const trust = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const seen: string[] = [];
  const port = nextPort++;
  new HttpsServerSession((server as unknown as EndHost).getTcpStack(), port, {
    serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, protocols: ['1.3'], sessionTicketStore: new SessionTicketStore(), earlyData: serverEarlyData,
  } as never, (request) => {
    seen.push(`${request.target}:${request.headers.get('Early-Data') ?? '-'}`);
    const response = createResponse(200, 'OK');
    response.body = new TextEncoder().encode(`ok ${request.target}`);
    return response;
  }).start();
  const open = (extra: object) => new HttpsClientSession((client as unknown as EndHost).getTcpStack(), '192.168.97.10', port, {
    verifier: trust, serverName: 'example.test', versions: ['1.3'], ...extra,
  } as never);
  return { open, seen };
}

const text = (result: { response?: { body: Uint8Array | null } }): string => new TextDecoder().decode(result.response?.body ?? new Uint8Array(0));

function primeTicket(open: (extra: object) => HttpsClientSession) {
  const first = open({});
  const sent = first.send(createRequest('GET', '/prime'));
  expect(sent.error).toBeUndefined();
  const ticket = first.handshake!.receivedTicket;
  expect(ticket).not.toBeNull();
  return ticket!;
}

describe('0-RTT HTTPS', () => {
  it('la requête précoce est servie avec Early-Data: 1', () => {
    const { open, seen } = lab(true);
    const ticket = primeTicket(open);
    const resumed = open({ resumptionTicket: ticket, earlyData: true });
    const result = resumed.send(createRequest('GET', '/early'));
    expect(result.ok).toBe(true);
    expect(text(result)).toBe('ok /early');
    expect(resumed.handshake!.earlyDataAccepted).toBe(true);
    expect(seen).toEqual(['/prime:-', '/early:1']);
  });

  it('refus du serveur : la requête est renvoyée normalement, sans Early-Data, une seule fois', () => {
    const { open, seen } = lab(false);
    const ticket = primeTicket(open);
    const resumed = open({ resumptionTicket: ticket, earlyData: true });
    const result = resumed.send(createRequest('GET', '/retry'));
    expect(result.ok).toBe(true);
    expect(text(result)).toBe('ok /retry');
    expect(resumed.handshake!.earlyDataAccepted).toBe(false);
    expect(seen).toEqual(['/prime:-', '/retry:-']);
  });

  it("sans l'option, aucune donnée précoce n'est envoyée même avec un ticket", () => {
    const { open, seen } = lab(true);
    const ticket = primeTicket(open);
    const resumed = open({ resumptionTicket: ticket });
    expect(resumed.send(createRequest('GET', '/plain')).ok).toBe(true);
    expect(resumed.handshake!.earlyDataAccepted).not.toBe(true);
    expect(seen).toEqual(['/prime:-', '/plain:-']);
  });
});
