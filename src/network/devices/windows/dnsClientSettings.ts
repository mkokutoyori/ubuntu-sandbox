import type { PSRegistryProvider, RegistryAddress, RegistryValueType } from './PSRegistryProvider';

const TCPIP_PARAMETERS = ['SYSTEM', 'CurrentControlSet', 'Services', 'Tcpip', 'Parameters'] as const;
const DNSCACHE_PARAMETERS = ['SYSTEM', 'CurrentControlSet', 'Services', 'Dnscache', 'Parameters'] as const;
const DEFAULT_NAME_ENCODING = 'Utf8WithMapping';
const NRPT_RULES_KEY = [...DNSCACHE_PARAMETERS, 'DnsPolicyConfig'] as const;
const NRPT_GLOBAL_KEY = [...DNSCACHE_PARAMETERS, 'NrptGlobal'] as const;
const DOH_SERVERS_KEY = [...DNSCACHE_PARAMETERS, 'DohWellKnownServers'] as const;

const MULTI_SZ_SEPARATOR = '\\0';
const SERVER_LIST_SEPARATOR = ';';

export const CONFIG_DNSSEC = 2;
export const CONFIG_DIRECT_ACCESS = 4;
export const CONFIG_NAME_SERVERS = 8;

const address = (segments: readonly string[]): RegistryAddress => ({ root: 'HKLM', segments, machine: null });

export interface DnsClientInterfaceSettings {
  readonly connectionSuffix: string;
  readonly registerThisConnectionsAddress: boolean;
  readonly useSuffixWhenRegistering: boolean;
}

export interface DnsClientGlobalSettings {
  readonly suffixSearchList: readonly string[];
  readonly useDevolution: boolean;
  readonly devolutionLevel: number;
}

export interface NrptRule {
  readonly name: string;
  readonly version: number;
  readonly namespaces: readonly string[];
  readonly ipsecCaRestriction: string;
  readonly directAccessDnsServers: readonly string[];
  readonly directAccessEnabled: boolean;
  readonly directAccessProxyType: string;
  readonly directAccessProxyName: string;
  readonly directAccessQueryIpsecEncryption: string;
  readonly directAccessQueryIpsecRequired: boolean;
  readonly nameServers: readonly string[];
  readonly dnsSecEnabled: boolean;
  readonly dnsSecQueryIpsecEncryption: string;
  readonly dnsSecQueryIpsecRequired: boolean;
  readonly dnsSecValidationRequired: boolean;
  readonly nameEncoding: string;
  readonly displayName: string;
  readonly comment: string;
}

export type NrptRuleDraft = Partial<Omit<NrptRule, 'name' | 'version'>> & { readonly namespaces: readonly string[] };

export interface NrptGlobalSettings {
  readonly enableDAForAllNetworks: string;
  readonly queryPolicy: string;
  readonly secureNameQueryFallback: string;
}

export interface DohServerAddress {
  readonly serverAddress: string;
  readonly dohTemplate: string;
  readonly allowFallbackToUdp: boolean;
  readonly autoUpgrade: boolean;
}

const NRPT_GLOBAL_DEFAULTS: NrptGlobalSettings = {
  enableDAForAllNetworks: 'Disable', queryPolicy: 'Disable', secureNameQueryFallback: 'Disable',
};

const WELL_KNOWN_DOH_SERVERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['https://cloudflare-dns.com/dns-query', ['1.1.1.1', '1.0.0.1', '2606:4700:4700::1111', '2606:4700:4700::1001']],
  ['https://dns.google/dns-query', ['8.8.8.8', '8.8.4.4', '2001:4860:4860::8888', '2001:4860:4860::8844']],
  ['https://dns.quad9.net/dns-query', ['9.9.9.9', '149.112.112.112', '2620:fe::fe', '2620:fe::9']],
];

export class WindowsDnsClientSettings {
  constructor(private readonly registry: PSRegistryProvider) {
    if (!registry.testPath(`HKLM:\\${DOH_SERVERS_KEY.join('\\')}`)) {
      for (const [template, addresses] of WELL_KNOWN_DOH_SERVERS) {
        for (const serverAddress of addresses) {
          this.setDohServer({ serverAddress, dohTemplate: template, allowFallbackToUdp: false, autoUpgrade: false });
        }
      }
    }
  }

  private read(segments: readonly string[]): Record<string, string | number> {
    return this.registry.getItemPropertyValues(`HKLM\\${segments.join('\\')}`) ?? {};
  }

  private write(segments: readonly string[], name: string, type: RegistryValueType, value: string | number): void {
    this.registry.setValue(address(segments), name, type, value);
  }

  private text(values: Record<string, string | number>, name: string): string {
    const found = Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found === undefined ? '' : String(found[1]);
  }

  private flag(values: Record<string, string | number>, name: string, fallback: boolean): boolean {
    const raw = this.text(values, name);
    return raw === '' ? fallback : Number(raw) !== 0;
  }

  private list(raw: string, separator: string): string[] {
    return raw.split(separator).map(item => item.trim()).filter(item => item !== '');
  }

