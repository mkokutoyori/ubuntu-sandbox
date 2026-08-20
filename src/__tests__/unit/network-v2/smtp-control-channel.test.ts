import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer, SMTP_PORT } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' });
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { pc, srv, server, client };
}

describe('SMTP control channel (RFC 5321 §2-4)', () => {
  it('sends an unprompted 220 banner right after the connection is accepted', () => {
    const { client } = buildTopology();
    const banner = client.connect();
    expect(banner?.code).toBe(220);
    expect(banner?.lines[0]).toContain('mail.example.com');
  });

  it('listens on TCP 25 by default', () => {
    const { srv } = buildTopology();
    const listeners = srv.getTcpStack().listListeners().map((l) => l.localPort);
    expect(listeners).toContain(SMTP_PORT);
  });

  it('greets with HELO and returns 250', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    expect(r?.code).toBe(250);
    expect(r?.lines[0]).toContain('client.example.org');
  });

  it('greets with EHLO and returns 250', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r?.code).toBe(250);
  });

  it('rejects HELO without an argument', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'HELO' })?.code).toBe(501);
  });

  it('rejects MAIL before HELO/EHLO with 503', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(503);
  });

  it('rejects RCPT before MAIL with 503', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    expect(r?.code).toBe(503);
  });

  it('rejects DATA before any RCPT with 503', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    const r = client.sendCommand({ verb: 'DATA' });
    expect(r?.code).toBe(503);
  });

  it('completes a full transaction: HELO -> MAIL -> RCPT -> DATA -> . -> 250', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'HELO', argument: 'client.example.org' })?.code).toBe(250);
    expect(client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' })?.code).toBe(250);
    expect(client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' })?.code).toBe(250);
    expect(client.sendCommand({ verb: 'DATA' })?.code).toBe(354);
    const final = client.sendDataBody('Subject: hi\r\n\r\nHello Bob.');
    expect(final?.code).toBe(250);
  });

  it('accepts multiple RCPT TO for one transaction', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' })?.code).toBe(250);
    expect(client.sendCommand({ verb: 'RCPT', argument: 'TO:<carol@example.org>' })?.code).toBe(250);
  });

  it('RSET clears the transaction and returns to the greeted state', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(client.sendCommand({ verb: 'RSET' })?.code).toBe(250);
    // RCPT should now be rejected again since the transaction was cleared.
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    expect(r?.code).toBe(503);
  });

  it('rejects a second MAIL FROM mid-transaction with 503', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<eve@example.org>' });
    expect(r?.code).toBe(503);
  });

  it('NOOP always returns 250', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'NOOP' })?.code).toBe(250);
  });

  it('replies 500 to an unrecognized command', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'BOGUS' })?.code).toBe(500);
  });

  it('closes the connection on QUIT with a 221 reply', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'QUIT' });
    expect(r?.code).toBe(221);
  });

  it('VRFY/EXPN are disabled by default (502)', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'VRFY', argument: 'alice' })?.code).toBe(502);
    expect(client.sendCommand({ verb: 'EXPN', argument: 'list' })?.code).toBe(502);
  });

  it('a new transaction can start again after a completed one', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    client.sendDataBody('Subject: hi\r\n\r\nHello Bob.');

    expect(client.sendCommand({ verb: 'MAIL', argument: 'FROM:<carol@example.org>' })?.code).toBe(250);
  });
});

describe('SMTP reply codec (RFC 5321 §4.2)', () => {
  it('round-trips a single-line reply', async () => {
    const { encodeReply, decodeReply, reply } = await import('@/network/smtp/replies');
    const r = reply(250, 'OK');
    const decoded = decodeReply(encodeReply(r));
    expect(decoded).toEqual(r);
  });

  it('round-trips a multi-line reply', async () => {
    const { encodeReply, decodeReply, reply } = await import('@/network/smtp/replies');
    const r = reply(214, 'Commands:', 'HELO EHLO MAIL', 'RCPT DATA');
    const decoded = decodeReply(encodeReply(r));
    expect(decoded).toEqual(r);
  });

  it('round-trips a reply with an enhanced status code (RFC 3463)', async () => {
    const { encodeReply, decodeReply, replyEnhanced } = await import('@/network/smtp/replies');
    const r = replyEnhanced(250, '2.1.0', 'Sender ok');
    const wire = encodeReply(r);
    expect(wire).toContain('250 2.1.0 Sender ok');
    const decoded = decodeReply(wire);
    expect(decoded).toEqual(r);
  });

  it('round-trips a command with an argument', async () => {
    const { encodeCommand, decodeCommand } = await import('@/network/smtp/replies');
    const cmd = { verb: 'MAIL', argument: 'FROM:<alice@example.org>' };
    expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
  });

  it('round-trips a command without an argument', async () => {
    const { encodeCommand, decodeCommand } = await import('@/network/smtp/replies');
    const cmd = { verb: 'QUIT' };
    expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
  });
});
