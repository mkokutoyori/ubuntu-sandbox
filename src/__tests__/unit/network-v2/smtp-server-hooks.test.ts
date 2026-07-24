import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer, SMTP_PORT, type SmtpAcceptedMessage } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(): { pc: LinuxPC; srv: LinuxPC } {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  return { pc, srv };
}

describe('SmtpServerOptions.onMessageAccepted (docs/PRD-Exchange.md §3 — real LDA hook)', () => {
  it('fires with the envelope/message once DATA is fully accepted', () => {
    const { pc, srv } = buildTopology();
    const accepted: SmtpAcceptedMessage[] = [];
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_PORT, {
      onMessageAccepted: (delivered) => accepted.push(delivered),
    });
    server.start();

    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const final = client.sendDataBody('Subject: hi\r\n\r\nBody');

    expect(final?.code).toBe(250);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].envelope.from).toBe('alice@example.org');
    expect(accepted[0].envelope.to).toEqual(['bob@example.org']);
    expect(accepted[0].message.headers.get('Subject')).toBe('hi');
  });

  it('does not fire when the transaction never completes DATA', () => {
    const { pc, srv } = buildTopology();
    const accepted: SmtpAcceptedMessage[] = [];
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_PORT, {
      onMessageAccepted: (delivered) => accepted.push(delivered),
    });
    server.start();

    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });

    expect(accepted).toHaveLength(0);
  });
});

describe('SmtpServerOptions.remoteIpAllowed (docs/PRD-Exchange.md §4.4 — Receive Connector IP restriction)', () => {
  it('closes the connection before any banner when the source IP is rejected', () => {
    const { pc, srv } = buildTopology();
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_PORT, {
      remoteIpAllowed: (ip) => ip === '10.0.1.99',
    });
    server.start();

    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
    const banner = client.connect();
    expect(banner).toBeNull();
  });

  it('accepts the connection normally when the source IP is allowed', () => {
    const { pc, srv } = buildTopology();
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, SMTP_PORT, {
      remoteIpAllowed: (ip) => ip === '10.0.1.2',
    });
    server.start();

    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
    const banner = client.connect();
    expect(banner?.code).toBe(220);
  });
});
