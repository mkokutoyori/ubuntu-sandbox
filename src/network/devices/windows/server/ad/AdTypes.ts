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
  servicePrincipalNames: string[];
}

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
  scope: 'DomainLocal' | 'Global' | 'Universal';
  category: 'Security' | 'Distribution';
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

export interface GpoSettings {
  accountPolicy?: GpoAccountPolicy;
  logonBanner?: { title: string; text: string };
  startupScript?: string;
  auditPolicy?: GpoAuditPolicy;
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
}

export type AdObject = AdUser | AdGroup | AdComputer | AdOrgUnit;

export interface DomainInfo {
  readonly dnsName: string;
  readonly netbiosName: string;
  readonly dcs: string[];
}
