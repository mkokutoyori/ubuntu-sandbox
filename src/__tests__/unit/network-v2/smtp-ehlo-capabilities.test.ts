import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import { buildCapabilities, formatCapabilityLines } from '@/network/smtp/extensions';

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

  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' });
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { client };
}

describe('SMTP EHLO/ESMTP capability negotiation (RFC 5321 §4.1.1.7)', () => {
  it('EHLO returns a multi-line reply listing capabilities', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r?.code).toBe(250);
    expect(r!.lines.length).toBeGreaterThan(1);
  });

  it('advertises ENHANCEDSTATUSCODES', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines).toContain('ENHANCEDSTATUSCODES');
  });

  it('advertises STARTTLS when TLS is not already active', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines).toContain('STARTTLS');
  });

  it('does not advertise AUTH when TLS is inactive and plaintext auth is not explicitly allowed', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines.some((l) => l.startsWith('AUTH'))).toBe(false);
  });

  it('plain HELO does not return a capability list', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    expect(r!.lines).toHaveLength(1);
  });
});

describe('buildCapabilities()/formatCapabilityLines() (RFC 5321 §4.1.1.7)', () => {
  it('omits STARTTLS once TLS is already active', () => {
    const caps = buildCapabilities({ tlsActive: true, authActive: false, allowPlainAuth: false });
    expect(caps.startTls).toBe(false);
    expect(formatCapabilityLines(caps)).not.toContain('STARTTLS');
  });

  it('advertises AUTH mechanisms once TLS is active', () => {
    const caps = buildCapabilities({ tlsActive: true, authActive: false, allowPlainAuth: false });
    expect(caps.authMechanisms).toEqual(['PLAIN', 'LOGIN', 'CRAM-MD5']);
    expect(formatCapabilityLines(caps)).toContain('AUTH PLAIN LOGIN CRAM-MD5');
  });

  it('advertises AUTH mechanisms when plaintext auth is explicitly allowed even without TLS', () => {
    const caps = buildCapabilities({ tlsActive: false, authActive: false, allowPlainAuth: true });
    expect(caps.authMechanisms.length).toBeGreaterThan(0);
  });

  it('includes SIZE only when a max message size is configured', () => {
    const withSize = buildCapabilities({ tlsActive: false, authActive: false, allowPlainAuth: false, maxMessageSize: 10485760 });
    expect(formatCapabilityLines(withSize)).toContain('SIZE 10485760');
    const withoutSize = buildCapabilities({ tlsActive: false, authActive: false, allowPlainAuth: false });
    expect(formatCapabilityLines(withoutSize).some((l) => l.startsWith('SIZE'))).toBe(false);
  });
});
