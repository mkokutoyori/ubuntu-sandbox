/**
 * GpoPullClient — `gpupdate /force`'s real network dialogue (PRD-Windows-
 * Server.md §5 P10): AS/TGS/AP-REQ Kerberos exchange for the machine's
 * own computer account, then a GSSAPI-bound LDAP session reading the
 * domain root's `gPLink` and — if this computer's own OU carries links
 * too — that OU's `gPLink`, resolving each linked GPO container's
 * settings with a further real SearchRequest.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';
import { dialKdc, buildApReq } from '@/network/kerberos/KerberosClient';
import { KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';
import { discoverDcHostname, rootDnOf } from './DcHostnameDiscovery';
import type { DomainMembership } from './DomainTypes';
import type { GpoSettings } from '../server/ad/AdTypes';

export interface GpoPullResult {
  ok: boolean;
  message: string;
  appliedGpoNames: string[];
  settings: GpoSettings;
}

function parseGpoSettings(attrs: Array<{ type: string; values: string[] }>): GpoSettings {
  const get = (name: string): string | undefined =>
    attrs.find(a => a.type.toLowerCase() === name.toLowerCase())?.values[0];
  const accountPolicyJson = get('gpoAccountPolicy');
  const logonBannerJson = get('gpoLogonBanner');
  const startupScript = get('gpoStartupScript');
  return {
    accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
    logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
    startupScript: startupScript || undefined,
  };
}

function mergeSettings(target: GpoSettings, source: GpoSettings): void {
  if (source.accountPolicy !== undefined) target.accountPolicy = { ...target.accountPolicy, ...source.accountPolicy };
  if (source.logonBanner !== undefined) target.logonBanner = source.logonBanner;
  if (source.startupScript !== undefined) target.startupScript = source.startupScript;
}

export function pullGroupPolicy(tcpStack: TcpStack, membership: DomainMembership, hostname: string): GpoPullResult {
  const noNetwork: GpoPullResult = { ok: false, message: 'The processing of Group Policy failed because of lack of network connectivity to a domain controller.', appliedGpoNames: [], settings: {} };
  const denied: GpoPullResult = { ok: false, message: 'Access is denied.', appliedGpoNames: [], settings: {} };

  const dcHostname = discoverDcHostname(tcpStack, membership.dcAddress, membership.dnsName);
  if (!dcHostname) return noNetwork;

  const realm = membership.dnsName.toUpperCase();
  const kdcConn = dialKdc(tcpStack, membership.dcAddress);
  if (!kdcConn.ok || !kdcConn.client) return noNetwork;
  const computerSam = `${hostname}$`;
  const cname = principalName(PrincipalNameType.NT_PRINCIPAL, computerSam);

  const asResult = kdcConn.client.asExchange(computerSam, membership.machineSecret, realm);
  if (!asResult.ok) return denied;
  const tgsResult = kdcConn.client.tgsExchange(asResult.ticket!, asResult.sessionKey!, cname, realm, dcHostname);
  if (!tgsResult.ok) return denied;
  const apReqBytes = buildApReq(tgsResult.ticket!, tgsResult.sessionKey!, cname, realm, KU_AP_REQ_AUTHENTICATOR);

  const conn = dialLdap(tcpStack, membership.dcAddress);
  if (!conn.ok || !conn.client) return noNetwork;
  const ldap = conn.client;

  const bind = ldap.bindSasl('GSSAPI', apReqBytes);
  if (!bind.ok) {
    ldap.unbind();
    return denied;
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
