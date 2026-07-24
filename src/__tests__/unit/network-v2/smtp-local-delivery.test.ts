import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import {
  splitAddress, addressesEqualStrict, addressesEqualPragmatic, resolveLocalPart, mailboxPathFor,
  mboxFromLine, formatMboxEntry, deliverLocalMessage,
} from '@/network/smtp/localDelivery';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('localDelivery.ts address helpers (RFC 5321 §2.4)', () => {
  it('splits an address into local part and domain', () => {
    expect(splitAddress('Bob@Example.ORG')).toEqual(['Bob', 'Example.ORG']);
  });

  it('domain comparison is always case-insensitive', () => {
    expect(addressesEqualStrict('bob@example.org', 'bob@EXAMPLE.ORG')).toBe(true);
    expect(addressesEqualPragmatic('bob@example.org', 'bob@EXAMPLE.ORG')).toBe(true);
  });

  it('strict comparison respects local-part case per the letter of the RFC', () => {
    expect(addressesEqualStrict('Bob@example.org', 'bob@example.org')).toBe(false);
  });

  it('pragmatic comparison (documented, used for account resolution) ignores local-part case', () => {
    expect(addressesEqualPragmatic('Bob@example.org', 'bob@example.org')).toBe(true);
  });

  it('resolves the mailbox local part in lowercase regardless of input case', () => {
    expect(resolveLocalPart('Bob@example.org')).toBe('bob');
  });

  it('builds the /var/mail/<user> mailbox path from an address', () => {
    expect(mailboxPathFor('Bob@example.org')).toBe('/var/mail/bob');
  });
});

describe('localDelivery.ts mbox formatting (§2.1.11)', () => {
  it('formats the From <envelope-sender> <timestamp> separator line', () => {
    const line = mboxFromLine('alice@example.org', 0);
    expect(line.startsWith('From alice@example.org ')).toBe(true);
  });

  it('falls back to MAILER-DAEMON for an empty envelope sender (a bounce)', () => {
    expect(mboxFromLine('', 0)).toContain('From MAILER-DAEMON ');
  });

  it('formats a full mbox entry with the From line, message, and trailing blank line', () => {
    const entry = formatMboxEntry({ envelopeFrom: 'alice@example.org', receivedAt: 0, rawMessage: 'Subject: hi\r\n\r\nBody' });
    expect(entry).toContain('From alice@example.org ');
    expect(entry).toContain('Subject: hi\r\n\r\nBody');
    expect(entry.endsWith('\r\n\r\n')).toBe(true);
  });
});

describe('SMTP local delivery agent (§2.1.11) against a real VirtualFileSystem', () => {
  it('writes a real, readable message to /var/mail/<user>', () => {
    const vfs = new VirtualFileSystem();
    const ok = deliverLocalMessage(
      vfs, 'bob@example.org',
      { envelopeFrom: 'alice@example.org', receivedAt: 0, rawMessage: 'Subject: hi\r\n\r\nHello Bob.' },
      { uid: 1000, gid: 1000 },
    );
    expect(ok).toBe(true);

    const content = vfs.readFile('/var/mail/bob');
    expect(content).toContain('From alice@example.org ');
    expect(content).toContain('Hello Bob.');
  });

  it('appends a second message rather than overwriting the first', () => {
    const vfs = new VirtualFileSystem();
    deliverLocalMessage(vfs, 'bob@example.org', { envelopeFrom: 'alice@example.org', receivedAt: 0, rawMessage: 'first message' }, { uid: 1000, gid: 1000 });
    deliverLocalMessage(vfs, 'bob@example.org', { envelopeFrom: 'carol@example.org', receivedAt: 1000, rawMessage: 'second message' }, { uid: 1000, gid: 1000 });

    const content = vfs.readFile('/var/mail/bob')!;
    expect(content).toContain('first message');
    expect(content).toContain('second message');
    expect(content.indexOf('first message')).toBeLessThan(content.indexOf('second message'));
  });

  it('resolves the mailbox path with case-insensitive account resolution', () => {
    const vfs = new VirtualFileSystem();
    deliverLocalMessage(vfs, 'Bob@Example.ORG', { envelopeFrom: 'alice@example.org', receivedAt: 0, rawMessage: 'hi' }, { uid: 1000, gid: 1000 });
    expect(vfs.readFile('/var/mail/bob')).toContain('hi');
  });
});
