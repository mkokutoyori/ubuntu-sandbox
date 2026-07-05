/**
 * PRD-HTTP.md §5 P7 — HTTPS: an HTTP/1.1 adapter over a real TLS 1.3
 * handshake (`PRD-TLS.md`), on a real wired TCP topology (dedicated test
 * port, never 443, so as not to interfere with the IIS/curl suites).
 * `TlsRecordWire` is tested standalone (pure byte encode/decode); the
 * client/server sessions are tested end-to-end, following the same
 * pattern as `http1-wire.test.ts`.
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
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encodeRecord, encodeRecords, decodeRecord, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { HstsStore } from '@/network/http/https/HstsStore';
import { createHttpToHttpsRedirectHandler } from '@/network/http/https/HttpToHttpsRedirect';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const NOW = Date.now();

describe('TlsRecordWire — RFC 8446 §5.1 byte-level record framing (no network)', () => {
  it('round-trips a handshake record with the correct 5-byte header layout', () => {
    const record: TlsRecord = { contentType: 'handshake', legacyVersion: 0x0303, fragment: new Uint8Array([1, 2, 3]) };
    const bytes = encodeRecord(record);
    expect(bytes.length).toBe(5 + 3);
    expect(bytes[0]).toBe(22); // handshake ContentType code
    expect(bytes[1]).toBe(0x03);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0); // length high byte
    expect(bytes[4]).toBe(3); // length low byte

    const { record: decoded, bytesConsumed } = decodeRecord(bytes, 0);
    expect(bytesConsumed).toBe(bytes.length);
    expect(decoded).toEqual(record);
  });

  it('round-trips several concatenated records (a whole flight)', () => {
    const records: TlsRecord[] = [
      { contentType: 'handshake', legacyVersion: 0x0303, fragment: new Uint8Array([9, 9]) },
      { contentType: 'application_data', legacyVersion: 0x0303, fragment: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const bytes = encodeRecords(records);
    expect(decodeRecords(bytes)).toEqual(records);
  });

  it('rejects a truncated header', () => {
    expect(() => decodeRecord(new Uint8Array([22, 3, 3]), 0)).toThrow(/truncated record header/);
  });

  it('rejects a fragment shorter than its declared length', () => {
    const bytes = new Uint8Array([22, 3, 3, 0, 10, 1, 2]); // declares length 10, only 2 bytes follow
    expect(() => decodeRecord(bytes, 0)).toThrow(/truncated record fragment/);
  });

  it('rejects an unknown ContentType code', () => {
    const bytes = new Uint8Array([99, 3, 3, 0, 0]);
    expect(() => decodeRecord(bytes, 0)).toThrow(/unknown ContentType/);
  });
});

describe('ApplicationDataCipher — simulated encrypt/decrypt of §5.2 inner plaintext (no network)', () => {
  it('round-trips plaintext through encrypt then decrypt with the same secret and sequence', () => {
    const secret = 'application-traffic-secret';
    const plaintext = new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n');
    const { records, nextSeq } = encryptApplicationData(secret, 0, plaintext);
    expect(nextSeq).toBe(1);
    expect(records[0].contentType).toBe('application_data');

    const { plaintext: decrypted, nextSeq: decNextSeq } = decryptApplicationData(secret, 0, records);
    expect(decNextSeq).toBe(1);
    expect(new TextDecoder().decode(decrypted)).toBe('GET / HTTP/1.1\r\n\r\n');
  });

  it('fails to reproduce the plaintext when decrypted with the wrong sequence number', () => {
    const secret = 'application-traffic-secret';
    const plaintext = new TextEncoder().encode('same-secret-wrong-seq');
    const { records } = encryptApplicationData(secret, 5, plaintext);
    expect(() => decryptApplicationData(secret, 0, records)).toThrow();
  });
});

describe('HstsStore — RFC 6797 remembered per-host, no global preload list', () => {
  it('upgrades a host after it announces Strict-Transport-Security', () => {
    const store = new HstsStore();
    expect(store.shouldUpgrade('example.test', NOW)).toBe(false);
    store.record('example.test', 'max-age=31536000', NOW);
    expect(store.shouldUpgrade('example.test', NOW)).toBe(true);
  });

  it('stops upgrading once max-age has elapsed', () => {
    const store = new HstsStore();
    store.record('example.test', 'max-age=100', NOW);
    expect(store.shouldUpgrade('example.test', NOW + 99_000)).toBe(true);
    expect(store.shouldUpgrade('example.test', NOW + 101_000)).toBe(false);
  });

  it('covers subdomains only when includeSubDomains is present', () => {
    const store = new HstsStore();
    store.record('example.test', 'max-age=100; includeSubDomains', NOW);
    expect(store.shouldUpgrade('api.example.test', NOW)).toBe(true);
    expect(store.shouldUpgrade('other.test', NOW)).toBe(false);
  });

  it('a max-age=0 clears a previously recorded policy', () => {
    const store = new HstsStore();
    store.record('example.test', 'max-age=100', NOW);
    store.record('example.test', 'max-age=0', NOW);
    expect(store.shouldUpgrade('example.test', NOW)).toBe(false);
  });

  it('ignores a header with no max-age directive', () => {
    const store = new HstsStore();
    store.record('example.test', 'includeSubDomains', NOW);
    expect(store.shouldUpgrade('example.test', NOW)).toBe(false);
  });
});

const TEST_PORT = 8443;

function topology() {
  const server = new LinuxPC('linux-pc', 'HTTPSSRV');
  const client = new LinuxPC('linux-pc', 'HTTPSCLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.97.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.97.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

function issueServerCert() {
  const ca = CertificateAuthority.generate('CN=https-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

describe('HttpsClientSession / HttpsServerSession — real TLS 1.3 handshake over a real TCP wire', () => {
  it('completes a handshake, negotiates ALPN http/1.1, and round-trips a request/response', () => {
    const { server, client } = topology();
    const { issued, verifier } = issueServerCert();

    const srv = new HttpsServerSession(
      server.getTcpStack(), TEST_PORT, { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      (req) => {
        const res = createResponse(200, 'OK');
        res.body = new TextEncoder().encode(`secure-echo:${req.target}`);
        return res;
      },
    );
    srv.start();

    const clientSession = new HttpsClientSession(client.getTcpStack(), '192.168.97.10', TEST_PORT, { verifier });
    const result = clientSession.send(createRequest('GET', '/hello'));

    expect(result.ok).toBe(true);
    expect(result.alpnProtocol).toBe('http/1.1');
    expect(result.response!.statusCode).toBe(200);
    expect(new TextDecoder().decode(result.response!.body!)).toBe('secure-echo:/hello');
  });

  it('rejects a certificate issued by an untrusted CA before any application data is exchanged', () => {
    const { server, client } = topology();
    const { issued } = issueServerCert();
    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const rogueVerifier = new CertificateVerifier({ trustAnchors: [rogueCa.rootCertificate], clock: () => NOW });

    const srv = new HttpsServerSession(
      server.getTcpStack(), TEST_PORT, { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      (req) => createResponse(200, 'OK'),
    );
    srv.start();

    const clientSession = new HttpsClientSession(client.getTcpStack(), '192.168.97.10', TEST_PORT, { verifier: rogueVerifier });
    const result = clientSession.send(createRequest('GET', '/'));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/TLS handshake/i);
  });

  it('reuses the same persistent TLS/TCP connection across multiple requests', () => {
    const { server, client } = topology();
    const { issued, verifier } = issueServerCert();

    const srv = new HttpsServerSession(
      server.getTcpStack(), TEST_PORT, { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      (req) => {
        const res = createResponse(200, 'OK');
        res.body = new TextEncoder().encode(req.target ?? '');
        return res;
      },
    );
    srv.start();

    const clientSession = new HttpsClientSession(client.getTcpStack(), '192.168.97.10', TEST_PORT, { verifier });
    const r1 = clientSession.send(createRequest('GET', '/one'));
    const socketAfterFirst = (clientSession as unknown as { socket: { localPort: number } }).socket;
    const r2 = clientSession.send(createRequest('GET', '/two'));
    const socketAfterSecond = (clientSession as unknown as { socket: { localPort: number } }).socket;

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(new TextDecoder().decode(r1.response!.body!)).toBe('/one');
    expect(new TextDecoder().decode(r2.response!.body!)).toBe('/two');
    expect(socketAfterFirst).toBe(socketAfterSecond);
  });

  it('records Strict-Transport-Security from the response into the client HSTS store', () => {
    const { server, client } = topology();
    const { issued, verifier } = issueServerCert();

    const srv = new HttpsServerSession(
      server.getTcpStack(), TEST_PORT,
      { serverCert: issued.cert, serverPrivateKey: issued.privateKey, hstsMaxAgeSeconds: 63072000, hstsIncludeSubDomains: true },
      (req) => createResponse(200, 'OK'),
    );
    srv.start();

    const clientSession = new HttpsClientSession(client.getTcpStack(), '192.168.97.10', TEST_PORT, { verifier });
    const result = clientSession.send(createRequest('GET', '/'));

    expect(result.ok).toBe(true);
    expect(result.response!.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(clientSession.hstsStore.shouldUpgrade('192.168.97.10', Date.now())).toBe(true);
  });

  it('negotiates h2 when both sides offer it ahead of http/1.1', () => {
    const { server, client } = topology();
    const { issued, verifier } = issueServerCert();

    const srv = new HttpsServerSession(
      server.getTcpStack(), TEST_PORT,
      { serverCert: issued.cert, serverPrivateKey: issued.privateKey, alpnProtocols: ['h2', 'http/1.1'] },
      (req) => createResponse(200, 'OK'),
    );
    srv.start();

    const clientSession = new HttpsClientSession(
      client.getTcpStack(), '192.168.97.10', TEST_PORT, { verifier, alpn: ['h2', 'http/1.1'] },
    );
    const result = clientSession.send(createRequest('GET', '/'));

    expect(result.ok).toBe(true);
    expect(result.alpnProtocol).toBe('h2');
  });

  it('connecting to a server with no listener reports the handshake as failed', () => {
    const { client } = topology();
    const { verifier } = issueServerCert();
    const clientSession = new HttpsClientSession(client.getTcpStack(), '192.168.97.10', TEST_PORT, { verifier });
    const result = clientSession.send(createRequest('GET', '/'));
    expect(result.ok).toBe(false);
  });
});

describe('createHttpToHttpsRedirectHandler — RFC 9110 §15.4.9 308 redirect (PRD-HTTP.md §2.1.K)', () => {
  const HTTP_TEST_PORT = 8080;

  it('a plain HTTP request is answered with a 308 redirect to the https:// equivalent', () => {
    const { server, client } = topology();
    const srv = new Http1ServerSession(server.getTcpStack(), HTTP_TEST_PORT, createHttpToHttpsRedirectHandler('example.test'));
    srv.start();

    const clientSession = new Http1ClientSession(client.getTcpStack(), '192.168.97.10', HTTP_TEST_PORT);
    const result = clientSession.send(createRequest('GET', '/some/path'));

    expect(result.ok).toBe(true);
    expect(result.response!.statusCode).toBe(308);
    expect(result.response!.headers.get('Location')).toBe('https://example.test/some/path');
  });

  it('includes a non-default HTTPS port in the redirect authority', () => {
    const { server, client } = topology();
    const srv = new Http1ServerSession(
      server.getTcpStack(), HTTP_TEST_PORT, createHttpToHttpsRedirectHandler('example.test', 8443),
    );
    srv.start();

    const clientSession = new Http1ClientSession(client.getTcpStack(), '192.168.97.10', HTTP_TEST_PORT);
    const result = clientSession.send(createRequest('GET', '/x'));

    expect(result.response!.headers.get('Location')).toBe('https://example.test:8443/x');
  });
});
