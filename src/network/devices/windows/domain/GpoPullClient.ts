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
import { decodeGpLink } from '../server/ad/AdTypes';

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
  const registryPolicyJson = get('gpoRegistryPolicy');
  return {
    accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
    logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
    startupScript: startupScript || undefined,
    auditPolicy: auditPolicyJson ? JSON.parse(auditPolicyJson) : undefined,
    registryPolicy: registryPolicyJson ? JSON.parse(registryPolicyJson) : undefined,
  };
}

function mergeSettings(target: GpoSettings, source: GpoSettings): void {
  if (source.accountPolicy !== undefined) target.accountPolicy = { ...target.accountPolicy, ...source.accountPolicy };
  if (source.logonBanner !== undefined) target.logonBanner = source.logonBanner;
  if (source.startupScript !== undefined) target.startupScript = source.startupScript;
  if (source.auditPolicy !== undefined) target.auditPolicy = { ...target.auditPolicy, ...source.auditPolicy };
  if (source.registryPolicy !== undefined) {
    const byKey = new Map((target.registryPolicy ?? []).map(e => [`${e.key.toLowerCase()}|${e.valueName.toLowerCase()}`, e]));
    for (const e of source.registryPolicy) byKey.set(`${e.key.toLowerCase()}|${e.valueName.toLowerCase()}`, e);
    target.registryPolicy = Array.from(byKey.values());
  }
}

export function pullGroupPolicy(tcpStack: TcpStack, membership: DomainMembership, hostname: string, userSam?: string): GpoPullResult {
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
  const applied: Array<{ name: string; order: number }> = [];

  /** Reads and applies one container's `gPLink` — decoding each entry's `-LinkEnabled`/`-Enforced`/`-Order` options; `overrideBlock` lets an Enforced link win even when this container's own inheritance is blocked, matching real AD's precedence rule. */
  const applyLinksFrom = (dn: string, inheritanceBlocked: boolean): void => {
    const self = ldap.search(dn, 'base', { kind: 'present', attr: 'objectClass' }, ['gPLink']);
    const links = self.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'gplink')?.values ?? [];
    for (const raw of links) {
      const decoded = decodeGpLink(raw);
      if (!decoded.linkEnabled) continue;
      if (inheritanceBlocked && !decoded.enforced) continue;
      const gpoResult = ldap.search(decoded.gpoDn, 'base', { kind: 'present', attr: 'objectClass' },
        ['displayName', 'gpoAccountPolicy', 'gpoLogonBanner', 'gpoStartupScript', 'gpoAuditPolicy', 'gpoRegistryPolicy']);
      const entry = gpoResult.entries[0];
      if (!entry) continue;
      const name = entry.attributes.find(a => a.type.toLowerCase() === 'displayname')?.values[0] ?? decoded.gpoDn;
      applied.push({ name, order: decoded.order });
      mergeSettings(merged, parseGpoSettings(entry.attributes));
    }
  };

  // Resolve the computer's own OU (and whether IT blocks inherited policy)
  // before processing domain-linked GPOs — blocked inheritance only ever
  // withholds policy the computer would otherwise INHERIT from an ancestor
  // (the domain root); it never withholds the OU's own direct links.
  const selfSearch = ldap.search(rootDn, 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: computerSam }, []);
  const computerDn = selfSearch.entries[0]?.dn;
  let parentDn: string | null = null;
  let ouBlocked = false;
  if (computerDn) {
    const candidate = computerDn.split(',').slice(1).join(',');
    if (candidate && candidate.toLowerCase() !== rootDn.toLowerCase()) {
      parentDn = candidate;
      const ouResult = ldap.search(parentDn, 'base', { kind: 'present', attr: 'objectClass' }, ['gPOptions']);
      ouBlocked = ouResult.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'gpoptions')?.values[0] === '1';
    }
  }

  applyLinksFrom(rootDn, ouBlocked);
  if (parentDn) applyLinksFrom(parentDn, false);

  // User Configuration policy (folder redirection, HKCU registry policy, …)
  // resolves against the logged-on user's own OU, independently of the
  // computer's placement (this simulator doesn't model Loopback Processing).
  if (userSam) {
    const userSearch = ldap.search(rootDn, 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: userSam }, []);
    const userDn = userSearch.entries[0]?.dn;
    if (userDn) {
      const userParentDn = userDn.split(',').slice(1).join(',');
      if (userParentDn && userParentDn.toLowerCase() !== rootDn.toLowerCase()
          && userParentDn.toLowerCase() !== (parentDn ?? '').toLowerCase()) {
        const userOuResult = ldap.search(userParentDn, 'base', { kind: 'present', attr: 'objectClass' }, ['gPOptions']);
        const userOuBlocked = userOuResult.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'gpoptions')?.values[0] === '1';
        applyLinksFrom(userParentDn, userOuBlocked);
      }
    }
  }

  ldap.unbind();
  return { ok: true, message: '', appliedGpoNames: applied.sort((a, b) => a.order - b.order).map(a => a.name), settings: merged };
}
