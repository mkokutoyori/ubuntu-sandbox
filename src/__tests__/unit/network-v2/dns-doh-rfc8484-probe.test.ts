/**
 * Sonde de DNS sur HTTPS (RFC 8484 §4.1, §5.1).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 4 cas sur 7 tombent.
 *   - le serveur n'implémentait pas GET ?dns= (base64url sans remplissage),
 *     alors que le §4.1 impose GET et POST (réponse 400)
 *   - une méthode non permise recevait 400 au lieu de 405
 *   - aucune réponse ne portait Cache-Control (§5.1 : durée de vie = plus petit TTL)
 *   - le client envoyait l'identifiant DNS de sa requête au lieu de 0 (§4.1)
 * Passent avant et après (témoins) : POST d'une requête valide, 415 sur un
 * type de contenu étranger, 400 sur un GET sans paramètre ou en base64 invalide
 * (refusés avant parce que GET l'était en bloc, non parce qu'ils étaient lus).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsHttpsServer, queryDnsOverHttps } from '@/network/dns/transport/DnsHttpsTransport';
import { createRequest } from '@/network/http/semantics/types';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { bytesToBase64 } from '@/crypto/encoding';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const NOW = Date.now();

function query(id: number): DnsMessage {
  return {
    id,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'www.example.com', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord('www.example.com', 120, '192.0.2.10'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.11'));
  const store = new ZoneStore();
  store.addZone(zone);
  const engine = new AuthoritativeServer(store);
  const seenIds: number[] = [];
  const ca = CertificateAuthority.generate('CN=doh-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=10.0.1.10', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  bindDnsHttpsServer(srv, (q) => { seenIds.push(q.id); return engine.answer(q); },
    { serverCert: issued.cert, serverPrivateKey: issued.privateKey });
  const raw = (method: Parameters<typeof createRequest>[0], target: string, contentType?: string, body?: Uint8Array) => {
    const client = new HttpsClientSession(pc.getTcpStack(), '10.0.1.10', 443, { verifier, alpn: ['http/1.1'] });
    const request = createRequest(method, target);
    request.headers.set('Host', '10.0.1.10');
    if (contentType) request.headers.set('Content-Type', contentType);
    if (body) request.body = body;
    const result = client.send(request);
    client.close();
    return result.response;
  };
  return { pc, verifier, seenIds, raw };
}

const b64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('DoH — RFC 8484', () => {
  it('témoin : POST d’une requête valide', async () => {
    const { pc, verifier } = lab();
    const reply = await queryDnsOverHttps(pc, new IPAddress('10.0.1.10'), query(9), { verifier });
    expect(reply?.answers).toHaveLength(2);
  });

  it('témoin : un type de contenu étranger reçoit 415', () => {
    const { raw } = lab();
    expect(raw('POST', '/dns-query', 'text/plain', encodeDnsMessage(query(0)))?.statusCode).toBe(415);
  });

  it('GET ?dns= en base64url sans remplissage reçoit la réponse', () => {
    const { raw } = lab();
    const response = raw('GET', `/dns-query?dns=${b64url(encodeDnsMessage(query(0)))}`);
    expect(response?.statusCode).toBe(200);
    expect(decodeDnsMessage(response!.body!).answers).toHaveLength(2);
  });

  it('GET sans paramètre dns, ou en base64 invalide, reçoit 400', () => {
    const { raw } = lab();
    expect(raw('GET', '/dns-query')?.statusCode).toBe(400);
    expect(raw('GET', '/dns-query?dns=***')?.statusCode).toBe(400);
  });

  it('une méthode non permise reçoit 405', () => {
    const { raw } = lab();
    expect(raw('PUT', '/dns-query', 'application/dns-message', encodeDnsMessage(query(0)))?.statusCode).toBe(405);
  });

  it('la réponse porte Cache-Control max-age égal au plus petit TTL', () => {
    const { raw } = lab();
    const response = raw('POST', '/dns-query', 'application/dns-message', encodeDnsMessage(query(0)));
    expect(response?.headers.get('Cache-Control')).toBe('max-age=120');
  });

  it('le client envoie l’identifiant DNS 0 et rend la réponse sous son identifiant', async () => {
    const { pc, verifier, seenIds } = lab();
    const reply = await queryDnsOverHttps(pc, new IPAddress('10.0.1.10'), query(9), { verifier });
    expect(seenIds).toEqual([0]);
    expect(reply?.id).toBe(9);
  });
});
