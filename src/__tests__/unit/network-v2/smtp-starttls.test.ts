import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { SmtpServer, type SmtpServerOptions } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import type { TlsClientConfig } from '@/network/smtp/starttls';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

const NOW = Date.now();

function issueServerCert() {
  const ca = CertificateAuthority.generate('CN=smtp-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=mail.example.com', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function buildTopology(serverOpts: SmtpServerOptions = {}, clientTlsConfig?: TlsClientConfig) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, 25, serverOpts);
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', undefined, clientTlsConfig);
  return { client };
}

describe('SMTP STARTTLS (RFC 3207)', () => {
  it('advertises STARTTLS in EHLO capabilities when TLS is configured', () => {
    const { issued } = issueServerCert();
    const { client } = buildTopology({ tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } });
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines).toContain('STARTTLS');
  });

  it('replies 454 when TLS is not configured on the server', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'STARTTLS' });
    expect(r?.code).toBe(454);
  });

  it('completes a real TLS 1.3 handshake and transparently encrypts everything after the 220 reply', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology(
      { tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } },
      { verifier },
    );
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });

    const r = client.startTls();
    expect(r?.code).toBe(220);
    expect(client.isTlsActive()).toBe(true);

    const ehlo = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(ehlo?.code).toBe(250);
    expect(client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' })?.code).toBe(250);
  });

  it('EHLO renegotiation after STARTTLS no longer advertises STARTTLS (TLS already active)', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology(
      { tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } },
      { verifier },
    );
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.startTls();

    const ehlo = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(ehlo!.lines).not.toContain('STARTTLS');
  });

  it('a command sent before HELO/EHLO after the TLS upgrade is rejected (mandatory renegotiation)', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology(
      { tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } },
      { verifier },
    );
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.startTls();

    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(503);
  });

  it('a second STARTTLS once TLS is already active is rejected with 503', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology(
      { tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } },
      { verifier },
    );
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.startTls();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });

    const r = client.sendCommand({ verb: 'STARTTLS' });
    expect(r?.code).toBe(503);
  });

  it('a command pipelined together with STARTTLS in the same write is purged, never executed after the upgrade', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology(
      { tls: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } },
      { verifier },
    );
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });

    const replies = client.sendPipelined([
      { verb: 'STARTTLS' },
      { verb: 'MAIL', argument: 'FROM:<injected-attacker@evil.example>' },
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0].code).toBe(220);
  });
});
