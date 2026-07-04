/**
 * DirectoryStore — in-memory AD DS directory (PRD-Windows-Server.md §5 P5).
 * One instance per promoted domain (created by `Install-ADDSForest`),
 * owned by the DC's `WindowsServer`. LDAP-lite: DNs are cosmetic strings
 * for display fidelity, not a real queryable tree — search is a flat
 * scan (§2.2 non-goals rule out a full LDAP wire protocol).
 */

import type { AdUser, AdGroup, AdComputer, AdOrgUnit } from './AdTypes';

export interface DirOpResult { ok: boolean; message: string }

export class DirectoryStore {
  private readonly users = new Map<string, AdUser>();
  private readonly groups = new Map<string, AdGroup>();
  private readonly computers = new Map<string, AdComputer>();
  private readonly orgUnits = new Map<string, AdOrgUnit>();

  constructor(
    readonly dnsName: string,
    readonly netbiosName: string,
    adminPassword: string,
  ) {
    this.seedDefaults(adminPassword);
  }

  private get dc(): string {
    return this.dnsName.split('.').map(p => `DC=${p}`).join(',');
  }

  private seedDefaults(adminPassword: string): void {
    this.orgUnits.set('domain controllers', {
      name: 'Domain Controllers', dn: `OU=Domain Controllers,${this.dc}`, gpLinks: [],
    });
    this.groups.set('domain admins', {
      sam: 'Domain Admins', dn: `CN=Domain Admins,CN=Users,${this.dc}`, scope: 'Global', members: ['Administrator'],
    });
    this.groups.set('domain users', {
      sam: 'Domain Users', dn: `CN=Domain Users,CN=Users,${this.dc}`, scope: 'Global', members: ['Administrator'],
    });
    this.groups.set('domain computers', {
      sam: 'Domain Computers', dn: `CN=Domain Computers,CN=Users,${this.dc}`, scope: 'Global', members: [],
    });
    this.users.set('administrator', {
      sam: 'Administrator', upn: `Administrator@${this.dnsName}`,
      dn: `CN=Administrator,CN=Users,${this.dc}`, ou: 'Users',
      enabled: true, password: adminPassword,
      memberOf: ['Domain Admins', 'Domain Users'], fullName: 'Administrator',
    });
  }

  // ─── Organizational Units ───────────────────────────────────────────

  newOrgUnit(name: string): DirOpResult {
    const key = name.toLowerCase();
    if (this.orgUnits.has(key)) return { ok: false, message: 'An object with that name already exists.' };
    this.orgUnits.set(key, { name, dn: `OU=${name},${this.dc}`, gpLinks: [] });
    return { ok: true, message: '' };
  }
  getOrgUnit(name: string): AdOrgUnit | null { return this.orgUnits.get(name.toLowerCase()) ?? null; }
  listOrgUnits(): AdOrgUnit[] { return [...this.orgUnits.values()]; }

  // ─── Users ──────────────────────────────────────────────────────────

  newUser(sam: string, opts: { password: string; fullName?: string; ou?: string; enabled?: boolean }): DirOpResult {
    const key = sam.toLowerCase();
    if (this.users.has(key)) return { ok: false, message: 'An object with that name already exists.' };
    const ou = opts.ou ?? 'Users';
    if (ou !== 'Users' && !this.orgUnits.has(ou.toLowerCase())) {
      return { ok: false, message: `Cannot find an object with identity: '${ou}'.` };
    }
    const container = ou === 'Users' ? `CN=Users,${this.dc}` : `OU=${ou},${this.dc}`;
    this.users.set(key, {
      sam, upn: `${sam}@${this.dnsName}`, dn: `CN=${sam},${container}`, ou,
      enabled: opts.enabled ?? true, password: opts.password,
      memberOf: ['Domain Users'], fullName: opts.fullName ?? '',
    });
    const domainUsers = this.groups.get('domain users');
    if (domainUsers && !domainUsers.members.includes(sam)) domainUsers.members.push(sam);
    return { ok: true, message: '' };
  }

