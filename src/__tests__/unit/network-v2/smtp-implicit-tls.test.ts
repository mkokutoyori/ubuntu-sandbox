import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { SmtpServer, SMTP_SUBMISSION_TLS_PORT } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

const NOW = Date.now();

function issueServerCert() {
  const ca = CertificateAuthority.generate('CN=smtps-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=mail.example.com', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  return { pc, srv };
}

describe('SMTP implicit TLS / smtps port 465 (RFC 8314)', () => {
  it('the server never sends anything before the TLS handshake completes', () => {
    const { issued } = issueServerCert();
    const { pc, srv } = buildTopology();
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_SUBMISSION_TLS_PORT, {
      tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      implicitTls: true,
    });
    server.start();

    const plainClient = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', SMTP_SUBMISSION_TLS_PORT);
    const banner = plainClient.connect();
    expect(banner).toBeNull();
  });

  it('completes the handshake and yields the greeting only afterward, over a real TLS 1.3 session', () => {
    const { issued, verifier } = issueServerCert();
    const { pc, srv } = buildTopology();
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_SUBMISSION_TLS_PORT, {
      tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      implicitTls: true,
    });
    server.start();

    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', SMTP_SUBMISSION_TLS_PORT, { verifier });
    const banner = client.connectImplicitTls();
    expect(banner?.code).toBe(220);
    expect(client.isTlsActive()).toBe(true);

    const ehlo = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(ehlo?.code).toBe(250);
    expect(ehlo!.lines).not.toContain('STARTTLS');
  });

  it('STARTTLS is not advertised on the implicit-TLS port (TLS is already active from the start)', () => {
    const { issued, verifier } = issueServerCert();
    const { pc, srv } = buildTopology();
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_SUBMISSION_TLS_PORT, {
      tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      implicitTls: true,
    });
    server.start();

    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', SMTP_SUBMISSION_TLS_PORT, { verifier });
    client.connectImplicitTls();
    const ehlo = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(ehlo!.lines.some((l) => l === 'STARTTLS')).toBe(false);
  });
});
