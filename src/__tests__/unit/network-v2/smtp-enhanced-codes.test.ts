import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
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

  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' });
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { client };
}

describe('SMTP enhanced status codes (RFC 3463/5248)', () => {
  it('the 220 banner carries 2.0.0', () => {
    const { client } = buildTopology();
    const r = client.connect();
    expect(r?.enhancedCode).toBe('2.0.0');
  });

  it('MAIL FROM success carries 2.1.0 (Sender ok)', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(250);
    expect(r?.enhancedCode).toBe('2.1.0');
  });

  it('RCPT TO success carries 2.1.5 (Destination address valid)', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    expect(r?.enhancedCode).toBe('2.1.5');
  });

  it('a completed DATA transaction carries 2.6.0 (Message accepted)', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const r = client.sendDataBody('Subject: hi\r\n\r\nBody');
    expect(r?.enhancedCode).toBe('2.6.0');
  });

  it('a bad-sequence 503 carries 5.5.1', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(503);
    expect(r?.enhancedCode).toBe('5.5.1');
  });

  it('an unrecognized command 500 carries 5.5.2', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'BOGUS' });
    expect(r?.enhancedCode).toBe('5.5.2');
  });

  it('a missing-argument 501 carries 5.5.4', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'HELO' });
    expect(r?.enhancedCode).toBe('5.5.4');
  });

  it('disabled VRFY 502 carries 5.5.1', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'VRFY', argument: 'alice' });
    expect(r?.enhancedCode).toBe('5.5.1');
  });
});
