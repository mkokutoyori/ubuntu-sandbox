import type { ConsoleSettingsPatch } from '../../../mgmt/ConsoleSettings';
import type { ConserveThresholds } from '../../../health/SystemLoad';
import type { LdbMonitorType } from '../../../health/LdbMonitor';
import type { LdbMethod } from '../../../nat/RealServerPool';
import type { ArgumentSpec, EnumValue } from '../../../../../../cli/ArgumentTypes';
import type { ObjectStore } from '../../../model/ObjectStore';
import type { PolicyStore } from '../../../model/PolicyStore';
import type { DosPolicyStore } from '../../../dos/DosPolicyStore';

import type { AccessGroup } from '../../../authz/AccessMatrix';
import type { SdwanConfiguration } from '../../../sdwan/SdwanTable';
import type { HaConfiguration } from '../../../ha/HaTypes';
import type { DhcpScope } from '../../../l3/FirewallDhcp';
import type { Dhcp6Scope } from '../../../l3/FirewallDhcp6';
import type {
  SyslogCollectorSettings, SyslogFilterSettings,
} from '../../../logging/SyslogCollectors';
import type { NtpSettings } from '../../../mgmt/FirewallNtp';
import type { FirewallDnsSettings } from '../../../l3/FirewallDnsClient';
import type { DnsServerInterface } from '../../../l3/FirewallDnsServer';

export interface FortiDnsZonePatch {
  readonly name: string;
  readonly domain: string;
  readonly type: string;
  readonly authoritative: boolean;
  readonly primaryName?: string;
  readonly contact?: string;
  readonly entries: ReadonlyArray<{ hostname: string; ip: string; ttl?: number }>;
}
import type {
  BgpConfiguration, OspfConfiguration, RipConfiguration,
} from '../../../routing/DynamicRoutingTypes';

export type FortiAccessGroup = AccessGroup;

export type FortiScope = 'global' | 'vdom' | 'both';

export interface FortiObjectView {
  readonly key: string;
  hasPhysicalKey(): boolean;
  effective(attribute: string): readonly string[];
  isExplicit(attribute: string): boolean;
  setting(path: string, attribute: string): readonly string[];
  childEntries(name: string): readonly FortiObjectView[];
  childSetting(name: string, attribute: string): readonly string[];
  childGroup(name: string): FortiObjectView | undefined;
}

export interface FortiSchemaEnvironment {
  setting(path: string, attribute: string): readonly string[];
  isPhysicalPort?(name: string): boolean;
  referenceHolders?(target: readonly string[], key: string): readonly string[];
}

export const EMPTY_ENVIRONMENT: FortiSchemaEnvironment = Object.freeze({
  setting: () => Object.freeze([]),
});

export interface FortiAttributeSpec {
  readonly name: string;
  readonly help: string;
  readonly parts: readonly ArgumentSpec[];
  readonly multiValue?: boolean;
  readonly referenceTo?: readonly string[];
  readonly quoted?: boolean;
  readonly quoteValue?: (value: string) => boolean;
  readonly defaultValue?: readonly string[];
  readonly availableWhen?: (object: FortiObjectView) => boolean;
  readonly unimplemented?: string;
  readonly unimplementedValues?: Readonly<Record<string, string>>;
  readonly readOnly?: boolean;
  readonly hidden?: boolean;
  readonly secret?: boolean;
  readonly allowsReservedCharacters?: boolean;
  readonly appliesImmediately?: (
    values: readonly string[], context: FortiCommitContext,
  ) => void;
  readonly acceptsValue?: (value: string) => boolean;
  readonly expectedValue?: string;
  readonly valueRefusal?: (
    value: string, environment: FortiSchemaEnvironment,
  ) => string | null;
}

export type { LldpSetting, LldpVdomSetting } from '../../../l2/LldpIntent';
import type { LldpSetting, LldpVdomSetting } from '../../../l2/LldpIntent';

