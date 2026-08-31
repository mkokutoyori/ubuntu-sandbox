export type DhcpRelayInfoPolicy = 'keep' | 'replace' | 'drop';

export const DHCP_RELAY_INFO_POLICIES: ReadonlySet<string> =
  new Set<DhcpRelayInfoPolicy>(['keep', 'replace', 'drop']);

export const CEF_LOAD_SHARING_ALGORITHMS: ReadonlySet<string> =
  new Set(['original', 'universal', 'tunnel', 'include-ports']);

export const CEF_ACCOUNTING_KINDS: ReadonlySet<string> =
  new Set(['per-prefix', 'non-recursive', 'load-balance-hash', 'prefix-length']);

export class CiscoGlobalConfig {
  dhcpRelayInfoPolicy: DhcpRelayInfoPolicy | null = null;
  dhcpRelayInfoTrustAll = false;
  dhcpSmartRelay = false;
  dhcpSnooping = false;
  dhcpSnoopingVlans: string | null = null;
  dhcpSnoopingInfoOption = false;
  defaultNetwork: string | null = null;
  localPolicyRouteMap: string | null = null;
  cefLoadSharingAlgorithm: string | null = null;
  cefAccounting: Set<string> = new Set();

  runningConfigLines(): string[] {
    const lines: string[] = [];
    for (const quoi of this.cefAccounting) lines.push(`ip cef accounting ${quoi}`);
    if (this.cefLoadSharingAlgorithm) {
      lines.push(`ip cef load-sharing algorithm ${this.cefLoadSharingAlgorithm}`);
    }
    if (this.dhcpSnooping) lines.push('ip dhcp snooping');
    if (this.dhcpSnoopingVlans) lines.push(`ip dhcp snooping vlan ${this.dhcpSnoopingVlans}`);
    if (this.dhcpSnoopingInfoOption) lines.push('ip dhcp snooping information option');
    if (this.dhcpRelayInfoPolicy) {
      lines.push(`ip dhcp relay information policy ${this.dhcpRelayInfoPolicy}`);
    }
    if (this.dhcpRelayInfoTrustAll) lines.push('ip dhcp relay information trust-all');
    if (this.dhcpSmartRelay) lines.push('ip dhcp smart-relay');
    if (this.defaultNetwork) lines.push(`ip default-network ${this.defaultNetwork}`);
    if (this.localPolicyRouteMap) {
      lines.push(`ip local policy route-map ${this.localPolicyRouteMap}`);
    }
    return lines;
  }
}

const GLOBAL_KEY = Symbol.for('CiscoGlobalConfig');

export function getGlobalConfig(router: object): CiscoGlobalConfig {
  const r = router as unknown as Record<symbol, CiscoGlobalConfig>;
  if (!r[GLOBAL_KEY]) r[GLOBAL_KEY] = new CiscoGlobalConfig();
  return r[GLOBAL_KEY];
}

export function globalConfigRunningConfigLines(router: object): string[] {
  const r = router as unknown as Record<symbol, CiscoGlobalConfig | undefined>;
  return r[GLOBAL_KEY]?.runningConfigLines() ?? [];
}
