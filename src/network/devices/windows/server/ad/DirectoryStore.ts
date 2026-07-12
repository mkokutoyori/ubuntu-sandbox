/**
 * DirectoryStore — real AD DS directory (PRD-Windows-Server.md §5 P5),
 * backed by the genuine LDAP `DirectoryTree` engine (RFC 4511 DIT) rather
 * than a flat-Maps shortcut: every user/group/computer/OU is a real entry
 * at a real DN, with real AD schema attributes (objectClass chains,
 * sAMAccountName, userPrincipalName, userAccountControl bit flags,
 * groupType bit flags, member/memberOf linked attributes). One instance
 * per promoted domain (created by `Install-ADDSForest`), owned by the
 * DC's `WindowsServer`.
 *
 * `newUser`/`getUser`/`newGroup`/etc. are a convenience façade projecting
 * `DirectoryEntry` attributes to/from the plain `AdUser`/`AdGroup`/...
 * shapes AD cmdlets consume — `getTree()` exposes the real tree directly
 * so `LdapServerHandler` can serve the very same data over TCP/389 to a
 * genuine LDAP client.
 */

import { DirectoryTree, type DirectoryEntry, type EntryReplMeta } from './ldap/DirectoryTree';
import { parseDN, formatDN, leafValue, type DistinguishedName } from './ldap/LdapDN';
import type { LdapBindCheck } from './ldap/LdapServer';
import type { AdUser, AdGroup, AdComputer, AdOrgUnit, Gpo, GpoSettings, GpoAccountPolicy, PasswordSettingsObject } from './AdTypes';
import { generateId } from '@/network/core/types';
import {
  type HighWatermarkVector, emptyHighWatermarkVector, recordUsn, cloneHighWatermarkVector,
} from './replication/HighWatermarkVector';
import { SiteRegistry, type SiteOpResult, type SiteInfo } from './forest/sites';
import { SchemaValidator } from './schema/SchemaValidator';
import { SchemaPartition, seedDefaultSchema } from './schema/SchemaPartition';
import type { AttributeSchema, ObjectClassSchema, SchemaOpResult } from './schema/SchemaValidator';
import { TrustRegistry, type TrustDirection, type TrustOpResult, type TrustInfo, type TrustRecord } from './forest/TrustRelationship';
import { GpoStore } from './gpo/GpoStore';
import { PsoStore } from './pso/PsoStore';
import { DomainFsmoRoles, type DomainFsmoRole } from './fsmo/FsmoRoles';

export interface DirOpResult { ok: boolean; message: string }

/** RFC-faithful AD userAccountControl bit flags (the subset this simulator needs). */
const UAC = {
  ACCOUNTDISABLE: 0x0002,
  NORMAL_ACCOUNT: 0x0200,
  WORKSTATION_TRUST_ACCOUNT: 0x1000,
  SERVER_TRUST_ACCOUNT: 0x2000,
} as const;

/** Real AD groupType bit-flag values (security groups only — no distribution-group support). */
const GROUP_TYPE: Record<AdGroup['scope'], number> = {
  Global: -2147483646,
  DomainLocal: -2147483644,
  Universal: -2147483640,
};
const SCOPE_OF_GROUP_TYPE = new Map<number, AdGroup['scope']>(
  (Object.keys(GROUP_TYPE) as AdGroup['scope'][]).map(scope => [GROUP_TYPE[scope], scope]),
);

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }
function isEnabledFromUac(values: string[] | undefined): boolean {
  const uac = Number(firstOf(values));
  return Number.isFinite(uac) && (uac & UAC.ACCOUNTDISABLE) === 0;
}
function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}
/** Drop attribute keys with no values so we don't materialize empty multi-valued attributes on the entry. */
function compact(attrs: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.length > 0));
}

