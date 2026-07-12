/**
 * `userAccountControl`'s `SMARTCARD_REQUIRED` bit — previously unmodeled.
 * Real AD disables ordinary password logon outright once this bit is set
 * (only a smart-card-backed PKINIT logon works); this simulator only
 * models the LDAP simple-bind gate (`checkPassword`), same deliberate
 * scope as lockout/expiration/maxPasswordAge.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — SMARTCARD_REQUIRED', () => {
  it('defaults to false', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.getUser('alice')!.smartcardRequired).toBe(false);
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('setUser({smartcardRequired: true}) blocks password authentication even with the correct password', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.setUser('alice', { smartcardRequired: true }).ok).toBe(true);
    expect(s.getUser('alice')!.smartcardRequired).toBe(true);
    expect(s.checkPassword('alice', 'alicepw')).toBe(false);
  });

  it('re-authenticates normally once smartcardRequired is cleared', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    s.setUser('alice', { smartcardRequired: true });
    expect(s.checkPassword('alice', 'alicepw')).toBe(false);
    s.setUser('alice', { smartcardRequired: false });
    expect(s.getUser('alice')!.smartcardRequired).toBe(false);
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('does not clobber unrelated UAC bits (enabled/passwordNeverExpires) when toggled together', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw', passwordNeverExpires: true });
    s.setUser('alice', { smartcardRequired: true });
    const u = s.getUser('alice')!;
    expect(u.smartcardRequired).toBe(true);
    expect(u.passwordNeverExpires).toBe(true);
    expect(u.enabled).toBe(true);
  });

  it('does not by itself lock out or disable the account', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    s.setUser('alice', { smartcardRequired: true });
    const u = s.getUser('alice')!;
    expect(u.enabled).toBe(true);
    expect(u.lockedOut).toBe(false);
  });
});
