/**
 * Real LDAP DIT tests: DirectoryTree add/delete/modify/search(base/one/sub)/compare
 * against a genuine parent/child tree keyed by DN.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryTree } from '@/network/devices/windows/server/ad/ldap/DirectoryTree';
import { parseDN, formatDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';
import { parseFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';

function tree(): DirectoryTree {
  return new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
}

describe('DirectoryTree — construction', () => {
  it('creates a root entry reachable by its DN', () => {
    const t = tree();
    const root = t.getByDn(parseDN('DC=lab,DC=local'));
    expect(root).not.toBeNull();
    expect(root?.attributes.get('objectclass')).toEqual(['top', 'domain']);
  });

  it('getRootDn round-trips through formatDN', () => {
    const t = tree();
    expect(formatDN(t.getRootDn())).toBe('DC=lab,DC=local');
  });

  it('getByDn is case-insensitive on DN component values', () => {
    const t = tree();
    expect(t.getByDn(parseDN('dc=LAB,dc=LOCAL'))).not.toBeNull();
  });

  it('isWithinTree is a structural DN check (descendant naming, not tree membership) and rejects foreign DNs', () => {
    const t = tree();
    expect(t.isWithinTree(parseDN('DC=lab,DC=local'))).toBe(true);
    expect(t.isWithinTree(parseDN('OU=Users,DC=lab,DC=local'))).toBe(true); // naming falls under the root even if the entry hasn't been added
    expect(t.isWithinTree(parseDN('DC=other,DC=local'))).toBe(false);
  });
});

describe('DirectoryTree — addEntry', () => {
  it('adds a child of the root', () => {
    const t = tree();
    const dn = parseDN('OU=Users,DC=lab,DC=local');
    const res = t.addEntry(dn, { objectClass: ['top', 'organizationalUnit'], ou: ['Users'] });
    expect(res).toEqual({ ok: true, message: '' });
    expect(t.getByDn(dn)).not.toBeNull();
    expect(t.isWithinTree(dn)).toBe(true);
  });

  it('adds a grandchild once its parent exists', () => {
    const t = tree();
    t.addEntry(parseDN('OU=Users,DC=lab,DC=local'), {});
    const userDn = parseDN('CN=Bob Smith,OU=Users,DC=lab,DC=local');
    const res = t.addEntry(userDn, { objectClass: ['user'], sAMAccountName: ['bob'] });
    expect(res.ok).toBe(true);
    expect(t.getByDn(userDn)?.attributes.get('samaccountname')).toEqual(['bob']);
  });

  it('fails with noSuchObject when the parent does not exist', () => {
    const t = tree();
    const res = t.addEntry(parseDN('CN=Bob Smith,OU=Missing,DC=lab,DC=local'), {});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/noSuchObject/);
  });

  it('fails with entryAlreadyExists on a duplicate DN', () => {
    const t = tree();
    const dn = parseDN('OU=Users,DC=lab,DC=local');
    t.addEntry(dn, {});
    const res = t.addEntry(dn, {});
    expect(res).toEqual({ ok: false, message: 'entryAlreadyExists' });
  });

  it('refuses to add the root entry itself', () => {
    const t = tree();
    const res = t.addEntry([], {});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/namingViolation/);
  });
});

describe('DirectoryTree — deleteEntry', () => {
  it('deletes a leaf entry', () => {
    const t = tree();
    const dn = parseDN('OU=Users,DC=lab,DC=local');
    t.addEntry(dn, {});
    const res = t.deleteEntry(dn);
    expect(res).toEqual({ ok: true, message: '' });
    expect(t.getByDn(dn)).toBeNull();
  });

  it('refuses to delete a non-leaf entry', () => {
    const t = tree();
    const ouDn = parseDN('OU=Users,DC=lab,DC=local');
    t.addEntry(ouDn, {});
    t.addEntry(parseDN('CN=Bob,OU=Users,DC=lab,DC=local'), {});
    const res = t.deleteEntry(ouDn);
    expect(res).toEqual({ ok: false, message: 'notAllowedOnNonLeaf' });
    expect(t.getByDn(ouDn)).not.toBeNull();
  });

  it('fails with noSuchObject for an unknown DN', () => {
    const t = tree();
    const res = t.deleteEntry(parseDN('OU=Ghost,DC=lab,DC=local'));
    expect(res).toEqual({ ok: false, message: 'noSuchObject' });
  });

  it('after deleting a leaf, its former parent can be deleted too', () => {
    const t = tree();
    const ouDn = parseDN('OU=Users,DC=lab,DC=local');
    const userDn = parseDN('CN=Bob,OU=Users,DC=lab,DC=local');
    t.addEntry(ouDn, {});
    t.addEntry(userDn, {});
    t.deleteEntry(userDn);
    expect(t.deleteEntry(ouDn)).toEqual({ ok: true, message: '' });
  });
});

describe('DirectoryTree — modifyEntry', () => {
  const dn = parseDN('CN=Bob,OU=Users,DC=lab,DC=local');
  function withUser(): DirectoryTree {
    const t = tree();
    t.addEntry(parseDN('OU=Users,DC=lab,DC=local'), {});
    t.addEntry(dn, { objectClass: ['user'], mail: ['bob@lab.local'] });
    return t;
  }

  it('replace overwrites an attribute', () => {
    const t = withUser();
    const res = t.modifyEntry(dn, [{ op: 'replace', type: 'mail', values: ['bob2@lab.local'] }]);
    expect(res.ok).toBe(true);
    expect(t.getByDn(dn)?.attributes.get('mail')).toEqual(['bob2@lab.local']);
  });

  it('replace with an empty value list deletes the attribute', () => {
    const t = withUser();
    t.modifyEntry(dn, [{ op: 'replace', type: 'mail', values: [] }]);
    expect(t.getByDn(dn)?.attributes.has('mail')).toBe(false);
  });

  it('add appends new values without duplicating existing (case-insensitive) ones', () => {
    const t = withUser();
    t.modifyEntry(dn, [{ op: 'add', type: 'mail', values: ['BOB@lab.local', 'bob@other.local'] }]);
    expect(t.getByDn(dn)?.attributes.get('mail')).toEqual(['bob@lab.local', 'bob@other.local']);
  });

  it('add creates a new attribute if it did not previously exist', () => {
    const t = withUser();
    t.modifyEntry(dn, [{ op: 'add', type: 'telephoneNumber', values: ['555-1234'] }]);
    expect(t.getByDn(dn)?.attributes.get('telephonenumber')).toEqual(['555-1234']);
  });

  it('delete with explicit values removes only those values (case-insensitive)', () => {
    const t = withUser();
    t.modifyEntry(dn, [{ op: 'add', type: 'mail', values: ['bob2@lab.local'] }]);
    t.modifyEntry(dn, [{ op: 'delete', type: 'mail', values: ['BOB@LAB.LOCAL'] }]);
    expect(t.getByDn(dn)?.attributes.get('mail')).toEqual(['bob2@lab.local']);
  });

  it('delete with no values removes the whole attribute', () => {
    const t = withUser();
    t.modifyEntry(dn, [{ op: 'delete', type: 'mail', values: [] }]);
    expect(t.getByDn(dn)?.attributes.has('mail')).toBe(false);
  });

  it('delete that empties the last remaining value removes the attribute entirely', () => {
    const t = withUser();
    t.modifyEntry(dn, [{ op: 'delete', type: 'mail', values: ['bob@lab.local'] }]);
    expect(t.getByDn(dn)?.attributes.has('mail')).toBe(false);
  });

  it('applies multiple changes in sequence within one call', () => {
    const t = withUser();
    const res = t.modifyEntry(dn, [
      { op: 'replace', type: 'objectClass', values: ['user', 'top'] },
      { op: 'add', type: 'cn', values: ['Bob'] },
    ]);
    expect(res.ok).toBe(true);
    expect(t.getByDn(dn)?.attributes.get('objectclass')).toEqual(['user', 'top']);
    expect(t.getByDn(dn)?.attributes.get('cn')).toEqual(['Bob']);
  });

  it('fails with noSuchObject for an unknown DN', () => {
    const t = tree();
    const res = t.modifyEntry(parseDN('CN=Ghost,DC=lab,DC=local'), [{ op: 'add', type: 'mail', values: ['x'] }]);
    expect(res).toEqual({ ok: false, message: 'noSuchObject' });
  });
});

describe('DirectoryTree — search', () => {
  function populated(): DirectoryTree {
    const t = tree();
    t.addEntry(parseDN('OU=Users,DC=lab,DC=local'), { objectClass: ['organizationalUnit'] });
    t.addEntry(parseDN('CN=Bob,OU=Users,DC=lab,DC=local'), { objectClass: ['user'], sAMAccountName: ['bob'] });
    t.addEntry(parseDN('CN=Alice,OU=Users,DC=lab,DC=local'), { objectClass: ['user'], sAMAccountName: ['alice'] });
    t.addEntry(parseDN('OU=Computers,DC=lab,DC=local'), { objectClass: ['organizationalUnit'] });
    t.addEntry(parseDN('CN=WS01,OU=Computers,DC=lab,DC=local'), { objectClass: ['computer'] });
    return t;
  }

  it('base scope returns only the base entry itself when it matches', () => {
    const t = populated();
    const res = t.search(parseDN('OU=Users,DC=lab,DC=local'), 'base', parseFilter('(objectClass=*)'));
    expect(res).toHaveLength(1);
    expect(formatDN(res[0].dn)).toBe('OU=Users,DC=lab,DC=local');
  });

  it('base scope returns nothing when the base entry does not match the filter', () => {
    const t = populated();
    const res = t.search(parseDN('OU=Users,DC=lab,DC=local'), 'base', parseFilter('(objectClass=user)'));
    expect(res).toHaveLength(0);
  });

  it('one scope returns only immediate children, not grandchildren or the base', () => {
    const t = populated();
    const res = t.search(parseDN('DC=lab,DC=local'), 'one', parseFilter('(objectClass=*)'));
    const dns = res.map(e => formatDN(e.dn)).sort();
    expect(dns).toEqual(['OU=Computers,DC=lab,DC=local', 'OU=Users,DC=lab,DC=local'].sort());
  });

  it('sub scope returns the base and all descendants matching the filter', () => {
    const t = populated();
    const res = t.search(parseDN('OU=Users,DC=lab,DC=local'), 'sub', parseFilter('(objectClass=user)'));
    const dns = res.map(e => formatDN(e.dn)).sort();
    expect(dns).toEqual(['CN=Alice,OU=Users,DC=lab,DC=local', 'CN=Bob,OU=Users,DC=lab,DC=local'].sort());
  });

  it('sub scope with a narrowing equality filter finds one specific entry', () => {
    const t = populated();
    const res = t.search(parseDN('DC=lab,DC=local'), 'sub', parseFilter('(sAMAccountName=bob)'));
    expect(res).toHaveLength(1);
    expect(formatDN(res[0].dn)).toBe('CN=Bob,OU=Users,DC=lab,DC=local');
  });

  it('returns an empty array when the base DN does not exist', () => {
    const t = populated();
    const res = t.search(parseDN('OU=Ghost,DC=lab,DC=local'), 'sub', parseFilter('(objectClass=*)'));
    expect(res).toEqual([]);
  });

  it('compound filters compose correctly across sub-scope search', () => {
    const t = populated();
    const res = t.search(parseDN('DC=lab,DC=local'), 'sub', parseFilter('(&(objectClass=user)(sAMAccountName=alice))'));
    expect(res).toHaveLength(1);
    expect(formatDN(res[0].dn)).toBe('CN=Alice,OU=Users,DC=lab,DC=local');
  });
});

describe('DirectoryTree — compare', () => {
  it('returns true when the value is present (case-insensitively)', () => {
    const t = tree();
    t.addEntry(parseDN('CN=Bob,DC=lab,DC=local'), { sAMAccountName: ['bob'] });
    expect(t.compare(parseDN('CN=Bob,DC=lab,DC=local'), 'sAMAccountName', 'BOB')).toBe('true');
  });

  it('returns false when the value is absent', () => {
    const t = tree();
    t.addEntry(parseDN('CN=Bob,DC=lab,DC=local'), { sAMAccountName: ['bob'] });
    expect(t.compare(parseDN('CN=Bob,DC=lab,DC=local'), 'sAMAccountName', 'eve')).toBe('false');
  });

  it('returns noSuchObject for a nonexistent DN', () => {
    const t = tree();
    expect(t.compare(parseDN('CN=Ghost,DC=lab,DC=local'), 'cn', 'x')).toBe('noSuchObject');
  });
});

describe('DirectoryTree — allDescendants', () => {
  it('returns the base entry plus every descendant, depth-first, regardless of filter', () => {
    const t = tree();
    t.addEntry(parseDN('OU=Users,DC=lab,DC=local'), {});
    t.addEntry(parseDN('CN=Bob,OU=Users,DC=lab,DC=local'), {});
    const all = t.allDescendants(parseDN('DC=lab,DC=local'));
    const dns = all.map(e => formatDN(e.dn)).sort();
    expect(dns).toEqual([
      'CN=Bob,OU=Users,DC=lab,DC=local',
      'DC=lab,DC=local',
      'OU=Users,DC=lab,DC=local',
    ].sort());
  });

  it('returns an empty array for an unknown base DN', () => {
    const t = tree();
    expect(t.allDescendants(parseDN('OU=Ghost,DC=lab,DC=local'))).toEqual([]);
  });
});

describe('DirectoryTree — multi-valued RDNs', () => {
  it('adds and retrieves an entry whose RDN has multiple AVAs joined by +', () => {
    const t = tree();
    const dn = parseDN('CN=Bob+OU=Special,DC=lab,DC=local');
    const res = t.addEntry(dn, { objectClass: ['user'] });
    expect(res.ok).toBe(true);
    expect(t.getByDn(parseDN('OU=Special+CN=Bob,DC=lab,DC=local'))).not.toBeNull();
  });
});
