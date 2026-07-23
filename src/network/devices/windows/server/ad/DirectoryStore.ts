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
import type { AdUser, AdGroup, AdComputer, AdOrgUnit, Gpo, GpoSettings } from './AdTypes';
import { generateId } from '@/network/core/types';
import {
  type HighWatermarkVector, emptyHighWatermarkVector, recordUsn, cloneHighWatermarkVector,
} from './replication/HighWatermarkVector';
import { SiteRegistry, type SiteOpResult, type SiteInfo } from './forest/sites';
import { SchemaValidator } from './schema/SchemaValidator';
import { SchemaPartition, seedDefaultSchema } from './schema/SchemaPartition';
import type { AttributeSchema, ObjectClassSchema, SchemaOpResult } from './schema/SchemaValidator';
import { TrustRegistry, type TrustDirection, type TrustOpResult, type TrustInfo, type TrustRecord } from './forest/TrustRelationship';

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

  // ─── Domain-wide FSMO roles (RID/PDC Emulator/Infrastructure Master) ──
  //
  // Stored as real attributes on the domain root entry (`fSMORoleOwner`
  // isn't split per-role on the real root object, but this simulator has
  // no separate RID Manager/Infrastructure container objects to hang each
  // role on individually — three attributes on the one root entry is the
  // simplification). Being real attributes on a replicated entry, a role
  // transfer performed on one DC becomes visible on a replication partner
  // through the existing `replicateFrom`/`changedSince` pull, exactly
  // like any other attribute change — no separate FSMO propagation path.

  private static readonly FSMO_DOMAIN_ATTRS = {
    RIDMaster: 'fsmoRidMaster',
    PDCEmulator: 'fsmoPdcEmulator',
    InfrastructureMaster: 'fsmoInfrastructureMaster',
  } as const;

  /** Called once at `Install-ADDSForest` — all 3 domain-level roles start on the founding DC. */
  initializeDomainFsmoRoles(foundingDcHostname: string): void {
    const root = this.tree.getByDn(this.tree.getRootDn());
    if (!root) return;
    this.tree.modifyEntry(root.dn, Object.values(DirectoryStore.FSMO_DOMAIN_ATTRS).map(attr => ({
      op: 'replace' as const, type: attr, values: [foundingDcHostname],
    })));
  }

  getDomainFsmoRoleOwner(role: keyof typeof DirectoryStore.FSMO_DOMAIN_ATTRS): string {
    const root = this.tree.getByDn(this.tree.getRootDn());
    return root ? firstOf(root.attributes.get(DirectoryStore.FSMO_DOMAIN_ATTRS[role].toLowerCase())) : '';
  }

  transferDomainFsmoRole(role: keyof typeof DirectoryStore.FSMO_DOMAIN_ATTRS, newOwnerHostname: string): void {
    const root = this.tree.getByDn(this.tree.getRootDn());
    if (!root) return;
    this.tree.modifyEntry(root.dn, [{ op: 'replace', type: DirectoryStore.FSMO_DOMAIN_ATTRS[role], values: [newOwnerHostname] }]);
  }

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

  private ouDn(name: string): DistinguishedName { return [...parseDN(`OU=${name}`), ...this.tree.getRootDn()]; }
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

  newOrgUnit(name: string): DirOpResult {
    const res = this.tree.addEntry(this.ouDn(name), { objectClass: ['top', 'organizationalUnit'], ou: [name] });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  getOrgUnit(name: string): AdOrgUnit | null {
    const entry = this.tree.getByDn(this.ouDn(name));
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

  newGpo(name: string): DirOpResult {
    const res = this.tree.addEntry(this.cnDn(name, this.policiesDn), {
      objectClass: ['top', 'container', 'groupPolicyContainer'],
      cn: [name], displayName: [name],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A GPO named "${name}" already exists.` };
  }

  private findGpoEntry(name: string): DirectoryEntry | null {
    return this.tree.getByDn(this.cnDn(name, this.policiesDn));
  }

  getGpo(name: string): Gpo | null {
    const entry = this.findGpoEntry(name);
    return entry ? this.projectGpo(entry) : null;
  }

  listGpos(): Gpo[] {
    return this.tree.allDescendants(this.policiesDn)
      .filter(e => hasObjectClass(e, 'groupPolicyContainer'))
      .map(e => this.projectGpo(e));
  }

  private projectGpo(entry: DirectoryEntry): Gpo {
    const accountPolicyJson = firstOf(entry.attributes.get('gpoaccountpolicy'));
    const logonBannerJson = firstOf(entry.attributes.get('gpologonbanner'));
    const startupScript = firstOf(entry.attributes.get('gpostartupscript'));
    const gpoDn = formatDN(entry.dn);
    return {
      id: firstOf(entry.attributes.get('cn')),
      name: firstOf(entry.attributes.get('displayname')),
      links: this.tree.allDescendants(this.tree.getRootDn())
        .filter(e => (e.attributes.get('gplink') ?? []).some(v => v.toLowerCase() === gpoDn.toLowerCase()))
        .map(e => formatDN(e.dn)),
      settings: {
        accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
        logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
        startupScript: startupScript || undefined,
      },
    };
  }

  setGpoSettings(name: string, settings: GpoSettings): DirOpResult {
    const entry = this.findGpoEntry(name);
    if (!entry) return { ok: false, message: `Cannot find a GPO with name "${name}".` };
    const changes: { op: 'replace'; type: string; values: string[] }[] = [];
    if (settings.accountPolicy !== undefined) changes.push({ op: 'replace', type: 'gpoAccountPolicy', values: [JSON.stringify(settings.accountPolicy)] });
    if (settings.logonBanner !== undefined) changes.push({ op: 'replace', type: 'gpoLogonBanner', values: [JSON.stringify(settings.logonBanner)] });
    if (settings.startupScript !== undefined) changes.push({ op: 'replace', type: 'gpoStartupScript', values: [settings.startupScript] });
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  /** `New-GPLink` — links a GPO to a domain or OU DN (`gPLink`, RFC-faithful attribute name — real AD stores an ordered, precedence-flagged list; this simulator keeps only the unordered link set, applied in `resultantSetOfPolicy`'s fixed domain-then-OU order). */
  newGPLink(gpoName: string, targetDn: string): DirOpResult {
    const gpo = this.findGpoEntry(gpoName);
    if (!gpo) return { ok: false, message: `Cannot find a GPO with name "${gpoName}".` };
    let target: DistinguishedName;
    try { target = parseDN(targetDn); } catch { return { ok: false, message: `"${targetDn}" is not a valid distinguished name.` }; }
    const targetEntry = this.tree.getByDn(target);
    if (!targetEntry) return { ok: false, message: `Cannot find an object with distinguished name: '${targetDn}'.` };
    this.tree.modifyEntry(target, [{ op: 'add', type: 'gPLink', values: [formatDN(gpo.dn)] }]);
    return { ok: true, message: '' };
  }

  /**
   * RSoP for a computer, real precedence order: domain-linked GPOs first,
   * then GPOs linked to the computer's own OU (more specific — its
   * settings override the domain's on conflicting keys). Only direct
   * links are honored (no OU-hierarchy walk beyond the computer's
   * immediate container), matching this simulator's flat OU placement
   * (P6 domain join always places computers in the Computers OU).
   */
  resultantSetOfPolicy(computerName?: string): { appliedGpoNames: string[]; settings: GpoSettings } {
    const domainLinked = this.linkedGposFor(this.tree.getRootDn());
    let ouLinked: Gpo[] = [];
    if (computerName) {
      const computer = this.findComputerEntry(computerName);
      const parentDn = computer ? computer.dn.slice(1) : null;
      if (parentDn) ouLinked = this.linkedGposFor(parentDn);
    }
    const ordered = [...domainLinked, ...ouLinked];
    const merged: GpoSettings = {};
    for (const gpo of ordered) {
      if (gpo.settings.accountPolicy !== undefined) merged.accountPolicy = { ...merged.accountPolicy, ...gpo.settings.accountPolicy };
      if (gpo.settings.logonBanner !== undefined) merged.logonBanner = gpo.settings.logonBanner;
      if (gpo.settings.startupScript !== undefined) merged.startupScript = gpo.settings.startupScript;
    }
    return { appliedGpoNames: ordered.map(g => g.name), settings: merged };
  }

  private linkedGposFor(dn: DistinguishedName): Gpo[] {
    const entry = this.tree.getByDn(dn);
    const links = entry?.attributes.get('gplink') ?? [];
    return links
      .map(gpoDn => { try { return this.tree.getByDn(parseDN(gpoDn)); } catch { return null; } })
      .filter((e): e is DirectoryEntry => e !== null)
      .map(e => this.projectGpo(e));
  }

  // ─── Users ──────────────────────────────────────────────────────────

  newUser(sam: string, opts: { password: string; fullName?: string; ou?: string; enabled?: boolean; department?: string; title?: string }): DirOpResult {
    const containerDn = opts.ou ? this.ouDn(opts.ou) : this.usersOuDn;
    if (opts.ou && !this.tree.getByDn(containerDn)) {
      return { ok: false, message: `Cannot find an object with identity: '${opts.ou}'.` };
    }
    const res = this.createUserEntry(sam, {
      password: opts.password, fullName: opts.fullName ?? '', containerDn, enabled: opts.enabled,
      department: opts.department, title: opts.title,
    });
    if (!res.ok) return res;
    this.addGroupMember('Domain Users', sam);
    return { ok: true, message: '' };
  }

  private createUserEntry(sam: string, opts: { password: string; fullName: string; containerDn: DistinguishedName; enabled?: boolean; department?: string; title?: string }): DirOpResult {
    const enabled = opts.enabled ?? true;
    const res = this.tree.addEntry(this.cnDn(sam, opts.containerDn), compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: [sam],
      sAMAccountName: [sam],
      userPrincipalName: [`${sam}@${this.dnsName}`],
      userAccountControl: [String(enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE)],
      userPassword: [opts.password],
      displayName: opts.fullName ? [opts.fullName] : [],
      department: opts.department ? [opts.department] : [],
      title: opts.title ? [opts.title] : [],
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
      department: firstOf(entry.attributes.get('department')),
      title: firstOf(entry.attributes.get('title')),
      servicePrincipalNames: entry.attributes.get('serviceprincipalname') ?? [],
    };
  }

  setUser(sam: string, opts: { enabled?: boolean; fullName?: string; password?: string; department?: string; title?: string; addSpns?: string[]; removeSpns?: string[] }): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    const changes: { op: 'replace' | 'add' | 'delete'; type: string; values: string[] }[] = [];
    if (opts.enabled !== undefined) {
      changes.push({ op: 'replace', type: 'userAccountControl', values: [String(opts.enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE)] });
    }
    if (opts.fullName !== undefined) changes.push({ op: 'replace', type: 'displayName', values: opts.fullName ? [opts.fullName] : [] });
    if (opts.password !== undefined) changes.push({ op: 'replace', type: 'userPassword', values: [opts.password] });
    if (opts.department !== undefined) changes.push({ op: 'replace', type: 'department', values: opts.department ? [opts.department] : [] });
    if (opts.title !== undefined) changes.push({ op: 'replace', type: 'title', values: opts.title ? [opts.title] : [] });
    if (opts.addSpns && opts.addSpns.length > 0) changes.push({ op: 'add', type: 'servicePrincipalName', values: opts.addSpns });
    if (opts.removeSpns && opts.removeSpns.length > 0) changes.push({ op: 'delete', type: 'servicePrincipalName', values: opts.removeSpns });
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  /** AD's Default Domain Policy LockoutThreshold default: 5 bad passwords locks the account (PRD-Windows-Server-Advanced §5 password policy). */
  private static readonly LOCKOUT_THRESHOLD = 5;

  /** A failed Kerberos pre-authentication (bad password) — increments badPwdCount and locks the account once the threshold is reached, matching real AD. */
  recordBadPasswordAttempt(sam: string): void {
    const entry = this.findUserEntry(sam);
    if (!entry) return;
    const count = Number(firstOf(entry.attributes.get('badpwdcount'))) || 0;
    const next = count + 1;
    const changes: { op: 'replace'; type: string; values: string[] }[] = [
      { op: 'replace', type: 'badPwdCount', values: [String(next)] },
    ];
    if (next >= DirectoryStore.LOCKOUT_THRESHOLD) {
      changes.push({ op: 'replace', type: 'lockoutTime', values: [String(Math.floor(Date.now() / 1000))] });
    }
    this.tree.modifyEntry(entry.dn, changes);
  }

  /** A successful logon resets the bad-password counter, matching real AD. */
  resetBadPasswordCount(sam: string): void {
    const entry = this.findUserEntry(sam);
    if (!entry) return;
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'badPwdCount', values: [] }]);
  }

  isLockedOut(sam: string): boolean {
    const entry = this.findUserEntry(sam);
    return entry ? firstOf(entry.attributes.get('lockouttime')) !== '' : false;
  }

  /** `Search-ADAccount -LockedOut`. */
  listLockedOutUsers(): Array<{ sam: string; name: string; badPwdCount: number }> {
    return this.listUserEntries()
      .filter(e => firstOf(e.attributes.get('lockouttime')) !== '')
      .map(e => ({
        sam: firstOf(e.attributes.get('samaccountname')),
        name: firstOf(e.attributes.get('displayname')) || firstOf(e.attributes.get('samaccountname')),
        badPwdCount: Number(firstOf(e.attributes.get('badpwdcount'))) || 0,
      }));
  }

  private listUserEntries(): DirectoryEntry[] {
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'user') && !hasObjectClass(e, 'computer'));
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

  /** `Remove-ADDomainController` / the AD-metadata-cleanup half of `ntdsutil` — deletes a (real or seized-from) DC's own computer account and its group memberships, same shape as `removeUser`. */
  removeComputer(name: string): DirOpResult {
    const entry = this.findComputerEntry(name);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${name}'.` };
    const computerDn = formatDN(entry.dn);
    for (const group of this.listGroupEntries()) {
      if ((group.attributes.get('member') ?? []).some(m => m.toLowerCase() === computerDn.toLowerCase())) {
        this.tree.modifyEntry(group.dn, [{ op: 'delete', type: 'member', values: [computerDn] }]);
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

  /** Creates the computer account — the side effect of a successful domain join (P6), or DC promotion for the DC's own account. */
  newComputer(name: string, machineSecret: string): DirOpResult {
    const res = this.tree.addEntry(this.computerDn(name), {
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
      cn: [name],
      sAMAccountName: [`${name}$`],
      userAccountControl: [String(UAC.WORKSTATION_TRUST_ACCOUNT)],
      userPassword: [machineSecret],
      servicePrincipalName: [`HOST/${name}`, `HOST/${name}.${this.dnsName}`],
    });
    if (!res.ok) return { ok: false, message: 'An object with that name already exists.' };
    this.addGroupMemberByDn('Domain Computers', this.computerDn(name));
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
      servicePrincipalName: [`HOST/${name}`, `HOST/${name}.${this.dnsName}`],
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
      servicePrincipalNames: entry.attributes.get('serviceprincipalname') ?? [],
    };
  }

  /** Every user/computer object carrying at least one SPN — `Get-ADObject -Filter {ServicePrincipalName -like "*"}`, the basis for cross-object duplicate-SPN detection. */
  listObjectsWithSpns(): Array<{ name: string; servicePrincipalNames: string[] }> {
    const users = this.listUsers().filter(u => u.servicePrincipalNames.length > 0).map(u => ({ name: u.sam, servicePrincipalNames: u.servicePrincipalNames }));
    const computers = this.listComputers().filter(c => c.servicePrincipalNames.length > 0).map(c => ({ name: c.name, servicePrincipalNames: c.servicePrincipalNames }));
    return [...users, ...computers];
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
