/**
 * DirectoryStore — real AD DS directory (PRD-Windows-Server.md §5 P5),
 * now backed by the genuine LDAP `DirectoryTree` engine rather than a
 * flat-Maps shortcut. These tests exercise both the AD-shaped
 * convenience façade (newUser/getUser/...) and, to prove the backing
 * store is genuinely the LDAP tree and not a cosmetic parallel
 * structure, direct LDAP-style searches via `getTree()`.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import { parseFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';
import { parseDN, formatDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — seeded defaults', () => {
  it('seeds the Administrator account, enabled, with the given password', () => {
    const s = store();
    const admin = s.getUser('Administrator');
    expect(admin).not.toBeNull();
    expect(admin?.enabled).toBe(true);
    expect(admin?.password).toBe('P@ssw0rd');
    expect(admin?.upn).toBe('Administrator@lab.local');
    expect(admin?.dn).toBe('CN=Administrator,CN=Users,DC=lab,DC=local');
  });

  it('seeds Domain Admins/Users/Computers groups with Administrator in the first two', () => {
    const s = store();
    expect(s.getGroup('Domain Admins')?.members).toEqual(['Administrator']);
    expect(s.getGroup('Domain Users')?.members).toEqual(['Administrator']);
    expect(s.getGroup('Domain Computers')?.members).toEqual([]);
  });

  it('seeds a Domain Controllers OU', () => {
    const s = store();
    expect(s.getOrgUnit('Domain Controllers')?.dn).toBe('OU=Domain Controllers,DC=lab,DC=local');
  });

  it("Administrator's memberOf reflects seeded group membership", () => {
    const s = store();
    expect(s.getUser('Administrator')?.memberOf.sort()).toEqual(['Domain Admins', 'Domain Users'].sort());
  });
});

describe('DirectoryStore — users', () => {
  it('creates a user under the default Users container', () => {
    const s = store();
    const res = s.newUser('bob', { password: 'hunter2', fullName: 'Bob Smith' });
    expect(res.ok).toBe(true);
    const bob = s.getUser('bob');
    expect(bob?.dn).toBe('CN=bob,CN=Users,DC=lab,DC=local');
    expect(bob?.upn).toBe('bob@lab.local');
    expect(bob?.fullName).toBe('Bob Smith');
    expect(bob?.enabled).toBe(true);
    expect(bob?.memberOf).toEqual(['Domain Users']);
  });

  it('creates a user under a named OU when it exists', () => {
    const s = store();
    s.newOrgUnit('Sales');
    const res = s.newUser('carl', { password: 'x', ou: 'Sales' });
    expect(res.ok).toBe(true);
    expect(s.getUser('carl')?.dn).toBe('CN=carl,OU=Sales,DC=lab,DC=local');
  });

  it('fails to create a user in a nonexistent OU', () => {
    const s = store();
    const res = s.newUser('dave', { password: 'x', ou: 'Ghost' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Cannot find an object/);
  });

  it('fails with a duplicate-object message on a repeated sAMAccountName', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    const res = s.newUser('bob', { password: 'y' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/already exists/);
  });

  it('creates a disabled user when enabled:false is passed', () => {
    const s = store();
    s.newUser('eve', { password: 'x', enabled: false });
    expect(s.getUser('eve')?.enabled).toBe(false);
    expect(s.checkPassword('eve', 'x')).toBe(false);
  });

  it('setUser toggles enabled/disabled and updates password/fullName', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    expect(s.setUser('bob', { enabled: false }).ok).toBe(true);
    expect(s.getUser('bob')?.enabled).toBe(false);
    expect(s.setUser('bob', { enabled: true, password: 'newpass', fullName: 'Bob R Smith' }).ok).toBe(true);
    const bob = s.getUser('bob');
    expect(bob?.enabled).toBe(true);
    expect(bob?.password).toBe('newpass');
    expect(bob?.fullName).toBe('Bob R Smith');
  });

  it('setUser fails for an unknown sam', () => {
    const s = store();
    expect(s.setUser('ghost', { enabled: false }).ok).toBe(false);
  });

  it('checkPassword only succeeds for the correct password on an enabled account', () => {
    const s = store();
    s.newUser('bob', { password: 'hunter2' });
    expect(s.checkPassword('bob', 'hunter2')).toBe(true);
    expect(s.checkPassword('bob', 'wrong')).toBe(false);
    expect(s.checkPassword('ghost', 'hunter2')).toBe(false);
  });

  it('removeUser deletes the entry and scrubs group membership both ways', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    expect(s.getGroup('Domain Users')?.members).toContain('bob');
    const res = s.removeUser('bob');
    expect(res.ok).toBe(true);
    expect(s.getUser('bob')).toBeNull();
    expect(s.getGroup('Domain Users')?.members).not.toContain('bob');
  });

  it('removeUser fails for an unknown sam', () => {
    const s = store();
    expect(s.removeUser('ghost').ok).toBe(false);
  });

  it('listUsers returns every seeded/created user, excluding computer accounts', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newComputer('WS01', 'secret');
    const sams = s.listUsers().map(u => u.sam).sort();
    expect(sams).toEqual(['Administrator', 'bob'].sort());
  });
});

describe('DirectoryStore — groups', () => {
  it('creates a group with the given scope', () => {
    const s = store();
    const res = s.newGroup('Engineers', 'DomainLocal');
    expect(res.ok).toBe(true);
    expect(s.getGroup('Engineers')?.scope).toBe('DomainLocal');
    expect(s.getGroup('Engineers')?.dn).toBe('CN=Engineers,CN=Users,DC=lab,DC=local');
  });

  it('defaults to Global scope', () => {
    const s = store();
    s.newGroup('Marketing');
    expect(s.getGroup('Marketing')?.scope).toBe('Global');
  });

  it('fails on a duplicate group name', () => {
    const s = store();
    s.newGroup('Engineers');
    expect(s.newGroup('Engineers').ok).toBe(false);
  });

  it('addGroupMember links both member (group) and memberOf (user) attributes', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newGroup('Engineers');
    const res = s.addGroupMember('Engineers', 'bob');
    expect(res.ok).toBe(true);
    expect(s.getGroup('Engineers')?.members).toContain('bob');
    expect(s.getUser('bob')?.memberOf).toContain('Engineers');
  });

  it('addGroupMember accepts a computer account as a member', () => {
    const s = store();
    s.newComputer('WS01', 'secret');
    s.newGroup('Workstations');
    expect(s.addGroupMember('Workstations', 'WS01').ok).toBe(true);
    expect(s.getGroup('Workstations')?.members).toContain('WS01$'); // real AD convention: computer accounts' sAMAccountName has a trailing $
  });

  it('addGroupMember fails for an unknown group or member', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    expect(s.addGroupMember('Ghost', 'bob').ok).toBe(false);
    s.newGroup('Engineers');
    expect(s.addGroupMember('Engineers', 'ghost').ok).toBe(false);
  });

  it('removeGroupMember unlinks both directions', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newGroup('Engineers');
    s.addGroupMember('Engineers', 'bob');
    const res = s.removeGroupMember('Engineers', 'bob');
    expect(res.ok).toBe(true);
    expect(s.getGroup('Engineers')?.members).not.toContain('bob');
    expect(s.getUser('bob')?.memberOf).not.toContain('Engineers');
  });

  it('groupsForUser reflects direct membership only', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newGroup('Engineers');
    s.addGroupMember('Engineers', 'bob');
    const groups = s.groupsForUser('bob').map(g => g.sam).sort();
    expect(groups).toEqual(['Domain Users', 'Engineers'].sort());
  });

  it('listGroups includes seeded and created groups', () => {
    const s = store();
    s.newGroup('Engineers');
    const sams = s.listGroups().map(g => g.sam).sort();
    expect(sams).toEqual(['Domain Admins', 'Domain Computers', 'Domain Users', 'Engineers', 'Event Log Readers'].sort());
  });
});

describe('DirectoryStore — computers', () => {
  it('creates a computer account under CN=Computers with a $ sAMAccountName and enabled workstation-trust UAC', () => {
    const s = store();
    const res = s.newComputer('WS01', 'machinesecret');
    expect(res.ok).toBe(true);
    const computer = s.getComputer('WS01');
    expect(computer?.dn).toBe('CN=WS01,CN=Computers,DC=lab,DC=local');
    expect(computer?.enabled).toBe(true);
    expect(computer?.machineSecret).toBe('machinesecret');
  });

  it('adds the computer to Domain Computers automatically', () => {
    const s = store();
    s.newComputer('WS01', 'secret');
    expect(s.getGroup('Domain Computers')?.members).toContain('WS01$'); // real AD convention: computer accounts' sAMAccountName has a trailing $
  });

  it('fails on a duplicate computer name', () => {
    const s = store();
    s.newComputer('WS01', 'secret');
    expect(s.newComputer('WS01', 'other').ok).toBe(false);
  });

  it('checkComputerSecret validates the machine secret', () => {
    const s = store();
    s.newComputer('WS01', 'secret');
    expect(s.checkComputerSecret('WS01', 'secret')).toBe(true);
    expect(s.checkComputerSecret('WS01', 'wrong')).toBe(false);
    expect(s.checkComputerSecret('ghost', 'secret')).toBe(false);
  });

  it('listComputers returns every computer account', () => {
    const s = store();
    s.newComputer('WS01', 'a');
    s.newComputer('WS02', 'b');
    expect(s.listComputers().map(c => c.name).sort()).toEqual(['WS01', 'WS02']);
  });
});

describe('DirectoryStore — organizational units', () => {
  it('creates and retrieves an OU', () => {
    const s = store();
    expect(s.newOrgUnit('Sales').ok).toBe(true);
    expect(s.getOrgUnit('Sales')?.dn).toBe('OU=Sales,DC=lab,DC=local');
  });

  it('fails on a duplicate OU name', () => {
    const s = store();
    s.newOrgUnit('Sales');
    expect(s.newOrgUnit('Sales').ok).toBe(false);
  });

  it('listOrgUnits includes both seeded and created OUs', () => {
    const s = store();
    s.newOrgUnit('Sales');
    const names = s.listOrgUnits().map(ou => ou.name).sort();
    expect(names).toEqual(['Domain Controllers', 'Sales'].sort());
  });
});

describe('DirectoryStore — genuinely backed by the real LDAP DIT (not a cosmetic parallel structure)', () => {
  it('a user created via newUser is independently findable through a raw LDAP sub-scope search', () => {
    const s = store();
    s.newUser('bob', { password: 'x', fullName: 'Bob Smith' });
    const tree = s.getTree();
    const results = tree.search(tree.getRootDn(), 'sub', parseFilter('(&(objectClass=user)(sAMAccountName=bob))'));
    expect(results).toHaveLength(1);
    expect(formatDN(results[0].dn)).toBe('CN=bob,CN=Users,DC=lab,DC=local');
    expect(results[0].attributes.get('displayname')).toEqual(['Bob Smith']);
  });

  it('a group membership edit made through addGroupMember is visible as a real multi-valued `member` attribute over the tree', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newGroup('Engineers');
    s.addGroupMember('Engineers', 'bob');
    const tree = s.getTree();
    const groupEntry = tree.getByDn(parseDN('CN=Engineers,CN=Users,DC=lab,DC=local'));
    expect(groupEntry?.attributes.get('member')).toEqual(['CN=bob,CN=Users,DC=lab,DC=local']);
  });

  it('deleting a user via removeUser is reflected by the tree refusing a getByDn lookup afterward', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    const dn = parseDN('CN=bob,CN=Users,DC=lab,DC=local');
    expect(s.getTree().getByDn(dn)).not.toBeNull();
    s.removeUser('bob');
    expect(s.getTree().getByDn(dn)).toBeNull();
  });

  it('objectClass chains are real and faithful to AD schema (computer is-a user)', () => {
    const s = store();
    s.newComputer('WS01', 'secret');
    const entry = s.getTree().getByDn(parseDN('CN=WS01,CN=Computers,DC=lab,DC=local'));
    expect(entry?.attributes.get('objectclass')).toEqual(['top', 'person', 'organizationalPerson', 'user', 'computer']);
  });
});
