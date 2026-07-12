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
import type { AdUser, AdGroup, AdComputer, AdOrgUnit, AdServiceAccount, Gpo, GpoSettings, GpoAccountPolicy, PasswordSettingsObject } from './AdTypes';
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
import { RidPool } from './fsmo/RidPool';
import { SdPropEngine } from './security/SdProp';
import { ManagedServiceAccountStore } from './msa/ManagedServiceAccountStore';
import { PasswordReplicationPolicy } from './rodc/PasswordReplicationPolicy';

export interface DirOpResult { ok: boolean; message: string }

/** RFC-faithful AD userAccountControl bit flags (the subset this simulator needs). */
const UAC = {
  ACCOUNTDISABLE: 0x0002,
  NORMAL_ACCOUNT: 0x0200,
  WORKSTATION_TRUST_ACCOUNT: 0x1000,
  SERVER_TRUST_ACCOUNT: 0x2000,
  DONT_EXPIRE_PASSWORD: 0x10000,
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

/** Real AD's fixed RIDs for its default security principals — same across every domain. */
const WELL_KNOWN_RID = {
  Administrator: 500,
  Krbtgt: 502,
  DomainAdmins: 512,
  DomainUsers: 513,
  DomainComputers: 515,
} as const;

/** This DC's own local RID allocation range when it's the first DC of a domain (and therefore its own RID Master) — generous enough that a lab domain never exhausts it. Blocks granted to *other* DCs start beyond this range (`grantRidPoolBlock`). */
const RID_MASTER_LOCAL_POOL_START = 1000;
const RID_MASTER_LOCAL_POOL_COUNT = 100_000;

/** Real AD's other well-known built-in security groups (a representative subset — see `seedDefaults`'s own comment for the `CN=Builtin`/well-known-SID simplification). */
const BUILTIN_GROUPS = [
  'Administrators', 'Account Operators', 'Backup Operators', 'Server Operators', 'Print Operators',
  'Cert Publishers', 'Group Policy Creator Owners', 'DnsAdmins',
] as const;

function generateDomainSid(): string {
  const rand = () => Math.floor(Math.random() * 0xFFFFFFFF);
  return `S-1-5-21-${rand()}-${rand()}-${rand()}`;
}

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }
function isEnabledFromUac(values: string[] | undefined): boolean {
  const uac = Number(firstOf(values));
  return Number.isFinite(uac) && (uac & UAC.ACCOUNTDISABLE) === 0;
}
function hasUacFlag(values: string[] | undefined, flag: number): boolean {
  const uac = Number(firstOf(values));
  return Number.isFinite(uac) && (uac & flag) !== 0;
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
  private readonly localRidPool: RidPool;
  /** Next block to grant a requesting DC — only meaningful while this DC holds the RID Master role; lazily initialized on first grant. */
  private nextGlobalRidPoolStart: number | null = null;
  private readonly sdProp: SdPropEngine;
  private readonly msaStore: ManagedServiceAccountStore;
  private readonly readOnly: boolean;
  private readonly prp = new PasswordReplicationPolicy();

  /**
   * `opts.skipSeed` (PRD-Windows-Server-Advanced.md §5 P5): an additional
   * DC joining an *existing* domain (`Install-ADDSDomainController`) must
   * not independently create its own Users/Computers OUs and default
   * groups — those already exist on the domain and would replicate in as
   * duplicates. It instead starts with an empty tree and relies entirely
   * on the initial replication sync (§5 P4) to populate everything,
   * exactly like real DCPromo's initial-sync-from-a-source-DC step.
   *
   * `opts.readOnly`: an RODC (MS-ADTS §3.1.1.1.11) — implies `skipSeed`
   * in practice (an RODC is always an *additional* DC), refuses every
   * local/LDAP-originated write on its `DirectoryTree`, and filters
   * uncached users'/computers' `userPassword` out of what it accepts via
   * replication (see `applyReplicatedEntry`).
   */
  constructor(
    readonly dnsName: string,
    readonly netbiosName: string,
    adminPassword: string,
    opts: { skipSeed?: boolean; sharedSchemaValidator?: SchemaValidator; readOnly?: boolean } = {},
  ) {
    const rootDn = parseDN(this.dnsName.split('.').map(p => `DC=${p}`).join(','));
    this.schemaValidator = opts.sharedSchemaValidator ?? new SchemaValidator();
    this.readOnly = opts.readOnly ?? false;
    const domainSid = opts.skipSeed ? undefined : generateDomainSid();
    this.tree = new DirectoryTree(rootDn, {
      objectClass: ['top', 'domain', 'domainDNS'],
      ...(domainSid ? { domainSid: [domainSid] } : {}),
    }, {
      invocationId: this.invocationId, nextUsn: () => ++this.localUsn,
    }, this.schemaValidator, this.readOnly);
    this.usersOuDn = [...parseDN('CN=Users'), ...rootDn];
    this.computersOuDn = [...parseDN('CN=Computers'), ...rootDn];
    this.policiesDn = [...parseDN('CN=Policies'), ...parseDN('CN=System'), ...rootDn];
    this.sites = new SiteRegistry(this.tree);
    this.schema = new SchemaPartition(this.tree, this.schemaValidator);
    this.trustRegistry = new TrustRegistry(this.tree);
    this.gpoStore = new GpoStore(this.tree);
    this.psoStore = new PsoStore(this.tree);
    this.fsmoRoles = new DomainFsmoRoles(this.tree, rootDn);
    this.localRidPool = opts.skipSeed
      ? new RidPool(0, 0)
      : new RidPool(RID_MASTER_LOCAL_POOL_START, RID_MASTER_LOCAL_POOL_COUNT);
    this.sdProp = new SdPropEngine(this.tree);
    this.msaStore = new ManagedServiceAccountStore(this.tree);
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

  /** Applies one entry pulled from a replication partner (attribute-by-attribute — see `DirectoryTree.applyReplicatedEntry`) and advances this DC's record of how caught-up it is with every DC whose writes appear in `stamp`, not just the partner dialed directly. On an RODC, a user/computer not covered by the Password Replication Policy never gets its real `userPassword` cached locally (MS-ADTS §3.1.1.1.11). */
  applyReplicatedEntry(dn: string, attributes: Record<string, string[]>, stamp: EntryReplMeta): void {
    let parsed: DistinguishedName;
    try { parsed = parseDN(dn); } catch { return; }
    const filtered = this.readOnly ? this.filterSecretsForRodc(attributes, stamp) : { attributes, stamp };
    this.tree.applyReplicatedEntry(parsed, filtered.attributes, filtered.stamp);
    for (const attrStamp of stamp.values()) recordUsn(this.inboundHighWatermark, attrStamp.originatingInvocationId, attrStamp.originatingUsn);
  }

  private filterSecretsForRodc(attributes: Record<string, string[]>, stamp: EntryReplMeta): { attributes: Record<string, string[]>; stamp: EntryReplMeta } {
    const sam = (attributes.sAMAccountName ?? attributes.samaccountname)?.[0];
    if (!sam || this.prp.isCachingAllowed(sam.replace(/\$$/, ''))) return { attributes, stamp };
    return {
      attributes: Object.fromEntries(Object.entries(attributes).filter(([k]) => k.toLowerCase() !== 'userpassword')),
      stamp: new Map([...stamp].filter(([k]) => k !== 'userpassword')),
    };
  }

  isReadOnly(): boolean { return this.readOnly; }
  setPasswordReplicationPolicy(allow: readonly string[], deny: readonly string[]): void { this.prp.setPolicy(allow, deny); }
  getPasswordReplicationPolicy(): { allowed: string[]; denied: string[] } {
    return { allowed: this.prp.getAllowed(), denied: this.prp.getDenied() };
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

    this.createGroupEntry('Domain Admins', 'Global', this.usersOuDn, WELL_KNOWN_RID.DomainAdmins);
    this.createGroupEntry('Domain Users', 'Global', this.usersOuDn, WELL_KNOWN_RID.DomainUsers);
    this.createGroupEntry('Domain Computers', 'Global', this.usersOuDn, WELL_KNOWN_RID.DomainComputers);
    /**
     * Real AD places these in a dedicated `CN=Builtin` container under
     * well-known, non-domain-relative SIDs (`S-1-5-32-544` for
     * Administrators, etc.) — this simulator's `formatObjectSid` only
     * models domain-relative RIDs, so these are seeded in `CN=Users`
     * with ordinary local-RID-pool SIDs instead, a deliberate
     * simplification (same container/SID scheme every other object here
     * already uses).
     */
    for (const builtin of BUILTIN_GROUPS) this.createGroupEntry(builtin, 'DomainLocal', this.usersOuDn);

    this.createUserEntry('Administrator', {
      password: adminPassword, fullName: 'Administrator', containerDn: this.usersOuDn, wellKnownRid: WELL_KNOWN_RID.Administrator, passwordNeverExpires: true,
    });
    this.addGroupMember('Domain Admins', 'Administrator');
    this.addGroupMember('Domain Users', 'Administrator');
    this.addGroupMember('Administrators', 'Administrator');
  }

  // ─── Organizational Units ───────────────────────────────────────────

  /** Matches `New-ADOrganizationalUnit`'s own default: a fresh OU is protected from accidental deletion unless the caller opts out. */
  newOrgUnit(path: string, opts: { protectedFromAccidentalDeletion?: boolean } = {}): DirOpResult {
    const segments = path.split('/').filter(s => s.length > 0);
    const leafName = segments[segments.length - 1] ?? path;
    const protect = opts.protectedFromAccidentalDeletion ?? true;
    const res = this.tree.addEntry(this.ouDn(path), {
      objectClass: ['top', 'organizationalUnit'], ou: [leafName],
      protectedFromAccidentalDeletion: [String(protect)],
    });
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

  setOuProtectedFromAccidentalDeletion(path: string, protect: boolean): DirOpResult {
    const dn = this.ouDn(path);
    if (!this.tree.getByDn(dn)) return { ok: false, message: `Cannot find an object with identity: '${path}'.` };
    this.tree.modifyEntry(dn, [{ op: 'replace', type: 'protectedFromAccidentalDeletion', values: [String(protect)] }]);
    return { ok: true, message: '' };
  }

  /** `Remove-ADOrganizationalUnit` — refuses (via `DirectoryTree.deleteEntry`'s own check) unless `protectedFromAccidentalDeletion` was cleared first, matching real AD's own two-step removal. */
  removeOrgUnit(path: string): DirOpResult {
    const dn = this.ouDn(path);
    if (!this.tree.getByDn(dn)) return { ok: false, message: `Cannot find an object with identity: '${path}'.` };
    return this.tree.deleteEntry(dn);
  }

  private projectOrgUnit(entry: DirectoryEntry): AdOrgUnit {
    return {
      name: firstOf(entry.attributes.get('ou')),
      dn: formatDN(entry.dn),
      gpLinks: entry.attributes.get('gplink') ?? [],
      protectedFromAccidentalDeletion: firstOf(entry.attributes.get('protectedfromaccidentaldeletion')) === 'true',
    };
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
  /** A PSO covering this user wins outright (never merged, real AD's own precedence rule); otherwise falls back to the domain-wide default (Default Domain Policy's `accountPolicy`, PRD §5 P10). */
  effectivePasswordPolicyFor(userSam: string): GpoAccountPolicy | null {
    const user = this.findUserEntry(userSam);
    if (!user) return null;
    return this.psoStore.effectivePasswordPolicyFor(user) ?? this.gpoStore.getGpo('Default Domain Policy')?.settings.accountPolicy ?? null;
  }

  // ─── FSMO roles (domain-wide: RID Master / PDC Emulator / Infrastructure Master) ────

  getFsmoRoleOwner(role: DomainFsmoRole): string | null { return this.fsmoRoles.getOwner(role); }
  /** Called once by `WindowsServer` right after promoting the first DC of a (forest-root or child) domain — never for an additional DC, which inherits ownership via its initial replication sync instead. */
  seedFsmoRoles(hostname: string): void { this.fsmoRoles.seedAllTo(hostname); }
  seizeFsmoRole(role: DomainFsmoRole, newOwnerHostname: string): void { this.fsmoRoles.seize(role, newOwnerHostname); }

  // ─── RID pool (RID Master) / object SIDs ────────────────────────────

  getDomainSid(): string | null {
    return this.tree.getByDn(this.tree.getRootDn())?.attributes.get('domainsid')?.[0] ?? null;
  }

  private formatObjectSid(rid: number): string { return `${this.getDomainSid() ?? 'S-1-5-21-0-0-0'}-${rid}`; }

  /** Allocates the next RID from this DC's own local pool, or `null` once exhausted (caller should request a fresh pool via `RidPoolClient` and `installRidPool`). */
  allocateNextRid(): number | null { return this.localRidPool.allocateNext(); }

  /** Installs a pool this DC received from the RID Master (`RidPoolClient.requestRidPool`), or re-seeds its own after a local exhaustion. */
  installRidPool(startRid: number, count: number): void { this.localRidPool.install(startRid, count); }

  /**
   * Grants a block of RIDs to a requesting DC — only valid while this DC
   * holds the RID Master role; callers (network handlers) must check
   * `getFsmoRoleOwner('RidMaster')` themselves first, since
   * `DirectoryStore` has no notion of its own hostname.
   */
  grantRidPoolBlock(requestedSize: number): { startRid: number; count: number } {
    if (this.nextGlobalRidPoolStart === null) this.nextGlobalRidPoolStart = RID_MASTER_LOCAL_POOL_START + RID_MASTER_LOCAL_POOL_COUNT;
    const startRid = this.nextGlobalRidPoolStart;
    this.nextGlobalRidPoolStart += requestedSize;
    return { startRid, count: requestedSize };
  }

  // ─── AdminSDHolder / SDProp ──────────────────────────────────────────

  /** One SDProp pass (real AD: every 60 minutes, on the PDC Emulator) — see `SdPropEngine` for what "protected" means here. */
  runSdProp(): string[] { return this.sdProp.run(); }

  // ─── Users ──────────────────────────────────────────────────────────

  /** Deliberately does not enforce `minPasswordLength` at creation (unlike `setUser`'s password-change path): every AD-related test in this codebase creates users with short test passwords, and the domain default policy already carries a 7-character minimum — enforcing it here would be a disruptive, out-of-proportion change for what a self-initiated task should touch. Real `New-ADUser` does enforce it; this is a documented, deliberate simplification. */
  newUser(sam: string, opts: { password: string; fullName?: string; ou?: string; enabled?: boolean; passwordNeverExpires?: boolean }): DirOpResult {
    const containerDn = opts.ou ? this.ouDn(opts.ou) : this.usersOuDn;
    if (opts.ou && !this.tree.getByDn(containerDn)) {
      return { ok: false, message: `Cannot find an object with identity: '${opts.ou}'.` };
    }
    const res = this.createUserEntry(sam, {
      password: opts.password, fullName: opts.fullName ?? '', containerDn, enabled: opts.enabled, passwordNeverExpires: opts.passwordNeverExpires,
    });
    if (!res.ok) return res;
    this.addGroupMember('Domain Users', sam);
    return { ok: true, message: '' };
  }

  private createUserEntry(sam: string, opts: {
    password: string; fullName: string; containerDn: DistinguishedName; enabled?: boolean; wellKnownRid?: number; passwordNeverExpires?: boolean;
  }): DirOpResult {
    const enabled = opts.enabled ?? true;
    const rid = opts.wellKnownRid ?? this.localRidPool.allocateNext();
    let uac = enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE;
    if (opts.passwordNeverExpires) uac |= UAC.DONT_EXPIRE_PASSWORD;
    const res = this.tree.addEntry(this.cnDn(sam, opts.containerDn), compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: [sam],
      sAMAccountName: [sam],
      userPrincipalName: [`${sam}@${this.dnsName}`],
      userAccountControl: [String(uac)],
      userPassword: [opts.password],
      displayName: opts.fullName ? [opts.fullName] : [],
      objectSid: rid !== null ? [this.formatObjectSid(rid)] : [],
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
      objectSid: firstOf(entry.attributes.get('objectsid')),
      adminCount: firstOf(entry.attributes.get('admincount')) === '1',
      lockedOut: this.isAccountLockedOut(firstOf(entry.attributes.get('samaccountname'))),
      accountExpires: Number(firstOf(entry.attributes.get('accountexpires'))) || null,
      passwordNeverExpires: hasUacFlag(entry.attributes.get('useraccountcontrol'), UAC.DONT_EXPIRE_PASSWORD),
    };
  }

  setUser(sam: string, opts: { enabled?: boolean; fullName?: string; password?: string; passwordNeverExpires?: boolean }): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    const changes: { op: 'replace'; type: string; values: string[] }[] = [];
    if (opts.enabled !== undefined || opts.passwordNeverExpires !== undefined) {
      let uac = Number(firstOf(entry.attributes.get('useraccountcontrol'))) || UAC.NORMAL_ACCOUNT;
      if (opts.enabled !== undefined) uac = opts.enabled ? uac & ~UAC.ACCOUNTDISABLE : uac | UAC.ACCOUNTDISABLE;
      if (opts.passwordNeverExpires !== undefined) uac = opts.passwordNeverExpires ? uac | UAC.DONT_EXPIRE_PASSWORD : uac & ~UAC.DONT_EXPIRE_PASSWORD;
      changes.push({ op: 'replace', type: 'userAccountControl', values: [String(uac)] });
    }
    if (opts.fullName !== undefined) changes.push({ op: 'replace', type: 'displayName', values: opts.fullName ? [opts.fullName] : [] });
    if (opts.password !== undefined) {
      const rejection = this.rejectPasswordChange(entry, opts.password);
      if (rejection) return rejection;
      const currentPassword = firstOf(entry.attributes.get('userpassword'));
      const policy = this.effectivePasswordPolicyFor(sam);
      const historyLength = policy?.passwordHistoryLength ?? 0;
      const history = entry.attributes.get('pwdhistory') ?? [];
      const newHistory = currentPassword ? [...history, currentPassword].slice(-historyLength) : history.slice(-historyLength);
      changes.push({ op: 'replace', type: 'userPassword', values: [opts.password] });
      changes.push({ op: 'replace', type: 'pwdLastSet', values: [String(Math.floor(Date.now() / 1000))] });
      changes.push({ op: 'replace', type: 'pwdHistory', values: newHistory });
    }
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  /** `null` if `newPassword` satisfies the user's effective policy (PSO, or domain default) — `minPasswordLength`, `minPasswordAge` (days since `pwdLastSet`), and `passwordHistoryLength` (the current password counts as the most recent history entry). No admin-reset bypass modeled — no cmdlet currently distinguishes a self-service change from a reset. */
  private rejectPasswordChange(entry: DirectoryEntry, newPassword: string): DirOpResult | null {
    const sam = firstOf(entry.attributes.get('samaccountname'));
    const policy = this.effectivePasswordPolicyFor(sam);
    if (!policy) return null;
    if (policy.minPasswordLength !== undefined && newPassword.length < policy.minPasswordLength) {
      return { ok: false, message: 'Unable to update the password. The value provided does not meet the length, complexity, or history requirements of the domain.' };
    }
    if (policy.minPasswordAge !== undefined && policy.minPasswordAge > 0) {
      const pwdLastSet = Number(firstOf(entry.attributes.get('pwdlastset'))) || 0;
      const elapsedDays = (Math.floor(Date.now() / 1000) - pwdLastSet) / 86400;
      if (pwdLastSet > 0 && elapsedDays < policy.minPasswordAge) {
        return { ok: false, message: 'Unable to update the password. The password has not been changed enough time since it was last set.' };
      }
    }
    const historyLength = policy.passwordHistoryLength ?? 0;
    if (historyLength > 0) {
      const currentPassword = firstOf(entry.attributes.get('userpassword'));
      const history = entry.attributes.get('pwdhistory') ?? [];
      const recent = [...history, currentPassword].filter(Boolean).slice(-historyLength);
      if (recent.includes(newPassword)) {
        return { ok: false, message: 'Unable to update the password. The value provided does not meet the length, complexity, or history requirements of the domain.' };
      }
    }
    return null;
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

  /**
   * Real AD's account lockout policy (`lockoutThreshold`/
   * `lockoutDurationMinutes`, PSO or domain default) — dormant until now:
   * this is the sole gate for an LDAP simple bind (`getBindCheck`), never
   * consulted by the real Kerberos AS-REQ path (`getUserSecret`), so
   * lockout here only covers simple-bind authentication attempts, not a
   * full AS-REQ preauth failure count.
   */
  checkPassword(sam: string, password: string): boolean {
    const entry = this.findUserEntry(sam);
    if (!entry) return false;
    if (!isEnabledFromUac(entry.attributes.get('useraccountcontrol'))) return false;
    const accountExpires = Number(firstOf(entry.attributes.get('accountexpires'))) || 0;
    if (accountExpires > 0 && Math.floor(Date.now() / 1000) >= accountExpires) return false;

    const policy = this.effectivePasswordPolicyFor(sam);
    const now = Math.floor(Date.now() / 1000);
    if (policy?.maxPasswordAge && policy.maxPasswordAge > 0 && !hasUacFlag(entry.attributes.get('useraccountcontrol'), UAC.DONT_EXPIRE_PASSWORD)) {
      const pwdLastSet = Number(firstOf(entry.attributes.get('pwdlastset'))) || 0;
      if (pwdLastSet > 0 && (now - pwdLastSet) / 86400 >= policy.maxPasswordAge) return false;
    }
    const threshold = policy?.lockoutThreshold ?? 0;
    const durationSeconds = (policy?.lockoutDurationMinutes ?? 30) * 60;
    const lockoutTime = Number(firstOf(entry.attributes.get('lockouttime'))) || 0;
    if (lockoutTime > 0) {
      if (now - lockoutTime < durationSeconds) return false;
      this.tree.modifyEntry(entry.dn, [
        { op: 'replace', type: 'lockoutTime', values: [] }, { op: 'replace', type: 'badPwdCount', values: [] },
      ]);
    }

    const matches = firstOf(entry.attributes.get('userpassword')) === password;
    if (matches) {
      if (firstOf(entry.attributes.get('badpwdcount'))) this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'badPwdCount', values: [] }]);
      return true;
    }
    if (threshold > 0) {
      const badPwdCount = (Number(firstOf(entry.attributes.get('badpwdcount'))) || 0) + 1;
      const changes: { op: 'replace'; type: string; values: string[] }[] = [{ op: 'replace', type: 'badPwdCount', values: [String(badPwdCount)] }];
      if (badPwdCount >= threshold) changes.push({ op: 'replace', type: 'lockoutTime', values: [String(now)] });
      this.tree.modifyEntry(entry.dn, changes);
    }
    return false;
  }

  isAccountLockedOut(sam: string): boolean {
    const entry = this.findUserEntry(sam);
    if (!entry) return false;
    const lockoutTime = Number(firstOf(entry.attributes.get('lockouttime'))) || 0;
    if (lockoutTime === 0) return false;
    const durationSeconds = (this.effectivePasswordPolicyFor(sam)?.lockoutDurationMinutes ?? 30) * 60;
    return Math.floor(Date.now() / 1000) - lockoutTime < durationSeconds;
  }

  /** `Unlock-ADAccount` — clears the lockout immediately, without waiting out the policy's duration. */
  unlockAccount(sam: string): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    this.tree.modifyEntry(entry.dn, [
      { op: 'replace', type: 'lockoutTime', values: [] }, { op: 'replace', type: 'badPwdCount', values: [] },
    ]);
    return { ok: true, message: '' };
  }

  /** `Set-ADAccountExpiration -DateTime`/`-TimeSpan` — `expiresAt` is an epoch-seconds timestamp; `null` clears it (`Clear-ADAccountExpiration`, real AD default: never expires). Only checked by `checkPassword` (LDAP simple bind), same deliberate scope as lockout — not consulted by the Kerberos AS-REQ path. */
  setAccountExpiration(sam: string, expiresAt: number | null): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'accountExpires', values: expiresAt !== null ? [String(expiresAt)] : [] }]);
    return { ok: true, message: '' };
  }

  isAccountExpired(sam: string): boolean {
    const entry = this.findUserEntry(sam);
    if (!entry) return false;
    const accountExpires = Number(firstOf(entry.attributes.get('accountexpires'))) || 0;
    return accountExpires > 0 && Math.floor(Date.now() / 1000) >= accountExpires;
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

  private createGroupEntry(sam: string, scope: AdGroup['scope'], containerDn: DistinguishedName, wellKnownRid?: number): DirOpResult {
    const rid = wellKnownRid ?? this.localRidPool.allocateNext();
    return this.tree.addEntry(this.cnDn(sam, containerDn), compact({
      objectClass: ['top', 'group'],
      cn: [sam],
      sAMAccountName: [sam],
      groupType: [String(GROUP_TYPE[scope])],
      objectSid: rid !== null ? [this.formatObjectSid(rid)] : [],
    }));
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

  private groupScopeOfDn(dnStr: string): AdGroup['scope'] | null {
    let dn: DistinguishedName;
    try { dn = parseDN(dnStr); } catch { return null; }
    const entry = this.tree.getByDn(dn);
    if (!entry || !hasObjectClass(entry, 'group')) return null;
    return SCOPE_OF_GROUP_TYPE.get(Number(firstOf(entry.attributes.get('grouptype')))) ?? null;
  }

  /**
   * `Set-ADGroup -GroupScope` (MS-ADTS §3.1.1.5.2.2) — real AD's own
   * conversion matrix: Global↔DomainLocal is never direct (must pass
   * through Universal); Global→Universal requires not being a member of
   * another Global group; DomainLocal→Universal requires no DomainLocal
   * members; Universal→Global requires no Universal members;
   * Universal→DomainLocal is always allowed.
   */
  setGroupScope(sam: string, newScope: AdGroup['scope']): DirOpResult {
    const entry = this.findGroupEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    const currentScope = SCOPE_OF_GROUP_TYPE.get(Number(firstOf(entry.attributes.get('grouptype')))) ?? 'Global';
    if (currentScope === newScope) return { ok: true, message: '' };

    if (currentScope === 'Global' && newScope === 'DomainLocal') {
      return { ok: false, message: 'Cannot directly convert a global-scope group to domain-local scope; convert to universal first.' };
    }
    if (currentScope === 'DomainLocal' && newScope === 'Global') {
      return { ok: false, message: 'Cannot directly convert a domain-local-scope group to global scope; convert to universal first.' };
    }
    if (currentScope === 'Global' && newScope === 'Universal') {
      const memberOfScopes = (entry.attributes.get('memberof') ?? []).map(dn => this.groupScopeOfDn(dn));
      if (memberOfScopes.includes('Global')) {
        return { ok: false, message: 'Cannot convert to universal scope: this group is a member of another global-scope group.' };
      }
    }
    if (currentScope === 'DomainLocal' && newScope === 'Universal') {
      const memberScopes = (entry.attributes.get('member') ?? []).map(dn => this.groupScopeOfDn(dn));
      if (memberScopes.includes('DomainLocal')) {
        return { ok: false, message: 'Cannot convert to universal scope: this group has a domain-local-scope member.' };
      }
    }
    if (currentScope === 'Universal' && newScope === 'Global') {
      const memberScopes = (entry.attributes.get('member') ?? []).map(dn => this.groupScopeOfDn(dn));
      if (memberScopes.includes('Universal')) {
        return { ok: false, message: 'Cannot convert to global scope: this group has a universal-scope member.' };
      }
    }

    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'groupType', values: [String(GROUP_TYPE[newScope])] }]);
    return { ok: true, message: '' };
  }

  private projectGroup(entry: DirectoryEntry): AdGroup {
    const groupType = Number(firstOf(entry.attributes.get('grouptype')));
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      dn: formatDN(entry.dn),
      scope: SCOPE_OF_GROUP_TYPE.get(groupType) ?? 'Global',
      members: (entry.attributes.get('member') ?? []).map(dnStr => this.samOfDn(dnStr)).filter((s): s is string => s !== null),
      objectSid: firstOf(entry.attributes.get('objectsid')),
      adminCount: firstOf(entry.attributes.get('admincount')) === '1',
    };
  }

  /** `Add-ADGroupMember` — `memberSam` may itself be a group (real AD supports nested groups); refuses direct or transitive self-membership (`Cannot make a group a member of itself` — a real, well-known AD error). */
  addGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.findGroupEntry(groupSam);
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    const member = this.findUserEntry(memberSam) ?? this.findComputerEntry(memberSam) ?? this.findGroupEntry(memberSam);
    if (!member) return { ok: false, message: `Cannot find an object with identity: '${memberSam}'.` };
    const memberDn = formatDN(member.dn);
    const groupDn = formatDN(group.dn);
    if (hasObjectClass(member, 'group')) {
      if (memberDn.toLowerCase() === groupDn.toLowerCase() || this.isReachableViaMembership(member, groupDn, new Set())) {
        return { ok: false, message: 'Cannot make a group a member of itself.' };
      }
    }
    this.tree.modifyEntry(group.dn, [{ op: 'add', type: 'member', values: [memberDn] }]);
    this.tree.modifyEntry(member.dn, [{ op: 'add', type: 'memberOf', values: [groupDn] }]);
    return { ok: true, message: '' };
  }

  /** `true` if `targetDn` is reachable by walking `fromGroup`'s own (possibly nested) `member` list — i.e. whether adding `fromGroup` as a member of the group at `targetDn` would close a cycle. Cycle-safe via `seen`. */
  private isReachableViaMembership(fromGroup: DirectoryEntry, targetDn: string, seen: Set<string>): boolean {
    const key = formatDN(fromGroup.dn).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    for (const memberDnStr of fromGroup.attributes.get('member') ?? []) {
      if (memberDnStr.toLowerCase() === targetDn.toLowerCase()) return true;
      let entry: DirectoryEntry | null;
      try { entry = this.tree.getByDn(parseDN(memberDnStr)); } catch { entry = null; }
      if (entry && hasObjectClass(entry, 'group') && this.isReachableViaMembership(entry, targetDn, seen)) return true;
    }
    return false;
  }

  removeGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.findGroupEntry(groupSam);
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    const member = this.findUserEntry(memberSam) ?? this.findComputerEntry(memberSam) ?? this.findGroupEntry(memberSam);
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
    const rid = this.localRidPool.allocateNext();
    const res = this.tree.addEntry(dn, compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
      cn: [name],
      sAMAccountName: [`${name}$`],
      userAccountControl: [String(UAC.WORKSTATION_TRUST_ACCOUNT)],
      userPassword: [machineSecret],
      objectSid: rid !== null ? [this.formatObjectSid(rid)] : [],
    }));
    if (!res.ok) return { ok: false, message: 'An object with that name already exists.' };
    this.addGroupMemberByDn('Domain Computers', dn);
    return { ok: true, message: '' };
  }

  /** `ms-DS-MachineAccountQuota` (default 10) — only ever consulted for a computer account created via a real LDAP `addRequest` (domain join, `LdapServerHandler`); `newComputer`/`promoteDomainController` (admin-driven or DC-bootstrap, direct local calls) are never subject to it, matching real AD's own quota semantics (it only gates the ordinary `SELF` create-child right, not an explicit administrative creation). */
  getMachineAccountQuota(): number {
    const raw = firstOf(this.tree.getByDn(this.tree.getRootDn())?.attributes.get('ms-ds-machineaccountquota'));
    return raw ? Number(raw) : 10;
  }

  setMachineAccountQuota(quota: number): void {
    this.tree.modifyEntry(this.tree.getRootDn(), [{ op: 'replace', type: 'ms-DS-MachineAccountQuota', values: [String(quota)] }]);
  }

  /** Domain Admins are exempt (real AD's quota only ever matters for an ordinary user); an anonymous bind (`creatorSam === null`) is always refused. */
  checkMachineAccountQuota(creatorSam: string | null): DirOpResult {
    if (!creatorSam) return { ok: false, message: 'unwillingToPerform: authentication required to create a computer account' };
    if (this.groupsForUser(creatorSam).some(g => g.sam === 'Domain Admins')) return { ok: true, message: '' };
    const quota = this.getMachineAccountQuota();
    const count = this.tree.allDescendants(this.tree.getRootDn())
      .filter(e => hasObjectClass(e, 'computer'))
      .filter(e => firstOf(e.attributes.get('createdbysam')).toLowerCase() === creatorSam.toLowerCase())
      .length;
    if (count >= quota) {
      return { ok: false, message: `unwillingToPerform: the machine account quota (${quota}) for this user has been exceeded` };
    }
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

  // ─── (Group) Managed Service Accounts ───────────────────────────────

  newServiceAccount(sam: string, opts: { isGroupManaged: boolean; principals: string[]; ou?: string }): DirOpResult {
    const containerDn = opts.ou ? this.ouDn(opts.ou) : this.computersOuDn;
    if (opts.ou && !this.tree.getByDn(containerDn)) {
      return { ok: false, message: `Cannot find an object with identity: '${opts.ou}'.` };
    }
    const rid = this.localRidPool.allocateNext();
    return this.msaStore.newServiceAccount(sam, containerDn, {
      isGroupManaged: opts.isGroupManaged, principals: opts.principals,
      objectSid: rid !== null ? this.formatObjectSid(rid) : undefined,
    });
  }

  getServiceAccount(sam: string): AdServiceAccount | null { return this.msaStore.getServiceAccount(sam); }
  listServiceAccounts(): AdServiceAccount[] { return this.msaStore.listServiceAccounts(); }
  resetManagedPassword(sam: string): DirOpResult { return this.msaStore.resetManagedPassword(sam); }
  setPrincipalsAllowedToRetrieveManagedPassword(sam: string, principals: string[]): DirOpResult {
    return this.msaStore.setPrincipalsAllowedToRetrieveManagedPassword(sam, principals);
  }

  /** For `LdapServerHandler`'s search gate on the constructed `msDS-ManagedPassword` attribute — see `ManagedServiceAccountStore.retrieveManagedPassword`. */
  retrieveManagedPassword(sam: string, requestingPrincipalSam: string | null): string | null {
    return this.msaStore.retrieveManagedPassword(sam, requestingPrincipalSam);
  }

  /** Creates the DC's own computer account under the Domain Controllers OU at promotion time — a distinct container and UAC flag (SERVER_TRUST_ACCOUNT) from a regular domain-joined workstation, matching real AD. */
  promoteDomainController(name: string, machineSecret: string): DirOpResult {
    const dcOuDn = this.ouDn('Domain Controllers');
    const rid = this.localRidPool.allocateNext();
    const res = this.tree.addEntry(this.cnDn(name, dcOuDn), compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
      cn: [name],
      sAMAccountName: [`${name}$`],
      userAccountControl: [String(UAC.SERVER_TRUST_ACCOUNT)],
      userPassword: [machineSecret],
      objectSid: rid !== null ? [this.formatObjectSid(rid)] : [],
    }), { bypassReadOnly: true });
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
      objectSid: firstOf(entry.attributes.get('objectsid')),
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
      containerDn: this.usersOuDn, enabled: false, wellKnownRid: WELL_KNOWN_RID.Krbtgt, passwordNeverExpires: true,
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
      resolvePrincipal: (name) => this.resolveIdentity(name),
    };
  }
}

function dnEqualsOu(dn: DistinguishedName, ou: DistinguishedName): boolean {
  return formatDN(dn).toLowerCase() === formatDN(ou).toLowerCase();
}
function leafOuName(dn: DistinguishedName): string {
  return dn[0]?.[0]?.value ?? '';
}
