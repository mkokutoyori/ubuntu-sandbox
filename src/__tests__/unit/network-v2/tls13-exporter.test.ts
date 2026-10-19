/**
 * RFC 8446 section 7.5, the TLS 1.3 exporter used by NTS (RFC 8915): the
 * derivation is compared with OpenSSL 3, which printed the keying material
 * for two cipher suites (SHA-256 and SHA-384 transcripts), four labels and
 * lengths from 1 to 100 bytes (scripts/oracle/record_tls_exporter.py; the
 * `exporter_master_secret` comes from the SSLKEYLOGFILE of the client).
 * A second case runs a full handshake between the simulator's own client and
 * server sessions and checks that both ends export the same bytes and that
 * different labels or contexts export different ones.
 *
 * Measured against nothing: `exportKeyingMaterial` did not exist, so every
 * case falls without it. The same-bytes-on-both-ends case is the witness that
 * the two sessions record the same exporter secret.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { exportKeyingMaterial } from '@/network/tls/keySchedule';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tls13-exporter-openssl.json', import.meta.url), 'utf8')) as {
  cases: { hash: 'sha256' | 'sha384'; exporterSecret: string; label: string; length: number; material: string }[];
};
const text = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('exporter derivation matches OpenSSL', () => {
  fixture.cases.forEach((c) => it(`${c.hash} ${c.label} ${c.length} bytes`, () => {
    expect(text(exportKeyingMaterial(c.exporterSecret, c.label, new Uint8Array(0), c.length, c.hash))).toBe(c.material);
  }));
});

describe('both ends of a simulated handshake export the same keying material', () => {
  const NOW = Date.now();
  function connect() {
    const ca = CertificateAuthority.generate('CN=ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=ntp.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });
    let flight: readonly TlsRecord[] | null = client.start();
    while (server.result === null && flight !== null) {
      const reply = server.handle(flight);
      if (reply === null) break;
      flight = client.handle(reply);
    }
    return { client, server };
  }
  it('same bytes, label and context separate them', () => {
    const { client, server } = connect();
    expect(client.result).toBe('success');
    const context = Uint8Array.of(0, 0, 0, 15, 0);
    const a = client.exportKeyingMaterial('EXPORTER-network-time-security', context, 32)!;
    const b = server.exportKeyingMaterial('EXPORTER-network-time-security', context, 32)!;
    expect(text(a)).toBe(text(b));
    expect(text(client.exportKeyingMaterial('EXPORTER-other', context, 32)!)).not.toBe(text(a));
    expect(text(client.exportKeyingMaterial('EXPORTER-network-time-security', Uint8Array.of(0, 0, 0, 15, 1), 32)!)).not.toBe(text(a));
  });
  it('is unavailable before the handshake completes', () => {
    const client = new TlsClientSession({ verifier: new CertificateVerifier({ trustAnchors: [], clock: () => NOW }) });
    expect(client.exportKeyingMaterial('EXPORTER-x', new Uint8Array(0), 8)).toBeNull();
  });
});
