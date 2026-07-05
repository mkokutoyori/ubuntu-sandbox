import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { alertForVerificationReason, ALERT_DESCRIPTION_CODE } from '@/network/tls/alerts';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

describe('alertForVerificationReason (RFC 8446 §6 mapping)', () => {
  it('maps each CertificateVerifier.VerificationReason to a distinct alert', () => {
    expect(alertForVerificationReason('unknown')).toBe('unknown_ca');
    expect(alertForVerificationReason('expired')).toBe('certificate_expired');
    expect(alertForVerificationReason('not-yet-valid')).toBe('certificate_expired');
    expect(alertForVerificationReason('bad-signature')).toBe('bad_certificate');
    expect(alertForVerificationReason('revoked')).toBe('certificate_revoked');
    expect(alertForVerificationReason('crl-stale')).toBe('certificate_unknown');
    expect(alertForVerificationReason('crl-untrusted')).toBe('certificate_unknown');
  });

  it('every alert in the dictionary has a distinct RFC 8446 §6 numeric code', () => {
    const codes = Object.values(ALERT_DESCRIPTION_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(ALERT_DESCRIPTION_CODE.close_notify).toBe(0);
    expect(ALERT_DESCRIPTION_CODE.handshake_failure).toBe(40);
    expect(ALERT_DESCRIPTION_CODE.unknown_ca).toBe(48);
    expect(ALERT_DESCRIPTION_CODE.no_application_protocol).toBe(120);
  });
});

describe('TLS sessions expose a structured alert on failure', () => {
  it('client surfaces unknown_ca when the server certificate is untrusted', () => {
    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const issued = rogueCa.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const legitCa = CertificateAuthority.generate('CN=legit-ca', { now: NOW });
    const verifier = new CertificateVerifier({ trustAnchors: [legitCa.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });

    const clientHello = client.start();
    const serverFlight = server.handle(clientHello)!;
    client.handle(serverFlight);

    expect(client.result).toBe('failure');
    expect(client.lastAlert).toEqual({ level: 'fatal', description: 'unknown_ca' });
  });

  it('client surfaces certificate_expired when the server certificate has expired', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 2000, notAfter: NOW - 1000 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });

    const clientHello = client.start();
    const serverFlight = server.handle(clientHello)!;
    client.handle(serverFlight);

    expect(client.result).toBe('failure');
    expect(client.lastAlert).toEqual({ level: 'fatal', description: 'certificate_expired' });
  });

  it('server surfaces unknown_ca when the client certificate is untrusted (mTLS)', () => {
    const serverCa = CertificateAuthority.generate('CN=server-ca', { now: NOW });
    const serverIssued = serverCa.issueCertificate({ subject: 'CN=server.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const serverVerifier = new CertificateVerifier({ trustAnchors: [serverCa.rootCertificate], clock: () => NOW });

    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const rogueClientIssued = rogueCa.issueCertificate({ subject: 'CN=client.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });

    const server = new TlsServerSession({
      serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey,
      requestClientCert: true, verifier: serverVerifier,
    });
    const client = new TlsClientSession({
      verifier: serverVerifier, clientCert: rogueClientIssued.cert, clientPrivateKey: rogueClientIssued.privateKey,
    });

    let flight: readonly TlsRecord[] | null = client.start();
    flight = server.handle(flight);
    flight = client.handle(flight!);
    server.handle(flight!);

    expect(server.result).toBe('reject');
    expect(server.lastAlert).toEqual({ level: 'fatal', description: 'unknown_ca' });
  });

  it('server surfaces handshake_failure when no group is mutually supported', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, supportedGroups: ['secp384r1'],
    });
    const client = new TlsClientSession({
      verifier: new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW }),
      supportedGroups: ['x25519', 'secp256r1'],
    });

    const clientHello = client.start();
    server.handle(clientHello);

    expect(server.result).toBe('reject');
    expect(server.lastAlert).toEqual({ level: 'fatal', description: 'handshake_failure' });
  });
});