export class DirectoryStore {
  private readonly tree: DirectoryTree;
  private readonly usersOuDn: DistinguishedName;
  private readonly computersOuDn: DistinguishedName;
  private readonly policiesDn: DistinguishedName;
  /** This DC's stable replication identity (PRD-Windows-Server-Advanced.md §5 P4, MS-DRSR's invocationId) — one per `DirectoryStore` instance, for its whole lifetime. */
  private readonly invocationId = `invocation-${generateId()}`;
  private localUsn = 0;
  /** Highest USN already absorbed from each other known DC, via any replication partner — advances as `applyReplicatedEntry` runs. */
  private readonly inboundHighWatermark: HighWatermarkVector = emptyHighWatermarkVector();
  private readonly sites: SiteRegistry;
  private readonly schemaValidator: SchemaValidator;
  private readonly schema: SchemaPartition;
  private readonly trustRegistry: TrustRegistry;
  private readonly gpoStore: GpoStore;
  private readonly psoStore: PsoStore;
  private readonly fsmoRoles: DomainFsmoRoles;

  /**
   * `opts.skipSeed` (PRD-Windows-Server-Advanced.md §5 P5): an additional
   * DC joining an *existing* domain (`Install-ADDSDomainController`) must
   * not independently create its own Users/Computers OUs and default
   * groups — those already exist on the domain and would replicate in as
   * duplicates. It instead starts with an empty tree and relies entirely
   * on the initial replication sync (§5 P4) to populate everything,
   * exactly like real DCPromo's initial-sync-from-a-source-DC step.
   */
  constructor(
    readonly dnsName: string,
    readonly netbiosName: string,
    adminPassword: string,
    opts: { skipSeed?: boolean; sharedSchemaValidator?: SchemaValidator } = {},
  ) {
    const rootDn = parseDN(this.dnsName.split('.').map(p => `DC=${p}`).join(','));
    this.schemaValidator = opts.sharedSchemaValidator ?? new SchemaValidator();
    this.tree = new DirectoryTree(rootDn, { objectClass: ['top', 'domain', 'domainDNS'] }, {
      invocationId: this.invocationId, nextUsn: () => ++this.localUsn,
    }, this.schemaValidator);
    this.usersOuDn = [...parseDN('CN=Users'), ...rootDn];
    this.computersOuDn = [...parseDN('CN=Computers'), ...rootDn];
    this.policiesDn = [...parseDN('CN=Policies'), ...parseDN('CN=System'), ...rootDn];
    this.sites = new SiteRegistry(this.tree);
    this.schema = new SchemaPartition(this.tree, this.schemaValidator);
    this.trustRegistry = new TrustRegistry(this.tree);
    this.gpoStore = new GpoStore(this.tree);
    this.psoStore = new PsoStore(this.tree);
    this.fsmoRoles = new DomainFsmoRoles(this.tree, rootDn);
    if (!opts.skipSeed) {
      // A shared validator (PRD §5 P8 — a child domain joining an existing
      // forest) is already seeded by its forest root; seeding again would
      // just hit harmless-but-noisy "already exists" errors.
      if (!opts.sharedSchemaValidator) seedDefaultSchema(this.schema);
      this.seedDefaults(adminPassword);
    }
  }

  // ─── Schema (PRD-Windows-Server-Advanced.md §5 P7) ─────────────────────

  newAttribute(schema: AttributeSchema): SchemaOpResult { return this.schema.newAttribute(schema); }
  newObjectClass(schema: ObjectClassSchema): SchemaOpResult { return this.schema.newObjectClass(schema); }
  listSchemaAttributes(): AttributeSchema[] { return this.schema.listAttributes(); }
  listSchemaObjectClasses(): ObjectClassSchema[] { return this.schema.listObjectClasses(); }
  /** The live schema validator — shared by reference across every domain of a forest (§5 P8). */
  getSchemaValidatorForSharing(): SchemaValidator { return this.schemaValidator; }

  // ─── Sites (PRD-Windows-Server-Advanced.md §5 P6) ──────────────────────

