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

import { DirectoryTree, type DirectoryEntry, type EntryReplMeta, type Modification } from './ldap/DirectoryTree';
import { parseDN, formatDN, leafValue, type DistinguishedName } from './ldap/LdapDN';
import type { LdapBindCheck } from './ldap/LdapServer';
import type { AdUser, AdGroup, AdComputer, AdOrgUnit, Gpo, GpoSettings, GpoAccountPolicy, GpoRegistryValue, GpoLinkInfo, AdFineGrainedPasswordPolicy, AdAccessRule, AdGenericObject, AdServiceAccount } from './AdTypes';
import { encodeGpLink, decodeGpLink } from './AdTypes';
import { generateId } from '@/network/core/types';
import {
  type HighWatermarkVector, emptyHighWatermarkVector, recordUsn, cloneHighWatermarkVector,
} from './replication/HighWatermarkVector';
import { SiteRegistry, type SiteOpResult, type SiteInfo, type SubnetInfo, type SiteLinkInfo, type SiteLinkTransport } from './forest/sites';
import { SchemaValidator } from './schema/SchemaValidator';
import { SchemaPartition, seedDefaultSchema } from './schema/SchemaPartition';
import type { AttributeSchema, ObjectClassSchema, SchemaOpResult } from './schema/SchemaValidator';
import { TrustRegistry, type TrustDirection, type TrustOpResult, type TrustInfo, type TrustRecord } from './forest/TrustRelationship';
import { DEFAULT_AD_FUNCTIONAL_LEVEL } from './adFunctionalLevels';
import { OU_PROPERTIES, PROTECTION_OBJECT_RIGHTS, PROTECTION_PARENT_RIGHT, isProtectionAce, protectionAce } from './adOrganizationalUnit';
import { NEVER_EXPIRES, USER_FLAGS, USER_PROPERTIES, CHANGE_PASSWORD_TRUSTEES, accountExpiresDate, applyUserFlag, cannotChangePasswordAce, isCannotChangePasswordAce, readUserFlag } from './adUser';

export interface DirOpResult { ok: boolean; message: string }

/** RFC-faithful AD userAccountControl bit flags (the subset this simulator needs). */
const UAC = {
  ACCOUNTDISABLE: 0x0002,
  NORMAL_ACCOUNT: 0x0200,
  WORKSTATION_TRUST_ACCOUNT: 0x1000,
  SERVER_TRUST_ACCOUNT: 0x2000,
  DONT_EXPIRE_PASSWORD: 0x10000,
} as const;

/** Real AD groupType bit-flag values: a scope bit (2/4/8) plus the top SECURITY_ENABLED bit (0x80000000) when the group is a security group — a Distribution group carries the same scope bit without that top bit set (docs/PRD-Exchange.md §1.2 point 3/§2.1 P3-préalable). */
const GROUP_SCOPE_BIT: Record<AdGroup['scope'], number> = {
  Global: 0x00000002,
  DomainLocal: 0x00000004,
  Universal: 0x00000008,
};
const SCOPE_OF_BIT = new Map<number, AdGroup['scope']>(
  (Object.keys(GROUP_SCOPE_BIT) as AdGroup['scope'][]).map(scope => [GROUP_SCOPE_BIT[scope], scope]),
);
const SECURITY_ENABLED_BIT = 0x80000000;

function computeGroupType(scope: AdGroup['scope'], category: AdGroup['category']): number {
  const bit = GROUP_SCOPE_BIT[scope];
  return category === 'Security' ? (bit | SECURITY_ENABLED_BIT) : bit;
}
function decodeGroupType(groupType: number): { scope: AdGroup['scope']; category: AdGroup['category'] } {
  const category: AdGroup['category'] = (groupType & SECURITY_ENABLED_BIT) !== 0 ? 'Security' : 'Distribution';
  const scope = SCOPE_OF_BIT.get(groupType & 0x0000000e) ?? 'Global';
  return { scope, category };
}

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }
function isEnabledFromUac(values: string[] | undefined): boolean {
  const uac = Number(firstOf(values));
  return Number.isFinite(uac) && (uac & UAC.ACCOUNTDISABLE) === 0;
}
function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}
/** Recycle-Bin-soft-deleted (`isDeleted=TRUE`) — every "normal" find/list method excludes these; only `-IncludeDeletedObjects` reaches them. */
function isSoftDeleted(entry: DirectoryEntry): boolean {
  return firstOf(entry.attributes.get('isdeleted')).toUpperCase() === 'TRUE';
}
/** Drop attribute keys with no values so we don't materialize empty multi-valued attributes on the entry. */
function compact(attrs: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.length > 0));
}
function hash32(seed: string, salt: number): number {
  let h = (salt * 0x9e3779b1) >>> 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h ^ seed.charCodeAt(i), 0x01000193)) >>> 0;
  return h;
}

export interface UserWriteOptions {
  commonName?: string;
  attributes?: Record<string, string>;
  flags?: Record<string, boolean>;
  spns?: string[];
  accountExpires?: string;
  changePasswordAtLogon?: boolean;
  cannotChangePassword?: boolean;
}

export interface OrgUnitWriteOptions {
  target?: { server: string; bindUser: string; bindPassword: string; authType: string; domainName?: string };
  attributes?: Record<string, string>;
  protected?: boolean;
}

export class DirectoryStore {
  private readonly tree: DirectoryTree;
  private readonly usersOuDn: DistinguishedName;
  private readonly computersOuDn: DistinguishedName;
  private readonly policiesDn: DistinguishedName;
  private readonly pswdSettingsDn: DistinguishedName;
  private readonly configurationDn: DistinguishedName;
  private readonly directoryServiceDn: DistinguishedName;
  private readonly deletedObjectsDn: DistinguishedName;
  /** `Enable-ADOptionalFeature -Identity "Recycle Bin Feature"` (PRD AD Recycle Bin) — irreversible, matching real AD; a non-empty list means enabled at those scope DNs (`CN=Partitions,CN=Configuration,...` for `-Scope ForestOrConfigurationSet`). */
  private recycleBinEnabledScopes: string[] = [];
  /** `Add-KdsRootKey` — real gMSA creation refuses without this present first. */
  private kdsRootKey: { keyId: string; effectiveTime: string } | null = null;
  /** This DC's stable replication identity (PRD-Windows-Server-Advanced.md §5 P4, MS-DRSR's invocationId) — one per `DirectoryStore` instance, for its whole lifetime. */
  private readonly invocationId = `invocation-${generateId()}`;
  private localUsn = 0;
  /** Highest USN already absorbed from each other known DC, via any replication partner — advances as `applyReplicatedEntry` runs. */
  private readonly inboundHighWatermark: HighWatermarkVector = emptyHighWatermarkVector();
  private readonly sites: SiteRegistry;
  private readonly schemaValidator: SchemaValidator;
  private readonly schema: SchemaPartition;
  private readonly trustRegistry: TrustRegistry;
  private readonly domainSidPrefix: string;
  private nextRid = 1000;
  private readonly acls = new Map<string, AdAccessRule[]>();

  /**
   * `opts.skipSeed` (PRD-Windows-Server-Advanced.md §5 P5): an additional
   * DC joining an *existing* domain (`Install-ADDSDomainController`) must
   * not independently create its own Users/Computers OUs and default
   * groups — those already exist on the domain and would replicate in as
   * duplicates. It instead starts with an empty tree and relies entirely
   * on the initial replication sync (§5 P4) to populate everything,
   * exactly like real DCPromo's initial-sync-from-a-source-DC step.
   */
  /**
   * The device's simulated clock (`WindowsPC.simulatedDate`), NOT wall-clock
   * `new Date()` — devices boot at a fixed simulated epoch
   * (`WindowsPC.wallEpoch`, unrelated to real time) so every timestamp this
   * store stamps (`pwdLastSet`, `whenChanged`, KDS root key `effectiveTime`)
   * must agree with what `Get-Date`/`Get-ADUserResultantPasswordPolicy`
   * date arithmetic sees, or `PasswordLastSet + MaxPasswordAge` comparisons
   * against `Get-Date` drift by however far the simulated epoch and real
   * wall-clock have diverged.
   */
  private readonly now: () => Date;

  domainMode: string = DEFAULT_AD_FUNCTIONAL_LEVEL.domainMode;

