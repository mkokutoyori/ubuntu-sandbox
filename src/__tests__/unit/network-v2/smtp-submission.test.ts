import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer, SMTP_SUBMISSION_PORT, SMTP_PORT } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import type { SmtpServerConfig } from '@/network/smtp/SmtpServerSession';
import { identityMatchesFrom, buildSubmissionContext, formatSenderLine, insertSenderHeader } from '@/network/smtp/submission';
import { SmtpServerSession } from '@/network/smtp/SmtpServerSession';
import { toBase64 } from '@/network/smtp/auth';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(port: number, config: Partial<SmtpServerConfig> = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const users = new Map([['alice', 'Wonderland1']]);
  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com', users, allowPlainTextAuth: true, ...config }, port);
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', port);
  return { client };
}

describe('MSA submission helper functions (RFC 6409)', () => {
  it('matches when the From: header contains the authenticated identity', () => {
    expect(identityMatchesFrom('alice', 'Alice <alice@example.org>')).toBe(true);
  });

  it('does not match when they differ', () => {
    expect(identityMatchesFrom('alice', 'Bob <bob@example.org>')).toBe(false);
  });

  it('buildSubmissionContext flags senderHeaderAdded only on mismatch', () => {
    expect(buildSubmissionContext('alice', 'alice@example.org').senderHeaderAdded).toBe(false);
    expect(buildSubmissionContext('alice', 'bob@example.org').senderHeaderAdded).toBe(true);
  });

  it('formats a Sender: line, qualifying a bare username with the hostname', () => {
    expect(formatSenderLine('alice', 'mail.example.com')).toBe('Sender: <alice@mail.example.com>');
    expect(formatSenderLine('alice@example.org', 'mail.example.com')).toBe('Sender: <alice@example.org>');
  });

  it('inserts the Sender: line at the top of the raw message', () => {
    const result = insertSenderHeader('From: bob@example.org\r\n\r\nHi', 'Sender: <alice@example.org>');
    expect(result.startsWith('Sender: <alice@example.org>\r\n')).toBe(true);
  });
});

describe('SMTP MSA submission port 587 (RFC 6409)', () => {
  it('rejects MAIL FROM before AUTH on port 587 with 530', () => {
    const { client } = buildTopology(SMTP_SUBMISSION_PORT);
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(530);
  });

  it('accepts MAIL FROM without AUTH on port 25 (unaffected by submission rules)', () => {
    const { client } = buildTopology(SMTP_PORT);
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(250);
  });

  it('accepts MAIL FROM on port 587 once authenticated', () => {
    const { client } = buildTopology(SMTP_SUBMISSION_PORT);
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.authPlain('alice', 'Wonderland1');
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(250);
  });

  it('adds a Sender: header when the declared From: differs from the authenticated identity', () => {
    const { client } = buildTopology(SMTP_SUBMISSION_PORT);
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.authPlain('alice', 'Wonderland1');
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    const r = client.sendDataBody('From: someone-else@example.org\r\nSubject: hi\r\n\r\nBody');
    expect(r?.code).toBe(250);
  });
});

describe('SMTP MSA Sender: header content (session-level)', () => {
  it('inserts a Sender: header reflecting the authenticated identity when From: differs', () => {
    const session = new SmtpServerSession({
      hostname: 'mail.example.com', users: new Map([['alice', 'Wonderland1']]), allowPlainTextAuth: true, submissionMode: true,
    });
    session.handle({ verb: 'EHLO', argument: 'client.example.org' });
    session.handle({ verb: 'AUTH', argument: `PLAIN ${toBase64('\0alice\0Wonderland1')}` });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('From: someone-else@example.org\r\nSubject: hi\r\n\r\nBody\r\n.\r\n');

    expect(session.lastDelivered!.message.headers.get('Sender')).toBe('<alice@mail.example.com>');
  });

  it('does not add a Sender: header when From: already matches the authenticated identity', () => {
    const session = new SmtpServerSession({
      hostname: 'mail.example.com', users: new Map([['alice', 'Wonderland1']]), allowPlainTextAuth: true, submissionMode: true,
    });
    session.handle({ verb: 'EHLO', argument: 'client.example.org' });
    session.handle({ verb: 'AUTH', argument: `PLAIN ${toBase64('\0alice\0Wonderland1')}` });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('From: alice@example.org\r\nSubject: hi\r\n\r\nBody\r\n.\r\n');

    expect(session.lastDelivered!.message.headers.has('Sender')).toBe(false);
  });
});
