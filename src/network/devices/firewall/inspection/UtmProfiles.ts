import { DEFAULT_OVERSIZE_LIMIT_MB } from './StreamAssembler';

export type UtmAction = 'allow' | 'block' | 'monitor';
export type SslInspectionMode = 'disable' | 'certificate-inspection' | 'deep-inspection';

export interface AntivirusProfile {
  readonly name: string;
  readonly httpScan: UtmAction;
  readonly ftpScan: UtmAction;
  readonly smtpScan: UtmAction;
  readonly comment?: string;
}

export interface UrlFilterEntry {
  readonly id: string;
  readonly pattern: string;
  readonly type: 'simple' | 'wildcard' | 'regex';
  readonly action: UtmAction;
}

export interface CategoryFilterEntry {
  readonly id: string;
  readonly category: number;
  readonly action: UtmAction;
}

export interface FilterTable {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly UrlFilterEntry[];
  readonly comment?: string;
}

export interface WebFilterProfile {
  readonly name: string;
  readonly urlFilterTable?: string;
  readonly categoryFilters: readonly CategoryFilterEntry[];
  readonly unclassifiedAction: UtmAction;
  readonly logAllUrl: boolean;
  readonly featureSet?: string;
  readonly comment?: string;
}

export interface DnsFilterProfile {
  readonly name: string;
  readonly categoryFilters: readonly CategoryFilterEntry[];
  readonly domainFilterTable?: string;
  readonly unclassifiedAction: UtmAction;
  readonly comment?: string;
}

export interface FileFilterEntry {
  readonly id: string;
  readonly fileTypes: readonly string[];
  readonly action: UtmAction;
  readonly direction: 'any' | 'incoming' | 'outgoing';
}

export interface FileFilterProfile {
  readonly name: string;
  readonly entries: readonly FileFilterEntry[];
  readonly scanArchiveContents: boolean;
  readonly comment?: string;
}

export interface ApplicationEntry {
  readonly id: string;
  readonly application: string;
  readonly action: UtmAction;
}

export interface ApplicationList {
  readonly name: string;
  readonly entries: readonly ApplicationEntry[];
  readonly comment?: string;
}

export interface SslSshProfile {
  readonly name: string;
  readonly httpsMode: SslInspectionMode;
  readonly httpsPorts: readonly number[];
  readonly caName: string;
  readonly untrustedCaName?: string;
  readonly serverCertMode?: string;
  readonly exemptions?: readonly SslExemptEntry[];
  readonly comment?: string;
}

export interface SslExemptEntry {
  readonly type: string;
  readonly category?: number;
  readonly regex?: string;
  readonly addressName?: string;
}

export interface ProtocolOptions {
  readonly name: string;
  readonly httpPorts: readonly number[];
  readonly httpsPorts: readonly number[];
  readonly ftpPorts: readonly number[];
  readonly dnsPorts: readonly number[];
  readonly oversizeLimitMb: number;
  readonly blockOversize: boolean;
  readonly comment?: string;
}

export const DEFAULT_PROTOCOL_OPTIONS: ProtocolOptions = Object.freeze({
  name: 'default',
  httpPorts: Object.freeze([80]),
  httpsPorts: Object.freeze([443]),
  ftpPorts: Object.freeze([21]),
  dnsPorts: Object.freeze([53]),
  oversizeLimitMb: DEFAULT_OVERSIZE_LIMIT_MB,
  blockOversize: false,
});

export type UrlCategoryId = number;

export interface UrlCategory {
  readonly id: UrlCategoryId;
  readonly name: string;
  readonly domains: readonly string[];
}

export const UNCLASSIFIED_CATEGORY = 0;

export const LOCAL_URL_CATEGORIES: readonly UrlCategory[] = Object.freeze([
  Object.freeze({
    id: 26, name: 'Social Networking',
    domains: Object.freeze(['social.example', 'reseau.example', 'lab-social.test']),
  }),
  Object.freeze({
    id: 33, name: 'Games',
    domains: Object.freeze(['jeux.example', 'games.example', 'lab-games.test']),
  }),
  Object.freeze({
    id: 14, name: 'Adult Materials',
    domains: Object.freeze(['adulte.example', 'lab-adult.test']),
  }),
  Object.freeze({
    id: 52, name: 'Information Technology',
    domains: Object.freeze(['docs.example', 'lab-it.test']),
  }),
]);

export function categoryOfDomain(host: string): UrlCategoryId {
  const lowered = host.toLowerCase();
  for (const category of LOCAL_URL_CATEGORIES) {
    for (const domain of category.domains) {
      if (lowered === domain || lowered.endsWith(`.${domain}`)) return category.id;
    }
  }
  return UNCLASSIFIED_CATEGORY;
}

export function categoryName(id: UrlCategoryId): string {
  if (id === UNCLASSIFIED_CATEGORY) return 'Unrated';
  return LOCAL_URL_CATEGORIES.find(category => category.id === id)?.name ?? 'Unrated';
}