  globalSettings(): DnsClientGlobalSettings {
    const tcpip = this.read(TCPIP_PARAMETERS);
    const dnscache = this.read(DNSCACHE_PARAMETERS);
    const level = Number(this.text(dnscache, 'DomainNameDevolutionLevel'));
    return {
      suffixSearchList: this.list(this.text(tcpip, 'SearchList'), ','),
      useDevolution: this.flag(tcpip, 'UseDomainNameDevolution', true),
      devolutionLevel: Number.isFinite(level) ? level : 0,
    };
  }

  setGlobalSettings(changes: { suffixSearchList?: readonly string[]; useDevolution?: boolean; devolutionLevel?: number }): void {
    if (changes.suffixSearchList !== undefined) this.write(TCPIP_PARAMETERS, 'SearchList', 'String', changes.suffixSearchList.join(','));
    if (changes.useDevolution !== undefined) this.write(TCPIP_PARAMETERS, 'UseDomainNameDevolution', 'DWord', changes.useDevolution ? 1 : 0);
    if (changes.devolutionLevel !== undefined) this.write(DNSCACHE_PARAMETERS, 'DomainNameDevolutionLevel', 'DWord', changes.devolutionLevel);
  }

  private interfaceKey(guid: string): string[] {
    return [...TCPIP_PARAMETERS, 'Interfaces', guid];
  }

  interfaceSettings(guid: string): DnsClientInterfaceSettings {
    const values = this.read(this.interfaceKey(guid));
    return {
      connectionSuffix: this.text(values, 'Domain'),
      registerThisConnectionsAddress: !this.flag(values, 'DisableDynamicUpdate', false),
      useSuffixWhenRegistering: this.flag(values, 'RegisterAdapterName', false),
    };
  }

  setInterfaceSettings(guid: string, changes: {
    connectionSuffix?: string | null; registerThisConnectionsAddress?: boolean; useSuffixWhenRegistering?: boolean;
  }): void {
    const key = this.interfaceKey(guid);
    if (changes.connectionSuffix === null) this.registry.deleteValue(address(key), 'Domain');
    else if (changes.connectionSuffix !== undefined) this.write(key, 'Domain', 'String', changes.connectionSuffix);
    if (changes.registerThisConnectionsAddress !== undefined) this.write(key, 'DisableDynamicUpdate', 'DWord', changes.registerThisConnectionsAddress ? 0 : 1);
    if (changes.useSuffixWhenRegistering !== undefined) this.write(key, 'RegisterAdapterName', 'DWord', changes.useSuffixWhenRegistering ? 1 : 0);
  }

  private ruleFrom(name: string, values: Record<string, string | number>): NrptRule {
    return {
      name,
      version: Number(this.text(values, 'Version')) || 2,
      namespaces: this.list(this.text(values, 'Name'), MULTI_SZ_SEPARATOR),
      ipsecCaRestriction: this.text(values, 'IPSECCARestriction'),
      directAccessDnsServers: this.list(this.text(values, 'DirectAccessDNSServers'), SERVER_LIST_SEPARATOR),
      directAccessEnabled: (Number(this.text(values, 'ConfigOptions')) & CONFIG_DIRECT_ACCESS) !== 0,
      directAccessProxyType: this.text(values, 'DirectAccessProxyType'),
      directAccessProxyName: this.text(values, 'DirectAccessProxyName'),
      directAccessQueryIpsecEncryption: this.text(values, 'DirectAccessQueryIPSECEncryption'),
      directAccessQueryIpsecRequired: this.flag(values, 'DirectAccessQueryIPSECRequired', false),
      nameServers: this.list(this.text(values, 'GenericDNSServers'), SERVER_LIST_SEPARATOR),
      dnsSecEnabled: (Number(this.text(values, 'ConfigOptions')) & CONFIG_DNSSEC) !== 0,
      dnsSecQueryIpsecEncryption: this.text(values, 'DNSSECQueryIPSECEncryption'),
      dnsSecQueryIpsecRequired: this.flag(values, 'DNSSECQueryIPSECRequired', false),
      dnsSecValidationRequired: this.flag(values, 'DNSSECValidationRequired', false),
      nameEncoding: this.text(values, 'NameEncoding') || DEFAULT_NAME_ENCODING,
      displayName: this.text(values, 'DisplayName'),
      comment: this.text(values, 'Comment'),
    };
  }

  nrptRules(): NrptRule[] {
    return this.registry.listSubkeyNames(`HKLM\\${NRPT_RULES_KEY.join('\\')}`)
      .map(name => this.ruleFrom(name, this.read([...NRPT_RULES_KEY, name])));
  }

  addNrptRule(name: string, draft: NrptRuleDraft): NrptRule {
    const key = [...NRPT_RULES_KEY, name];
    this.registry.createKey(address(key));
    this.writeRule(key, { ...this.ruleFrom(name, {}), ...draft, name });
    return this.nrptRules().find(rule => rule.name === name)!;
  }

  updateNrptRule(name: string, changes: Partial<NrptRuleDraft>): NrptRule | null {
    const current = this.nrptRules().find(rule => rule.name === name);
    if (current === undefined) return null;
    this.writeRule([...NRPT_RULES_KEY, name], { ...current, ...changes });
    return this.nrptRules().find(rule => rule.name === name) ?? null;
  }