export interface FortiInterfacePatch {
  readonly vdom?: string;
  readonly ip?: string;
  readonly mask?: string;
  readonly up?: boolean;
  readonly allowAccess?: readonly string[];
  readonly type?: string;
  readonly parent?: string;
  readonly vlanId?: number;
  readonly mtu?: number;
  readonly aggregate?: {
    readonly members: readonly string[];
    readonly lacpMode: 'static' | 'active' | 'passive';
    readonly lacpSpeed: 'slow' | 'fast';
    readonly algorithm: 'L2' | 'L3' | 'L4';
    readonly minLinks: number;
    readonly minLinksDown: 'operational' | 'administrative';
    readonly lacpHaSecondary: boolean;
  };
  readonly lldp?: {
    readonly transmission: LldpSetting;
    readonly reception: LldpSetting;
  };
}

export interface FortiStaticRoute {
  readonly id: string;
  readonly destination: string;
  readonly mask: string;
  readonly gateway: string;
  readonly iface: string;
  readonly distance: number;
  readonly priority: number;
  readonly blackhole: boolean;
  readonly enabled: boolean;
}

export interface FortiSchedulePatch {
  readonly name: string;
  readonly days: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly onetime: boolean;
}

export interface FortiIpPoolPatch {
  readonly name: string;
  readonly type: string;
  readonly startIP: string;
  readonly endIP: string;
  readonly sourceStartIP?: string;
  readonly sourceEndIP?: string;
  readonly blockSize: number;
  readonly blocksPerUser: number;
  readonly pbaTimeout: number;
  readonly permitAnyHost: boolean;
  readonly arpReply: boolean;
  readonly arpInterface?: string;
  readonly associatedInterface?: string;
  readonly comment?: string;
}

export interface FortiVipPatch {
  readonly name: string;
  readonly externalAddress: string;
  readonly externalEndAddress?: string;
  readonly mappedAddress: string;
  readonly mappedEndAddress?: string;
  readonly externalInterfaces: readonly string[];
  readonly sourceFilters: readonly string[];
  readonly arpReply: boolean;
  readonly portForward: boolean;
  readonly protocol: number;
  readonly externalPortFrom: number;
  readonly externalPortTo: number;
  readonly mappedPort: number;
  readonly natSourceVip: boolean;
  readonly comment?: string;
}

export interface FortiFqdnVipPatch {
  readonly name: string;
  readonly externalAddress: string;
  readonly externalEndAddress?: string;
  readonly mappedAddressObject: string;
  readonly externalInterfaces: readonly string[];
  readonly sourceFilters: readonly string[];
  readonly arpReply: boolean;
  readonly comment?: string;
}

export interface FortiCentralSnatPatch {
  readonly id: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly translate: boolean;
  readonly sourceInterfaces: readonly string[];
  readonly destinationInterfaces: readonly string[];
  readonly originalAddresses: readonly string[];
  readonly destinationAddresses: readonly string[];
  readonly protocol: number;
  readonly sourcePortFrom: number;
  readonly sourcePortTo: number;
  readonly translatedPortFrom?: number;
  readonly translatedPortTo?: number;
  readonly pool?: string;
  readonly comment?: string;
}

export interface FortiPolicyRoutePatch {
  readonly id: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly action: 'permit' | 'deny';
  readonly inputDevices: readonly string[];
  readonly sources: readonly string[];
  readonly destinations: readonly string[];
  readonly outputDevice?: string;
  readonly gateway?: string;
  readonly protocol: number;
  readonly startPort: number;
  readonly endPort: number;
  readonly startSourcePort: number;
  readonly endSourcePort: number;
  readonly comment?: string;
}

