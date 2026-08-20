import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServerSession } from '@/network/smtp/SmtpServerSession';
import {
  formatReceivedLine, prependReceivedHeader, extractReceivedChain,
  formatReturnPathLine, prependReturnPath, extractReturnPath, determineProtocolLabel,
} from '@/network/smtp/trace';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('SMTP trace headers (RFC 5321 §4.4)', () => {
  it('formats a Received: line with HELO identity and real source IP both present', () => {
    const line = formatReceivedLine({
      fromHelo: 'liar.example.org', fromIp: '203.0.113.9', by: 'mail.example.com',
      withProtocol: 'ESMTP', timestamp: 0,
    });
    expect(line).toContain('from liar.example.org');
    expect(line).toContain('([203.0.113.9])');
    expect(line).toContain('by mail.example.com');
    expect(line).toContain('with ESMTP');
  });

  it('a lying HELO does not overwrite the real observed source IP', () => {
    const line = formatReceivedLine({
      fromHelo: 'not-really-my-name.example', fromIp: '198.51.100.5', by: 'mail.example.com',
      withProtocol: 'SMTP', timestamp: 0,
    });
    expect(line).toContain('not-really-my-name.example');
    expect(line).toContain('198.51.100.5');
  });

  it('a message relayed across two hops carries two distinct Received: headers, most recent first', () => {
    const hop1 = prependReceivedHeader('Subject: hi\r\n\r\nBody', {
      fromHelo: 'origin.example.org', fromIp: '203.0.113.1', by: 'relay1.example.com',
      withProtocol: 'ESMTP', timestamp: 1000,
    });
    const hop2 = prependReceivedHeader(hop1, {
      fromHelo: 'relay1.example.com', fromIp: '198.51.100.1', by: 'relay2.example.com',
      withProtocol: 'ESMTP', timestamp: 2000,
    });

    const chain = extractReceivedChain(hop2);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toContain('relay2.example.com');
    expect(chain[0]).toContain('relay1.example.com');
    expect(chain[1]).toContain('origin.example.org');
    expect(chain[1]).toContain('relay1.example.com');
  });

  it('Return-Path is only added at final delivery, never on a merely relayed copy', () => {
    const relayed = 'Received: from a by b; date\r\nSubject: hi\r\n\r\nBody';
    expect(extractReturnPath(relayed)).toBeNull();

    const delivered = prependReturnPath(relayed, { address: 'alice@example.org' });
    expect(extractReturnPath(delivered)).toBe('alice@example.org');
    expect(formatReturnPathLine({ address: 'alice@example.org' })).toBe('Return-Path: <alice@example.org>');
  });

  it('determines the protocol label from extended-hello/TLS/AUTH state', () => {
    expect(determineProtocolLabel(false, false, false)).toBe('SMTP');
    expect(determineProtocolLabel(true, false, false)).toBe('ESMTP');
    expect(determineProtocolLabel(true, false, true)).toBe('ESMTPA');
    expect(determineProtocolLabel(true, true, false)).toBe('ESMTPS');
  });

  it('a completed transaction captures the true connection source IP alongside the (possibly lying) HELO', () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com' }, '203.0.113.9');
    session.handle({ verb: 'EHLO', argument: 'evil-liar.example' });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('Subject: hi\r\n\r\nBody\r\n.\r\n');

    const chain = extractReceivedChain(session.lastDelivered!.rawMessage);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toContain('evil-liar.example');
    expect(chain[0]).toContain('203.0.113.9');
    expect(chain[0]).toContain('with ESMTP');
  });

  it('a plain HELO (not EHLO) trace as SMTP, not ESMTP', () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com' }, '203.0.113.9');
    session.handle({ verb: 'HELO', argument: 'client.example.org' });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('Subject: hi\r\n\r\nBody\r\n.\r\n');

    const chain = extractReceivedChain(session.lastDelivered!.rawMessage);
    expect(chain[0]).toContain('with SMTP');
    expect(chain[0]).not.toContain('with ESMTP');
  });
});
