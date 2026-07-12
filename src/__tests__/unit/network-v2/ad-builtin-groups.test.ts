/**
 * Built-in security groups (`Administrators`, `Account Operators`,
 * `Backup Operators`, `Server Operators`, `Print Operators`,
 * `Cert Publishers`, `Group Policy Creator Owners`, `DnsAdmins`) — only
 * Domain Admins/Domain Users/Domain Computers were seeded before. Real
 * AD places most of these in a dedicated `CN=Builtin` container under
 * well-known non-domain-relative SIDs; this simulator seeds them in
 * `CN=Users` with ordinary local-RID-pool SIDs instead (documented
 * simplification in `DirectoryStore.seedDefaults`).
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — built-in security groups', () => {
  it('seeds all the built-in groups as DomainLocal scope', () => {
    const s = store();
    for (const sam of ['Administrators', 'Account Operators', 'Backup Operators', 'Server Operators', 'Print Operators', 'Cert Publishers', 'Group Policy Creator Owners', 'DnsAdmins']) {
      const group = s.getGroup(sam);
      expect(group).not.toBeNull();
      expect(group!.scope).toBe('DomainLocal');
    }
  });

  it('adds the seeded Administrator to the built-in Administrators group', () => {
    const s = store();
    expect(s.getGroup('Administrators')!.members).toContain('Administrator');
  });

  it('an ordinary user is not a member of any built-in group by default', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    expect(s.getGroup('Administrators')!.members).not.toContain('bob');
    expect(s.getGroup('Account Operators')!.members).not.toContain('bob');
  });
});

describe('SdProp — expanded protected-group set', () => {
  it('marks a member of a newly-protected built-in group (Account Operators)', () => {
    const s = store();
    s.newUser('carol', { password: 'x' });
    s.addGroupMember('Account Operators', 'carol');
    const marked = s.runSdProp();
    expect(marked).toContain('carol');
    expect(s.getUser('carol')!.adminCount).toBe(true);
  });

  it('marks a member of Backup Operators, Server Operators, and Print Operators', () => {
    const s = store();
    s.newUser('dave', { password: 'x' });
    s.newUser('erin', { password: 'x' });
    s.newUser('frank', { password: 'x' });
    s.addGroupMember('Backup Operators', 'dave');
    s.addGroupMember('Server Operators', 'erin');
    s.addGroupMember('Print Operators', 'frank');
    const marked = s.runSdProp();
    expect(marked).toEqual(expect.arrayContaining(['dave', 'erin', 'frank']));
  });
});