export interface FortiGlobalSettings {
  readonly hostname?: string;
  readonly multiVdom: boolean;
  readonly authHttpPort?: number;
  readonly authHttpsPort?: number;
  readonly authKeepAlive?: boolean;
  readonly fragmentMemoryMb?: number;
  readonly adminSshPort?: number;
  readonly adminTelnetPort?: number;
  readonly adminHttpPort?: number;
  readonly adminHttpsPort?: number;
  readonly adminTimeoutMin?: number;
  readonly adminLockoutThreshold?: number;
  readonly adminLockoutDurationSec?: number;
  readonly preLoginBanner?: boolean;
  readonly postLoginBanner?: boolean;
  readonly lldpTransmission?: boolean;
  readonly lldpReception?: boolean;
  readonly timezone?: string;
  readonly conserveThresholds?: ConserveThresholds;
  readonly avFailopen?: string;
  readonly revisionOnLogout?: boolean;
  readonly adminHttpsRedirect?: boolean;
  readonly adminServerCertificate?: string;
}

export interface FortiIpsGlobalSettings {
  readonly failOpen: boolean;
}

export interface FortiLdbMonitorPatch {
  readonly name: string;
  readonly type: LdbMonitorType;
  readonly intervalSec: number;
  readonly timeoutSec: number;
  readonly retry: number;
  readonly port: number;
}

export interface FortiRealServerPatch {
  readonly id: string;
  readonly address: string;
  readonly port: number;
  readonly weight: number;
  readonly enabled: boolean;
  readonly maxConnections: number;
}

export interface FortiBalancedVipPatch {
  readonly name: string;
  readonly externalAddress: string;
  readonly externalEndAddress?: string;
  readonly externalInterfaces: readonly string[];
  readonly sourceFilters: readonly string[];
  readonly arpReply: boolean;
  readonly protocol: number;
  readonly externalPort: number;
  readonly method: LdbMethod;
  readonly monitors: readonly string[];
  readonly servers: readonly FortiRealServerPatch[];
  readonly comment?: string;
}

export interface FortiVdomSettings {
  readonly centralNat: boolean;
  readonly opmode: 'nat' | 'transparent';
  readonly manageIP?: string;
  readonly manageMask?: string;
  readonly gateway?: string;
}

export interface FortiMemoryLogPatch {
  readonly enabled?: boolean;
  readonly capacity?: number;
  readonly maxBytes?: number;
  readonly fullThresholds?: {
    readonly first?: number;
    readonly second?: number;
    readonly final?: number;
  };
}