  getUser(sam: string): AdUser | null { return this.users.get(sam.toLowerCase()) ?? null; }
  listUsers(): AdUser[] { return [...this.users.values()]; }

  setUser(sam: string, opts: { enabled?: boolean; fullName?: string; password?: string }): DirOpResult {
    const user = this.users.get(sam.toLowerCase());
    if (!user) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    if (opts.enabled !== undefined) user.enabled = opts.enabled;
    if (opts.fullName !== undefined) user.fullName = opts.fullName;
    if (opts.password !== undefined) user.password = opts.password;
    return { ok: true, message: '' };
  }

  removeUser(sam: string): DirOpResult {
    const key = sam.toLowerCase();
    if (!this.users.has(key)) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    this.users.delete(key);
    for (const g of this.groups.values()) g.members = g.members.filter(m => m.toLowerCase() !== key);
    return { ok: true, message: '' };
  }

  checkPassword(sam: string, password: string): boolean {
    const user = this.users.get(sam.toLowerCase());
    return user !== undefined && user.enabled && user.password === password;
  }

  /** Full transitive set of group SAMs `sam` belongs to (direct only — no nested-group expansion, per LDAP-lite scope). */
  groupsForUser(sam: string): AdGroup[] {
    const user = this.users.get(sam.toLowerCase());
    if (!user) return [];
    return user.memberOf.map(g => this.groups.get(g.toLowerCase())).filter((g): g is AdGroup => g !== undefined);
  }

  // ─── Groups ─────────────────────────────────────────────────────────

  newGroup(sam: string, scope: AdGroup['scope'] = 'Global'): DirOpResult {
    const key = sam.toLowerCase();
    if (this.groups.has(key)) return { ok: false, message: 'An object with that name already exists.' };
    this.groups.set(key, { sam, dn: `CN=${sam},CN=Users,${this.dc}`, scope, members: [] });
    return { ok: true, message: '' };
  }
  getGroup(sam: string): AdGroup | null { return this.groups.get(sam.toLowerCase()) ?? null; }
  listGroups(): AdGroup[] { return [...this.groups.values()]; }

  addGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.groups.get(groupSam.toLowerCase());
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    const user = this.users.get(memberSam.toLowerCase());
    if (!user) return { ok: false, message: `Cannot find an object with identity: '${memberSam}'.` };
    if (!group.members.some(m => m.toLowerCase() === user.sam.toLowerCase())) group.members.push(user.sam);
    if (!user.memberOf.some(g => g.toLowerCase() === group.sam.toLowerCase())) user.memberOf.push(group.sam);
    return { ok: true, message: '' };
  }

  removeGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.groups.get(groupSam.toLowerCase());
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    group.members = group.members.filter(m => m.toLowerCase() !== memberSam.toLowerCase());
    const user = this.users.get(memberSam.toLowerCase());
    if (user) user.memberOf = user.memberOf.filter(g => g.toLowerCase() !== group.sam.toLowerCase());
    return { ok: true, message: '' };
  }

  // ─── Computers ──────────────────────────────────────────────────────

  /** Creates the computer account — the side effect of a successful domain join (P6), or DC promotion for the DC's own account. */
  newComputer(name: string, machineSecret: string): DirOpResult {
    const key = name.toLowerCase();
    if (this.computers.has(key)) return { ok: false, message: 'An object with that name already exists.' };
    this.computers.set(key, {
      name, dn: `CN=${name},CN=Computers,${this.dc}`, machineSecret, enabled: true,
    });
    const domainComputers = this.groups.get('domain computers');
    if (domainComputers && !domainComputers.members.includes(name)) domainComputers.members.push(name);
    return { ok: true, message: '' };
  }

  getComputer(name: string): AdComputer | null { return this.computers.get(name.toLowerCase()) ?? null; }
  listComputers(): AdComputer[] { return [...this.computers.values()]; }

  checkComputerSecret(name: string, secret: string): boolean {
    const computer = this.computers.get(name.toLowerCase());
    return computer !== undefined && computer.enabled && computer.machineSecret === secret;
  }
}