export class UtmProfileStore {
  private readonly antivirus = new Map<string, AntivirusProfile>();
  private readonly webfilter = new Map<string, WebFilterProfile>();
  private readonly dnsfilter = new Map<string, DnsFilterProfile>();
  private readonly filefilter = new Map<string, FileFilterProfile>();
  private readonly applications = new Map<string, ApplicationList>();
  private readonly sslSsh = new Map<string, SslSshProfile>();
  private readonly protocolOptions = new Map<string, ProtocolOptions>();
  private readonly urlFilterTables = new Map<string, FilterTable>();
  private readonly domainFilterTables = new Map<string, FilterTable>();

  constructor() {
    this.protocolOptions.set('default', DEFAULT_PROTOCOL_OPTIONS);
  }

  setAntivirus(profile: AntivirusProfile): void { this.antivirus.set(profile.name, profile); }
  getAntivirus(name: string): AntivirusProfile | undefined { return this.antivirus.get(name); }
  removeAntivirus(name: string): boolean { return this.antivirus.delete(name); }
  antivirusNames(): readonly string[] { return Object.freeze([...this.antivirus.keys()]); }

  setWebFilter(profile: WebFilterProfile): void { this.webfilter.set(profile.name, profile); }
  getWebFilter(name: string): WebFilterProfile | undefined { return this.webfilter.get(name); }
  removeWebFilter(name: string): boolean { return this.webfilter.delete(name); }
  webFilterNames(): readonly string[] { return Object.freeze([...this.webfilter.keys()]); }

  setDnsFilter(profile: DnsFilterProfile): void { this.dnsfilter.set(profile.name, profile); }
  getDnsFilter(name: string): DnsFilterProfile | undefined { return this.dnsfilter.get(name); }
  removeDnsFilter(name: string): boolean { return this.dnsfilter.delete(name); }
  dnsFilterNames(): readonly string[] { return Object.freeze([...this.dnsfilter.keys()]); }

  setFileFilter(profile: FileFilterProfile): void { this.filefilter.set(profile.name, profile); }
  getFileFilter(name: string): FileFilterProfile | undefined { return this.filefilter.get(name); }
  removeFileFilter(name: string): boolean { return this.filefilter.delete(name); }

  setApplicationList(list: ApplicationList): void {
    this.applications.set(list.name, list);
  }

  getApplicationList(name: string): ApplicationList | undefined {
    return this.applications.get(name);
  }

  removeApplicationList(name: string): boolean {
    return this.applications.delete(name);
  }

  applicationListNames(): readonly string[] {
    return Object.freeze([...this.applications.keys()]);
  }
  fileFilterNames(): readonly string[] { return Object.freeze([...this.filefilter.keys()]); }

  setSslSsh(profile: SslSshProfile): void { this.sslSsh.set(profile.name, profile); }
  getSslSsh(name: string): SslSshProfile | undefined { return this.sslSsh.get(name); }
  removeSslSsh(name: string): boolean { return this.sslSsh.delete(name); }
  sslSshNames(): readonly string[] { return Object.freeze([...this.sslSsh.keys()]); }

  setUrlFilterTable(table: FilterTable): void { this.urlFilterTables.set(table.id, table); }
  removeUrlFilterTable(id: string): boolean { return this.urlFilterTables.delete(id); }
  urlFilterTableIds(): readonly string[] {
    return Object.freeze([...this.urlFilterTables.keys()]);
  }

  setDomainFilterTable(table: FilterTable): void {
    this.domainFilterTables.set(table.id, table);
  }

  removeDomainFilterTable(id: string): boolean { return this.domainFilterTables.delete(id); }
  domainFilterTableIds(): readonly string[] {
    return Object.freeze([...this.domainFilterTables.keys()]);
  }

  urlFiltersOf(profile: WebFilterProfile): readonly UrlFilterEntry[] {
    if (profile.urlFilterTable === undefined) return Object.freeze([]);
    return this.urlFilterTables.get(profile.urlFilterTable)?.entries ?? Object.freeze([]);
  }

  domainFiltersOf(profile: DnsFilterProfile): readonly UrlFilterEntry[] {
    if (profile.domainFilterTable === undefined) return Object.freeze([]);
    return this.domainFilterTables.get(profile.domainFilterTable)?.entries ?? Object.freeze([]);
  }

  setProtocolOptions(options: ProtocolOptions): void {
    this.protocolOptions.set(options.name, options);
  }

  getProtocolOptions(name?: string): ProtocolOptions {
    if (name === undefined) return DEFAULT_PROTOCOL_OPTIONS;
    return this.protocolOptions.get(name) ?? DEFAULT_PROTOCOL_OPTIONS;
  }

  removeProtocolOptions(name: string): boolean { return this.protocolOptions.delete(name); }
  protocolOptionNames(): readonly string[] {
    return Object.freeze([...this.protocolOptions.keys()]);
  }
}