export interface FortiCommitDevice {
  applyInterface(name: string, patch: FortiInterfacePatch): void;
  applyZone(name: string, members: readonly string[], intrazone: string): void;
  removeZone(name: string): void;
  applyStaticRoute(route: FortiStaticRoute): void;
  removeStaticRoute(id: string): void;
  applySchedule(schedule: FortiSchedulePatch): void;
  removeSchedule(name: string): void;
  applyVdomSettings(settings: FortiVdomSettings): void;
  setVdomLldp(transmission: LldpVdomSetting, reception: LldpVdomSetting): void;
  setSessionDirtyMode(mode: string): void;
  onPolicyChanged(policyId: string, policyMode: string): void;
  applyIpPool(pool: FortiIpPoolPatch): void;
  removeIpPool(name: string): void;
  applyVip(vip: FortiVipPatch): void;
  applyFqdnVip(vip: FortiFqdnVipPatch): string | void;
  removeVip(name: string): void;
  applyCentralSnat(entry: FortiCentralSnatPatch): void;
  removeCentralSnat(id: string): void;
  applyPolicyRoute(route: FortiPolicyRoutePatch): void;
  removePolicyRoute(id: string): void;
  applyMemoryLog(patch: FortiMemoryLogPatch): void;
  applyGlobalSettings(settings: FortiGlobalSettings): void;
  applyIpsGlobal(settings: FortiIpsGlobalSettings): void;
  applyLdbMonitor(monitor: FortiLdbMonitorPatch): void;
  applyFragmentMemoryThreshold(megabytes: number): void;
  refusePasswordReuse(admin: string, secret: string): string | null;
  refuseReuseLimit(limit: number): string | null;
  refuseBoundInterface(iface: string, excludingTable: string): string | null;
  applyIpv6Address(iface: string, address: string, prefixLength: number): boolean;
  applyIpv6AllowAccess(iface: string, services: readonly string[]): void;
  applyIpv6StaticRoute(route: {
    id: string; destination: string; prefixLength: number;
    gateway: string; iface: string; distance: number; enabled: boolean;
  }): void;
  removeIpv6StaticRoute(id: string): void;
  removeLdbMonitor(name: string): void;
  applyBalancedVip(vip: FortiBalancedVipPatch): string | void;
  applyReplacementMessage(message: string, buffer: string): void;
  applyConsoleSettings(settings: ConsoleSettingsPatch): void;
  applyDnsSettings(settings: FirewallDnsSettings): void;
  applyDnsServerInterface(entry: DnsServerInterface): void;
  removeDnsServerInterface(iface: string): void;
  applyDnsZone(zone: FortiDnsZonePatch): void;
  removeDnsZone(name: string): void;
  resolveFqdnNow(fqdn: string): void;
  setCaptivePortalInterface(iface: string, on: boolean): void;
  refreshCaptivePortal(): void;
  applySyslogCollector(settings: SyslogCollectorSettings): string | void;
  applySyslogFilter(settings: SyslogFilterSettings): string | void;
  applyVdom(name: string): void;
  removeVdom(name: string): void;
  applyVdomLink(name: string): void;
  removeVdomLink(name: string): void;
  applySwitchInterface(name: string, members: readonly string[]): void;
  removeSwitchInterface(name: string): void;
  applyAntivirusProfile(profile: FortiAntivirusPatch): void;
  removeAntivirusProfile(name: string): void;
  applyApplicationList(list: FortiApplicationListPatch): void;
  removeApplicationList(name: string): void;
  applyWebFilterProfile(profile: FortiWebFilterPatch): void;
  webFilterFeatureSet(name: string): string | undefined;
  removeWebFilterProfile(name: string): void;
  applyDnsFilterProfile(profile: FortiDnsFilterPatch): void;
  removeDnsFilterProfile(name: string): void;
  applyFileFilterProfile(profile: FortiFileFilterPatch): void;
  removeFileFilterProfile(name: string): void;
  applySslSshProfile(profile: FortiSslSshPatch): void;
  removeSslSshProfile(name: string): void;
  applyProtocolOptions(options: FortiProtocolOptionsPatch): void;
  removeProtocolOptions(name: string): void;
  applyLocalUser(user: FortiLocalUserPatch): void;
  removeLocalUser(name: string): void;
  applyUserGroup(group: FortiUserGroupPatch): void;
  removeUserGroup(name: string): void;
  applyRemoteAuthServer(server: FortiRemoteServerPatch): void;
  applyLdapServer(server: FortiLdapServerPatch): void;
  applyPhase1(tunnel: FortiPhase1Patch): void;
  applySslVpnSettings(settings: FortiSslVpnPatch): string | void;
  applySdwan(settings: SdwanConfiguration): string | void;
  applyHa(settings: HaConfiguration): string | void;
  applyRip(settings: RipConfiguration): string | void;
  applyOspf(settings: OspfConfiguration): string | void;
  applyBgp(settings: BgpConfiguration): string | void;
  applyDhcpScope(scope: DhcpScope): void;
  removeDhcpScope(id: string): void;
  applyDhcp6Scope(scope: Dhcp6Scope): void;
  removeDhcp6Scope(id: string): void;
  applyDhcp6Scope(scope: Dhcp6Scope): void;
  removeDhcp6Scope(id: string): void;
  acquireDhcpLease(iface: string): void;
  applyOnetimeSchedule(schedule: {
    name: string; start: string; end: string;
  }): string | void;
  applyScheduleGroup(group: {
    name: string; members: readonly string[];
  }): string | void;
  applyNtp(settings: NtpSettings): string | void;
  hasInterface(name: string): boolean;
  applyLocalCertificate(entry: FortiLocalCertificatePatch): string | void;
  removeLocalCertificate(name: string): void;
  applyCaCertificate(entry: FortiCaCertificatePatch): string | void;
  removeCaCertificate(name: string): void;
  removePhase1(name: string): void;
  applyPhase2(tunnel: FortiPhase2Patch): void;
  removePhase2(name: string): void;
  removeRemoteAuthServer(name: string): void;
  applyAuthSetting(setting: FortiAuthSettingPatch): void;
  applyAccessProfile(profile: FortiAccessProfilePatch): void;
  removeAccessProfile(name: string): void;
  applyAdminAccount(admin: FortiAdminPatch): void;
  removeAdminAccount(name: string): void;
  applyUrlFilterTable(table: FortiFilterTablePatch): void;
  removeUrlFilterTable(id: string): void;
  applyDomainFilterTable(table: FortiFilterTablePatch): void;
  removeDomainFilterTable(id: string): void;
}

