import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SMTP_PORT, SMTP_SUBMISSION_PORT, SMTP_SUBMISSION_TLS_PORT } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  return { pc, srv };
}

describe('LinuxServer hosts a real SMTP service on 25/587/465 (§2.1.16/P17)', () => {
  it('listens on all three SMTP ports by default', () => {
    const { srv } = buildTopology();
    const ports = srv.getTcpStack().listListeners().map((l) => l.localPort);
    expect(ports).toContain(SMTP_PORT);
    expect(ports).toContain(SMTP_SUBMISSION_PORT);
    expect(ports).toContain(SMTP_SUBMISSION_TLS_PORT);
  });

  it('exposes getSmtpServer()/getSmtpSubmissionServer()/getSmtpImplicitTlsServer() accessors', () => {
    const { srv } = buildTopology();
    expect(srv.getSmtpServer()).toBeDefined();
    expect(srv.getSmtpSubmissionServer()).toBeDefined();
    expect(srv.getSmtpImplicitTlsServer()).toBeDefined();
  });

  it('a real client can complete a full SMTP transaction against port 25', () => {
    const { pc } = buildTopology();
    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const final = client.sendDataBody('Subject: hi\r\n\r\nBody');
    expect(final?.code).toBe(250);
  });

  it('port 587 (submission) requires AUTH before MAIL FROM', () => {
    const { pc } = buildTopology();
    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', SMTP_SUBMISSION_PORT);
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(530);
  });

  it('port 465 (smtps) refuses a plaintext handshake (implicit TLS, never a clear banner)', () => {
    const { pc } = buildTopology();
    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', SMTP_SUBMISSION_TLS_PORT);
    const banner = client.connect();
    expect(banner).toBeNull();
  });
});