  removeNrptRule(name: string): boolean {
    return this.registry.deleteKey(address([...NRPT_RULES_KEY, name]));
  }

  private writeRule(key: readonly string[], rule: NrptRule): void {
    const options = (rule.dnsSecEnabled ? CONFIG_DNSSEC : 0)
      | (rule.directAccessEnabled ? CONFIG_DIRECT_ACCESS : 0)
      | (rule.nameServers.length > 0 ? CONFIG_NAME_SERVERS : 0);
    this.write(key, 'Version', 'DWord', rule.version);
    this.write(key, 'Name', 'MultiString', rule.namespaces.join(MULTI_SZ_SEPARATOR));
    this.write(key, 'ConfigOptions', 'DWord', options);
    this.keepUnlessDefault(key, 'GenericDNSServers', 'String', rule.nameServers.join(SERVER_LIST_SEPARATOR));
    this.keepUnlessDefault(key, 'DirectAccessDNSServers', 'String', rule.directAccessDnsServers.join(SERVER_LIST_SEPARATOR));
    this.keepUnlessDefault(key, 'DirectAccessProxyType', 'String', rule.directAccessProxyType);
    this.keepUnlessDefault(key, 'DirectAccessProxyName', 'String', rule.directAccessProxyName);
    this.keepUnlessDefault(key, 'DirectAccessQueryIPSECEncryption', 'String', rule.directAccessQueryIpsecEncryption);
    this.keepUnlessDefault(key, 'DirectAccessQueryIPSECRequired', 'DWord', rule.directAccessQueryIpsecRequired ? 1 : 0);
    this.keepUnlessDefault(key, 'IPSECCARestriction', 'String', rule.ipsecCaRestriction);
    this.keepUnlessDefault(key, 'DNSSECQueryIPSECEncryption', 'String', rule.dnsSecQueryIpsecEncryption);
    this.keepUnlessDefault(key, 'DNSSECQueryIPSECRequired', 'DWord', rule.dnsSecQueryIpsecRequired ? 1 : 0);
    this.keepUnlessDefault(key, 'DNSSECValidationRequired', 'DWord', rule.dnsSecValidationRequired ? 1 : 0);
    this.keepUnlessDefault(key, 'NameEncoding', 'String', rule.nameEncoding === DEFAULT_NAME_ENCODING ? '' : rule.nameEncoding);
    this.keepUnlessDefault(key, 'DisplayName', 'String', rule.displayName);
    this.keepUnlessDefault(key, 'Comment', 'String', rule.comment);
  }

  private keepUnlessDefault(key: readonly string[], name: string, type: 'String' | 'DWord', value: string | number): void {
    if (value === '' || value === 0) this.registry.deleteValue(address(key), name);
    else this.write(key, name, type, value);
  }

  nrptGlobal(): NrptGlobalSettings {
    const values = this.read(NRPT_GLOBAL_KEY);
    return {
      enableDAForAllNetworks: this.text(values, 'EnableDAForAllNetworks') || NRPT_GLOBAL_DEFAULTS.enableDAForAllNetworks,
      queryPolicy: this.text(values, 'QueryPolicy') || NRPT_GLOBAL_DEFAULTS.queryPolicy,
      secureNameQueryFallback: this.text(values, 'SecureNameQueryFallback') || NRPT_GLOBAL_DEFAULTS.secureNameQueryFallback,
    };
  }

  setNrptGlobal(changes: Partial<NrptGlobalSettings>): void {
    this.registry.createKey(address(NRPT_GLOBAL_KEY));
    for (const [name, value] of Object.entries(changes)) {
      const label = name === 'enableDAForAllNetworks' ? 'EnableDAForAllNetworks' : name[0].toUpperCase() + name.slice(1);
      if (value !== undefined) this.write(NRPT_GLOBAL_KEY, label, 'String', value);
    }
  }

  dohServers(): DohServerAddress[] {
    return this.registry.listSubkeyNames(`HKLM\\${DOH_SERVERS_KEY.join('\\')}`).map((serverAddress) => {
      const values = this.read([...DOH_SERVERS_KEY, serverAddress]);
      return {
        serverAddress,
        dohTemplate: this.text(values, 'Template'),
        allowFallbackToUdp: this.flag(values, 'AllowFallbackToUdp', false),
        autoUpgrade: this.flag(values, 'AutoUpgrade', false),
      };
    });
  }

  setDohServer(entry: DohServerAddress): void {
    const key = [...DOH_SERVERS_KEY, entry.serverAddress];
    this.registry.createKey(address(key));
    this.write(key, 'Template', 'String', entry.dohTemplate);
    this.write(key, 'AllowFallbackToUdp', 'DWord', entry.allowFallbackToUdp ? 1 : 0);
    this.write(key, 'AutoUpgrade', 'DWord', entry.autoUpgrade ? 1 : 0);
  }

  removeDohServer(serverAddress: string): boolean {
    return this.registry.deleteKey(address([...DOH_SERVERS_KEY, serverAddress]));
  }
}