export interface FortiAntivirusPatch {
  readonly name: string;
  readonly http: string;
  readonly ftp: string;
  readonly smtp: string;
  readonly comment?: string;
}

export interface FortiUrlFilterPatch {
  readonly id: string;
  readonly pattern: string;
  readonly type: string;
  readonly action: string;
  readonly enabled: boolean;
}

export interface FortiCategoryFilterPatch {
  readonly id: string;
  readonly category: number;
  readonly action: string;
}

export interface FortiLocalUserPatch {
  readonly name: string;
  readonly type: string;
  readonly password?: string;
  readonly server?: string;
  readonly enabled: boolean;
  readonly emailTo?: string;
}

export interface FortiGroupMatchPatch {
  readonly id: string;
  readonly serverName: string;
  readonly groupName: string;
}

export interface FortiUserGroupPatch {
  readonly name: string;
  readonly groupType: string;
  readonly members: readonly string[];
  readonly matches: readonly FortiGroupMatchPatch[];
  readonly authTimeoutMin: number;
}

export interface FortiRemoteServerPatch {
  readonly name: string;
  readonly kind: 'radius' | 'tacacs+' | 'ldap';
  readonly address: string;
  readonly secret: string;
  readonly port: number;
  readonly authType?: string;
}

export interface FortiSslVpnRulePatch {
  readonly id: string;
  readonly groups: readonly string[];
  readonly users: readonly string[];
  readonly portal: string;
}

export interface FortiSslVpnPatch {
  readonly enabled: boolean;
  readonly port: number;
  readonly serverCertificate: string;
  readonly sourceInterfaces: readonly string[];
  readonly rules: readonly FortiSslVpnRulePatch[];
}

export interface FortiLocalCertificatePatch {
  readonly name: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly comments?: string;
}

export interface FortiCaCertificatePatch {
  readonly name: string;
  readonly certificatePem: string;
  readonly trusted: boolean;
}

export interface FortiPhase1Patch {
  readonly name: string;
  readonly boundInterface: string;
  readonly ikeVersion: 1 | 2;
  readonly type: string;
  readonly remoteGateway: string;
  readonly proposals: readonly string[];
  readonly dhGroups: readonly number[];
  readonly presharedKey: string;
  readonly keyLifeSeconds: number;
  readonly authMethod: 'psk' | 'signature';
  readonly certificate: string;
  readonly dpd: string;
  readonly dpdRetryIntervalSeconds: number;
  readonly dpdRetryCount: number;
  readonly natTraversal: string;
  readonly policyBased: boolean;
  readonly modeCfg?: boolean;
  readonly authUserGroup?: string;
  readonly poolStart?: string;
  readonly poolEnd?: string;
  readonly poolNetmask?: string;
  readonly splitInclude?: string;
  readonly xauthType?: string;
  readonly authUser?: string;
  readonly authPassword?: string;
  readonly dnsServers?: readonly string[];
  readonly comments?: string;
}

export interface FortiPhase2Patch {
  readonly name: string;
  readonly phase1Name: string;
  readonly proposals: readonly string[];
  readonly sourceSubnet: string;
  readonly sourceMask: string;
  readonly destinationSubnet: string;
  readonly destinationMask: string;
  readonly pfs: boolean;
  readonly dhGroups: readonly number[];
  readonly keyLifeSeconds: number;
  readonly autoNegotiate: boolean;
}