  constructor(
    readonly dnsName: string,
    readonly netbiosName: string,
    adminPassword: string,
    opts: { skipSeed?: boolean; sharedSchemaValidator?: SchemaValidator; now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    const rootDn = parseDN(this.dnsName.split('.').map(p => `DC=${p}`).join(','));
    this.schemaValidator = opts.sharedSchemaValidator ?? new SchemaValidator();
    this.tree = new DirectoryTree(rootDn, { objectClass: ['top', 'domain', 'domainDNS'] }, {
      invocationId: this.invocationId, nextUsn: () => ++this.localUsn,
    }, this.schemaValidator);
    this.domainSidPrefix = `S-1-5-21-${hash32(this.dnsName, 1)}-${hash32(this.dnsName, 2)}-${hash32(this.dnsName, 3)}`;
    this.usersOuDn = [...parseDN('CN=Users'), ...rootDn];
    this.computersOuDn = [...parseDN('CN=Computers'), ...rootDn];
    this.policiesDn = [...parseDN('CN=Policies'), ...parseDN('CN=System'), ...rootDn];
    this.pswdSettingsDn = [...parseDN('CN=Password Settings Container'), ...parseDN('CN=System'), ...rootDn];
    this.configurationDn = [...parseDN('CN=Configuration'), ...rootDn];
    this.directoryServiceDn = [...parseDN('CN=Directory Service'), ...parseDN('CN=Windows NT'), ...parseDN('CN=Services'), ...this.configurationDn];
    this.deletedObjectsDn = [...parseDN('CN=Deleted Objects'), ...rootDn];
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

  newSite(name: string, description = ''): SiteOpResult { return this.sites.newSite(name, description); }
  /** `Set-ADReplicationSite -Identity <old> -Name <new>` — also repoints every DC whose `site` attribute (assignServerToSite, below) held the old name, since that's a plain string copy, not a DN reference the rename would otherwise fix up on its own. */
  renameSite(oldName: string, newName: string): SiteOpResult {
    const res = this.sites.renameSite(oldName, newName);
    if (!res.ok) return res;
    for (const dc of this.listDomainControllers()) {
      if (this.siteForDc(dc.name) === oldName) this.assignServerToSite(dc.name, newName);
    }
    return res;
  }
  listSites(): SiteInfo[] { return this.sites.listSites(); }
  getSite(name: string): SiteInfo | null { return this.sites.getSite(name); }
  newSubnet(cidr: string, siteName: string, description = ''): SiteOpResult { return this.sites.newSubnet(cidr, siteName, description); }
  listSubnets(): SubnetInfo[] { return this.sites.listSubnets(); }
  /** The name of the site whose subnet contains `ip`, or null if none does (§2.2 scope — no fallback-site guessing). */
  siteForIp(ip: string): string | null { return this.sites.siteForIp(ip); }

  /** `New-ADReplicationSiteLink`/`Get`/`Set` — bookkeeping only, cost/frequency/schedule are stored and reported, never consulted to pace or route replication (PRD-Repadmin.md §0.2, same "no KCC" boundary as `/kcc`). */
  ensureDefaultSiteLink(): void { this.sites.ensureDefaultSiteLink(); }
  newSiteLink(
    name: string, sitesIncluded: string[],
    opts?: { cost?: number; replicationFrequencyInMinutes?: number; transport?: SiteLinkTransport; description?: string },
  ): SiteOpResult { return this.sites.newSiteLink(name, sitesIncluded, opts); }
  listSiteLinks(): SiteLinkInfo[] { return this.sites.listSiteLinks(); }
  getSiteLink(name: string): SiteLinkInfo | null { return this.sites.getSiteLink(name); }
  setSiteLink(
    name: string, patch: { cost?: number; replicationFrequencyInMinutes?: number; sitesIncluded?: string[]; description?: string },
  ): SiteOpResult { return this.sites.setSiteLink(name, patch); }

  /**
   * `Move-ADDirectoryServer -Identity <dc> -Site <site>` — explicit admin
   * override of a DC's site membership, independent of `siteForIp` (real
   * AD's own reason this cmdlet exists — see forest/sites.ts header).
   *
   * Stored as `site`/`ipAddress` attributes directly on the DC's own
   * computer-account entry (already reliably replicated — every
   * `Get-ADDomainController` test depends on that) rather than as a
   * separate `CN=Servers,CN=<site>,...` structural entry that would need
   * moving between sites: this simulator has no tombstone/deletion
   * replication (PRD-Repadmin.md §0.2 point 2 — permanent, not a gap to
   * close here), so a delete+add "move" would hard-delete on the
   * originating DC only, leaving a stale duplicate on every DC that
   * independently created its own copy (e.g. a DC's initial
   * self-assignment at promotion) — an attribute REPLACE on one
   * already-shared entry has no such split-brain failure mode.
   */
  assignServerToSite(dcName: string, siteName: string, ipAddress?: string): SiteOpResult {
    if (!this.sites.siteExists(siteName)) return { ok: false, message: `Cannot find a site named "${siteName}".` };
    const entry = this.findComputerEntry(dcName);
    if (!entry) return { ok: false, message: `Cannot find a domain controller named "${dcName}".` };
    const changes: Modification[] = [{ op: 'replace', type: 'site', values: [siteName] }];
    if (ipAddress) changes.push({ op: 'replace', type: 'ipAddress', values: [ipAddress] });
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  /** The site `dcName` is explicitly assigned to (via promotion-time auto-assignment or `Move-ADDirectoryServer`), or `null` if never assigned. */
  siteForDc(dcName: string): string | null {
    return firstOf(this.findComputerEntry(dcName)?.attributes.get('site')) || null;
  }

  /** The IP address recorded for `dcName` at its last `assignServerToSite` call (§ above — a pragmatic stand-in for DNS, which isn't replicated between DCs here), or `null`. */
  ipForDc(dcName: string): string | null {
    return firstOf(this.findComputerEntry(dcName)?.attributes.get('ipaddress')) || null;
  }

  /** The DC name whose recorded address is `ip`, or `null`. */
  dcForIp(ip: string): string | null {
    const dc = this.listDomainControllers().find(c => this.ipForDc(c.name) === ip);
    return dc?.name ?? null;
  }

  // ─── Trusts (PRD-Windows-Server-Advanced.md §5 P9) ─────────────────────

  addTrust(remoteRealm: string, direction: TrustDirection, transitive: boolean, interrealmKey: string, remoteNetbiosName?: string): TrustOpResult {
    return this.trustRegistry.addTrust(remoteRealm, direction, transitive, interrealmKey, remoteNetbiosName);
  }
  getTrust(remoteRealm: string): TrustRecord | null { return this.trustRegistry.getTrust(remoteRealm); }
  listTrusts(): TrustInfo[] { return this.trustRegistry.listTrusts(); }
  removeTrust(remoteRealm: string): TrustOpResult { return this.trustRegistry.removeTrust(remoteRealm); }
  resetTrustSecret(remoteRealm: string, newInterrealmKey: string): TrustOpResult { return this.trustRegistry.resetTrustSecret(remoteRealm, newInterrealmKey); }

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

  /** PRD-Repadmin.md P2: how far this DC has absorbed a specific partner's changes — `/showrepl`'s per-neighbor USN column. */
  highestKnownUsnFor(invocationId: string): number {
    return this.inboundHighWatermark.usnByInvocationId.get(invocationId) ?? 0;
  }

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
    this.tree.addEntry(this.pswdSettingsDn, { objectClass: ['top', 'container'], cn: ['Password Settings Container'] });
    this.tree.addEntry(this.configurationDn, { objectClass: ['top', 'container'], cn: ['Configuration'] });
    this.tree.addEntry([...parseDN('CN=Partitions'), ...this.configurationDn], { objectClass: ['top', 'container'], cn: ['Partitions'] });
    // Real AD's own crossRef object for this domain (`CN=<netbios>,CN=
    // Partitions,CN=Configuration,...`), carrying the NetBIOS↔DNS mapping
    // (`nETBIOSName`/`dnsRoot`) — queried over real LDAP by a remote DC
    // creating a trust with us (PRD-Wecutil.md's sibling gap fix,
    // WindowsServer.newADTrust §1.3 grounding) to learn our flat name for
    // its own 4769 `TargetDomainName` auditing, exactly as real cross-realm
    // Kerberos referral auditing does.
    this.tree.addEntry([...parseDN(`CN=${this.netbiosName}`), ...parseDN('CN=Partitions'), ...this.configurationDn], {
      objectClass: ['top', 'crossRef'], cn: [this.netbiosName], nETBIOSName: [this.netbiosName], dnsRoot: [this.dnsName],
    });
    this.tree.addEntry([...parseDN('CN=Services'), ...this.configurationDn], { objectClass: ['top', 'container'], cn: ['Services'] });
    this.tree.addEntry([...parseDN('CN=Windows NT'), ...parseDN('CN=Services'), ...this.configurationDn], { objectClass: ['top', 'container'], cn: ['Windows NT'] });
    this.tree.addEntry(this.directoryServiceDn, { objectClass: ['top', 'container'], cn: ['Directory Service'] });
    // Real AD always has this container, whether or not the Recycle Bin
    // optional feature is enabled (it also backs pre-2008-R2 tombstone
    // reanimation) — seeded unconditionally so `Enable-ADOptionalFeature`
    // only needs to flip the feature flag, not lazily create it.
    this.tree.addEntry(this.deletedObjectsDn, { objectClass: ['top', 'container'], cn: ['Deleted Objects'] });

    this.createGroupEntry('Domain Admins', 'Global', this.usersOuDn);
    this.createGroupEntry('Domain Users', 'Global', this.usersOuDn);
    this.createGroupEntry('Domain Computers', 'Global', this.usersOuDn);
    // Built-in group backing WEF/WEC (PRD-Wecutil.md §2.1 P2) — a
    // collector's machine account must be a member so it can read the
    // event logs of the sources it forwards from. Distinct from the
    // same-named *local* group already seeded by WindowsUserManager
    // (S-1-5-32-573) — `Add-ADGroupMember`/`Get-ADGroupMember` only ever
    // consult this directory-backed one.
    this.createGroupEntry('Event Log Readers', 'Global', this.usersOuDn);

    this.createUserEntry('Administrator', { password: adminPassword, fullName: 'Administrator', containerDn: this.usersOuDn });
    this.addGroupMember('Domain Admins', 'Administrator');
    this.addGroupMember('Domain Users', 'Administrator');
  }

  // ─── Organizational Units ───────────────────────────────────────────

  /** A real nested container DN (`OU=Child,OU=Parent,DC=...`) if `rawDn` names one that already exists, else `null` — real AD's `-Path` for OU/user/group creation, not just a leaf name under the domain root. */
  private resolveContainerDn(rawDn: string): DistinguishedName | null {
    try {
      const parsed = parseDN(rawDn);
      if (this.tree.getByDn(parsed)) return parsed;
    } catch { /* not a valid DN */ }
    return null;
  }

  /** `-Path`/`ou` container resolution shared by `newUser`/`newGroup`: a full nested DN first (real AD `-Path`), falling back to a bare OU name directly under the domain root for callers that only ever passed a leaf name. `undefined` input returns `fallback` unconditionally; a non-empty input that resolves to neither returns `null` (caller reports "not found"). */
  private resolveOuContainer(rawPathOrName: string | undefined, fallback: DistinguishedName): DistinguishedName | null {
    if (rawPathOrName === undefined) return fallback;
    const nested = this.resolveContainerDn(rawPathOrName);
    if (nested) return nested;
    const flat = this.ouDn(this.resolveIdentity(rawPathOrName));
    return this.tree.getByDn(flat) ? flat : null;
  }

  newOrgUnit(name: string, path?: string, opts: OrgUnitWriteOptions = {}): DirOpResult {
    const parentDn = path ? this.resolveContainerDn(path) : this.tree.getRootDn();
    if (!parentDn) return { ok: false, message: `Cannot find an object with identity: '${path}'.` };
    const dn = [...parseDN(`OU=${name}`), ...parentDn];
    const attributes: Record<string, string[]> = { objectClass: ['top', 'organizationalUnit'], ou: [name], name: [name] };
    for (const [ldap, value] of Object.entries(opts.attributes ?? {})) {
      if (value !== '') attributes[ldap] = [value];
    }
    const res = this.tree.addEntry(dn, attributes);
    if (!res.ok) return { ok: false, message: 'An object with that name already exists.' };
    this.setOrgUnitProtection(dn, opts.protected !== false);
    return { ok: true, message: '' };
  }

  setOrgUnitAttributes(identity: string, attributes: Record<string, string>): DirOpResult {
    const entry = this.findOrgUnitEntry(this.resolveIdentity(identity)) ?? this.resolveTargetEntry(identity);
    if (!entry || !hasObjectClass(entry, 'organizationalUnit')) {
      return { ok: false, message: `Cannot find an object with identity: '${identity}'.` };
    }
    for (const [ldap, value] of Object.entries(attributes)) {
      this.tree.modifyEntry(entry.dn, [value === ''
        ? { op: 'delete', type: ldap, values: [] }
        : { op: 'replace', type: ldap, values: [value] }]);
    }
    return { ok: true, message: '' };
  }

  setOrgUnitProtectionByIdentity(identity: string, protect: boolean): DirOpResult {
    const entry = this.findOrgUnitEntry(this.resolveIdentity(identity)) ?? this.resolveTargetEntry(identity);
    if (!entry || !hasObjectClass(entry, 'organizationalUnit')) {
      return { ok: false, message: `Cannot find an object with identity: '${identity}'.` };
    }
    this.setOrgUnitProtection(entry.dn, protect);
    return { ok: true, message: '' };
  }

  removeOrgUnit(identity: string, ctx?: { recursive?: boolean }): DirOpResult {
    const entry = this.findOrgUnitEntry(this.resolveIdentity(identity)) ?? this.resolveTargetEntry(identity);
    if (!entry || !hasObjectClass(entry, 'organizationalUnit')) {
      return { ok: false, message: `Cannot find an object with identity: '${identity}'.` };
    }
    const dnText = formatDN(entry.dn);
    if (this.deniedRight(dnText, 'Delete')) {
      return { ok: false, message: `Access is denied. The object ${dnText} is protected from accidental deletion.` };
    }
    const children = this.tree.allDescendants(entry.dn).filter(e => e.dn.length > entry.dn.length);
    if (children.length > 0 && ctx?.recursive !== true) {
      return { ok: false, message: 'The directory service can perform the requested operation only on a leaf object.' };
    }
    for (const child of [...children].sort((a, b) => b.dn.length - a.dn.length)) {
      if (this.deniedRight(formatDN(child.dn), 'Delete')) {
        return { ok: false, message: `Access is denied. The object ${formatDN(child.dn)} is protected from accidental deletion.` };
      }
    }
    for (const child of [...children].sort((a, b) => b.dn.length - a.dn.length)) this.softOrHardDelete(child);
    return this.softOrHardDelete(entry);
  }

  private setOrgUnitProtection(dn: DistinguishedName, protect: boolean): void {
    const own = formatDN(dn);
    const kept = (this.getAcl(own) ?? []).filter(ace => !isProtectionAce(ace));
    this.setAcl(own, protect ? [...kept, ...PROTECTION_OBJECT_RIGHTS.map(protectionAce)] : kept);
    if (dn.length <= this.tree.getRootDn().length) return;
    const parent = formatDN(dn.slice(1));
    const parentKept = (this.getAcl(parent) ?? []).filter(ace => !isProtectionAce(ace));
    const stillProtected = protect || this.tree.allDescendants(dn.slice(1))
      .some(child => child.dn.length === dn.length && this.deniedRight(formatDN(child.dn), 'Delete'));
    this.setAcl(parent, stillProtected ? [...parentKept, protectionAce(PROTECTION_PARENT_RIGHT)] : parentKept);
  }

  isOrgUnitProtected(dn: string): boolean { return this.deniedRight(dn, 'Delete'); }

  private findOrgUnitEntry(name: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'ou', value: name })
      .filter(e => hasObjectClass(e, 'organizationalUnit'));
    return entry ?? null;
  }

