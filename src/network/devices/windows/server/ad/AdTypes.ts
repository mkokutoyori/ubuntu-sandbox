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