export interface FortiLdapServerPatch {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly baseDn: string;
  readonly cnid: string;
  readonly bindType: string;
  readonly username?: string;
  readonly password?: string;
}

export interface FortiAuthSettingPatch {
  readonly timeoutMinutes: number;
  readonly timeoutType: string;
  readonly secureHttp?: boolean;
}

export interface FortiAccessProfilePatch {
  readonly name: string;
  readonly rights: Readonly<Record<string, string>>;
  readonly comments?: string;
}

export interface FortiTrustHostPatch {
  readonly index: number;
  readonly address: string;
  readonly mask: string;
}

export interface FortiAdminPatch {
  readonly name: string;
  readonly password?: string;
  readonly profile: string;
  readonly vdoms: readonly string[];
  readonly trustHosts: readonly FortiTrustHostPatch[];
  readonly comments?: string;
}

export interface FortiFilterTablePatch {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly FortiUrlFilterPatch[];
  readonly comment?: string;
}

export interface FortiApplicationListPatch {
  readonly name: string;
  readonly entries: ReadonlyArray<{
    id: string; application: string; action: string;
  }>;
  readonly comment?: string;
}

export interface FortiWebFilterPatch {
  readonly name: string;
  readonly urlFilterTable?: string;
  readonly categoryFilters: readonly FortiCategoryFilterPatch[];
  readonly unclassifiedAction: string;
  readonly logAllUrl: boolean;
  readonly featureSet: string;
  readonly comment?: string;
}

export interface FortiDnsFilterPatch {
  readonly name: string;
  readonly domainFilterTable?: string;
  readonly categoryFilters: readonly FortiCategoryFilterPatch[];
  readonly unclassifiedAction: string;
  readonly comment?: string;
}

export interface FortiFileFilterEntryPatch {
  readonly id: string;
  readonly fileTypes: readonly string[];
  readonly action: string;
  readonly direction: string;
}

export interface FortiFileFilterPatch {
  readonly name: string;
  readonly entries: readonly FortiFileFilterEntryPatch[];
  readonly scanArchiveContents: boolean;
  readonly comment?: string;
}

export interface FortiSslSshPatch {
  readonly name: string;
  readonly httpsMode: string;
  readonly httpsPorts: readonly number[];
  readonly caName: string;
  readonly untrustedCaName?: string;
  readonly serverCertMode?: string;
  readonly exemptions?: readonly FortiSslExemptPatch[];
  readonly comment?: string;
}

export interface FortiSslExemptPatch {
  readonly type: string;
  readonly category?: number;
  readonly regex?: string;
  readonly addressName?: string;
}

export interface FortiProtocolOptionsPatch {
  readonly name: string;
  readonly httpPorts: readonly number[];
  readonly httpsPorts: readonly number[];
  readonly ftpPorts: readonly number[];
  readonly dnsPorts: readonly number[];
  readonly oversizeLimitMb: number;
  readonly blockOversize: boolean;
  readonly comment?: string;
}

export interface FortiCommitContext {
  readonly policy: PolicyStore;
  readonly localIn: PolicyStore;
  readonly localIn6: PolicyStore;
  readonly dos: DosPolicyStore;
  readonly objects: ObjectStore;
  readonly device: FortiCommitDevice;
  readonly vdom: string;
  readonly position: number;
}

export interface FortiTableSpec {
  readonly path: readonly string[];
  readonly kind: 'table' | 'object';
  readonly keyType?: 'name' | 'integer' | 'address';
  readonly quotedKey?: boolean;
  readonly ordered?: boolean;
  readonly scope: FortiScope;
  readonly accessGroup: FortiAccessGroup;
  readonly help: string;
  readonly renderOrder: number;
  readonly attributes: readonly FortiAttributeSpec[];
  readonly children?: readonly FortiTableSpec[];
  readonly predefined?: readonly string[];
  readonly fixedKeys?: readonly string[];
  readonly keyOnConfigLine?: boolean;
  readonly scopeOnly?: boolean;
  readonly unavailable?: string;
  readonly onCommit?: (
    object: FortiObjectView, context: FortiCommitContext) => string | void;
  readonly onDelete?: (key: string, context: FortiCommitContext) => void;
}

