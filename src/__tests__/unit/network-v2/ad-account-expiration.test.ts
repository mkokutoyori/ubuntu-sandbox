/**
 * Account expiration (`Set-ADAccountExpiration`/`Clear-ADAccountExpiration`)
 * — previously absent entirely. Deliberately scoped to `checkPassword`
 * (LDAP simple bind) only, same convention as account lockout: not
 * consulted by the Kerberos AS-REQ path, which has a much larger blast
 * radius to touch safely as a self-initiated task.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — account expiration', () => {
  it('never expires by default', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    expect(s.getUser('alice')!.accountExpires).toBeNull();
    expect(s.isAccountExpired('alice')).toBe(false);
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('refuses authentication once the expiration timestamp has passed', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
    expect(s.setAccountExpiration('alice', pastTimestamp).ok).toBe(true);

    expect(s.isAccountExpired('alice')).toBe(true);
    expect(s.checkPassword('alice', 'alicepw')).toBe(false);
    expect(s.getUser('alice')!.accountExpires).toBe(pastTimestamp);
  });

  it('still authenticates before a future expiration timestamp', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
    s.setAccountExpiration('alice', futureTimestamp);

    expect(s.isAccountExpired('alice')).toBe(false);
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('Clear-ADAccountExpiration (null) removes a previously set expiration', () => {
    const s = store();
    s.newUser('alice', { password: 'alicepw' });
    s.setAccountExpiration('alice', Math.floor(Date.now() / 1000) - 3600);
    expect(s.checkPassword('alice', 'alicepw')).toBe(false);

    s.setAccountExpiration('alice', null);
    expect(s.getUser('alice')!.accountExpires).toBeNull();
    expect(s.checkPassword('alice', 'alicepw')).toBe(true);
  });

  it('fails cleanly for an unknown identity', () => {
    const s = store();
    const res = s.setAccountExpiration('ghost', 0);
    expect(res.ok).toBe(false);
  });
});
