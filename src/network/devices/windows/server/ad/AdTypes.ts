/**
 * AdTypes — Active Directory Domain Services object model
 * (PRD-Windows-Server.md §4.3, §5 P5). A deliberate "LDAP-lite" subset:
 * no schema extensibility, no real LDAP wire protocol, no multi-DC
 * replication (PRD §2.2 non-goals) — just enough of a directory to make
 * `Install-ADDSForest`, the AD cmdlets, domain join and domain logon
 * (P6) real.
 */

export interface AdUser {
  readonly sam: string;
  readonly upn: string;
  readonly dn: string;
  readonly sid: string;
  ou: string;
  enabled: boolean;
  password: string;
  memberOf: string[];
  fullName: string;
  department: string;
  title: string;
  emailAddress: string;
  passwordLastSet: string;
  passwordNeverExpires: boolean;
  servicePrincipalNames: string[];
  /** Roaming profile / redirected home folder (real LDAP `profilePath`/`homeDirectory`/`homeDrive` attributes, PRD AD roaming-profiles gap). */
  profilePath: string;
  homeDirectory: string;
  homeDrive: string;  properties: Record<string, string>;
  flags: Record<string, boolean>;
  accountExpirationDate: Date | null;
  cannotChangePassword: boolean;
  changePasswordAtLogon: boolean;

}

/**
 * A raw AD object of ANY class, exposed generically for `Get-ADObject`/
 * `Set-ADObject`/`Restore-ADObject` (PRD AD Recycle Bin) — unlike
 * `AdUser`/`AdGroup`/etc.'s fixed shape, these cmdlets operate on
 * arbitrary attributes (`msDS-DeletedObjectLifetime` on a Configuration
 * NC container, `isDeleted`/`lastKnownParent` on a soft-deleted object),
 * so `attributes` carries the entry's raw multi-valued attribute map
 * (lowercased keys, matching `DirectoryEntry`) directly.
 */
export interface AdGenericObject {
  dn: string;
  name: string;
  objectClass: string;
  isDeleted: boolean;
  lastKnownParent?: string;
  whenChanged?: string;
  attributes: Record<string, string[]>;
}

export const AD_NULL_GUID = '00000000-0000-0000-0000-000000000000';

export interface AdAccessRule {
  identitySam: string;
  rights: string;
  accessControlType: 'Allow' | 'Deny';
  objectType: string;
  inheritanceType: string;
  inheritedObjectType: string;
}

export interface AdGroup {
  readonly sam: string;
  readonly dn: string;
  readonly name: string;
  scope: 'DomainLocal' | 'Global' | 'Universal';
  category: 'Security' | 'Distribution';
  properties: Record<string, string>;
  members: string[];
}

/** Subset of `WindowsAccountsPolicyState` a GPO can carry (PRD-Windows-Server.md §5 P10 — "politique de mots de passe et de verrouillage du domaine"). `maxPasswordAge`/`minPasswordAge` are in days, `lockoutDurationMinutes`/`lockoutWindowMinutes` in minutes — matching how `New-TimeSpan` values get unwrapped by the cmdlets that set these. */
export interface GpoAccountPolicy {
  minPasswordLength?: number;
  maxPasswordAge?: number;
  minPasswordAge?: number;
  passwordHistoryLength?: number;
  lockoutThreshold?: number;
  lockoutDurationMinutes?: number;
  lockoutWindowMinutes?: number;
  complexityEnabled?: boolean;
  reversibleEncryptionEnabled?: boolean;
}

/** A Fine-Grained Password Policy (`msDS-PasswordSettings`, PRD-Windows-Server-Advanced.md §5 P10) — the same account-policy shape as a GPO's, plus the precedence that resolves conflicts between PSOs applying to the same account (lowest wins) and the direct/group subjects it applies to. */
export interface AdFineGrainedPasswordPolicy {
  readonly name: string;
  precedence: number;
  description: string;
  settings: GpoAccountPolicy;
}

/** Advanced Audit Policy Configuration a GPO carries (PRD-Auditpol.md §2.1 P8) — keyed by real subcategory name, applied on top of the local `auditpol` state by every `gpupdate`, matching real Windows' "GPO wins over local" precedence. */
export type GpoAuditPolicy = Record<string, { success?: boolean; failure?: boolean }>;

