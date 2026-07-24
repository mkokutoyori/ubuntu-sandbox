import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpServerSession } from '@/network/smtp/SmtpServerSession';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import {
  parseMailFromArgument, parseRcptToArgument, stuffDotLines, unstuffDotLines, splitHeadersAndBody,
} from '@/network/smtp/envelope';

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
  return { pc, srv, server, client };
}

describe('SMTP envelope parsing (RFC 5321 §2.3.1)', () => {
  it('parses a MAIL FROM address', () => {
    expect(parseMailFromArgument('FROM:<alice@example.org>')).toBe('alice@example.org');
  });

  it('parses a bounce MAIL FROM (empty reverse-path)', () => {
    expect(parseMailFromArgument('FROM:<>')).toBe('');
  });

  it('parses a RCPT TO address', () => {
    expect(parseRcptToArgument('TO:<bob@example.org>')).toBe('bob@example.org');
  });

  it('returns null for a malformed argument', () => {
    expect(parseMailFromArgument('bogus')).toBeNull();
    expect(parseRcptToArgument(undefined)).toBeNull();
  });
});

describe('SMTP dot-stuffing round-trip (RFC 5321 §4.5.2)', () => {
  it('stuffs a body line that begins with a period', () => {
    const body = 'Hello\r\n.This starts with a period\r\nBye';
    expect(stuffDotLines(body)).toBe('Hello\r\n..This starts with a period\r\nBye');
  });

  it('stuffs a body line that is exactly a lone period', () => {
    expect(stuffDotLines('a\r\n.\r\nb')).toBe('a\r\n..\r\nb');
  });

  it('unstuffs back to the original body', () => {
    const original = 'Hello\r\n.This starts with a period\r\nBye';
    expect(unstuffDotLines(stuffDotLines(original))).toBe(original);
  });

  it('leaves lines with no leading period untouched', () => {
    const body = 'no dots here\r\nnor here';
    expect(stuffDotLines(body)).toBe(body);
    expect(unstuffDotLines(body)).toBe(body);
  });

  it('round-trips end to end through a real DATA transaction', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });

    const body = 'Subject: dots\r\n\r\n.Line starting with a dot\r\nNormal line';
    const final = client.sendDataBody(body);
    expect(final?.code).toBe(250);
  });
});

describe('SMTP envelope vs RFC 5322 headers distinction', () => {
  it('the envelope recipient can differ from every To:/Cc: header (Bcc case)', () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com' });
    session.handle({ verb: 'HELO', argument: 'client.example.org' });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bcc-target@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('To: bob@example.org\r\nSubject: hi\r\n\r\nBody text.\r\n.\r\n');

    expect(session.lastDelivered?.envelope.to).toEqual(['bcc-target@example.org']);
    expect(session.lastDelivered?.message.headers.get('To')).toBe('bob@example.org');
  });

  it('splits headers and body at the first blank line', () => {
    const parsed = splitHeadersAndBody('From: a@b.com\r\nSubject: hi\r\n\r\nLine one\r\nLine two');
    expect(parsed.headers.get('From')).toBe('a@b.com');
    expect(parsed.headers.get('Subject')).toBe('hi');
    expect(parsed.body).toBe('Line one\r\nLine two');
  });

  it('a message with no blank line has an empty body', () => {
    const parsed = splitHeadersAndBody('From: a@b.com\r\nSubject: hi');
    expect(parsed.body).toBe('');
  });
});
