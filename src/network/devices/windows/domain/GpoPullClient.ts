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

export interface GpoPullResult {
  ok: boolean;
  message: string;
  appliedGpoNames: string[];
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
  return {
    accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
    logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
    startupScript: startupScript || undefined,
    auditPolicy: auditPolicyJson ? JSON.parse(auditPolicyJson) : undefined,
  };
}

function mergeSettings(target: GpoSettings, source: GpoSettings): void {
  if (source.accountPolicy !== undefined) target.accountPolicy = { ...target.accountPolicy, ...source.accountPolicy };
  if (source.logonBanner !== undefined) target.logonBanner = source.logonBanner;
  if (source.startupScript !== undefined) target.startupScript = source.startupScript;
  if (source.auditPolicy !== undefined) target.auditPolicy = { ...target.auditPolicy, ...source.auditPolicy };
}

export function pullGroupPolicy(tcpStack: TcpStack, membership: DomainMembership, hostname: string): GpoPullResult {
  const conn = dialLdap(tcpStack, membership.dcAddress);
  if (!conn.ok || !conn.client) {
    return { ok: false, message: 'The processing of Group Policy failed because of lack of network connectivity to a domain controller.', appliedGpoNames: [], settings: {} };
  }
  const ldap = conn.client;
  const computerSam = `${hostname}$`;
  const bind = ldap.bind(computerSam, membership.machineSecret);
  if (!bind.ok) {
    ldap.unbind();
    return { ok: false, message: 'Access is denied.', appliedGpoNames: [], settings: {} };
  }

  const rootDn = rootDnOf(membership.dnsName);
  const merged: GpoSettings = {};
  const appliedGpoNames: string[] = [];

  const applyLinksFrom = (dn: string): void => {
    const self = ldap.search(dn, 'base', { kind: 'present', attr: 'objectClass' }, ['gPLink']);
    const links = self.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'gplink')?.values ?? [];
    for (const gpoDn of links) {
      const gpoResult = ldap.search(gpoDn, 'base', { kind: 'present', attr: 'objectClass' },
        ['displayName', 'gpoAccountPolicy', 'gpoLogonBanner', 'gpoStartupScript']);
      const entry = gpoResult.entries[0];
      if (!entry) continue;
      const name = entry.attributes.find(a => a.type.toLowerCase() === 'displayname')?.values[0] ?? gpoDn;
      appliedGpoNames.push(name);
      mergeSettings(merged, parseGpoSettings(entry.attributes));
    }
  };

  applyLinksFrom(rootDn);

  const selfSearch = ldap.search(rootDn, 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: computerSam }, []);
  const computerDn = selfSearch.entries[0]?.dn;
  if (computerDn) {
    const parentDn = computerDn.split(',').slice(1).join(',');
    if (parentDn && parentDn.toLowerCase() !== rootDn.toLowerCase()) applyLinksFrom(parentDn);
  }

  ldap.unbind();
  return { ok: true, message: '', appliedGpoNames, settings: merged };
}
