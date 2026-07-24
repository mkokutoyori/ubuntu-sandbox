import { describe, it, expect } from 'vitest';
import { MailboxStore } from '@/network/devices/windows/server/exchange/MailboxStore';
import { DistributionGroupStore } from '@/network/devices/windows/server/exchange/DistributionGroupStore';
import { buildGlobalAddressList, resolveGalRecipient } from '@/network/devices/windows/server/exchange/GlobalAddressList';

describe('buildGlobalAddressList() (docs/PRD-Exchange.md §2.1 P4)', () => {
  it('includes every activated mailbox with its derived primary SMTP address', () => {
    const mailboxes = new MailboxStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');
    mailboxes.enable('carol', 'carol@mandeng.lan');
    const gal = buildGlobalAddressList(mailboxes, new DistributionGroupStore());
    expect(gal.filter(e => e.kind === 'Mailbox').map(e => e.primarySmtpAddress).sort()).toEqual(['bob@mandeng.lan', 'carol@mandeng.lan']);
  });

  it('a disabled mailbox disappears from the GAL immediately', () => {
    const mailboxes = new MailboxStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');
    mailboxes.disable('bob');
    const gal = buildGlobalAddressList(mailboxes, new DistributionGroupStore());
    expect(gal.some(e => e.samAccountName === 'bob')).toBe(false);
  });

  it('includes mail-enabled distribution and security groups', () => {
    const groups = new DistributionGroupStore();
    groups.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
    groups.mailEnable('ITAdmins', 'itadmins@mandeng.lan', 'SecurityMailEnabled');
    const gal = buildGlobalAddressList(new MailboxStore(), groups);
    expect(gal.find(e => e.samAccountName === 'Sales')?.kind).toBe('Distribution');
    expect(gal.find(e => e.samAccountName === 'ITAdmins')?.kind).toBe('SecurityMailEnabled');
  });
});

describe('resolveGalRecipient() — display-name/SAM resolution at send time (§2.1 P4)', () => {
  const mailboxes = new MailboxStore();
  mailboxes.enable('bob', 'bob@mandeng.lan');
  const groups = new DistributionGroupStore();
  groups.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
  const gal = buildGlobalAddressList(mailboxes, groups);

  it('a literal SMTP address passes through unresolved', () => {
    const res = resolveGalRecipient('bob@mandeng.lan', gal);
    expect(res).toEqual({ kind: 'literal-address', address: 'bob@mandeng.lan' });
  });

  it('a SAM account name resolves to the matching mailbox entry', () => {
    const res = resolveGalRecipient('bob', gal);
    expect(res).toEqual({ kind: 'resolved', entry: gal.find(e => e.samAccountName === 'bob') });
  });

  it('resolution is case-insensitive', () => {
    const res = resolveGalRecipient('BOB', gal);
    expect(res.kind).toBe('resolved');
  });

  it('a distribution group name resolves too, not only mailboxes', () => {
    const res = resolveGalRecipient('Sales', gal);
    expect(res.kind).toBe('resolved');
    expect(res.kind === 'resolved' && res.entry.kind).toBe('Distribution');
  });

  it('an unknown name produces not-found', () => {
    expect(resolveGalRecipient('ghost', gal)).toEqual({ kind: 'not-found' });
  });
});