  newSite(name: string): SiteOpResult { return this.sites.newSite(name); }
  listSites(): SiteInfo[] { return this.sites.listSites(); }
  newSubnet(cidr: string, siteName: string): SiteOpResult { return this.sites.newSubnet(cidr, siteName); }
  /** The name of the site whose subnet contains `ip`, or null if none does (§2.2 scope — no fallback-site guessing). */
  siteForIp(ip: string): string | null { return this.sites.siteForIp(ip); }

  // ─── Trusts (PRD-Windows-Server-Advanced.md §5 P9) ─────────────────────

  addTrust(remoteRealm: string, direction: TrustDirection, transitive: boolean, interrealmKey: string): TrustOpResult {
    return this.trustRegistry.addTrust(remoteRealm, direction, transitive, interrealmKey);
  }
  getTrust(remoteRealm: string): TrustRecord | null { return this.trustRegistry.getTrust(remoteRealm); }
  listTrusts(): TrustInfo[] { return this.trustRegistry.listTrusts(); }

  /** The domain root's DN — the default `New-GPLink -Target` for a domain-wide policy (Default Domain Policy). */
  getDomainDn(): string { return formatDN(this.tree.getRootDn()); }

  /** Kerberos realm name (RFC 4120 §6.1: the DNS domain name, uppercased) — used by `KdcSession`/`KerberosClient`. */
  getRealm(): string { return this.dnsName.toUpperCase(); }

  /** The real DIT this store operates on — `LdapServerHandler` serves this same tree over TCP/389. */
  getTree(): DirectoryTree { return this.tree; }

  // ─── Multi-DC replication (PRD-Windows-Server-Advanced.md §5 P4) ──────

  getInvocationId(): string { return this.invocationId; }
  getLocalUsn(): number { return this.localUsn; }

  /** The vector to send a replication partner: what this DC already knows, from itself and from every other DC it's absorbed via replication — so the partner only returns genuinely new objects. */
  getOutboundHighWatermark(): HighWatermarkVector {
    const vector = cloneHighWatermarkVector(this.inboundHighWatermark);
    recordUsn(vector, this.invocationId, this.localUsn);
    return vector;
  }

  /** Every local entry a partner requesting `partnerVector` hasn't seen yet. */
  changesSince(partnerVector: HighWatermarkVector): DirectoryEntry[] {
    return this.tree.changedSince(partnerVector);
  }

  /** Applies one entry pulled from a replication partner and advances this DC's record of how caught-up it is with that entry's originating DC. */
  applyReplicatedEntry(dn: string, attributes: Record<string, string[]>, stamp: EntryReplMeta): void {
    let parsed: DistinguishedName;
    try { parsed = parseDN(dn); } catch { return; }
    this.tree.applyReplicatedEntry(parsed, attributes, stamp);
    recordUsn(this.inboundHighWatermark, stamp.originatingInvocationId, stamp.originatingUsn);
  }

  /** Resolves an OU by name (`"Sales"`) or nested path (`"Sales/EU"`, top-down, matching `New-ADOrganizationalUnit -Path`'s parent-first convention). */
  private ouDn(path: string): DistinguishedName {
    const segments = path.split('/').filter(s => s.length > 0);
    const rdns = segments.map(seg => parseDN(`OU=${seg}`)[0]).reverse();
    return [...rdns, ...this.tree.getRootDn()];
  }
  private cnDn(cn: string, containerDn: DistinguishedName): DistinguishedName { return [...parseDN(`CN=${cn}`), ...containerDn]; }
  private computerDn(name: string): DistinguishedName { return this.cnDn(name, this.computersOuDn); }

