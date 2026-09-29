/**
 * GpoPullClient — `gpupdate /force`'s real network dialogue (PRD-Windows-
 * Server.md §5 P10): dials the DC's LDAP listener, binds as this
 * machine's own computer account (the real credential Group Policy
 * processing runs under, not the logged-on user), then reads the
 * domain root's `gPLink` and — if this computer's own OU carries links
 * too — that OU's `gPLink`, resolving each linked GPO container's
 * settings with a further real SearchRequest. Mirrors `DomainLogonClient`'s
 * wire shape exactly.
 *
 * Real gpupdate also reads GPO content from SYSVOL (file-based); this
 * simulator keeps everything in the directory (`gpoAccountPolicy`/
 * `gpoLogonBanner`/`gpoStartupScript` attributes) since no SYSVOL/FRS
 * replication content exists here (PRD §2.2 non-goal, already excluded
 * for domain join/SYSVOL provisioning in P6).
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';
import type { DomainMembership } from './DomainTypes';
import type { GpoSettings } from '../server/ad/AdTypes';
import { containerChain, resolveGroupPolicy, type GpoContainerReader } from '../server/ad/GpoResolution';

export interface GpoPullResult {
  ok: boolean;
  message: string;
  failure?: 'no-domain-controller' | 'access-denied';
  appliedGpoNames: string[];
  appliedUserGpoNames: string[];
  settings: GpoSettings;
}

function rootDnOf(dnsName: string): string {
  return dnsName.split('.').map(p => `DC=${p}`).join(',');
}

function parseGpoSettings(attrs: Array<{ type: string; values: string[] }>): GpoSettings {
  const get = (name: string): string | undefined =>
    attrs.find(a => a.type.toLowerCase() === name.toLowerCase())?.values[0];
  const accountPolicyJson = get('gpoAccountPolicy');
  const logonBannerJson = get('gpoLogonBanner');
  const startupScript = get('gpoStartupScript');
  const auditPolicyJson = get('gpoAuditPolicy');
  const registryPolicyJson = get('gpoRegistryPolicy');
  return {
    accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
    logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
    startupScript: startupScript || undefined,
    auditPolicy: auditPolicyJson ? JSON.parse(auditPolicyJson) : undefined,
    registryPolicy: registryPolicyJson ? JSON.parse(registryPolicyJson) : undefined,
  };
}

type LdapAttributes = Array<{ type: string; values: string[] }>;

function valuesOf(attrs: LdapAttributes, name: string): string[] {
  return attrs.find(a => a.type.toLowerCase() === name.toLowerCase())?.values ?? [];
}

export function pullGroupPolicy(tcpStack: TcpStack, membership: DomainMembership, hostname: string, userSam?: string): GpoPullResult {
  const conn = dialLdap(tcpStack, membership.dcAddress);
  if (!conn.ok || !conn.client) {
    return { ok: false, failure: 'no-domain-controller', message: 'The processing of Group Policy failed because of lack of network connectivity to a domain controller.', appliedGpoNames: [], appliedUserGpoNames: [], settings: {} };
  }
  const ldap = conn.client;
  const computerSam = `${hostname}$`;
  const bind = ldap.bind(computerSam, membership.machineSecret);
  if (!bind.ok) {
    ldap.unbind();
    return { ok: false, failure: 'access-denied', message: 'Access is denied.', appliedGpoNames: [], appliedUserGpoNames: [], settings: {} };
  }

  const rootDn = rootDnOf(membership.dnsName);
  const readBase = (dn: string, attributes: string[]) =>
    ldap.search(dn, 'base', { kind: 'present', attr: 'objectClass' }, attributes).entries[0];
  const reader: GpoContainerReader = {
    gpLinks: dn => valuesOf(readBase(dn, ['gPLink'])?.attributes ?? [], 'gPLink'),
    inheritanceBlocked: dn => valuesOf(readBase(dn, ['gPOptions'])?.attributes ?? [], 'gPOptions')[0] === '1',
    readGpo: dn => {
      const entry = readBase(dn, ['displayName', 'gpoAccountPolicy', 'gpoLogonBanner', 'gpoStartupScript', 'gpoAuditPolicy', 'gpoRegistryPolicy']);
      if (!entry) return null;
      return { name: valuesOf(entry.attributes, 'displayName')[0] ?? dn, settings: parseGpoSettings(entry.attributes) };
    },
  };
  const dnOf = (sam: string): string | undefined =>
    ldap.search(rootDn, 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam }, []).entries[0]?.dn;

  const computerDn = dnOf(computerSam);
  const userDn = userSam ? dnOf(userSam) : undefined;
  const result = resolveGroupPolicy(
    reader,
    computerDn ? containerChain(computerDn, rootDn) : [rootDn],
    userDn ? containerChain(userDn, rootDn) : undefined,
  );
  ldap.unbind();
  return { ok: true, message: '', ...result };
}