  getOrgUnit(name: string): AdOrgUnit | null {
    const entry = this.findOrgUnitEntry(name);
    return entry ? this.projectOrgUnit(entry) : null;
  }

  listOrgUnits(): AdOrgUnit[] {
    return this.tree.allDescendants(this.tree.getRootDn())
      .filter(e => hasObjectClass(e, 'organizationalUnit'))
      .map(e => this.projectOrgUnit(e));
  }

  private projectOrgUnit(entry: DirectoryEntry): AdOrgUnit {
    const properties: Record<string, string> = {};
    const known = new Set(['objectclass', 'ou', 'name', 'gplink']);
    for (const spec of OU_PROPERTIES) {
      known.add(spec.ldap.toLowerCase());
      const value = firstOf(entry.attributes.get(spec.ldap.toLowerCase()));
      if (value) properties[spec.parameter] = value;
    }
    for (const [ldap, values] of entry.attributes) {
      if (!known.has(ldap.toLowerCase()) && values.length > 0) {
        properties[this.tree.canonicalAttributeName(ldap)] = values[0];
      }
    }
    return {
      name: firstOf(entry.attributes.get('ou')), dn: formatDN(entry.dn),
      gpLinks: (entry.attributes.get('gplink') ?? []).map(v => decodeGpLink(v).gpoDn),
      properties, protectedFromAccidentalDeletion: this.isOrgUnitProtected(formatDN(entry.dn)),
    };
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
    const auditPolicyJson = firstOf(entry.attributes.get('gpoauditpolicy'));
    const registryPolicyJson = firstOf(entry.attributes.get('gporegistrypolicy'));
    const gpoDn = formatDN(entry.dn);
    return {
      id: firstOf(entry.attributes.get('cn')),
      name: firstOf(entry.attributes.get('displayname')),
      links: this.tree.allDescendants(this.tree.getRootDn())
        .filter(e => (e.attributes.get('gplink') ?? []).some(v => decodeGpLink(v).gpoDn.toLowerCase() === gpoDn.toLowerCase()))
        .map(e => formatDN(e.dn)),
      settings: {
        accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
        logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
        startupScript: startupScript || undefined,
        auditPolicy: auditPolicyJson ? JSON.parse(auditPolicyJson) : undefined,
        registryPolicy: registryPolicyJson ? JSON.parse(registryPolicyJson) : undefined,
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
    if (settings.auditPolicy !== undefined) changes.push({ op: 'replace', type: 'gpoAuditPolicy', values: [JSON.stringify(settings.auditPolicy)] });
    if (settings.registryPolicy !== undefined) changes.push({ op: 'replace', type: 'gpoRegistryPolicy', values: [JSON.stringify(settings.registryPolicy)] });
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  /** `Set-GPRegistryValue` — records/updates one registry-based policy entry on a GPO (keyed by key+valueName), applied into the target's registry hive by `gpupdate` (PRD-Windows-Server.md §5 P10). */
  setGpRegistryValue(gpoName: string, entryPatch: GpoRegistryValue): DirOpResult {
    const gpo = this.getGpo(gpoName);
    if (!gpo) return { ok: false, message: `Cannot find a GPO with name "${gpoName}".` };
    const existing = gpo.settings.registryPolicy ?? [];
    const idx = existing.findIndex(e => e.key.toLowerCase() === entryPatch.key.toLowerCase() && e.valueName.toLowerCase() === entryPatch.valueName.toLowerCase());
    const next = [...existing];
    if (idx >= 0) next[idx] = entryPatch; else next.push(entryPatch);
    return this.setGpoSettings(gpoName, { registryPolicy: next });
  }

  /** `New-GPLink` — links a GPO to a domain or OU DN (`gPLink`, RFC-faithful attribute name — real AD stores an ordered, precedence-flagged list encoded as a trailing options bitmask on each link string; this simulator mirrors that shape (`<gpoDn>;linkEnabled=..;enforced=..;order=..`) instead of a bare DN, so `-LinkEnabled`/`-Enforced`/`-Order` round-trip through `Get-GPInheritance`). */
  newGPLink(gpoName: string, targetDn: string, opts?: { linkEnabled?: boolean; enforced?: boolean; order?: number }): DirOpResult {
    const gpo = this.findGpoEntry(gpoName);
    if (!gpo) return { ok: false, message: `Cannot find a GPO with name "${gpoName}".` };
    const targetEntry = this.resolveTargetEntry(targetDn);
    if (!targetEntry) return { ok: false, message: `Cannot find an object with distinguished name: '${targetDn}'.` };
    const gpoDn = formatDN(gpo.dn);
    const existingLinks = targetEntry.attributes.get('gplink') ?? [];
    if (existingLinks.some(v => decodeGpLink(v).gpoDn.toLowerCase() === gpoDn.toLowerCase())) {
      return { ok: false, message: `The GPO "${gpoName}" is already linked to '${targetDn}'.` };
    }
    const encoded = encodeGpLink(gpoDn, {
      linkEnabled: opts?.linkEnabled ?? true,
      enforced: opts?.enforced ?? false,
      order: opts?.order ?? 1,
    });
    this.tree.modifyEntry(targetEntry.dn, [{ op: 'add', type: 'gPLink', values: [encoded] }]);
    return { ok: true, message: '' };
  }

  /** `Set-GPLink` — updates the link options (`-LinkEnabled`/`-Enforced`/`-Order`) of an EXISTING link between a GPO and a target; fields omitted from `opts` keep their current value. */
  setGpLink(gpoName: string, targetDn: string, opts: { linkEnabled?: boolean; enforced?: boolean; order?: number }): DirOpResult {
    const gpo = this.findGpoEntry(gpoName);
    if (!gpo) return { ok: false, message: `Cannot find a GPO with name "${gpoName}".` };
    const targetEntry = this.resolveTargetEntry(targetDn);
    if (!targetEntry) return { ok: false, message: `Cannot find an object with distinguished name: '${targetDn}'.` };
    const gpoDn = formatDN(gpo.dn).toLowerCase();
    const links = targetEntry.attributes.get('gplink') ?? [];
    const idx = links.findIndex(v => decodeGpLink(v).gpoDn.toLowerCase() === gpoDn);
    if (idx < 0) return { ok: false, message: `The GPO "${gpoName}" is not linked to '${targetDn}'.` };
    const current = decodeGpLink(links[idx]);
    const next = [...links];
    next[idx] = encodeGpLink(current.gpoDn, {
      linkEnabled: opts.linkEnabled ?? current.linkEnabled,
      enforced: opts.enforced ?? current.enforced,
      order: opts.order ?? current.order,
    });
    this.tree.modifyEntry(targetEntry.dn, [{ op: 'replace', type: 'gPLink', values: next }]);
    return { ok: true, message: '' };
  }

  /**
   * RSoP for a computer, real precedence order: domain-linked GPOs first,
   * then GPOs linked to the computer's own OU (more specific — its
   * settings override the domain's on conflicting keys). Only direct
   * links are honored (no OU-hierarchy walk beyond the computer's
   * immediate container). Disabled links (`-LinkEnabled No`) never apply;
   * an Enforced domain-level link still applies even when the computer's
   * own OU has inheritance blocked — real AD's "Enforced wins over
   * blocked inheritance" rule.
   *
   * `userSam`, when given, additionally folds in GPOs linked to the
   * logged-on user's own OU — real AD's User Configuration settings
   * (folder redirection, HKCU registry policy, …) resolve against the
   * USER object's location, independently of where the computer object
   * sits (this simulator doesn't model Loopback Processing, so there's
   * no computer-OU override of that for now).
   */
  resultantSetOfPolicy(computerName?: string, userSam?: string): { appliedGpoNames: string[]; settings: GpoSettings } {
    let ouEntry: DirectoryEntry | null = null;
    if (computerName) {
      const computer = this.findComputerEntry(computerName);
      if (computer) ouEntry = this.tree.getByDn(computer.dn.slice(1));
    }
    let userOuEntry: DirectoryEntry | null = null;
    if (userSam) {
      const user = this.findUserEntry(userSam);
      if (user) userOuEntry = this.tree.getByDn(user.dn.slice(1));
    }
    const inheritanceBlocked = ouEntry ? firstOf(ouEntry.attributes.get('gpoptions')) === '1' : false;
    const domainLinks = this.linkedGposFor(this.tree.getRootDn()).filter(l => l.enabled && (l.enforced || !inheritanceBlocked));
    const ouLinks = ouEntry ? this.linkedGposFor(ouEntry.dn).filter(l => l.enabled) : [];
    const userOuLinks = (userOuEntry && userOuEntry.dn.join(',') !== ouEntry?.dn.join(','))
      ? this.linkedGposFor(userOuEntry.dn).filter(l => l.enabled) : [];
    const ordered = [...domainLinks, ...ouLinks, ...userOuLinks].sort((a, b) => a.order - b.order).map(l => l.gpo);
    const merged: GpoSettings = {};
    for (const gpo of ordered) {
      if (gpo.settings.accountPolicy !== undefined) merged.accountPolicy = { ...merged.accountPolicy, ...gpo.settings.accountPolicy };
      if (gpo.settings.logonBanner !== undefined) merged.logonBanner = gpo.settings.logonBanner;
      if (gpo.settings.startupScript !== undefined) merged.startupScript = gpo.settings.startupScript;
      if (gpo.settings.auditPolicy !== undefined) merged.auditPolicy = { ...merged.auditPolicy, ...gpo.settings.auditPolicy };
      if (gpo.settings.registryPolicy !== undefined) {
        const byKey = new Map((merged.registryPolicy ?? []).map(e => [`${e.key.toLowerCase()}|${e.valueName.toLowerCase()}`, e]));
        for (const e of gpo.settings.registryPolicy) byKey.set(`${e.key.toLowerCase()}|${e.valueName.toLowerCase()}`, e);
        merged.registryPolicy = Array.from(byKey.values());
      }
    }
    return { appliedGpoNames: ordered.map(g => g.name), settings: merged };
  }

  setGpInheritance(targetDn: string, blocked: boolean): DirOpResult {
    const entry = this.resolveTargetEntry(targetDn);
    if (!entry) return { ok: false, message: `Cannot find an object with distinguished name: '${targetDn}'.` };
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'gPOptions', values: [blocked ? '1' : '0'] }]);
    return { ok: true, message: '' };
  }

