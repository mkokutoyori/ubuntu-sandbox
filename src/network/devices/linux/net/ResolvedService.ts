/**
 * systemd-resolved — le stub qui répond enfin.
 *
 * `ss -ulnp` annonçait un stub à l'écoute sur 127.0.0.53:53 depuis
 * toujours : c'était un `bind()` sans gestionnaire, posé pour que `ss` et
 * `netstat` aient l'air justes. Le système affirmait un service qui
 * n'existait pas (`docs/PRD-resolvectl.md` §0).
 *
 * Ce module est le service réel : configuration globale et par lien,
 * sélection du serveur selon les domaines, cache, et compteurs.
 *
 * Référence : `systemd-resolved.service(8)`, `resolved.conf(5)`.
 */

import { DnsCache } from '@/network/dns/resolver/DnsCache';

export type TriState = 'yes' | 'no' | 'resolve';
export type DnssecMode = 'yes' | 'no' | 'allow-downgrade';
export type DnsOverTlsMode = 'yes' | 'no' | 'opportunistic';

export interface ResolvedLinkConfig {
  dnsServers: string[];
  /** Un domaine préfixé `~` ne sert qu'au routage, pas à la recherche. */
  domains: string[];
  defaultRoute: boolean;
  llmnr: TriState;
  mdns: TriState;
  dnssec: DnssecMode;
  dnsOverTls: DnsOverTlsMode;
  /** Posée par networkd plutôt que par l'opérateur. */
  fromNetworkd: boolean;
}

export interface ResolvedGlobalConfig {
  dnsServers: string[];
  fallbackDns: string[];
  domains: string[];
  llmnr: TriState;
  mdns: TriState;
  dnssec: DnssecMode;
  dnsOverTls: DnsOverTlsMode;
  cache: boolean;
}

export interface ResolvedStatistics {
  transactions: number;
  cacheHits: number;
  cacheMisses: number;
  currentCacheSize: number;
  failedTransactions: number;
}

export function defaultLinkConfig(): ResolvedLinkConfig {
  return {
    dnsServers: [],
    domains: [],
    defaultRoute: false,
    llmnr: 'yes',
    mdns: 'no',
    dnssec: 'allow-downgrade',
    dnsOverTls: 'no',
    fromNetworkd: false,
  };
}

export function defaultGlobalConfig(): ResolvedGlobalConfig {
  return {
    dnsServers: [],
    fallbackDns: [],
    domains: [],
    llmnr: 'yes',
    mdns: 'no',
    dnssec: 'allow-downgrade',
    dnsOverTls: 'no',
    cache: true,
  };
}

/** L'adresse du stub. Le résolveur NSS ne laisse passer qu'elle en 127.*. */
export const STUB_ADDRESS = '127.0.0.53';
export const RESOLVED_CONF_PATH = '/etc/systemd/resolved.conf';
export const RUN_STUB_RESOLV = '/run/systemd/resolve/stub-resolv.conf';
export const RUN_UPSTREAM_RESOLV = '/run/systemd/resolve/resolv.conf';

function parseTri(v: string | undefined, fallback: TriState): TriState {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'yes' || s === 'no' || s === 'resolve' ? s : fallback;
}

/**
 * `resolved.conf` est un fichier d'unités systemd : sections entre
 * crochets, `clé=valeur`, `#` et `;` en commentaire.
 */
export function parseResolvedConf(text: string | null): ResolvedGlobalConfig {
  const cfg = defaultGlobalConfig();
  if (!text) return cfg;
  const values = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  const list = (key: string): string[] =>
    (values.get(key) ?? '').split(/[\s,]+/).filter(Boolean);

  cfg.dnsServers = list('dns');
  cfg.fallbackDns = list('fallbackdns');
  cfg.domains = list('domains');
  cfg.llmnr = parseTri(values.get('llmnr'), cfg.llmnr);
  cfg.mdns = parseTri(values.get('multicastdns'), cfg.mdns);
  const dnssec = (values.get('dnssec') ?? '').trim().toLowerCase();
  if (dnssec === 'yes' || dnssec === 'no' || dnssec === 'allow-downgrade') cfg.dnssec = dnssec;
  const dot = (values.get('dnsovertls') ?? '').trim().toLowerCase();
  if (dot === 'yes' || dot === 'no' || dot === 'opportunistic') cfg.dnsOverTls = dot;
  const cache = (values.get('cache') ?? '').trim().toLowerCase();
  if (cache) cfg.cache = !/^(no|false|0)$/.test(cache);
  return cfg;
}

export interface ResolvedQueryOutcome {
  addresses: string[];
  /** D'où vient la réponse — `resolvectl query` le dit à l'opérateur. */
  origin: 'cache' | 'network' | 'none';
  link: string | null;
  server: string | null;
}

export interface ResolvedDeps {
  /** Interroge réellement un serveur sur le câble. Null = pas de réponse. */
  queryUpstream(server: string, name: string): string[] | null;
  now?(): number;
}

export class ResolvedService {
  private global = defaultGlobalConfig();
  private readonly links = new Map<string, ResolvedLinkConfig>();
  private readonly cache: DnsCache;
  private stats: ResolvedStatistics = {
    transactions: 0, cacheHits: 0, cacheMisses: 0,
    currentCacheSize: 0, failedTransactions: 0,
  };
  /** Réponses mises en cache par le stub, avec leur échéance. */
  private readonly answers = new Map<string, { addresses: string[]; expiresAtMs: number }>();

