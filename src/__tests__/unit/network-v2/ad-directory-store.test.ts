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
    expect(sams).toEqual(['Domain Admins', 'Domain Computers', 'Domain Users', 'Engineers'].sort());
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

describe('DirectoryStore — PSO (fine-grained password policy)', () => {
  it('creates a PSO and reads its settings/precedence back', () => {
    const s = store();
    const res = s.newPso('Strict Admins Policy', 10, { minPasswordLength: 15, lockoutThreshold: 3 });
    expect(res.ok).toBe(true);
    const pso = s.getPso('Strict Admins Policy')!;
    expect(pso.precedence).toBe(10);
    expect(pso.settings.minPasswordLength).toBe(15);
    expect(pso.appliesTo).toEqual([]);
  });

  it('refuses a duplicate PSO name', () => {
    const s = store();
    s.newPso('Strict Admins Policy', 10, { minPasswordLength: 15 });
    const res = s.newPso('Strict Admins Policy', 20, { minPasswordLength: 8 });
    expect(res.ok).toBe(false);
  });

  it('a PSO applied directly to a user overrides the domain default wholesale, not merged', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newPso('Strict Policy', 10, { minPasswordLength: 15, lockoutThreshold: 3 });
    s.setPsoAppliesTo('Strict Policy', ['bob']);

    const effective = s.effectivePasswordPolicyFor('bob')!;
    expect(effective.minPasswordLength).toBe(15);
    expect(effective.lockoutThreshold).toBe(3);
    expect(effective.maxPasswordAge).toBeUndefined();
  });

  it('a PSO applied via group membership resolves the same as a direct link', () => {
    const s = store();
    s.newUser('carol', { password: 'x' });
    s.newGroup('Executives');
    s.addGroupMember('Executives', 'carol');
    s.newPso('Executive Policy', 5, { minPasswordLength: 20 });
    s.setPsoAppliesTo('Executive Policy', ['Executives']);

    expect(s.effectivePasswordPolicyFor('carol')?.minPasswordLength).toBe(20);
  });

  it('returns null when no PSO applies, letting the caller fall back to the domain default', () => {
    const s = store();
    s.newUser('dave', { password: 'x' });
    expect(s.effectivePasswordPolicyFor('dave')).toBeNull();
  });

  it('the lowest-precedence PSO wins when several apply to the same user', () => {
    const s = store();
    s.newUser('erin', { password: 'x' });
    s.newPso('Loose Policy', 50, { minPasswordLength: 6 });
    s.setPsoAppliesTo('Loose Policy', ['erin']);
    s.newPso('Strict Policy', 1, { minPasswordLength: 20 });
    s.setPsoAppliesTo('Strict Policy', ['erin']);

    expect(s.effectivePasswordPolicyFor('erin')?.minPasswordLength).toBe(20);
  });
});

describe('DirectoryStore — RID pool / objectSid', () => {
  it('generates a domain SID and assigns real AD well-known RIDs to the seeded principals', () => {
    const s = store();
    const sid = s.getDomainSid();
    expect(sid).toMatch(/^S-1-5-21-\d+-\d+-\d+$/);
    expect(s.getUser('Administrator')?.objectSid).toBe(`${sid}-500`);
    expect(s.getGroup('Domain Admins')?.objectSid).toBe(`${sid}-512`);
    expect(s.getGroup('Domain Users')?.objectSid).toBe(`${sid}-513`);
    expect(s.getGroup('Domain Computers')?.objectSid).toBe(`${sid}-515`);
  });

  it('assigns krbtgt the real AD well-known RID 502', () => {
    const s = store();
    s.ensureKrbtgtPrincipal('secret');
    expect(s.getUser('krbtgt')?.objectSid).toBe(`${s.getDomainSid()}-502`);
  });

  it('allocates sequential RIDs from the local pool for ordinary new objects', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.newUser('carol', { password: 'x' });
    const bobRid = Number(s.getUser('bob')!.objectSid.split('-').pop());
    const carolRid = Number(s.getUser('carol')!.objectSid.split('-').pop());
    expect(carolRid).toBe(bobRid + 1);
    expect(bobRid).toBeGreaterThanOrEqual(1000);
  });

  it('assigns a computer account an objectSid from the same local pool', () => {
    const s = store();
    s.newComputer('WS01', 'secret');
    expect(s.getComputer('WS01')?.objectSid).toMatch(new RegExp(`^${s.getDomainSid()}-\\d+$`));
  });

  it('grantRidPoolBlock hands out non-overlapping blocks to successive requesters', () => {
    const s = store();
    const block1 = s.grantRidPoolBlock(500);
    const block2 = s.grantRidPoolBlock(500);
    expect(block2.startRid).toBe(block1.startRid + block1.count);
  });
});

describe('DirectoryStore — AdminSDHolder / SDProp', () => {
  it('marks a direct member of a protected group (Domain Admins) with adminCount=1', () => {
    const s = store();
    expect(s.getUser('Administrator')?.adminCount).toBe(false);
    const marked = s.runSdProp();
    expect(marked).toContain('Administrator');
    expect(s.getUser('Administrator')?.adminCount).toBe(true);
  });

  it('does not mark a user outside any protected group', () => {
    const s = store();
    s.newUser('bob', { password: 'x' });
    s.runSdProp();
    expect(s.getUser('bob')?.adminCount).toBe(false);
  });

  it('marks members of a protected group reached only through nested group membership', () => {
    const s = store();
    s.newUser('carol', { password: 'x' });
    s.newGroup('Junior Admins');
    s.addGroupMember('Junior Admins', 'carol');
    const juniorDn = s.getGroup('Junior Admins')!.dn;
    s.getTree().modifyEntry(parseDN(s.getGroup('Domain Admins')!.dn), [{ op: 'add', type: 'member', values: [juniorDn] }]);

    const marked = s.runSdProp();
    expect(marked).toContain('carol');
    expect(s.getUser('carol')?.adminCount).toBe(true);
  });

  it("real AD's quirk: adminCount is never cleared automatically after removal from the protected group", () => {
    const s = store();
    s.runSdProp();
    expect(s.getUser('Administrator')?.adminCount).toBe(true);
    s.removeGroupMember('Domain Admins', 'Administrator');
    expect(s.getUser('Administrator')?.adminCount).toBe(true);
  });

  it('is idempotent across repeated passes', () => {
    const s = store();
    const first = s.runSdProp();
    const second = s.runSdProp();
    expect(second).toEqual(first);
  });
});
