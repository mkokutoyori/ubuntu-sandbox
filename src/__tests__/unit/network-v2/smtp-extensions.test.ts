import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import type { SmtpServerConfig } from '@/network/smtp/SmtpServerSession';
import { parseMailFromExtensionParams, hasNonAsciiBytes } from '@/network/smtp/extensions';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(config: Partial<SmtpServerConfig> = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com', ...config });
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { client };
}

describe('SMTP SIZE extension (RFC 1870)', () => {
  it('parses the SIZE= parameter', () => {
    expect(parseMailFromExtensionParams('FROM:<a@b.com> SIZE=1024')).toEqual({ size: 1024, bodyType: undefined });
  });

  it('rejects a MAIL FROM whose declared SIZE exceeds the configured maximum with 552', () => {
    const { client } = buildTopology({ maxMessageSize: 1000 });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org> SIZE=5000' });
    expect(r?.code).toBe(552);
    expect(r?.enhancedCode).toBe('5.3.4');
  });

  it('accepts a MAIL FROM whose declared SIZE is within the configured maximum', () => {
    const { client } = buildTopology({ maxMessageSize: 10000 });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org> SIZE=500' });
    expect(r?.code).toBe(250);
  });

  it('EHLO advertises SIZE when a maximum is configured', () => {
    const { client } = buildTopology({ maxMessageSize: 10485760 });
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines).toContain('SIZE 10485760');
  });
});

describe('SMTP 8BITMIME extension (RFC 6152)', () => {
  it('parses the BODY= parameter', () => {
    expect(parseMailFromExtensionParams('FROM:<a@b.com> BODY=8BITMIME')).toEqual({ size: undefined, bodyType: '8BITMIME' });
  });

  it('detects non-ASCII bytes in a body', () => {
    expect(hasNonAsciiBytes('plain ascii')).toBe(false);
    expect(hasNonAsciiBytes('café')).toBe(true);
  });

  it('rejects an 8-bit body when 7BIT was declared, with 554', () => {
    const { client } = buildTopology({ eightBitMimeEnabled: true });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org> BODY=7BIT' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const r = client.sendDataBody('Subject: café\r\n\r\nBody');
    expect(r?.code).toBe(554);
    expect(r?.enhancedCode).toBe('5.6.3');
  });

  it('accepts an 8-bit body when BODY=8BITMIME was declared', () => {
    const { client } = buildTopology({ eightBitMimeEnabled: true });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org> BODY=8BITMIME' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const r = client.sendDataBody('Subject: café\r\n\r\nBody');
    expect(r?.code).toBe(250);
  });

  it('rejects an 8-bit body when 8BITMIME was never negotiated, even without an explicit BODY= param', () => {
    const { client } = buildTopology({ eightBitMimeEnabled: false });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const r = client.sendDataBody('Subject: café\r\n\r\nBody');
    expect(r?.code).toBe(554);
  });
});

describe('SMTP PIPELINING extension (RFC 2920)', () => {
  it('EHLO advertises PIPELINING when enabled', () => {
    const { client } = buildTopology({ pipeliningEnabled: true });
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines).toContain('PIPELINING');
  });

  it('processes a MAIL+RCPT+DATA group sent together without waiting for each individual reply', () => {
    const { client } = buildTopology({ pipeliningEnabled: true });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });

    const replies = client.sendPipelined([
      { verb: 'MAIL', argument: 'FROM:<alice@example.org>' },
      { verb: 'RCPT', argument: 'TO:<bob@example.org>' },
      { verb: 'DATA' },
    ]);

    expect(replies).toHaveLength(3);
    expect(replies[0].code).toBe(250);
    expect(replies[1].code).toBe(250);
    expect(replies[2].code).toBe(354);

    const final = client.sendDataBody('Subject: hi\r\n\r\nBody');
    expect(final?.code).toBe(250);
  });

  it('rejects a grouped command sent without PIPELINING having been negotiated', () => {
    const { client } = buildTopology({ pipeliningEnabled: false });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });

    const replies = client.sendPipelined([
      { verb: 'MAIL', argument: 'FROM:<alice@example.org>' },
      { verb: 'RCPT', argument: 'TO:<bob@example.org>' },
    ]);

    expect(replies).toHaveLength(2);
    expect(replies[0].code).toBe(250);
    expect(replies[1].code).toBe(503);
  });

  it('rejects a grouped command under plain HELO even if the server has pipelining enabled', () => {
    const { client } = buildTopology({ pipeliningEnabled: true });
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });

    const replies = client.sendPipelined([
      { verb: 'MAIL', argument: 'FROM:<alice@example.org>' },
      { verb: 'RCPT', argument: 'TO:<bob@example.org>' },
    ]);

    expect(replies[1].code).toBe(503);
  });
});