export function pathKey(path: readonly string[]): string {
  return path.join(' ');
}

export function attributeMap(
  spec: FortiTableSpec,
): ReadonlyMap<string, FortiAttributeSpec> {
  const map = new Map<string, FortiAttributeSpec>();
  for (const attribute of spec.attributes) map.set(attribute.name, attribute);
  return map;
}

export function childMap(spec: FortiTableSpec): ReadonlyMap<string, FortiTableSpec> {
  const map = new Map<string, FortiTableSpec>();
  for (const child of spec.children ?? []) {
    map.set(child.path[child.path.length - 1], child);
  }
  return map;
}

export function keyAttributeName(spec: FortiTableSpec): string | undefined {
  if (spec.kind !== 'table') return undefined;

  const first = spec.attributes[0];
  if (!first) return undefined;
  return first.readOnly === true || first.unimplemented !== undefined
    ? first.name
    : undefined;
}

export function attributeArity(spec: FortiAttributeSpec): number {
  return spec.parts.length;
}

export function isQuoted(spec: FortiAttributeSpec): boolean {
  if (spec.quoted !== undefined) return spec.quoted;
  return spec.referenceTo !== undefined
    || spec.parts.every(part => part.type === 'WORD' || part.type === 'LINE');
}

const ENABLE_VALUES: readonly EnumValue[] = Object.freeze([
  { keyword: 'enable', description: 'Enable setting.' },
  { keyword: 'disable', description: 'Disable setting.' },
]);

export function enable(
  name: string, help: string, byDefault = false,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'ENUM', description: help, values: ENABLE_VALUES }],
    defaultValue: [byDefault ? 'enable' : 'disable'],
  };
}

export function text(
  name: string, help: string, defaultValue = '',
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    parts: [{ name, type: 'LINE', description: help }],
    defaultValue: [defaultValue],
  };
}

export function word(
  name: string, help: string, defaultValue = '',
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    parts: [{ name, type: 'WORD', description: help }],
    defaultValue: [defaultValue],
  };
}

export function choice(
  name: string, help: string, values: readonly EnumValue[], byDefault: string,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'ENUM', description: help, values }],
    defaultValue: [byDefault],
  };
}

export function count(
  name: string, help: string, min: number, max: number, byDefault: number,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'INT', description: help, range: [min, max] }],
    defaultValue: [String(byDefault)],
  };
}

export function refList(
  name: string, help: string, targets: readonly string[],
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    multiValue: true,
    referenceTo: targets,
    parts: [{ name, type: 'WORD', description: help }],
  };
}

export function reference(
  name: string, help: string, targets: readonly string[], defaultValue?: string,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    referenceTo: targets,
    parts: [{ name, type: 'WORD', description: help }],
    defaultValue: defaultValue === undefined ? undefined : [defaultValue],
  };
}

export function address(name: string, help: string, byDefault?: string): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'IP_ADDR', description: help }],
    defaultValue: byDefault === undefined ? undefined : [byDefault],
  };
}

export function addressMask(
  name: string, help: string, byDefault?: readonly string[],
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [
      { name, type: 'IP_ADDR', description: help },
      { name: `${name}-mask`, type: 'SUBNET_MASK', description: 'Subnet mask.' },
    ],
    defaultValue: byDefault === undefined ? undefined : [...byDefault],
  };
}

export function moment(name: string, help: string): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [
      { name, type: 'TIME', description: 'Time of day, format hh:mm.' },
      { name: `${name}-date`, type: 'WORD', description: 'Date, format yyyy/mm/dd.' },
    ],
    defaultValue: undefined,
  };
}

export function clock(name: string, help: string, byDefault?: string): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'TIME', description: help }],
    defaultValue: byDefault === undefined ? undefined : [byDefault],
  };
}