  private seedDefaults(adminPassword: string): void {
    this.tree.addEntry(this.usersOuDn, { objectClass: ['top', 'container'], cn: ['Users'] });
    this.tree.addEntry(this.computersOuDn, { objectClass: ['top', 'container'], cn: ['Computers'] });
    this.tree.addEntry(this.ouDn('Domain Controllers'), { objectClass: ['top', 'organizationalUnit'], ou: ['Domain Controllers'] });
    this.tree.addEntry([...parseDN('CN=System'), ...this.tree.getRootDn()], { objectClass: ['top', 'container'], cn: ['System'] });
    this.tree.addEntry(this.policiesDn, { objectClass: ['top', 'container'], cn: ['Policies'] });

    this.createGroupEntry('Domain Admins', 'Global', this.usersOuDn);
    this.createGroupEntry('Domain Users', 'Global', this.usersOuDn);
    this.createGroupEntry('Domain Computers', 'Global', this.usersOuDn);

    this.createUserEntry('Administrator', { password: adminPassword, fullName: 'Administrator', containerDn: this.usersOuDn });
    this.addGroupMember('Domain Admins', 'Administrator');
    this.addGroupMember('Domain Users', 'Administrator');
  }

  // ─── Organizational Units ───────────────────────────────────────────

  newOrgUnit(path: string): DirOpResult {
    const segments = path.split('/').filter(s => s.length > 0);
    const leafName = segments[segments.length - 1] ?? path;
    const res = this.tree.addEntry(this.ouDn(path), { objectClass: ['top', 'organizationalUnit'], ou: [leafName] });
    if (res.ok) return { ok: true, message: '' };
    if (res.message.startsWith('noSuchObject')) return { ok: false, message: `Cannot find an object with identity: parent of '${path}'.` };
    return { ok: false, message: 'An object with that name already exists.' };
  }

  getOrgUnit(path: string): AdOrgUnit | null {
    const entry = this.tree.getByDn(this.ouDn(path));
    return entry ? this.projectOrgUnit(entry) : null;
  }

  listOrgUnits(): AdOrgUnit[] {
    return this.tree.allDescendants(this.tree.getRootDn())
      .filter(e => hasObjectClass(e, 'organizationalUnit'))
      .map(e => this.projectOrgUnit(e));
  }

  private projectOrgUnit(entry: DirectoryEntry): AdOrgUnit {
    return { name: firstOf(entry.attributes.get('ou')), dn: formatDN(entry.dn), gpLinks: entry.attributes.get('gplink') ?? [] };
  }

  // ─── Group Policy Objects (PRD-Windows-Server.md §5 P10) ────────────

  newGpo(name: string): DirOpResult { return this.gpoStore.newGpo(name); }
  getGpo(name: string): Gpo | null { return this.gpoStore.getGpo(name); }
  listGpos(): Gpo[] { return this.gpoStore.listGpos(); }
  setGpoSettings(name: string, settings: GpoSettings): DirOpResult { return this.gpoStore.setGpoSettings(name, settings); }
  setGpoSecurityFiltering(name: string, principals: string[]): DirOpResult { return this.gpoStore.setGpoSecurityFiltering(name, principals); }
  newGPLink(gpoName: string, targetDn: string): DirOpResult { return this.gpoStore.newGPLink(gpoName, targetDn); }

  resultantSetOfPolicy(computerName?: string): { appliedGpoNames: string[]; settings: GpoSettings } {
    return this.gpoStore.resultantSetOfPolicy(computerName ? this.findComputerEntry(computerName) : null);
  }

  // ─── Fine-grained password policy (PSO) ─────────────────────────────

  newPso(name: string, precedence: number, settings: GpoAccountPolicy): DirOpResult { return this.psoStore.newPso(name, precedence, settings); }
  getPso(name: string): PasswordSettingsObject | null { return this.psoStore.getPso(name); }
  listPsos(): PasswordSettingsObject[] { return this.psoStore.listPsos(); }
  setPsoAppliesTo(name: string, principals: string[]): DirOpResult { return this.psoStore.setPsoAppliesTo(name, principals); }

  /** The winning PSO's settings for `userSam`, or `null` if none applies (caller falls back to the domain default `GpoAccountPolicy`). */
  effectivePasswordPolicyFor(userSam: string): GpoAccountPolicy | null {
    const user = this.findUserEntry(userSam);
    return user ? this.psoStore.effectivePasswordPolicyFor(user) : null;
  }