  getGpInheritance(targetDn: string): { dn: string; gpoInheritanceBlocked: boolean; gpoLinks: GpoLinkInfo[] } | null {
    const entry = this.resolveTargetEntry(targetDn);
    if (!entry) return null;
    const links = entry.attributes.get('gplink') ?? [];
    return {
      dn: formatDN(entry.dn),
      gpoInheritanceBlocked: firstOf(entry.attributes.get('gpoptions')) === '1',
      gpoLinks: links.map(raw => {
        const decoded = decodeGpLink(raw);
        const gpoEntry = this.tree.getByDn(parseDN(decoded.gpoDn));
        return {
          displayName: gpoEntry ? firstOf(gpoEntry.attributes.get('displayname')) : decoded.gpoDn,
          gpoDn: decoded.gpoDn,
          enabled: decoded.linkEnabled,
          enforced: decoded.enforced,
          order: decoded.order,
        };
      }),
    };
  }

  private linkedGposFor(dn: DistinguishedName): Array<{ gpo: Gpo; enabled: boolean; enforced: boolean; order: number }> {
    const entry = this.tree.getByDn(dn);
    const links = entry?.attributes.get('gplink') ?? [];
    return links
      .map(raw => {
        const decoded = decodeGpLink(raw);
        let gpoEntry: DirectoryEntry | null;
        try { gpoEntry = this.tree.getByDn(parseDN(decoded.gpoDn)); } catch { gpoEntry = null; }
        if (!gpoEntry) return null;
        return { gpo: this.projectGpo(gpoEntry), enabled: decoded.linkEnabled, enforced: decoded.enforced, order: decoded.order };
      })
      .filter((l): l is { gpo: Gpo; enabled: boolean; enforced: boolean; order: number } => l !== null);
  }

  // ─── Password policy: Default Domain Policy + Fine-Grained (PSO) ────
  //
  // The Default Domain Password Policy is real Windows Server's own
  // account-policy settings on the "Default Domain Policy" GPO — not a
  // separate store, matching where real AD actually keeps it (Computer
  // Configuration > Windows Settings > Security Settings > Account
  // Policies). FGPPs (`msDS-PasswordSettings`) are real entries under a
  // "Password Settings Container" sibling of the Policies container,
  // replicating like any other object; each PSO's settings blob reuses
  // the same `GpoAccountPolicy` shape as the domain policy's.

  getDefaultDomainPasswordPolicy(): GpoAccountPolicy {
    return this.getGpo('Default Domain Policy')?.settings.accountPolicy ?? {};
  }

  setDefaultDomainPasswordPolicy(patch: GpoAccountPolicy): DirOpResult {
    const gpo = this.getGpo('Default Domain Policy');
    if (!gpo) return { ok: false, message: 'Cannot find the Default Domain Policy GPO.' };
    return this.setGpoSettings('Default Domain Policy', { accountPolicy: { ...gpo.settings.accountPolicy, ...patch } });
  }

  private findPsoEntry(name: string): DirectoryEntry | null {
    return this.tree.getByDn(this.cnDn(name, this.pswdSettingsDn));
  }

