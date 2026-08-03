/**
 * PRD-HTTP.md §5 P12 — migration of the pre-existing IIS/curl/
 * `Invoke-WebRequest` consumers onto the real engine (§2.1.M):
 * `HttpClient.ts`/`WindowsIisRole.ts` now speak real RFC 9112 framing
 * (`http1/`) instead of a JSON-PDU-over-raw-TCP stand-in — same public
 * signatures, verified against a real wired topology (mirroring
 * `windows-iis-role.test.ts`'s pattern for the plaintext side).
 * `Curl.ts`'s HTTPS path now attempts a genuine TLS 1.3 handshake
 * (`HttpsClientSession`) instead of banner-sniffing — `scenario-7-ssh-
 * on-443.test.ts` already covers the "peer isn't TLS at all" case; this
 * file covers the complementary "peer is genuinely TLS but curl has no
 * matching trust anchor" case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { dialHttp } from '@/network/http/HttpClient';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'P12SRV');
  const client = new WindowsPC('windows-pc', 'P12CLI');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.113.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.113.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

const TEST_PORT = 8678;

describe('dialHttp — migrated onto the real RFC 9112 engine (http1/), same public API', () => {
  it('sends the Host header and arbitrary custom headers, arriving intact at the server', () => {
    const { server, client } = topology();
    let seenHeaders: Record<string, string> = {};
    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      seenHeaders = Object.fromEntries(req.headers.entries());
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode('ok');
      return res;
    });
    srv.start();

    const result = dialHttp({
      tcpStack: client.getTcpStack(), targetIp: '192.168.113.10', port: TEST_PORT,
      path: '/widgets', headers: { 'X-Custom': 'abc123' },
    });

    expect(result.ok).toBe(true);
    expect(result.response!.statusCode).toBe(200);
    expect(seenHeaders['Host']).toBe('192.168.113.10');
    expect(seenHeaders['X-Custom']).toBe('abc123');
  });

  it('round-trips a POST method through the real engine', () => {
    const { server, client } = topology();
    let seenMethod = '';
    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      seenMethod = req.method ?? '';
      return createResponse(201, 'Created');
    });
    srv.start();

    const result = dialHttp({ tcpStack: client.getTcpStack(), targetIp: '192.168.113.10', port: TEST_PORT, method: 'POST' });

    expect(result.ok).toBe(true);
    expect(seenMethod).toBe('POST');
    expect(result.response!.statusCode).toBe(201);
  });
});

describe('Curl.ts HTTPS — real TLS 1.3 attempt (PRD-HTTP.md §5 P12), no CA trust store in this scope', () => {
  it('reports an SSL certificate problem against a genuinely TLS-speaking server curl has no trust anchor for', async () => {
    const httpsServer = new WindowsPC('windows-pc', 'P12HTTPS');
    const linuxClient = new LinuxPC('linux-pc', 'P12CURL');
    const sw = new GenericSwitch('switch-generic', 'SW3');
    new Cable('c1').connect(httpsServer.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(linuxClient.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    httpsServer.getPorts()[0].configureIP(new IPAddress('192.168.114.10'), mask);
    linuxClient.getPorts()[0].configureIP(new IPAddress('192.168.114.20'), mask);

    const NOW = Date.now();
    const ca = CertificateAuthority.generate('CN=p12-test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=p12.example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });

    const srv = new HttpsServerSession(
      httpsServer.getTcpStack(), 443, { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      () => createResponse(200, 'OK'),
    );
    srv.start();

    // Sans `-k` : ce cas veut précisément constater le REFUS faute d'ancre
    // de confiance. Il passait `-k` quand l'option était parsée puis jetée
    // (docs/PRD-Curl.md §2.2) ; maintenant qu'elle agit, `-k` demande
    // justement de ne pas vérifier, et le transfert aboutirait — les deux
    // moitiés de la ligne se contredisaient.
    const out = await linuxClient.executeCommand('curl https://192.168.114.10/');
    expect(out.toLowerCase()).toMatch(/ssl certificate problem/);

    // Et l'autre moitié, désormais vraie elle aussi : `-k` passe outre.
    const insecure = await linuxClient.executeCommand('curl -k https://192.168.114.10/');
    expect(insecure.toLowerCase()).not.toMatch(/ssl certificate problem/);
  });
});