  // ─── FSMO roles (domain-wide: RID Master / PDC Emulator / Infrastructure Master) ────

  getFsmoRoleOwner(role: DomainFsmoRole): string | null { return this.fsmoRoles.getOwner(role); }
  /** Called once by `WindowsServer` right after promoting the first DC of a (forest-root or child) domain — never for an additional DC, which inherits ownership via its initial replication sync instead. */
  seedFsmoRoles(hostname: string): void { this.fsmoRoles.seedAllTo(hostname); }
  seizeFsmoRole(role: DomainFsmoRole, newOwnerHostname: string): void { this.fsmoRoles.seize(role, newOwnerHostname); }

  // ─── Users ──────────────────────────────────────────────────────────

  newUser(sam: string, opts: { password: string; fullName?: string; ou?: string; enabled?: boolean }): DirOpResult {
    const containerDn = opts.ou ? this.ouDn(opts.ou) : this.usersOuDn;
    if (opts.ou && !this.tree.getByDn(containerDn)) {
      return { ok: false, message: `Cannot find an object with identity: '${opts.ou}'.` };
    }
    const res = this.createUserEntry(sam, { password: opts.password, fullName: opts.fullName ?? '', containerDn, enabled: opts.enabled });
    if (!res.ok) return res;
    this.addGroupMember('Domain Users', sam);
    return { ok: true, message: '' };
  }

