import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  parseNotifyParam, parseOrcptParam, parseRcptDsnParams, isBounceEnvelope, shouldGenerateDsn,
  formatDeliveryStatusPart, buildDsnMessage, buildDsnForFailedDelivery,
} from '@/network/smtp/dsn';
import { SmtpServerSession } from '@/network/smtp/SmtpServerSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('dsn.ts parameter parsing (RFC 3461)', () => {
  it('parses NOTIFY=FAILURE,DELAY', () => {
    expect(parseNotifyParam('TO:<bob@example.org> NOTIFY=FAILURE,DELAY')).toEqual(['FAILURE', 'DELAY']);
  });

  it('parses a single NOTIFY condition', () => {
    expect(parseNotifyParam('TO:<bob@example.org> NOTIFY=NEVER')).toEqual(['NEVER']);
  });

  it('returns an empty array when NOTIFY= is absent', () => {
    expect(parseNotifyParam('TO:<bob@example.org>')).toEqual([]);
  });

  it('parses ORCPT=rfc822;<address>', () => {
    expect(parseOrcptParam('TO:<bob@example.org> ORCPT=rfc822;original@example.org')).toBe('original@example.org');
  });

  it('parseRcptDsnParams combines both', () => {
    const params = parseRcptDsnParams('TO:<bob@example.org> NOTIFY=FAILURE ORCPT=rfc822;original@example.org');
    expect(params.notify).toEqual(['FAILURE']);
    expect(params.orcpt).toBe('original@example.org');
  });
});

describe('dsn.ts anti-bounce-loop rule (RFC 3464 §5.1 no double bounce)', () => {
  it('a normal sender envelope generates a DSN by default (no NOTIFY= given)', () => {
    expect(shouldGenerateDsn('alice@example.org', [])).toBe(true);
  });

  it('NOTIFY=NEVER suppresses the DSN', () => {
    expect(shouldGenerateDsn('alice@example.org', ['NEVER'])).toBe(false);
  });

  it('recognizes a bounce envelope (empty MAIL FROM)', () => {
    expect(isBounceEnvelope('')).toBe(true);
    expect(isBounceEnvelope('alice@example.org')).toBe(false);
  });

  it('never generates a second DSN when the original envelope was already a bounce', () => {
    expect(shouldGenerateDsn('', [])).toBe(false);
    expect(shouldGenerateDsn('', ['FAILURE'])).toBe(false);
  });
});

describe('dsn.ts multipart/report message building (RFC 3464/6522)', () => {
  it('formats the message/delivery-status part with Final-Recipient/Action/Status', () => {
    const part = formatDeliveryStatusPart({ finalRecipient: 'bob@example.org', action: 'failed', status: '5.1.1' });
    expect(part).toContain('Final-Recipient: rfc822;bob@example.org');
    expect(part).toContain('Action: failed');
    expect(part).toContain('Status: 5.1.1');
  });

  it('includes Diagnostic-Code and Original-Envelope-Id when present', () => {
    const part = formatDeliveryStatusPart({
      finalRecipient: 'bob@example.org', action: 'failed', status: '5.1.1',
      diagnosticCode: 'smtp; 550 5.1.1 User unknown', originalEnvelopeId: 'orig@example.org',
    });
    expect(part).toContain('Diagnostic-Code: smtp; 550 5.1.1 User unknown');
    expect(part).toContain('Original-Envelope-Id: orig@example.org');
  });

  it('builds a real multipart/report message with the correct boundary structure', () => {
    const msg = buildDsnMessage({ finalRecipient: 'bob@example.org', action: 'failed', status: '5.1.1' });
    expect(msg).toContain('Content-Type: multipart/report; report-type=delivery-status; boundary="DSN-BOUNDARY"');
    expect(msg).toContain('Content-Type: message/delivery-status');
    expect(msg).toContain('--DSN-BOUNDARY--');
  });

  it('includes an optional message/rfc822 part with the original headers', () => {
    const msg = buildDsnMessage(
      { finalRecipient: 'bob@example.org', action: 'failed', status: '5.1.1' },
      'From: alice@example.org\r\nSubject: hi',
    );
    expect(msg).toContain('Content-Type: message/rfc822');
    expect(msg).toContain('From: alice@example.org');
  });
});

describe('buildDsnForFailedDelivery() end-to-end (objective 21)', () => {
  it('produces a DSN addressed back to the original sender with an empty MAIL FROM', () => {
    const dsn = buildDsnForFailedDelivery('alice@example.org', 'bob@remote.example', '550 5.1.1 User unknown', { notify: [] });
    expect(dsn).not.toBeNull();
    expect(dsn!.envelopeFrom).toBe('');
    expect(dsn!.envelopeTo).toBe('alice@example.org');
    expect(dsn!.message).toContain('bob@remote.example');
  });

  it('addresses the DSN to ORCPT when provided, instead of the plain sender', () => {
    const dsn = buildDsnForFailedDelivery('alice@example.org', 'bob@remote.example', 'timeout', { notify: [], orcpt: 'orig-alice@example.org' });
    expect(dsn!.envelopeTo).toBe('orig-alice@example.org');
  });

  it('returns null (no DSN generated) for a failure on an already-bounce message', () => {
    const dsn = buildDsnForFailedDelivery('', 'bob@remote.example', '550 5.1.1', { notify: [] });
    expect(dsn).toBeNull();
  });

  it('returns null when NOTIFY=NEVER was requested', () => {
    const dsn = buildDsnForFailedDelivery('alice@example.org', 'bob@remote.example', '550 5.1.1', { notify: ['NEVER'] });
    expect(dsn).toBeNull();
  });
});

describe('SMTP session wiring: NOTIFY=/ORCPT= captured per recipient (RFC 3461)', () => {
  it('captures NOTIFY=/ORCPT= on RCPT TO and exposes them on the delivered transaction', () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com' });
    session.handle({ verb: 'HELO', argument: 'client.example.org' });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org> NOTIFY=FAILURE,DELAY ORCPT=rfc822;bob-orig@example.org' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('Subject: hi\r\n\r\nBody\r\n.\r\n');

    const dsnParams = session.lastDelivered!.dsnRequests.get('bob@example.org');
    expect(dsnParams?.notify).toEqual(['FAILURE', 'DELAY']);
    expect(dsnParams?.orcpt).toBe('bob-orig@example.org');
  });

  it('a recipient without NOTIFY=/ORCPT= still gets an entry with empty defaults', () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com' });
    session.handle({ verb: 'HELO', argument: 'client.example.org' });
    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('Subject: hi\r\n\r\nBody\r\n.\r\n');

    const dsnParams = session.lastDelivered!.dsnRequests.get('bob@example.org');
    expect(dsnParams?.notify).toEqual([]);
    expect(dsnParams?.orcpt).toBeUndefined();
  });
});
