/**
 * Last-logon tracking — completely absent before. Models real AD's
 * `lastLogonTimestamp` (updated on every successful LDAP simple bind,
 * same deliberate scope as lockout/expiration) rather than the
 * per-DC, non-replicated `lastLogon` — a documented simplification.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — last-logon tracking', () => {
  it('is null before any successful authentication', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.getUser('alice')!.lastLogonTimestamp).toBeNull();
  });

  it('records a timestamp on successful authentication', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    const before = Math.floor(Date.now() / 1000);
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
    const stamp = s.getUser('alice')!.lastLogonTimestamp;
    expect(stamp).not.toBeNull();
    expect(stamp!).toBeGreaterThanOrEqual(before);
  });

  it('does not record a timestamp on a failed authentication attempt', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.checkPassword('alice', 'wrongpassword')).toBe(false);
    expect(s.getUser('alice')!.lastLogonTimestamp).toBeNull();
  });

  it('advances on each subsequent successful authentication', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    s.checkPassword('alice', 'alicepw');
    const first = s.getUser('alice')!.lastLogonTimestamp!;
    s.checkPassword('alice', 'alicepw');
    const second = s.getUser('alice')!.lastLogonTimestamp!;
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