/** One `Set-GPRegistryValue` entry — a registry-based policy setting a GPO carries, applied into the target's registry hive on `gpupdate`. */
export interface GpoRegistryValue {
  key: string;
  valueName: string;
  type: string;
  value: string;
}

export interface GpoSettings {
  accountPolicy?: GpoAccountPolicy;
  logonBanner?: { title: string; text: string };
  startupScript?: string;
  auditPolicy?: GpoAuditPolicy;
  registryPolicy?: GpoRegistryValue[];
}

/** A single `gPLink` entry, decoded: which GPO, and its link-specific options (real AD encodes these as a trailing options bitmask on the link string; order is this simulator's own addition since it doesn't model true multi-value ordering). */
export interface GpoLinkInfo {
  displayName: string;
  gpoDn: string;
  enabled: boolean;
  enforced: boolean;
  order: number;
}

/**
 * `gPLink` wire encoding shared by `DirectoryStore` (direct in-process
 * reads/writes) and `GpoPullClient` (the real LDAP-wire `gpupdate` path) —
 * both must decode the exact same attribute values, so the format lives
 * here rather than being duplicated. Mirrors real AD's own shape (a
 * trailing options suffix on each linked GPO's DN) with `order` as this
 * simulator's own addition (real AD infers order from list position).
 */
export function encodeGpLink(gpoDn: string, opts: { linkEnabled: boolean; enforced: boolean; order: number }): string {
  return `${gpoDn};linkEnabled=${opts.linkEnabled ? 1 : 0};enforced=${opts.enforced ? 1 : 0};order=${opts.order}`;
}
export function decodeGpLink(raw: string): { gpoDn: string; linkEnabled: boolean; enforced: boolean; order: number } {
  const [gpoDn, ...rest] = raw.split(';');
  let linkEnabled = true;
  let enforced = false;
  let order = 1;
  for (const part of rest) {
    const [k, v] = part.split('=');
    if (k === 'linkEnabled') linkEnabled = v === '1';
    else if (k === 'enforced') enforced = v === '1';
    else if (k === 'order') order = Number(v) || 1;
  }
  return { gpoDn, linkEnabled, enforced, order };
}

/** `Gpo { id; name; links; settings }` — the exact minimal model from PRD-Windows-Server.md §4.4. */
export interface Gpo {
  readonly id: string;
  readonly name: string;
  links: string[];
  settings: GpoSettings;
}

export interface AdComputer {
  readonly name: string;
  readonly dn: string;
  machineSecret: string;
  enabled: boolean;
  /** IP the computer account last joined/logged on from — diagnostic only. */
  lastKnownIp?: string;
  servicePrincipalNames: string[];
}

export interface AdOrgUnit {
  readonly name: string;
  readonly dn: string;
  gpLinks: string[];
  properties: Record<string, string>;
  protectedFromAccidentalDeletion: boolean;
}

export type AdObject = AdUser | AdGroup | AdComputer | AdOrgUnit;

export interface DomainInfo {
  readonly dnsName: string;
  readonly netbiosName: string;
  readonly dcs: string[];
}

/**
 * A gMSA (group-managed, multi-computer via `principalsAllowed`) or sMSA
 * (`restrictToSingleComputer`, linked to exactly one computer via
 * `hostComputerDn`) — PRD's Managed Service Accounts feature. Real AD
 * derives the actual managed password from the KDS root key on a timer;
 * this simulator models the account object and its authorization data
 * (who's allowed to retrieve/use it) without deriving real key material —
 * `Install-ADServiceAccount`/`Test-ADServiceAccount` check authorization
 * over a real LDAP round trip, they just don't do real gMSA cryptography.
 */
export interface AdServiceAccount {
  readonly sam: string;
  readonly dn: string;
  dnsHostName: string;
  description: string;
  isGroupManaged: boolean;
  principalsAllowed: string[];
  managedPasswordIntervalDays: number;
  hostComputerDn: string;
  servicePrincipalNames: string[];
  passwordLastSet: string;
}
