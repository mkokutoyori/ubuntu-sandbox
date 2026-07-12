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
  ou: string;
  enabled: boolean;
  password: string;
  memberOf: string[];
  fullName: string;
}

export interface AdGroup {
  readonly sam: string;
  readonly dn: string;
  scope: 'DomainLocal' | 'Global' | 'Universal';
  members: string[];
}

/** Subset of `WindowsAccountsPolicyState` a GPO can carry (PRD-Windows-Server.md §5 P10 — "politique de mots de passe et de verrouillage du domaine"). */
export interface GpoAccountPolicy {
  minPasswordLength?: number;
  maxPasswordAge?: number;
  minPasswordAge?: number;
  passwordHistoryLength?: number;
  lockoutThreshold?: number;
  lockoutDurationMinutes?: number;
  lockoutWindowMinutes?: number;
}

export type GpoAuditSetting = 'None' | 'Success' | 'Failure' | 'SuccessAndFailure';

export interface GpoAuditPolicy {
  accountLogon?: GpoAuditSetting;
  accountManagement?: GpoAuditSetting;
  logonEvents?: GpoAuditSetting;
  objectAccess?: GpoAuditSetting;
  policyChange?: GpoAuditSetting;
  privilegeUse?: GpoAuditSetting;
  systemEvents?: GpoAuditSetting;
}

/** Principal SAM names per User Rights Assignment policy (a representative subset of `secpol.msc`'s full list). */
export interface GpoUserRightsAssignment {
  logOnLocally?: string[];
  denyLogOnLocally?: string[];
  logOnAsService?: string[];
  accessComputerFromNetwork?: string[];
  denyAccessComputerFromNetwork?: string[];
  allowLogOnThroughRemoteDesktop?: string[];
}

export interface GpoSettings {
  accountPolicy?: GpoAccountPolicy;
  auditPolicy?: GpoAuditPolicy;
  userRightsAssignment?: GpoUserRightsAssignment;
  logonBanner?: { title: string; text: string };
  startupScript?: string;
}

/** `Gpo { id; name; links; settings }` — the exact minimal model from PRD-Windows-Server.md §4.4, plus security filtering (empty = applies to Authenticated Users, real AD's default). */
export interface Gpo {
  readonly id: string;
  readonly name: string;
  links: string[];
  settings: GpoSettings;
  securityFiltering: string[];
}

/** A Fine-Grained Password Policy (real AD's `msDS-PasswordSettings` object): overrides the domain default `GpoAccountPolicy` wholesale (never merged) for whichever users/groups it targets, winner decided by lowest `precedence`. */
export interface PasswordSettingsObject {
  readonly name: string;
  readonly dn: string;
  precedence: number;
  settings: GpoAccountPolicy;
  appliesTo: string[];
}

export interface AdComputer {
  readonly name: string;
  readonly dn: string;
  machineSecret: string;
  enabled: boolean;
  /** IP the computer account last joined/logged on from — diagnostic only. */
  lastKnownIp?: string;
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