  constructor(private readonly deps: ResolvedDeps) {
    this.cache = new DnsCache(deps.now ?? (() => Date.now()));
  }

  setGlobal(cfg: ResolvedGlobalConfig): void { this.global = cfg; }
  getGlobal(): Readonly<ResolvedGlobalConfig> { return this.global; }

  linkConfig(iface: string): ResolvedLinkConfig {
    let cfg = this.links.get(iface);
    if (!cfg) { cfg = defaultLinkConfig(); this.links.set(iface, cfg); }
    return cfg;
  }

  listLinks(): ReadonlyMap<string, ResolvedLinkConfig> { return this.links; }

  /** `resolvectl revert <lien>` — retire tout ce qui a été posé sur ce lien. */
  revertLink(iface: string): void { this.links.set(iface, defaultLinkConfig()); }

  /**
   * Le lien dont un `Domains=` couvre le nom gagne ; sinon un lien
   * `default-route` ; sinon le global ; sinon `FallbackDNS`. C'est la
   * règle de systemd, et c'est elle qui rend `status` lisible.
   */
  selectServer(name: string): { server: string | null; link: string | null } {
    const fqdn = name.toLowerCase().replace(/\.$/, '');
    let bestLink: string | null = null;
    let bestLength = -1;
    for (const [iface, cfg] of this.links) {
      if (cfg.dnsServers.length === 0) continue;
      for (const raw of cfg.domains) {
        const domain = raw.replace(/^~/, '').toLowerCase().replace(/\.$/, '');
        if (!domain) continue;
        if (fqdn === domain || fqdn.endsWith(`.${domain}`)) {
          if (domain.length > bestLength) { bestLength = domain.length; bestLink = iface; }
        }
      }
    }
    if (bestLink) return { server: this.links.get(bestLink)!.dnsServers[0], link: bestLink };

    for (const [iface, cfg] of this.links) {
      if (cfg.defaultRoute && cfg.dnsServers.length > 0) {
        return { server: cfg.dnsServers[0], link: iface };
      }
    }
    for (const [iface, cfg] of this.links) {
      if (cfg.dnsServers.length > 0) return { server: cfg.dnsServers[0], link: iface };
    }
    if (this.global.dnsServers.length > 0) return { server: this.global.dnsServers[0], link: null };
    if (this.global.fallbackDns.length > 0) return { server: this.global.fallbackDns[0], link: null };
    return { server: null, link: null };
  }

  /** Ce que le stub fait d'une requête : cache, puis fil, puis cache. */
  resolve(name: string, ttlSeconds = 60): ResolvedQueryOutcome {
    this.stats.transactions++;
    const key = name.toLowerCase().replace(/\.$/, '');
    const now = (this.deps.now ?? (() => Date.now()))();

    if (this.global.cache) {
      const cached = this.answers.get(key);
      if (cached && cached.expiresAtMs > now) {
        this.stats.cacheHits++;
        return { addresses: [...cached.addresses], origin: 'cache', link: null, server: null };
      }
      if (cached) this.answers.delete(key);
      this.stats.cacheMisses++;
    }

    const { server, link } = this.selectServer(key);
    if (!server) {
      this.stats.failedTransactions++;
      return { addresses: [], origin: 'none', link: null, server: null };
    }
    const addresses = this.deps.queryUpstream(server, key);
    if (!addresses || addresses.length === 0) {
      this.stats.failedTransactions++;
      return { addresses: [], origin: 'none', link, server };
    }
    if (this.global.cache) {
      this.answers.set(key, { addresses: [...addresses], expiresAtMs: now + ttlSeconds * 1000 });
      this.stats.currentCacheSize = this.answers.size;
    }
    return { addresses, origin: 'network', link, server };
  }

  flushCaches(): void {
    this.answers.clear();
    this.cache.flush();
    this.stats.currentCacheSize = 0;
  }

  statistics(): Readonly<ResolvedStatistics> {
    return { ...this.stats, currentCacheSize: this.answers.size };
  }

  resetStatistics(): void {
    this.stats = {
      transactions: 0, cacheHits: 0, cacheMisses: 0,
      currentCacheSize: this.answers.size, failedTransactions: 0,
    };
  }

  /** Contenu de `/run/systemd/resolve/stub-resolv.conf`. */
  stubResolvConf(): string {
    const search = [...new Set([
      ...this.global.domains,
      ...[...this.links.values()].flatMap((l) => l.domains),
    ])].filter((d) => !d.startsWith('~'));
    const lines = [
      '# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).',
      '# Do not edit.',
      '',
      `nameserver ${STUB_ADDRESS}`,
    ];
    if (search.length) lines.push(`search ${search.join(' ')}`);
    return `${lines.join('\n')}\n`;
  }

  /** Contenu de `/run/systemd/resolve/resolv.conf` — les serveurs en amont. */
  upstreamResolvConf(): string {
    const servers = [...new Set([
      ...[...this.links.values()].flatMap((l) => l.dnsServers),
      ...this.global.dnsServers,
      ...this.global.fallbackDns,
    ])];
    const search = [...new Set([
      ...this.global.domains,
      ...[...this.links.values()].flatMap((l) => l.domains),
    ])].filter((d) => !d.startsWith('~'));
    const lines = [
      '# This is /run/systemd/resolve/resolv.conf managed by man:systemd-resolved(8).',
      '# Do not edit.',
      '',
    ];
    for (const s of servers) lines.push(`nameserver ${s}`);
    if (search.length) lines.push(`search ${search.join(' ')}`);
    return `${lines.join('\n')}\n`;
  }
}
