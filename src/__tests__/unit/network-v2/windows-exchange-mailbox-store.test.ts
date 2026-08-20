import { describe, it, expect } from 'vitest';
import { MailboxStore } from '@/network/devices/windows/server/exchange/MailboxStore';

describe('MailboxStore (docs/PRD-Exchange.md §4.1, P2)', () => {
  it('enable() creates a mailbox with the 5 standard empty folders', () => {
    const store = new MailboxStore();
    const res = store.enable('bob', 'bob@mandeng.lan');
    expect(res.ok).toBe(true);
    const mbx = store.get('bob')!;
    expect(Object.keys(mbx.folders).sort()).toEqual(['Deleted Items', 'Drafts', 'Inbox', 'Junk Email', 'Sent Items'].sort());
    for (const f of Object.values(mbx.folders)) expect(f).toEqual([]);
    expect(mbx.primarySmtpAddress).toBe('bob@mandeng.lan');
    expect(mbx.quotaBytes).toBeNull();
  });

  it('enable() fails for an identity that is already mailbox-enabled', () => {
    const store = new MailboxStore();
    store.enable('bob', 'bob@mandeng.lan');
    const res = store.enable('bob', 'bob2@mandeng.lan');
    expect(res.ok).toBe(false);
  });

  it('enable() fails when the primary SMTP address is already used by another mailbox', () => {
    const store = new MailboxStore();
    store.enable('bob', 'shared@mandeng.lan');
    const res = store.enable('carol', 'shared@mandeng.lan');
    expect(res.ok).toBe(false);
  });

  it('get() is case-insensitive on identity', () => {
    const store = new MailboxStore();
    store.enable('Bob', 'bob@mandeng.lan');
    expect(store.get('bob')).not.toBeNull();
    expect(store.get('BOB')).not.toBeNull();
  });

  it('disable() removes the mailbox but the identity stays available for a fresh enable()', () => {
    const store = new MailboxStore();
    store.enable('bob', 'bob@mandeng.lan');
    const res = store.disable('bob');
    expect(res.ok).toBe(true);
    expect(store.get('bob')).toBeNull();
    expect(store.enable('bob', 'bob@mandeng.lan').ok).toBe(true);
  });

  it('disable() on a non-mailbox-enabled identity fails cleanly', () => {
    const store = new MailboxStore();
    expect(store.disable('ghost').ok).toBe(false);
  });

  it('list() returns every enabled mailbox', () => {
    const store = new MailboxStore();
    store.enable('bob', 'bob@mandeng.lan');
    store.enable('carol', 'carol@mandeng.lan');
    expect(store.list().map(m => m.adIdentity).sort()).toEqual(['bob', 'carol']);
  });

  describe('deliver() — the single write path into a mailbox', () => {
    it('delivers into Inbox for a matching primary SMTP address', () => {
      const store = new MailboxStore();
      store.enable('bob', 'bob@mandeng.lan');
      const res = store.deliver('bob@mandeng.lan', 'alice@mandeng.lan', 'Hello', 'Subject: Hello\r\n\r\nHi Bob.', 1000);
      expect(res.delivered).toBe(true);
      const mbx = store.get('bob')!;
      expect(mbx.folders.Inbox).toHaveLength(1);
      expect(mbx.folders.Inbox[0].subject).toBe('Hello');
      expect(mbx.folders.Inbox[0].from).toBe('alice@mandeng.lan');
      expect(mbx.folders.Inbox[0].read).toBe(false);
    });

    it('address matching is case-insensitive', () => {
      const store = new MailboxStore();
      store.enable('bob', 'bob@mandeng.lan');
      const res = store.deliver('Bob@Mandeng.LAN', 'alice@mandeng.lan', 'Hi', 'body', 1000);
      expect(res.delivered).toBe(true);
    });

    it('fails with not-found for an address with no matching mailbox', () => {
      const store = new MailboxStore();
      const res = store.deliver('ghost@mandeng.lan', 'alice@mandeng.lan', 'Hi', 'body', 1000);
      expect(res.delivered).toBe(false);
      expect(res.reason).toBe('not-found');
    });

    it('fails with quota-exceeded once the mailbox quota would be crossed, and does not deliver the message', () => {
      const store = new MailboxStore();
      store.enable('bob', 'bob@mandeng.lan');
      store.setQuota('bob', 10);
      const res = store.deliver('bob@mandeng.lan', 'alice@mandeng.lan', 'Hi', 'this message is way over ten bytes', 1000);
      expect(res.delivered).toBe(false);
      expect(res.reason).toBe('quota-exceeded');
      expect(store.get('bob')!.folders.Inbox).toHaveLength(0);
    });

    it('multiple delivered messages accumulate independently in Inbox', () => {
      const store = new MailboxStore();
      store.enable('bob', 'bob@mandeng.lan');
      store.deliver('bob@mandeng.lan', 'alice@mandeng.lan', 'First', 'first body', 1000);
      store.deliver('bob@mandeng.lan', 'carol@mandeng.lan', 'Second', 'second body', 2000);
      const inbox = store.get('bob')!.folders.Inbox;
      expect(inbox).toHaveLength(2);
      expect(inbox[0].subject).toBe('First');
      expect(inbox[1].subject).toBe('Second');
      expect(inbox[0].id).not.toBe(inbox[1].id);
    });
  });

  describe('totalSizeBytes() / totalItemCount()', () => {
    it('sums sizes and counts across all folders, not just Inbox', () => {
      const store = new MailboxStore();
      store.enable('bob', 'bob@mandeng.lan');
      store.deliver('bob@mandeng.lan', 'alice@mandeng.lan', 'A', '12345', 1000);
      const mbx = store.get('bob')!;
      mbx.folders['Sent Items'].push({ id: 'x', from: 'bob@mandeng.lan', to: ['carol@mandeng.lan'], subject: 'Sent', receivedAt: 1500, read: true, sizeBytes: 7 });
      expect(store.totalSizeBytes(mbx)).toBe(12);
      expect(store.totalItemCount(mbx)).toBe(2);
    });
  });
});