  private createUserEntry(sam: string, opts: { password: string; fullName: string; containerDn: DistinguishedName; enabled?: boolean }): DirOpResult {
    const enabled = opts.enabled ?? true;
    const res = this.tree.addEntry(this.cnDn(sam, opts.containerDn), compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: [sam],
      sAMAccountName: [sam],
      userPrincipalName: [`${sam}@${this.dnsName}`],
      userAccountControl: [String(enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE)],
      userPassword: [opts.password],
      displayName: opts.fullName ? [opts.fullName] : [],
    }));
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  private findUserEntry(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam })
      .filter(e => hasObjectClass(e, 'user') && !hasObjectClass(e, 'computer'));
    return entry ?? null;
  }

  getUser(sam: string): AdUser | null {
    const entry = this.findUserEntry(sam);
    return entry ? this.projectUser(entry) : null;
  }

  listUsers(): AdUser[] {
    return this.tree.allDescendants(this.tree.getRootDn())
      .filter(e => hasObjectClass(e, 'user') && !hasObjectClass(e, 'computer'))
      .map(e => this.projectUser(e));
  }

  private projectUser(entry: DirectoryEntry): AdUser {
    const containerDn = entry.dn.slice(1);
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      upn: firstOf(entry.attributes.get('userprincipalname')),
      dn: formatDN(entry.dn),
      ou: dnEqualsOu(containerDn, this.usersOuDn) ? 'Users' : firstOf(entry.attributes.get('ou')) || leafOuName(containerDn),
      enabled: isEnabledFromUac(entry.attributes.get('useraccountcontrol')),
      password: firstOf(entry.attributes.get('userpassword')),
      memberOf: (entry.attributes.get('memberof') ?? []).map(dnStr => this.samOfDn(dnStr)).filter((s): s is string => s !== null),
      fullName: firstOf(entry.attributes.get('displayname')),
    };
  }

  setUser(sam: string, opts: { enabled?: boolean; fullName?: string; password?: string }): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    const changes: { op: 'replace'; type: string; values: string[] }[] = [];
    if (opts.enabled !== undefined) {
      changes.push({ op: 'replace', type: 'userAccountControl', values: [String(opts.enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE)] });
    }
    if (opts.fullName !== undefined) changes.push({ op: 'replace', type: 'displayName', values: opts.fullName ? [opts.fullName] : [] });
    if (opts.password !== undefined) changes.push({ op: 'replace', type: 'userPassword', values: [opts.password] });
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  removeUser(sam: string): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    const userDn = formatDN(entry.dn);
    for (const group of this.listGroupEntries()) {
      if ((group.attributes.get('member') ?? []).some(m => m.toLowerCase() === userDn.toLowerCase())) {
        this.tree.modifyEntry(group.dn, [{ op: 'delete', type: 'member', values: [userDn] }]);
      }
    }
    const res = this.tree.deleteEntry(entry.dn);
    return res.ok ? { ok: true, message: '' } : { ok: false, message: res.message };
  }

  checkPassword(sam: string, password: string): boolean {
    const entry = this.findUserEntry(sam);
    if (!entry) return false;
    return isEnabledFromUac(entry.attributes.get('useraccountcontrol')) && firstOf(entry.attributes.get('userpassword')) === password;
  }

  /** The user's (or krbtgt's) long-term secret — for `KdcSession` to derive the client's/service's Kerberos key from, not for authentication (see `checkPassword`). Null if absent, matching `KDC_ERR_C_PRINCIPAL_UNKNOWN`. */
  getUserSecret(sam: string): string | null {
    const entry = this.findUserEntry(sam);
    return entry ? firstOf(entry.attributes.get('userpassword')) || null : null;
  }

  /** Direct group membership only (real AD's `memberOf` linked attribute reflects direct membership — no nested-group expansion, per PRD §2.2 scope). */
  groupsForUser(sam: string): AdGroup[] {
    const entry = this.findUserEntry(sam);
    if (!entry) return [];
    return (entry.attributes.get('memberof') ?? [])
      .map(dnStr => this.tree.getByDn(parseDN(dnStr)))
      .filter((e): e is DirectoryEntry => e !== null && hasObjectClass(e, 'group'))
      .map(e => this.projectGroup(e));
  }

  // ─── Groups ─────────────────────────────────────────────────────────

  newGroup(sam: string, scope: AdGroup['scope'] = 'Global', ou?: string): DirOpResult {
    const containerDn = ou ? this.ouDn(ou) : this.usersOuDn;
    if (ou && !this.tree.getByDn(containerDn)) {
      return { ok: false, message: `Cannot find an object with identity: '${ou}'.` };
    }
    const res = this.createGroupEntry(sam, scope, containerDn);
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  private createGroupEntry(sam: string, scope: AdGroup['scope'], containerDn: DistinguishedName): DirOpResult {
    return this.tree.addEntry(this.cnDn(sam, containerDn), {
      objectClass: ['top', 'group'],
      cn: [sam],
      sAMAccountName: [sam],
      groupType: [String(GROUP_TYPE[scope])],
    });
  }

  private findGroupEntry(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam })
      .filter(e => hasObjectClass(e, 'group'));
    return entry ?? null;
  }

  private listGroupEntries(): DirectoryEntry[] {
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'group'));
  }

  getGroup(sam: string): AdGroup | null {
    const entry = this.findGroupEntry(sam);
    return entry ? this.projectGroup(entry) : null;
  }

  listGroups(): AdGroup[] { return this.listGroupEntries().map(e => this.projectGroup(e)); }

  private projectGroup(entry: DirectoryEntry): AdGroup {
    const groupType = Number(firstOf(entry.attributes.get('grouptype')));
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      dn: formatDN(entry.dn),
      scope: SCOPE_OF_GROUP_TYPE.get(groupType) ?? 'Global',
      members: (entry.attributes.get('member') ?? []).map(dnStr => this.samOfDn(dnStr)).filter((s): s is string => s !== null),
    };
  }

  addGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.findGroupEntry(groupSam);
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    const member = this.findUserEntry(memberSam) ?? this.findComputerEntry(memberSam);
    if (!member) return { ok: false, message: `Cannot find an object with identity: '${memberSam}'.` };
    const memberDn = formatDN(member.dn);
    const groupDn = formatDN(group.dn);
    this.tree.modifyEntry(group.dn, [{ op: 'add', type: 'member', values: [memberDn] }]);
    this.tree.modifyEntry(member.dn, [{ op: 'add', type: 'memberOf', values: [groupDn] }]);
    return { ok: true, message: '' };
  }

  removeGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.findGroupEntry(groupSam);
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    const member = this.findUserEntry(memberSam) ?? this.findComputerEntry(memberSam);
    const groupDn = formatDN(group.dn);
    this.tree.modifyEntry(group.dn, [{ op: 'delete', type: 'member', values: member ? [formatDN(member.dn)] : [] }]);
    if (member) this.tree.modifyEntry(member.dn, [{ op: 'delete', type: 'memberOf', values: [groupDn] }]);
    return { ok: true, message: '' };
  }

  /** Resolve a member DN string back to its sAMAccountName (real AD's `member`/`memberOf` store DNs, not names — callers want the friendlier sam). */
  private samOfDn(dnStr: string): string | null {
    let dn: DistinguishedName;
    try { dn = parseDN(dnStr); } catch { return null; }
    const entry = this.tree.getByDn(dn);
    return entry ? firstOf(entry.attributes.get('samaccountname')) || null : null;
  }

  // ─── Computers ──────────────────────────────────────────────────────

  /** Creates the computer account — the side effect of a successful domain join (P6), or DC promotion for the DC's own account. `ouPath` (e.g. `"Sales/EU"`) places it in a nested OU instead of the default flat Computers container. */
  newComputer(name: string, machineSecret: string, ouPath?: string): DirOpResult {
    const dn = ouPath ? this.cnDn(name, this.ouDn(ouPath)) : this.computerDn(name);
    const res = this.tree.addEntry(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
      cn: [name],
      sAMAccountName: [`${name}$`],
      userAccountControl: [String(UAC.WORKSTATION_TRUST_ACCOUNT)],
      userPassword: [machineSecret],
    });
    if (!res.ok) return { ok: false, message: 'An object with that name already exists.' };
    this.addGroupMemberByDn('Domain Computers', dn);
    return { ok: true, message: '' };
  }

  private addGroupMemberByDn(groupSam: string, memberDn: DistinguishedName): void {
    const group = this.findGroupEntry(groupSam);
    if (!group) return;
    this.tree.modifyEntry(group.dn, [{ op: 'add', type: 'member', values: [formatDN(memberDn)] }]);
    this.tree.modifyEntry(memberDn, [{ op: 'add', type: 'memberOf', values: [formatDN(group.dn)] }]);
  }

  private findComputerEntry(name: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'cn', value: name })
      .filter(e => hasObjectClass(e, 'computer'));
    return entry ?? null;
  }

  /** Creates the DC's own computer account under the Domain Controllers OU at promotion time — a distinct container and UAC flag (SERVER_TRUST_ACCOUNT) from a regular domain-joined workstation, matching real AD. */
  promoteDomainController(name: string, machineSecret: string): DirOpResult {
    const dcOuDn = this.ouDn('Domain Controllers');
    const res = this.tree.addEntry(this.cnDn(name, dcOuDn), {
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
      cn: [name],
      sAMAccountName: [`${name}$`],
      userAccountControl: [String(UAC.SERVER_TRUST_ACCOUNT)],
      userPassword: [machineSecret],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  /** `Get-ADDomainController` (PRD-Windows-Server-Advanced.md §5 P5) — every computer account under the Domain Controllers OU, real or replicated in from a partner. */
  listDomainControllers(): AdComputer[] {
    return this.listComputers().filter(c => c.dn.toLowerCase().includes('ou=domain controllers,'));
  }

  getComputer(name: string): AdComputer | null {
    const entry = this.findComputerEntry(name);
    return entry ? this.projectComputer(entry) : null;
  }

  listComputers(): AdComputer[] {
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'computer')).map(e => this.projectComputer(e));
  }

  private projectComputer(entry: DirectoryEntry): AdComputer {
    return {
      name: firstOf(entry.attributes.get('cn')),
      dn: formatDN(entry.dn),
      machineSecret: firstOf(entry.attributes.get('userpassword')),
      enabled: isEnabledFromUac(entry.attributes.get('useraccountcontrol')),
      lastKnownIp: firstOf(entry.attributes.get('ipaddress')) || undefined,
    };
  }

  checkComputerSecret(name: string, secret: string): boolean {
    const entry = this.findComputerEntry(name);
    if (!entry) return false;
    return isEnabledFromUac(entry.attributes.get('useraccountcontrol')) && firstOf(entry.attributes.get('userpassword')) === secret;
  }

  /** The computer account's long-term secret — for `KdcSession` to derive a machine principal's Kerberos key from (mirrors `getUserSecret`). */
  getComputerSecret(name: string): string | null {
    const entry = this.findComputerEntry(name);
    return entry ? firstOf(entry.attributes.get('userpassword')) || null : null;
  }

  /** `Set-ADComputer -Identity <name> -AllowedToDelegateTo <svc1,svc2,...>` (PRD-Windows-Server-Advanced.md §5 P10) — the `msDS-AllowedToDelegateTo` multi-valued attribute S4U2Proxy checks. */
  setAllowedToDelegateTo(name: string, targetServiceNames: string[]): DirOpResult {
    const entry = this.findComputerEntry(name);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${name}'.` };
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'msDS-AllowedToDelegateTo', values: targetServiceNames }]);
    return { ok: true, message: '' };
  }

  /** Whether `delegatingComputerName`'s `msDS-AllowedToDelegateTo` lists `targetServiceName` — the S4U2Proxy gate (`KdcSession.handleS4U2Proxy`). */
  isDelegationAllowedFrom(delegatingComputerName: string, targetServiceName: string): boolean {
    const entry = this.findComputerEntry(delegatingComputerName);
    if (!entry) return false;
    const allowed = entry.attributes.get('msds-allowedtodelegateto') ?? [];
    return allowed.some(v => v.toLowerCase() === targetServiceName.toLowerCase());
  }

  /**
   * Creates the `krbtgt` account the KDC uses to encrypt every ticket-
   * granting ticket, if it doesn't already exist (idempotent — real DC
   * promotion creates it exactly once). Disabled and excluded from
   * `Domain Users`, matching real AD's krbtgt: it never interactively
   * logs on, it only exists to hold the KDC's own long-term key.
   */
  ensureKrbtgtPrincipal(secret: string): DirOpResult {
    if (this.findUserEntry('krbtgt')) return { ok: true, message: '' };
    return this.createUserEntry('krbtgt', {
      password: secret, fullName: 'Key Distribution Center Service Account',
      containerDn: this.usersOuDn, enabled: false,
    });
  }

  // ─── Identity resolution / LDAP bind ────────────────────────────────

  /** Resolves an AD "-Identity"-style argument (a full DN, a UPN, or a bare sAMAccountName) down to a plain sam, for cmdlets and LDAP simple-bind names alike. */
  resolveIdentity(identity: string): string {
    if (identity.includes('=')) {
      try {
        const v = leafValue(parseDN(identity));
        if (v !== null) return v;
      } catch { /* not a valid DN — fall through to UPN/bare handling */ }
    }
    if (identity.includes('@')) return identity.split('@')[0];
    return identity;
  }

  /** An `LdapBindCheck` backed by this directory's user/computer passwords — for `LdapServerHandler` to authenticate simple binds against. */
  getBindCheck(): LdapBindCheck {
    return {
      checkBind: (name, password) => {
        const sam = this.resolveIdentity(name);
        return this.checkPassword(sam, password) || this.checkComputerSecret(sam.replace(/\$$/, ''), password);
      },
    };
  }
}

function dnEqualsOu(dn: DistinguishedName, ou: DistinguishedName): boolean {
  return formatDN(dn).toLowerCase() === formatDN(ou).toLowerCase();
}
function leafOuName(dn: DistinguishedName): string {
  return dn[0]?.[0]?.value ?? '';
}