  newFineGrainedPasswordPolicy(name: string, precedence: number, settings: GpoAccountPolicy, description?: string): DirOpResult {
    const res = this.tree.addEntry(this.cnDn(name, this.pswdSettingsDn), {
      objectClass: ['top', 'msDS-PasswordSettings'],
      cn: [name],
      'msDS-PasswordSettingsPrecedence': [String(precedence)],
      'msDS-PSOSettings': [JSON.stringify(settings)],
      ...(description ? { description: [description] } : {}),
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A password settings object named "${name}" already exists.` };
  }

  getFineGrainedPasswordPolicy(name: string): AdFineGrainedPasswordPolicy | null {
    const entry = this.findPsoEntry(name);
    return entry ? this.projectPso(entry) : null;
  }

  listFineGrainedPasswordPolicies(): AdFineGrainedPasswordPolicy[] {
    return this.tree.allDescendants(this.pswdSettingsDn).filter(e => hasObjectClass(e, 'msDS-PasswordSettings')).map(e => this.projectPso(e));
  }

  private projectPso(entry: DirectoryEntry): AdFineGrainedPasswordPolicy {
    const settingsJson = firstOf(entry.attributes.get('msds-psosettings'));
    return {
      name: firstOf(entry.attributes.get('cn')),
      precedence: Number(firstOf(entry.attributes.get('msds-passwordsettingsprecedence')) || '0'),
      description: firstOf(entry.attributes.get('description')),
      settings: settingsJson ? JSON.parse(settingsJson) as GpoAccountPolicy : {},
    };
  }

  /** `Add-ADFineGrainedPasswordPolicySubject` — subjects may be users or groups (real AD's `msDS-PSOAppliesTo` accepts either). */
  addFineGrainedPasswordPolicySubject(name: string, subjectSams: string[]): DirOpResult {
    const entry = this.findPsoEntry(name);
    if (!entry) return { ok: false, message: `Cannot find a password settings object with identity: '${name}'.` };
    const dns: string[] = [];
    for (const sam of subjectSams) {
      const subject = this.findUserEntry(sam) ?? this.findGroupEntry(sam);
      if (!subject) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
      dns.push(formatDN(subject.dn));
    }
    this.tree.modifyEntry(entry.dn, [{ op: 'add', type: 'msDS-PSOAppliesTo', values: dns }]);
    return { ok: true, message: '' };
  }

  listFineGrainedPasswordPolicySubjects(name: string): string[] {
    const entry = this.findPsoEntry(name);
    if (!entry) return [];
    return (entry.attributes.get('msds-psoappliesto') ?? []).map(dnStr => this.samOfDn(dnStr)).filter((s): s is string => s !== null);
  }

  /**
   * `Get-ADUserResultantPasswordPolicy` — the PSO with the LOWEST
   * Precedence among every PSO the user is a subject of, directly or via
   * group membership (real AD's own tie-breaking rule). Null when no PSO
   * applies — the Default Domain Policy governs implicitly, matching
   * real AD returning nothing in that case rather than that policy
   * itself.
   */
  getResultantPasswordPolicy(userSam: string): AdFineGrainedPasswordPolicy | null {
    const user = this.findUserEntry(userSam);
    if (!user) return null;
    const userDn = formatDN(user.dn).toLowerCase();
    const groupDns = new Set((user.attributes.get('memberof') ?? []).map(d => d.toLowerCase()));
    const applicable = this.listPsoEntries().filter(entry => {
      const subjects = entry.attributes.get('msds-psoappliesto') ?? [];
      return subjects.some(dn => dn.toLowerCase() === userDn || groupDns.has(dn.toLowerCase()));
    });
    if (applicable.length === 0) return null;
    applicable.sort((a, b) =>
      Number(firstOf(a.attributes.get('msds-passwordsettingsprecedence'))) - Number(firstOf(b.attributes.get('msds-passwordsettingsprecedence'))));
    return this.projectPso(applicable[0]);
  }

  private listPsoEntries(): DirectoryEntry[] {
    return this.tree.allDescendants(this.pswdSettingsDn).filter(e => hasObjectClass(e, 'msDS-PasswordSettings'));
  }

  // ─── Users ──────────────────────────────────────────────────────────

  newUser(sam: string, opts: { password: string; fullName?: string; ou?: string; enabled?: boolean; department?: string; title?: string; emailAddress?: string; passwordNeverExpires?: boolean; actingSam?: string } & UserWriteOptions): DirOpResult {
    const containerDn = this.resolveOuContainer(opts.ou, this.usersOuDn);
    if (!containerDn) {
      return { ok: false, message: `Cannot find an object with identity: '${opts.ou}'.` };
    }
    if (opts.actingSam && !this.hasPermission(opts.actingSam, formatDN(containerDn), 'CreateChild')) {
      return { ok: false, message: 'Access is denied.' };
    }
    const res = this.createUserEntry(sam, {
      password: opts.password, fullName: opts.fullName ?? '', containerDn, enabled: opts.enabled,
      department: opts.department, title: opts.title, emailAddress: opts.emailAddress,
      passwordNeverExpires: opts.passwordNeverExpires,
      commonName: opts.commonName,
      attributes: opts.attributes, flags: opts.flags, spns: opts.spns,
      accountExpires: opts.accountExpires, changePasswordAtLogon: opts.changePasswordAtLogon,
    });
    if (!res.ok) return res;
    if (opts.cannotChangePassword) this.setCannotChangePassword(sam, true);
    this.addGroupMember('Domain Users', sam);
    return { ok: true, message: '' };
  }

  private nextObjectSid(): string { return `${this.domainSidPrefix}-${this.nextRid++}`; }

  private createUserEntry(sam: string, opts: { password: string; fullName: string; containerDn: DistinguishedName; enabled?: boolean; department?: string; title?: string; emailAddress?: string; passwordNeverExpires?: boolean } & UserWriteOptions): DirOpResult {
    const enabled = opts.enabled ?? true;
    let uac = enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE;
    if (opts.passwordNeverExpires) uac |= UAC.DONT_EXPIRE_PASSWORD;
    for (const spec of USER_FLAGS) {
      const wanted = opts.flags?.[spec.parameter];
      if (wanted !== undefined) uac = applyUserFlag(uac, spec, wanted);
    }
    const attributes: Record<string, string[]> = compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: [opts.commonName || sam],
      name: [opts.commonName || sam],
      sAMAccountName: [sam],
      userPrincipalName: [`${sam}@${this.dnsName}`],
      objectSid: [this.nextObjectSid()],
      userAccountControl: [String(uac)],
      userPassword: [opts.password],
      displayName: opts.fullName ? [opts.fullName] : [],
      department: opts.department ? [opts.department] : [],
      title: opts.title ? [opts.title] : [],
      mail: opts.emailAddress ? [opts.emailAddress] : [],
      pwdLastSet: [opts.changePasswordAtLogon ? '0' : this.now().toISOString()],
      accountExpires: [opts.accountExpires ?? NEVER_EXPIRES],
      servicePrincipalName: opts.spns ?? [],
    });
    for (const [ldap, value] of Object.entries(opts.attributes ?? {})) {
      if (value !== '') attributes[ldap] = [value];
    }
    const res = this.tree.addEntry(this.cnDn(opts.commonName || sam, opts.containerDn), attributes);
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  setCannotChangePassword(identity: string, blocked: boolean): DirOpResult {
    const entry = this.findUserEntry(this.resolveIdentity(identity));
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${identity}'.` };
    const dn = formatDN(entry.dn);
    const kept = (this.getAcl(dn) ?? []).filter(ace => !isCannotChangePasswordAce(ace));
    this.setAcl(dn, blocked ? [...kept, ...CHANGE_PASSWORD_TRUSTEES.map(cannotChangePasswordAce)] : kept);
    return { ok: true, message: '' };
  }

  cannotChangePassword(dn: string): boolean {
    return (this.getAcl(dn) ?? []).some(isCannotChangePasswordAce);
  }

  private findUserEntry(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam })
      .filter(e => hasObjectClass(e, 'user') && !hasObjectClass(e, 'computer') && !isSoftDeleted(e));
    return entry ?? null;
  }

  getUser(sam: string): AdUser | null {
    const entry = this.findUserEntry(sam);
    return entry ? this.projectUser(entry) : null;
  }

  listUsers(): AdUser[] {
    return this.tree.allDescendants(this.tree.getRootDn())
      .filter(e => hasObjectClass(e, 'user') && !hasObjectClass(e, 'computer') && !isSoftDeleted(e))
      .map(e => this.projectUser(e));
  }

  private projectUserProperties(entry: DirectoryEntry): Record<string, string> {
    const known = new Set(['objectclass', 'cn', 'name', 'samaccountname', 'objectsid', 'useraccountcontrol',
      'userpassword', 'pwdlastset', 'accountexpires', 'serviceprincipalname', 'memberof', 'ou']);
    const out: Record<string, string> = {};
    for (const spec of USER_PROPERTIES) {
      known.add(spec.ldap.toLowerCase());
      const value = firstOf(entry.attributes.get(spec.ldap.toLowerCase()));
      if (value) out[spec.parameter] = value;
    }
    for (const [ldap, values] of entry.attributes) {
      if (!known.has(ldap.toLowerCase()) && values.length > 0) {
        out[this.tree.canonicalAttributeName(ldap)] = values[0];
      }
    }
    return out;
  }

  private projectUserFlags(entry: DirectoryEntry): Record<string, boolean> {
    const uac = Number(firstOf(entry.attributes.get('useraccountcontrol'))) || 0;
    const out: Record<string, boolean> = {};
    for (const spec of USER_FLAGS) out[spec.parameter] = readUserFlag(uac, spec);
    return out;
  }

  private projectUser(entry: DirectoryEntry): AdUser {
    const containerDn = entry.dn.slice(1);
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      upn: firstOf(entry.attributes.get('userprincipalname')),
      dn: formatDN(entry.dn),
      sid: firstOf(entry.attributes.get('objectsid')),
      ou: dnEqualsOu(containerDn, this.usersOuDn) ? 'Users' : firstOf(entry.attributes.get('ou')) || leafOuName(containerDn),
      enabled: isEnabledFromUac(entry.attributes.get('useraccountcontrol')),
      password: firstOf(entry.attributes.get('userpassword')),
      emailAddress: firstOf(entry.attributes.get('mail')),
      passwordLastSet: firstOf(entry.attributes.get('pwdlastset')),
      passwordNeverExpires: (Number(firstOf(entry.attributes.get('useraccountcontrol'))) & UAC.DONT_EXPIRE_PASSWORD) !== 0,
      memberOf: (entry.attributes.get('memberof') ?? []).map(dnStr => this.samOfDn(dnStr)).filter((s): s is string => s !== null),
      fullName: firstOf(entry.attributes.get('displayname')),
      properties: this.projectUserProperties(entry),
      flags: this.projectUserFlags(entry),
      accountExpirationDate: accountExpiresDate(firstOf(entry.attributes.get('accountexpires'))),
      cannotChangePassword: this.cannotChangePassword(formatDN(entry.dn)),
      changePasswordAtLogon: firstOf(entry.attributes.get('pwdlastset')) === '0',
      department: firstOf(entry.attributes.get('department')),
      title: firstOf(entry.attributes.get('title')),
      servicePrincipalNames: entry.attributes.get('serviceprincipalname') ?? [],
      profilePath: firstOf(entry.attributes.get('profilepath')),
      homeDirectory: firstOf(entry.attributes.get('homedirectory')),
      homeDrive: firstOf(entry.attributes.get('homedrive')),
    };
  }

  setUser(sam: string, opts: { enabled?: boolean; fullName?: string; password?: string; department?: string; title?: string; addSpns?: string[]; removeSpns?: string[]; actingSam?: string; profilePath?: string; homeDirectory?: string; homeDrive?: string }): DirOpResult {
    const entry = this.findUserEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    if (opts.actingSam) {
      const targetDn = formatDN(entry.dn);
      if (opts.password !== undefined && !this.hasPermission(opts.actingSam, targetDn, 'ExtendedRight')) {
        return { ok: false, message: 'Access is denied.' };
      }
      const changesOtherThanPassword = opts.enabled !== undefined || opts.fullName !== undefined || opts.department !== undefined
        || opts.title !== undefined || (opts.addSpns?.length ?? 0) > 0 || (opts.removeSpns?.length ?? 0) > 0;
      if (changesOtherThanPassword && !this.hasPermission(opts.actingSam, targetDn, 'WriteProperty')) {
        return { ok: false, message: 'Access is denied.' };
      }
    }
    const changes: { op: 'replace' | 'add' | 'delete'; type: string; values: string[] }[] = [];
    if (opts.enabled !== undefined) {
      changes.push({ op: 'replace', type: 'userAccountControl', values: [String(opts.enabled ? UAC.NORMAL_ACCOUNT : UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE)] });
    }
    if (opts.fullName !== undefined) changes.push({ op: 'replace', type: 'displayName', values: opts.fullName ? [opts.fullName] : [] });
    if (opts.password !== undefined) {
      changes.push({ op: 'replace', type: 'userPassword', values: [opts.password] });
      changes.push({ op: 'replace', type: 'pwdLastSet', values: [this.now().toISOString()] });
    }
    if (opts.department !== undefined) changes.push({ op: 'replace', type: 'department', values: opts.department ? [opts.department] : [] });
    if (opts.title !== undefined) changes.push({ op: 'replace', type: 'title', values: opts.title ? [opts.title] : [] });
    if (opts.addSpns && opts.addSpns.length > 0) changes.push({ op: 'add', type: 'servicePrincipalName', values: opts.addSpns });
    if (opts.removeSpns && opts.removeSpns.length > 0) changes.push({ op: 'delete', type: 'servicePrincipalName', values: opts.removeSpns });
    if (opts.profilePath !== undefined) changes.push({ op: 'replace', type: 'profilePath', values: opts.profilePath ? [opts.profilePath] : [] });
    if (opts.homeDirectory !== undefined) changes.push({ op: 'replace', type: 'homeDirectory', values: opts.homeDirectory ? [opts.homeDirectory] : [] });
    if (opts.homeDrive !== undefined) changes.push({ op: 'replace', type: 'homeDrive', values: opts.homeDrive ? [opts.homeDrive] : [] });
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
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'user') && !hasObjectClass(e, 'computer') && !isSoftDeleted(e));
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
    return this.softOrHardDelete(entry);
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
    return this.softOrHardDelete(entry);
  }

  /** `Remove-ADGroup` — same shape as `removeUser`/`removeComputer`; also unlinks this group from any parent group it's nested in. The group's OWN `member` attribute is left untouched, so a `Restore-ADObject` brings its membership back automatically (real AD Recycle Bin's actual behavior — no separate membership ledger needed). */
  removeGroup(sam: string): DirOpResult {
    const entry = this.findGroupEntry(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    const groupDn = formatDN(entry.dn);
    for (const group of this.listGroupEntries()) {
      if (group === entry) continue;
      if ((group.attributes.get('member') ?? []).some(m => m.toLowerCase() === groupDn.toLowerCase())) {
        this.tree.modifyEntry(group.dn, [{ op: 'delete', type: 'member', values: [groupDn] }]);
      }
    }
    return this.softOrHardDelete(entry);
  }

  // ─── AD Recycle Bin / Optional Features ─────────────────────────────

  /** `(Get-ADRootDSE).configurationNamingContext`. */
  getConfigurationNamingContext(): string { return formatDN(this.configurationDn); }

  /** `Get-ADObject -Identity "CN=Directory Service,CN=Windows NT,CN=Services,$ConfigNC"` — the well-known object real `Set-ADObject -Replace @{msDS-DeletedObjectLifetime=...}` targets. */
  getDirectoryServiceObjectDn(): string { return formatDN(this.directoryServiceDn); }

  getOptionalFeature(name: string): { name: string; enabledScopes: string[] } | null {
    if (name.toLowerCase() !== 'recycle bin feature') return null;
    return { name: 'Recycle Bin Feature', enabledScopes: [...this.recycleBinEnabledScopes] };
  }

  /** `Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target <domain>` — irreversible in real AD (no `Disable-ADOptionalFeature` exists); idempotent here (re-enabling at the same scope is a no-op, not an error). */
  enableOptionalFeature(name: string, scopeDn: string): DirOpResult {
    if (name.toLowerCase() !== 'recycle bin feature') return { ok: false, message: `Cannot find an optional feature with identity: '${name}'.` };
    let formatted: string;
    try { formatted = formatDN(parseDN(scopeDn)); } catch { return { ok: false, message: `Cannot find an object with distinguished name: '${scopeDn}'.` }; }
    if (!this.recycleBinEnabledScopes.some(s => s.toLowerCase() === formatted.toLowerCase())) {
      this.recycleBinEnabledScopes.push(formatted);
    }
    return { ok: true, message: '' };
  }

  private isRecycleBinEnabled(): boolean { return this.recycleBinEnabledScopes.length > 0; }

  /**
   * Moves a deleted leaf entry into `CN=Deleted Objects` in place — same
   * RDN, no GUID-mangling (unlike real AD, whose `CN=<name>\nDEL:<guid>`
   * exists purely to dodge same-CN collisions across many deletes; out of
   * scope here since these tests only ever restore what they just
   * deleted) — recording `isDeleted`/`lastKnownParent`/`whenChanged` for
   * `Restore-ADObject`. All other attributes (including a group's own
   * `member` list) are left untouched, so a restored object comes back
   * exactly as it was — real AD Recycle Bin's actual behavior. Hard-
   * deletes instead when the Recycle Bin optional feature isn't enabled
   * (this simulator doesn't model pre-2008-R2 tombstone reanimation, so a
   * disabled-feature delete stays simply permanent, matching this
   * codebase's pre-Recycle-Bin behavior).
   */
  private softOrHardDelete(entry: DirectoryEntry): DirOpResult {
    if (!this.isRecycleBinEnabled()) {
      const res = this.tree.deleteEntry(entry.dn);
      return res.ok ? { ok: true, message: '' } : { ok: false, message: res.message };
    }
    const originalParentDn = formatDN(entry.dn.slice(1));
    const leafRdn = formatDN([entry.dn[0]]);
    const move = this.tree.renameEntry(entry.dn, leafRdn, false, this.deletedObjectsDn);
    if (!move.ok) return { ok: false, message: move.message };
    const moved = this.tree.getByDn([entry.dn[0], ...this.deletedObjectsDn]);
    if (moved) {
      this.tree.modifyEntry(moved.dn, [
        { op: 'replace', type: 'isDeleted', values: ['TRUE'] },
        { op: 'replace', type: 'lastKnownParent', values: [originalParentDn] },
        { op: 'replace', type: 'whenChanged', values: [this.now().toISOString()] },
      ]);
    }
    return { ok: true, message: '' };
  }

  /** `Restore-ADObject -Identity $deletedObj [-TargetPath <ou>]` — moves the entry back out of `CN=Deleted Objects` to `-TargetPath` (or its recorded `lastKnownParent` when omitted), clearing the tombstone markers. */
  restoreObject(rawDn: string, targetPathDn?: string): DirOpResult {
    let entry: DirectoryEntry | null;
    try { entry = this.tree.getByDn(parseDN(rawDn)); } catch { entry = null; }
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${rawDn}'.` };
    if (!isSoftDeleted(entry)) return { ok: false, message: 'The specified object is not in a deleted state, and no changes were made.' };
    const targetRaw = targetPathDn || firstOf(entry.attributes.get('lastknownparent'));
    if (!targetRaw) return { ok: false, message: 'Cannot determine the original location to restore this object to.' };
    let targetParentDn: DistinguishedName;
    try { targetParentDn = parseDN(targetRaw); } catch { return { ok: false, message: `Cannot find an object with identity: '${targetRaw}'.` }; }
    if (!this.tree.getByDn(targetParentDn)) return { ok: false, message: `Cannot find an object with identity: '${targetRaw}'.` };
    const leafRdn = formatDN([entry.dn[0]]);
    const move = this.tree.renameEntry(entry.dn, leafRdn, false, targetParentDn);
    if (!move.ok) return { ok: false, message: move.message };
    const restored = this.tree.getByDn([entry.dn[0], ...targetParentDn]);
    if (restored) {
      this.tree.modifyEntry(restored.dn, [
        { op: 'delete', type: 'isDeleted', values: [] },
        { op: 'delete', type: 'lastKnownParent', values: [] },
      ]);
    }
    return { ok: true, message: '' };
  }

  // ─── Generic AD objects (Get-ADObject / Set-ADObject) ────────────────

  private genericObjectClassOf(entry: DirectoryEntry): string {
    if (hasObjectClass(entry, 'computer')) return 'computer';
    if (hasObjectClass(entry, 'user')) return 'user';
    if (hasObjectClass(entry, 'group')) return 'group';
    if (hasObjectClass(entry, 'organizationalUnit')) return 'organizationalUnit';
    if (hasObjectClass(entry, 'groupPolicyContainer')) return 'groupPolicyContainer';
    return 'container';
  }

  private projectGenericObject(entry: DirectoryEntry): AdGenericObject {
    const attributes: Record<string, string[]> = {};
    for (const [k, v] of entry.attributes) attributes[k] = [...v];
    return {
      dn: formatDN(entry.dn),
      name: firstOf(entry.attributes.get('cn')) || firstOf(entry.attributes.get('ou')) || firstOf(entry.attributes.get('samaccountname')),
      objectClass: this.genericObjectClassOf(entry),
      isDeleted: isSoftDeleted(entry),
      lastKnownParent: firstOf(entry.attributes.get('lastknownparent')) || undefined,
      whenChanged: firstOf(entry.attributes.get('whenchanged')) || undefined,
      attributes,
    };
  }

  getObjectByDn(rawDn: string, includeDeleted: boolean): AdGenericObject | null {
    let entry: DirectoryEntry | null;
    try { entry = this.tree.getByDn(parseDN(rawDn)); } catch { entry = null; }
    if (!entry) return null;
    if (isSoftDeleted(entry) && !includeDeleted) return null;
    return this.projectGenericObject(entry);
  }

  /** `Get-ADObject -Filter {...} [-SearchBase <dn>] [-IncludeDeletedObjects]` — every real object in the tree (any class), for the cmdlet layer's own generic `-Filter` clause matching. */
  listObjects(opts: { includeDeleted: boolean; searchBaseDn?: string }): AdGenericObject[] {
    let baseDn = this.tree.getRootDn();
    if (opts.searchBaseDn) {
      try { baseDn = parseDN(opts.searchBaseDn); } catch { /* fall back to the root */ }
    }
    return this.tree.allDescendants(baseDn)
      .filter(e => opts.includeDeleted || !isSoftDeleted(e))
      .map(e => this.projectGenericObject(e));
  }

  /** `Set-ADObject -Identity <dn> -Replace @{attr = value}`. */
  setObjectAttributes(rawDn: string, replace: Record<string, string>): DirOpResult {
    let entry: DirectoryEntry | null;
    try { entry = this.tree.getByDn(parseDN(rawDn)); } catch { entry = null; }
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${rawDn}'.` };
    this.tree.modifyEntry(entry.dn, Object.entries(replace).map(([type, value]) => ({ op: 'replace' as const, type, values: [value] })));
    return { ok: true, message: '' };
  }

  // ─── KDS root key / Managed Service Accounts (gMSA/sMSA) ────────────

  /** `Add-KdsRootKey` — the forest-wide secret every gMSA's managed password is derived from in real AD; this simulator only needs its presence (as a real prerequisite `New-ADServiceAccount` enforces), not the actual key-derivation cryptography. */
  addKdsRootKey(): { keyId: string; effectiveTime: string } {
    this.kdsRootKey = { keyId: generateId(), effectiveTime: new Date().toISOString() };
    return this.kdsRootKey;
  }

  getKdsRootKey(): { keyId: string; effectiveTime: string } | null { return this.kdsRootKey; }

  /** `New-ADServiceAccount` — a gMSA (`principalsAllowed` non-empty, multi-computer) or an sMSA (`-RestrictToSingleComputer`, linked to exactly one computer via `Add-ADComputerServiceAccount`). Real AD refuses without a KDS root key already present. */
  newServiceAccount(name: string, opts: {
    dnsHostName: string; description?: string; path?: string;
    principalsAllowed?: string[]; managedPasswordIntervalDays?: number; restrictToSingleComputer?: boolean;
  }): DirOpResult {
    if (!this.kdsRootKey) {
      return { ok: false, message: 'The Key Distribution Services root key is not yet available. Run Add-KdsRootKey first.' };
    }
    const containerDn = this.resolveOuContainer(opts.path, this.usersOuDn);
    if (!containerDn) return { ok: false, message: `Cannot find an object with identity: '${opts.path}'.` };
    const isGroupManaged = !opts.restrictToSingleComputer;
    const res = this.tree.addEntry(this.cnDn(name, containerDn), compact({
      objectClass: ['top', isGroupManaged ? 'msDS-GroupManagedServiceAccount' : 'msDS-ManagedServiceAccount'],
      cn: [name],
      sAMAccountName: [`${name}$`],
      dNSHostName: [opts.dnsHostName],
      description: opts.description ? [opts.description] : [],
      'msDS-ManagedPasswordInterval': [String(opts.managedPasswordIntervalDays ?? 30)],
      'msDS-GroupMSAMembership': opts.principalsAllowed ?? [],
      pwdLastSet: [this.now().toISOString()],
    }));
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  private findServiceAccountEntry(name: string): DirectoryEntry | null {
    const bare = name.replace(/\$$/, '');
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'cn', value: bare })
      .filter(e => hasObjectClass(e, 'msDS-GroupManagedServiceAccount') || hasObjectClass(e, 'msDS-ManagedServiceAccount'));
    return entry ?? null;
  }

  private projectServiceAccount(entry: DirectoryEntry): AdServiceAccount {
    const hostComputerDn = firstOf(entry.attributes.get('msds-hostserviceaccount'));
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      dn: formatDN(entry.dn),
      dnsHostName: firstOf(entry.attributes.get('dnshostname')),
      description: firstOf(entry.attributes.get('description')),
      isGroupManaged: hasObjectClass(entry, 'msDS-GroupManagedServiceAccount'),
      principalsAllowed: entry.attributes.get('msds-groupmsamembership') ?? [],
      managedPasswordIntervalDays: Number(firstOf(entry.attributes.get('msds-managedpasswordinterval'))) || 30,
      hostComputerDn,
      servicePrincipalNames: entry.attributes.get('serviceprincipalname') ?? [],
      passwordLastSet: firstOf(entry.attributes.get('pwdlastset')),
    };
  }

  getServiceAccount(name: string): AdServiceAccount | null {
    const entry = this.findServiceAccountEntry(name);
    return entry ? this.projectServiceAccount(entry) : null;
  }

  /** `Set-ADServiceAccount -ServicePrincipalNames @{ Add = @(...) }`. */
  addServiceAccountSpns(name: string, addSpns: string[]): DirOpResult {
    const entry = this.findServiceAccountEntry(name);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${name}'.` };
    this.tree.modifyEntry(entry.dn, [{ op: 'add', type: 'servicePrincipalName', values: addSpns }]);
    return { ok: true, message: '' };
  }

  /** `Add-ADComputerServiceAccount -Identity <computer> -ServiceAccount <sMSA>` — links an sMSA to its exclusive host computer. */
  addComputerServiceAccount(computerName: string, serviceAccountName: string): DirOpResult {
    const computer = this.findComputerEntry(computerName);
    if (!computer) return { ok: false, message: `Cannot find an object with identity: '${computerName}'.` };
    const account = this.findServiceAccountEntry(serviceAccountName);
    if (!account) return { ok: false, message: `Cannot find an object with identity: '${serviceAccountName}'.` };
    this.tree.modifyEntry(account.dn, [{ op: 'replace', type: 'msDS-HostServiceAccount', values: [formatDN(computer.dn)] }]);
    return { ok: true, message: '' };
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

  newGroup(sam: string, scope: AdGroup['scope'] = 'Global', ou?: string, category: AdGroup['category'] = 'Security'): DirOpResult {
    const containerDn = this.resolveOuContainer(ou, this.usersOuDn);
    if (!containerDn) {
      return { ok: false, message: `Cannot find an object with identity: '${ou}'.` };
    }
    const res = this.createGroupEntry(sam, scope, containerDn, category);
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  private createGroupEntry(sam: string, scope: AdGroup['scope'], containerDn: DistinguishedName, category: AdGroup['category'] = 'Security'): DirOpResult {
    return this.tree.addEntry(this.cnDn(sam, containerDn), {
      objectClass: ['top', 'group'],
      cn: [sam],
      sAMAccountName: [sam],
      groupType: [String(computeGroupType(scope, category))],
    });
  }

  private findGroupEntry(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam })
      .filter(e => hasObjectClass(e, 'group') && !isSoftDeleted(e));
    return entry ?? null;
  }

  private listGroupEntries(): DirectoryEntry[] {
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'group') && !isSoftDeleted(e));
  }

  getGroup(sam: string): AdGroup | null {
    const entry = this.findGroupEntry(sam);
    return entry ? this.projectGroup(entry) : null;
  }

  listGroups(): AdGroup[] { return this.listGroupEntries().map(e => this.projectGroup(e)); }

  private projectGroup(entry: DirectoryEntry): AdGroup {
    const groupType = Number(firstOf(entry.attributes.get('grouptype')));
    const { scope, category } = decodeGroupType(groupType);
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      dn: formatDN(entry.dn),
      scope,
      category,
      members: (entry.attributes.get('member') ?? []).map(dnStr => this.samOfDn(dnStr)).filter((s): s is string => s !== null),
    };
  }

  /** A group member can itself be a user, a computer, another group, or a
   *  `foreignSecurityPrincipal` stub for a cross-domain trust member —
   *  real AD's AGDLP model (Account → Global → Domain Local → Permission)
   *  relies on nesting Global groups inside Domain Local ones. */
  private findGroupMemberEntry(sam: string): DirectoryEntry | null {
    return this.findUserEntry(sam) ?? this.findComputerEntry(sam) ?? this.findGroupEntry(sam)
      ?? this.findForeignSecurityPrincipalEntry(sam);
  }

  private foreignSecurityPrincipalsDn(): DistinguishedName {
    return [...parseDN('CN=ForeignSecurityPrincipals'), ...this.tree.getRootDn()];
  }

  private ensureForeignSecurityPrincipalsContainer(): void {
    const dn = this.foreignSecurityPrincipalsDn();
    if (!this.tree.getByDn(dn)) {
      this.tree.addEntry(dn, { objectClass: ['top', 'container'], cn: ['ForeignSecurityPrincipals'] });
    }
  }

  private findForeignSecurityPrincipalEntry(qualifiedSam: string): DirectoryEntry | null {
    this.ensureForeignSecurityPrincipalsContainer();
    const container = this.tree.getByDn(this.foreignSecurityPrincipalsDn());
    if (!container) return null;
    for (const entry of container.children.values()) {
      if (hasObjectClass(entry, 'foreignSecurityPrincipal') && firstOf(entry.attributes.get('samaccountname')) === qualifiedSam) {
        return entry;
      }
    }
    return null;
  }

  /**
   * `Add-ADGroupMember -Members "<remoteRealm>\<sam>"` (trust-relationships
   * gap 1): real AD never fully imports a trusted domain's object — it
   * creates a lightweight local `foreignSecurityPrincipal` stub the group's
   * `member` attribute can actually reference. Only succeeds when
   * `remoteRealm` has a real established trust (`TrustRegistry.getTrust`,
   * already checked by `New-ADTrust`/`netdom trust`) — a made-up domain
   * name is rejected exactly like a made-up local user would be.
   */
  addForeignSecurityPrincipal(remoteRealm: string, remoteSam: string): DirOpResult & { sam?: string } {
    if (!this.getTrust(remoteRealm)) {
      return { ok: false, message: `Cannot find an object with identity: '${remoteRealm}\\${remoteSam}'.` };
    }
    const qualifiedSam = `${remoteRealm}\\${remoteSam}`;
    const existing = this.findForeignSecurityPrincipalEntry(qualifiedSam);
    if (existing) return { ok: true, message: '', sam: qualifiedSam };
    this.ensureForeignSecurityPrincipalsContainer();
    const rdn = `${remoteSam}@${remoteRealm}`;
    const dn = [...parseDN(`CN=${rdn}`), ...this.foreignSecurityPrincipalsDn()];
    const res = this.tree.addEntry(dn, {
      objectClass: ['top', 'foreignSecurityPrincipal'],
      cn: [rdn],
      sAMAccountName: [qualifiedSam],
      name: [remoteSam],
    });
    return res.ok ? { ok: true, message: '', sam: qualifiedSam } : { ok: false, message: 'An object with that name already exists.' };
  }

  addGroupMember(groupSam: string, memberSam: string): DirOpResult {
    const group = this.findGroupEntry(groupSam);
    if (!group) return { ok: false, message: `Cannot find an object with identity: '${groupSam}'.` };
    const member = this.findGroupMemberEntry(memberSam);
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
    const member = this.findGroupMemberEntry(memberSam);
    const groupDn = formatDN(group.dn);
    this.tree.modifyEntry(group.dn, [{ op: 'delete', type: 'member', values: member ? [formatDN(member.dn)] : [] }]);
    if (member) this.tree.modifyEntry(member.dn, [{ op: 'delete', type: 'memberOf', values: [groupDn] }]);
    return { ok: true, message: '' };
  }

  /** `Get-ADGroupMember` — direct members only, each tagged by kind so a caller can distinguish a nested Global group, a cross-domain `foreignSecurityPrincipal`, or a plain user/computer (real AD's AGDLP model). */
  getGroupMembersDetailed(groupSam: string): Array<{ sam: string; dn: string; objectClass: 'user' | 'computer' | 'group' | 'foreignSecurityPrincipal' }> {
    const group = this.findGroupEntry(groupSam);
    if (!group) return [];
    const out: Array<{ sam: string; dn: string; objectClass: 'user' | 'computer' | 'group' | 'foreignSecurityPrincipal' }> = [];
    for (const dnStr of group.attributes.get('member') ?? []) {
      let dn: DistinguishedName;
      try { dn = parseDN(dnStr); } catch { continue; }
      const entry = this.tree.getByDn(dn);
      if (!entry) continue;
      const sam = firstOf(entry.attributes.get('samaccountname'));
      if (!sam) continue;
      const objectClass: 'user' | 'computer' | 'group' | 'foreignSecurityPrincipal' = hasObjectClass(entry, 'foreignSecurityPrincipal')
        ? 'foreignSecurityPrincipal' : hasObjectClass(entry, 'group')
        ? 'group' : hasObjectClass(entry, 'computer') ? 'computer' : 'user';
      out.push({ sam, dn: formatDN(entry.dn), objectClass });
    }
    return out;
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
    // `cn` holds the bare machine name, but callers resolving a group
    // member identity (PRD-Wecutil.md §2.1 P2) pass the real
    // `sAMAccountName` form ("<Name>$", precedent §1.3) — strip the
    // trailing `$` before searching so both forms resolve.
    const cn = name.endsWith('$') ? name.slice(0, -1) : name;
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'cn', value: cn })
      .filter(e => hasObjectClass(e, 'computer') && !isSoftDeleted(e));
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
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'computer') && !isSoftDeleted(e)).map(e => this.projectComputer(e));
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

  private resolveSidToSam(identity: string): string {
    if (!identity.startsWith('S-1-5-')) return identity;
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'objectSid', value: identity });
    return entry ? firstOf(entry.attributes.get('samaccountname')) : identity;
  }

  private isDomainAdmin(sam: string): boolean {
    if (sam.toLowerCase() === 'administrator') return true;
    const entry = this.findUserEntry(sam);
    if (!entry) return false;
    const domainAdminsDn = formatDN(this.cnDn('Domain Admins', this.usersOuDn)).toLowerCase();
    return (entry.attributes.get('memberof') ?? []).some(dn => dn.toLowerCase() === domainAdminsDn);
  }

  deniedRight(targetDn: string, right: string): boolean {
    let dn: DistinguishedName;
    try { dn = parseDN(targetDn); } catch { return false; }
    const entry = this.tree.getByDn(dn);
    const own = this.acls.get(formatDN(entry ? entry.dn : dn).toLowerCase());
    return own?.some(ace => ace.accessControlType === 'Deny' && ace.rights === right) ?? false;
  }

  hasPermission(subjectSam: string, targetDn: string, right: string): boolean {
    if (this.deniedRight(targetDn, right)) return false;
    if (this.isDomainAdmin(subjectSam)) return true;
    let dn: DistinguishedName;
    try { dn = parseDN(targetDn); } catch { return false; }
    const rootLength = this.tree.getRootDn().length;
    while (dn.length >= rootLength) {
      const acl = this.acls.get(formatDN(dn).toLowerCase());
      if (acl?.some(ace =>
        ace.identitySam.toLowerCase() === subjectSam.toLowerCase() && ace.accessControlType === 'Allow' && ace.rights === right)) {
        return true;
      }
      if (dn.length === rootLength) break;
      dn = dn.slice(1);
    }
    return false;
  }

  private resolveTargetEntry(rawDn: string): DirectoryEntry | null {
    try {
      const parsed = parseDN(rawDn);
      const direct = this.tree.getByDn(parsed);
      if (direct) return direct;
    } catch { /* not a valid DN */ }
    return this.tree.getByDn(this.ouDn(this.resolveIdentity(rawDn)));
  }

  getAcl(dn: string): AdAccessRule[] | null {
    const entry = this.resolveTargetEntry(dn);
    if (!entry) return null;
    return this.acls.get(formatDN(entry.dn).toLowerCase()) ?? [];
  }

  setAcl(dn: string, rules: AdAccessRule[]): DirOpResult {
    const entry = this.resolveTargetEntry(dn);
    if (!entry) return { ok: false, message: `Cannot find path '${dn}' because it does not exist.` };
    const resolved = rules.map(r => ({ ...r, identitySam: this.resolveSidToSam(r.identitySam) }));
    this.acls.set(formatDN(entry.dn).toLowerCase(), resolved);
    return { ok: true, message: '' };
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
