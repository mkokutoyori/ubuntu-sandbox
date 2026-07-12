/**
 * Password policy enforcement on a change (`Set-ADAccountPassword`-style):
 * `minPasswordLength`, `minPasswordAge`, and `passwordHistoryLength` were
 * all declared on `GpoAccountPolicy`/PSO but never actually checked
 * anywhere — dead fields, the same situation account lockout was in
 * before it got wired up. Deliberately NOT enforced at account creation
 * (`newUser`) — this codebase's own tests routinely use short passwords
 * there, and retrofitting that would be a disruptive, out-of-proportion
 * change for a self-initiated task.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function storeWithDefaultPolicy(): DirectoryStore {
  const s = new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd');
  s.newGpo('Default Domain Policy');
  s.setGpoSettings('Default Domain Policy', {
    accountPolicy: { minPasswordLength: 7, passwordHistoryLength: 24, maxPasswordAge: 42, minPasswordAge: 1, lockoutThreshold: 5 },
  });
  return s;
}

describe('DirectoryStore — password policy enforcement on change (domain default)', () => {
  it('refuses a new password shorter than minPasswordLength', () => {
    const s = storeWithDefaultPolicy();
    s.newUser('alice', { password: 'alicepw' });
    const res = s.setUser('alice', { password: 'short' });
    expect(res.ok).toBe(false);
    expect(s.getUser('alice')!.password).toBe('alicepw');
  });

  it('accepts a new password meeting the length requirement', () => {
    const s = storeWithDefaultPolicy();
    s.newUser('alice', { password: 'alicepw' });
    const res = s.setUser('alice', { password: 'longenough' });
    expect(res.ok).toBe(true);
    expect(s.getUser('alice')!.password).toBe('longenough');
  });

  it('refuses a second password change before minPasswordAge has elapsed', () => {
    const s = storeWithDefaultPolicy();
    s.newUser('bob', { password: 'bobpassword' });
    expect(s.setUser('bob', { password: 'firstchange' }).ok).toBe(true);
    const second = s.setUser('bob', { password: 'secondchange' });
    expect(second.ok).toBe(false);
    expect(s.getUser('bob')!.password).toBe('firstchange');
  });

  it('does not gate the very first change on minPasswordAge (no prior pwdLastSet baseline)', () => {
    const s = storeWithDefaultPolicy();
    s.newUser('carol', { password: 'carolpassword' });
    expect(s.setUser('carol', { password: 'brandnew1' }).ok).toBe(true);
  });
});

describe('DirectoryStore — password history enforcement (PSO with minPasswordAge disabled)', () => {
  it('refuses reusing a remembered password, but allows one that has aged out of history', () => {
    const s = storeWithDefaultPolicy();
    s.newUser('dave', { password: 'original1' });
    s.newPso('NoAgeGate', 1, { minPasswordAge: 0, passwordHistoryLength: 2 });
    s.setPsoAppliesTo('NoAgeGate', ['dave']);

    expect(s.setUser('dave', { password: 'change2' }).ok).toBe(true);
    expect(s.setUser('dave', { password: 'change3' }).ok).toBe(true);

    const reuseRecent = s.setUser('dave', { password: 'change2' });
    expect(reuseRecent.ok).toBe(false);

    const reuseForgotten = s.setUser('dave', { password: 'original1' });
    expect(reuseForgotten.ok).toBe(true);
  });
});
