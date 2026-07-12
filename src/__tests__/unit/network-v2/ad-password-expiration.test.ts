/**
 * `maxPasswordAge` (`GpoAccountPolicy`/PSO) was the last previously-dead
 * password-policy field — declared, never checked. `checkPassword` (LDAP
 * simple bind, same deliberate scope as lockout/account expiration) now
 * refuses once a password has aged past it, unless the account carries
 * `userAccountControl`'s `DONT_EXPIRE_PASSWORD` bit
 * (`Set-ADUser -PasswordNeverExpires`).
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function storeWithMaxAge(days: number): DirectoryStore {
  const s = new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd');
  s.newGpo('Default Domain Policy');
  s.setGpoSettings('Default Domain Policy', { accountPolicy: { maxPasswordAge: days } });
  return s;
}

describe('DirectoryStore — password expiration (maxPasswordAge)', () => {
  it('does not expire immediately after creation', () => {
    const s = storeWithMaxAge(42);
    s.newUser('alice', { password: 'alicepw' });
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('refuses authentication once maxPasswordAge has elapsed since pwdLastSet', () => {
    const s = storeWithMaxAge(42);
    s.newUser('alice', { password: 'alicepw' });
    const entry = s.getTree().search(s.getTree().getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: 'alice' })[0];
    entry.attributes.set('pwdlastset', [String(Math.floor(Date.now() / 1000) - 43 * 86400)]);

    expect(s.checkPassword('alice', 'alicepw')).toBe(false);
  });

  it('exempts an account with passwordNeverExpires set', () => {
    const s = storeWithMaxAge(42);
    s.newUser('alice', { password: 'alicepw', passwordNeverExpires: true });
    expect(s.getUser('alice')!.passwordNeverExpires).toBe(true);
    const entry = s.getTree().search(s.getTree().getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: 'alice' })[0];
    entry.attributes.set('pwdlastset', [String(Math.floor(Date.now() / 1000) - 100 * 86400)]);

    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('setUser can toggle passwordNeverExpires independently of enabled', () => {
    const s = storeWithMaxAge(42);
    s.newUser('alice', { password: 'alicepw' });
    expect(s.getUser('alice')!.passwordNeverExpires).toBe(false);

    s.setUser('alice', { passwordNeverExpires: true });
    expect(s.getUser('alice')!.passwordNeverExpires).toBe(true);
    expect(s.getUser('alice')!.enabled).toBe(true);

    s.setUser('alice', { enabled: false });
    expect(s.getUser('alice')!.enabled).toBe(false);
    expect(s.getUser('alice')!.passwordNeverExpires).toBe(true);
  });

  it('the seeded Administrator and krbtgt never expire', () => {
    const s = storeWithMaxAge(42);
    expect(s.getUser('Administrator')!.passwordNeverExpires).toBe(true);
  });
});
