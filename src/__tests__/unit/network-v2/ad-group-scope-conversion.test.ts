/**
 * `Set-ADGroup -GroupScope` (MS-ADTS §3.1.1.5.2.2) — real AD's own
 * conversion matrix, previously entirely unenforced (group scope could
 * be changed freely with no validation at all).
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import { parseDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — group scope conversion rules', () => {
  it('refuses Global to DomainLocal directly', () => {
    const s = store();
    s.newGroup('Eng', 'Global');
    const res = s.setGroupScope('Eng', 'DomainLocal');
    expect(res.ok).toBe(false);
  });

  it('refuses DomainLocal to Global directly', () => {
    const s = store();
    s.newGroup('FileShare', 'DomainLocal');
    const res = s.setGroupScope('FileShare', 'Global');
    expect(res.ok).toBe(false);
  });

  it('allows Global to Universal when not a member of another Global group', () => {
    const s = store();
    s.newGroup('Eng', 'Global');
    const res = s.setGroupScope('Eng', 'Universal');
    expect(res.ok).toBe(true);
    expect(s.getGroup('Eng')!.scope).toBe('Universal');
  });

  it('refuses Global to Universal when a member of another Global group', () => {
    const s = store();
    s.newGroup('Eng', 'Global');
    s.newGroup('AllStaff', 'Global');
    s.getTree().modifyEntry(parseDN(s.getGroup('AllStaff')!.dn), [{ op: 'add', type: 'member', values: [s.getGroup('Eng')!.dn] }]);
    s.getTree().modifyEntry(parseDN(s.getGroup('Eng')!.dn), [{ op: 'add', type: 'memberOf', values: [s.getGroup('AllStaff')!.dn] }]);
    const res = s.setGroupScope('Eng', 'Universal');
    expect(res.ok).toBe(false);
  });

  it('allows DomainLocal to Universal when it has no DomainLocal members', () => {
    const s = store();
    s.newGroup('FileShare', 'DomainLocal');
    s.newUser('alice', { password: 'x' });
    s.addGroupMember('FileShare', 'alice');
    const res = s.setGroupScope('FileShare', 'Universal');
    expect(res.ok).toBe(true);
  });

  it('refuses DomainLocal to Universal when it has a DomainLocal member', () => {
    const s = store();
    s.newGroup('FileShare', 'DomainLocal');
    s.newGroup('Inner', 'DomainLocal');
    s.getTree().modifyEntry(parseDN(s.getGroup('FileShare')!.dn), [{ op: 'add', type: 'member', values: [s.getGroup('Inner')!.dn] }]);
    const res = s.setGroupScope('FileShare', 'Universal');
    expect(res.ok).toBe(false);
  });

  it('allows Universal to DomainLocal unconditionally', () => {
    const s = store();
    s.newGroup('Eng', 'Universal');
    const res = s.setGroupScope('Eng', 'DomainLocal');
    expect(res.ok).toBe(true);
  });

  it('refuses Universal to Global when it has a Universal member', () => {
    const s = store();
    s.newGroup('Outer', 'Universal');
    s.newGroup('Inner', 'Universal');
    s.getTree().modifyEntry(parseDN(s.getGroup('Outer')!.dn), [{ op: 'add', type: 'member', values: [s.getGroup('Inner')!.dn] }]);
    const res = s.setGroupScope('Outer', 'Global');
    expect(res.ok).toBe(false);
  });

  it('allows Universal to Global when it has no Universal member', () => {
    const s = store();
    s.newGroup('Outer', 'Universal');
    const res = s.setGroupScope('Outer', 'Global');
    expect(res.ok).toBe(true);
  });

  it('is a no-op success when the requested scope matches the current one', () => {
    const s = store();
    s.newGroup('Eng', 'Global');
    const res = s.setGroupScope('Eng', 'Global');
    expect(res.ok).toBe(true);
  });

  it('fails cleanly for an unknown group', () => {
    const s = store();
    const res = s.setGroupScope('ghost', 'Universal');
    expect(res.ok).toBe(false);
  });
});
