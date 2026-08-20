import { describe, it, expect } from 'vitest';
import { MailboxStore } from '@/network/devices/windows/server/exchange/MailboxStore';
import { DistributionGroupStore, resolveGroupRecipients, deliverExpanded } from '@/network/devices/windows/server/exchange/DistributionGroupStore';

describe('DistributionGroupStore (docs/PRD-Exchange.md §4.2, P3)', () => {
  it('mailEnable() creates a mail-enabled group entry', () => {
    const store = new DistributionGroupStore();
    const res = store.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
    expect(res.ok).toBe(true);
    expect(store.get('Sales')).toEqual({ adGroupSam: 'Sales', type: 'Distribution', primarySmtpAddress: 'sales@mandeng.lan' });
  });

  it('mailEnable() fails for an already mail-enabled group', () => {
    const store = new DistributionGroupStore();
    store.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
    expect(store.mailEnable('Sales', 'sales2@mandeng.lan', 'Distribution').ok).toBe(false);
  });

  it('mailEnable() fails when the address is already used', () => {
    const store = new DistributionGroupStore();
    store.mailEnable('Sales', 'shared@mandeng.lan', 'Distribution');
    expect(store.mailEnable('Marketing', 'shared@mandeng.lan', 'Distribution').ok).toBe(false);
  });

  it('getByAddress() resolves case-insensitively', () => {
    const store = new DistributionGroupStore();
    store.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
    expect(store.getByAddress('Sales@Mandeng.LAN')?.adGroupSam).toBe('Sales');
  });

  it('setPrimarySmtpAddress() updates the address and re-indexes lookups', () => {
    const store = new DistributionGroupStore();
    store.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
    const res = store.setPrimarySmtpAddress('Sales', 'salesteam@mandeng.lan');
    expect(res.ok).toBe(true);
    expect(store.getByAddress('sales@mandeng.lan')).toBeNull();
    expect(store.getByAddress('salesteam@mandeng.lan')?.adGroupSam).toBe('Sales');
  });

  it('list() returns every mail-enabled group, both types', () => {
    const store = new DistributionGroupStore();
    store.mailEnable('Sales', 'sales@mandeng.lan', 'Distribution');
    store.mailEnable('ITAdmins', 'itadmins@mandeng.lan', 'SecurityMailEnabled');
    expect(store.list().map(g => g.adGroupSam).sort()).toEqual(['ITAdmins', 'Sales']);
  });
});

describe('resolveGroupRecipients() (§2.1 P3 — envelope expansion)', () => {
  it('maps AD group member sams to their mailbox SMTP addresses', () => {
    const mailboxes = new MailboxStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');
    mailboxes.enable('carol', 'carol@mandeng.lan');
    const addresses = resolveGroupRecipients(['bob', 'carol'], mailboxes);
    expect(addresses.sort()).toEqual(['bob@mandeng.lan', 'carol@mandeng.lan']);
  });

  it('skips members with no mailbox', () => {
    const mailboxes = new MailboxStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');
    const addresses = resolveGroupRecipients(['bob', 'ghost'], mailboxes);
    expect(addresses).toEqual(['bob@mandeng.lan']);
  });
});

describe('deliverExpanded() — a message to a group address fans out to every member mailbox', () => {
  it('delivers to all 3 members independently, visible in each Inbox', () => {
    const mailboxes = new MailboxStore();
    const groups = new DistributionGroupStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');
    mailboxes.enable('carol', 'carol@mandeng.lan');
    mailboxes.enable('dave', 'dave@mandeng.lan');
    groups.mailEnable('Team', 'team@mandeng.lan', 'Distribution');

    const results = deliverExpanded(
      groups, mailboxes, () => ['bob', 'carol', 'dave'],
      'team@mandeng.lan', 'alice@mandeng.lan', 'Announcement', 'Subject: Announcement\r\n\r\nHi team.', 1000,
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.delivered)).toBe(true);
    expect(mailboxes.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(mailboxes.get('carol')!.folders.Inbox).toHaveLength(1);
    expect(mailboxes.get('dave')!.folders.Inbox).toHaveLength(1);
  });

  it('a message to a plain mailbox address (not a group) delivers a single time, unchanged', () => {
    const mailboxes = new MailboxStore();
    const groups = new DistributionGroupStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');

    const results = deliverExpanded(groups, mailboxes, () => [], 'bob@mandeng.lan', 'alice@mandeng.lan', 'Hi', 'body', 1000);
    expect(results).toHaveLength(1);
    expect(results[0].delivered).toBe(true);
    expect(mailboxes.get('bob')!.folders.Inbox).toHaveLength(1);
  });

  it('a member removed from the group no longer receives future deliveries', () => {
    const mailboxes = new MailboxStore();
    const groups = new DistributionGroupStore();
    mailboxes.enable('bob', 'bob@mandeng.lan');
    mailboxes.enable('carol', 'carol@mandeng.lan');
    groups.mailEnable('Team', 'team@mandeng.lan', 'Distribution');

    let members = ['bob', 'carol'];
    deliverExpanded(groups, mailboxes, () => members, 'team@mandeng.lan', 'alice@mandeng.lan', 'First', 'first', 1000);
    members = ['carol'];
    deliverExpanded(groups, mailboxes, () => members, 'team@mandeng.lan', 'alice@mandeng.lan', 'Second', 'second', 2000);

    expect(mailboxes.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(mailboxes.get('carol')!.folders.Inbox).toHaveLength(2);
  });
});
