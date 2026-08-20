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
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

export type TriState = 'yes' | 'no' | 'resolve';
export type DnssecMode = 'yes' | 'no' | 'allow-downgrade';
export type DnsOverTlsMode = 'yes' | 'no' | 'opportunistic';

/**
 * Réglages d'un lien. `null` veut dire « non posé sur ce lien » : c'est
 * alors le global de `resolved.conf` qui s'applique. Une valeur par défaut
 * en dur masquerait le global, et `DNSOverTLS=`/`DNSSEC=` n'auraient
 * jamais d'effet sur un lien existant.
 */
export interface ResolvedLinkConfig {
  dnsServers: string[];
  /** Un domaine préfixé `~` ne sert qu'au routage, pas à la recherche. */
  domains: string[];
  defaultRoute: boolean;
  llmnr: TriState | null;
  mdns: TriState | null;
  dnssec: DnssecMode | null;
  dnsOverTls: DnsOverTlsMode | null;
  /**
   * `resolvectl nta` — domaines soustraits à la validation DNSSEC. Un nom
   * couvert par une ancre négative est rendu sans être validé.
   */
  negativeTrustAnchors: string[];
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
  /** Réponses validées comme signées et intègres. */
  secureTransactions: number;
}

export function defaultLinkConfig(): ResolvedLinkConfig {
  return {
    dnsServers: [],
    domains: [],
    defaultRoute: false,
    llmnr: null,
    mdns: null,
    dnssec: null,
    dnsOverTls: null,
    negativeTrustAnchors: [],
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

/** Les types que le stub sait résoudre. */
export type ResolvedQtype = 'A' | 'AAAA';

export interface ResolvedQueryOutcome {
  addresses: string[];
  /** D'où vient la réponse — `resolvectl query` le dit à l'opérateur. */
  origin: 'cache' | 'network' | 'none';
  link: string | null;
  server: string | null;
  /**
   * Verdict DNSSEC de la réponse. `unset` quand le mode est `no` : on n'a
   * pas validé, ce qui n'est pas la même chose qu'avoir validé et trouvé
   * la zone non signée (`insecure`).
   */
  dnssec: DnssecStatus | 'unset';
  /** True quand la réponse a voyagé chiffrée (DNS-over-TLS). */
  encrypted: boolean;
  /**
   * Par quel protocole la réponse est venue. `resolvectl query` le dit à
   * l'opérateur, et c'est la seule façon de distinguer un nom résolu par
   * le lien d'un nom résolu par un serveur.
   */
  protocol: 'dns' | 'llmnr' | 'mdns';
  /**
   * Ce que l'amont a répondu. `nodata` — le nom existe mais pas pour ce
   * type — ne se confond pas avec `nxdomain` : une recherche A+AAAA dont
   * seule la moitié existe est le cas courant, pas une erreur.
   */
  verdict: 'answer' | 'nodata' | 'nxdomain' | 'failure';
  /** Motif du refus, quand la réponse a été écartée. */
  refusedBecause?: 'bogus' | 'unsigned-but-required' | 'no-encrypted-transport';
}

export interface UpstreamAnswer {
  addresses: string[];
  /** Enregistrements bruts, RRSIG compris quand le bit DO est posé. */
  records: readonly ResourceRecord<ResourceRecordData>[];
  /** Le nom est inconnu de la zone, tous types confondus. */
  nxdomain?: boolean;
}

export interface ResolvedDeps {
  /** Interroge réellement un serveur sur le câble. Null = pas de réponse. */
  queryUpstream(
    server: string, name: string, qtype: ResolvedQtype,
    dnssecOk: boolean, encrypted: boolean,
  ): Promise<UpstreamAnswer | null>;
  /**
   * Variante synchrone, utilisée quand il n'y a rien à valider. Valider
   * coûte des allers-retours supplémentaires vers le haut de la chaîne,
   * donc la validation impose le chemin asynchrone ; sans elle, le
   * résolveur NSS synchrone du système peut continuer d'interroger le
   * stub dans la même pile d'appel.
   */
  queryUpstreamSync?(server: string, name: string, qtype: ResolvedQtype): UpstreamAnswer | null;
  /** Valide une réponse signée en remontant la chaîne de confiance. */
  validate?(records: readonly ResourceRecord<ResourceRecordData>[]): Promise<DnssecStatus>;
  /**
   * True quand une ancre de confiance est posée. Sans ancre, aucune
   * chaîne ne peut aboutir : il n'y a donc rien à valider, et le chemin
   * synchrone reste ouvert.
   */
  hasTrustAnchors?(): boolean;
  /** Interroge le lien en LLMNR (RFC 4795) — noms mono-label. */
  resolveLlmnr?(name: string): Promise<string[]>;
  /** Interroge le lien en mDNS (RFC 6762) — noms `.local`. */
  resolveMdns?(name: string): Promise<string[]>;
  now?(): number;
}

/** True pour un nom du domaine `.local`, terrain exclusif de mDNS. */
export function isMdnsName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  return n === 'local' || n.endsWith('.local');
}

/** True pour un nom mono-label, seul terrain de LLMNR. */
export function isLlmnrName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  return n !== '' && !n.includes('.');
}

export class ResolvedService {
  private global = defaultGlobalConfig();
  private readonly links = new Map<string, ResolvedLinkConfig>();
  private readonly cache: DnsCache;
  private stats: ResolvedStatistics = {
    transactions: 0, cacheHits: 0, cacheMisses: 0,
    currentCacheSize: 0, failedTransactions: 0, secureTransactions: 0,
  };
  /** Réponses mises en cache par le stub, avec leur échéance. */
  private readonly answers = new Map<string, {
    addresses: string[]; expiresAtMs: number;
    dnssec: DnssecStatus | 'unset'; encrypted: boolean;
    verdict: ResolvedQueryOutcome['verdict'];
    protocol: ResolvedQueryOutcome['protocol'];
  }>();

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

  /**
   * Le mode DNSSEC effectif pour un lien : le réglage du lien l'emporte
   * sur le global, comme chez systemd.
   */
  dnssecModeFor(link: string | null): DnssecMode {
    if (link) {
      const cfg = this.links.get(link);
      if (cfg?.dnssec) return cfg.dnssec;
    }
    return this.global.dnssec;
  }

  /** Le réglage LLMNR effectif : celui du lien s'il est posé, sinon le global. */
  llmnrFor(link: string | null): TriState {
    if (link) {
      const cfg = this.links.get(link);
      if (cfg?.llmnr) return cfg.llmnr;
    }
    return this.global.llmnr;
  }

  /** Le réglage mDNS effectif : celui du lien s'il est posé, sinon le global. */
  mdnsFor(link: string | null): TriState {
    if (link) {
      const cfg = this.links.get(link);
      if (cfg?.mdns) return cfg.mdns;
    }
    return this.global.mdns;
  }

  /**
   * Le mode DNS-over-TLS effectif pour un lien : le réglage du lien
   * l'emporte sur le global, comme pour DNSSEC.
   */
  dnsOverTlsModeFor(link: string | null): DnsOverTlsMode {
    if (link) {
      const cfg = this.links.get(link);
      if (cfg?.dnsOverTls) return cfg.dnsOverTls;
    }
    return this.global.dnsOverTls;
  }

  /**
   * True quand la requête ne peut pas se régler dans la pile d'appel :
   * chiffrer demande une poignée de main TCP, valider demande de remonter
   * la chaîne. Les deux imposent l'asynchrone.
   */
  requiresAsync(link: string | null, name?: string): boolean {
    return this.willValidate(link, name) || this.dnsOverTlsModeFor(link) !== 'no';
  }

  /** True quand une requête pour ce lien passera par la validation. */
  willValidate(link: string | null, name?: string): boolean {
    if (this.dnssecModeFor(link) === 'no') return false;
    if (this.deps.validate === undefined) return false;
    if (name !== undefined && this.underNegativeTrustAnchor(link, name)) return false;
    return this.deps.hasTrustAnchors?.() ?? true;
  }

  /** True si le nom tombe sous une ancre négative posée sur ce lien. */
  underNegativeTrustAnchor(link: string | null, name: string): boolean {
    const anchors = link ? this.links.get(link)?.negativeTrustAnchors ?? [] : [];
    const fqdn = name.toLowerCase().replace(/\.$/, '');
    return anchors.some((raw) => {
      const domain = raw.toLowerCase().replace(/\.$/, '');
      return domain !== '' && (fqdn === domain || fqdn.endsWith(`.${domain}`));
    });
  }

  /**
   * Chemin synchrone : même cache, même sélection de serveur, sans
   * validation. Rend null quand la validation s'impose — l'appelant doit
   * alors passer par `resolve`.
   */
  /** La clé de cache : un nom seul ne suffit pas, A et AAAA diffèrent. */
  private cacheKey(name: string, qtype: ResolvedQtype): string {
    return `${name}|${qtype}`;
  }

  resolveSync(
    name: string, qtype: ResolvedQtype = 'A', ttlSeconds = 60,
  ): ResolvedQueryOutcome | null {
    const key = name.toLowerCase().replace(/\.$/, '');
    const ck = this.cacheKey(key, qtype);
    const now = (this.deps.now ?? (() => Date.now()))();

    if (this.global.cache) {
      const cached = this.answers.get(ck);
      if (cached && cached.expiresAtMs > now) {
        this.stats.transactions++;
        this.stats.cacheHits++;
        return {
          addresses: [...cached.addresses], origin: 'cache',
          link: null, server: null, dnssec: cached.dnssec, encrypted: cached.encrypted,
          verdict: cached.verdict, protocol: cached.protocol,
        };
      }
    }
    // LLMNR et mDNS partent sur un groupe et attendent une réponse : ils
    // ne peuvent pas tenir dans la pile d'appel, comme DNSSEC et DoT.
    if (this.usesLinkLocal(key, null)) return null;
    const { server, link } = this.selectServer(key);
    if (this.requiresAsync(link, key) || !this.deps.queryUpstreamSync) return null;

    this.stats.transactions++;
    if (this.global.cache) {
      this.answers.delete(ck);
      this.stats.cacheMisses++;
    }
    if (!server) {
      this.stats.failedTransactions++;
      return {
        addresses: [], origin: 'none', link: null, server: null,
        dnssec: 'unset', encrypted: false, verdict: 'failure', protocol: 'dns',
      };
    }
    const answer = this.deps.queryUpstreamSync(server, key, qtype);
    if (!answer || answer.addresses.length === 0) {
      this.stats.failedTransactions++;
      return {
        addresses: [], origin: 'none', link, server, dnssec: 'unset', encrypted: false,
        verdict: this.emptyVerdict(answer), protocol: 'dns',
      };
    }
    if (this.global.cache) {
      this.answers.set(ck, {
        addresses: [...answer.addresses], expiresAtMs: now + ttlSeconds * 1000,
        dnssec: 'unset', encrypted: false, verdict: 'answer', protocol: 'dns',
      });
      this.stats.currentCacheSize = this.answers.size;
    }
    return {
      addresses: answer.addresses, origin: 'network', link, server,
      dnssec: 'unset', encrypted: false, verdict: 'answer', protocol: 'dns',
    };
  }

  /**
   * Le réglage effectif de LLMNR / mDNS pour un lien. `resolve` autorise
   * à interroger sans répondre, `yes` les deux, `no` ni l'un ni l'autre.
   */
  linkLocalMode(protocol: 'llmnr' | 'mdns', link: string | null): TriState {
    return protocol === 'llmnr' ? this.llmnrFor(link) : this.mdnsFor(link);
  }

  /**
   * Le réglage global n'est pas un interrupteur indépendant : c'est le
   * défaut des liens qui n'en posent pas. Un protocole de lien est donc
   * actif dès qu'un lien l'autorise — et quand aucun lien n'est encore
   * configuré, c'est le global qui tranche.
   *
   * Sans cette règle, `resolvectl llmnr eth0 no` sur l'unique lien ne
   * fermait rien, le global valant encore `yes` ; et à l'inverse
   * `resolvectl mdns eth0 yes` restait sans effet sur une machine sans
   * serveur DNS, faute de lien à consulter.
   */
  linkLocalEnabled(protocol: 'llmnr' | 'mdns', wanted: TriState[] = ['yes', 'resolve']): boolean {
    const links = [...this.links.keys()];
    if (links.length === 0) return wanted.includes(this.linkLocalMode(protocol, null));
    return links.some((l) => wanted.includes(this.linkLocalMode(protocol, l)));
  }

  /**
   * True si ce nom relève d'un résolveur de lien plutôt que du DNS. La
   * règle est celle de systemd : `.local` à mDNS, mono-label à LLMNR, et
   * seulement si le réglage l'autorise.
   */
  usesLinkLocal(name: string, link: string | null): 'llmnr' | 'mdns' | null {
    const allowed = (protocol: 'llmnr' | 'mdns'): boolean => (
      link ? this.linkLocalMode(protocol, link) !== 'no' : this.linkLocalEnabled(protocol)
    );
    if (isMdnsName(name)) {
      return allowed('mdns') && this.deps.resolveMdns ? 'mdns' : null;
    }
    if (isLlmnrName(name)) {
      return allowed('llmnr') && this.deps.resolveLlmnr ? 'llmnr' : null;
    }
    return null;
  }

  /**
   * Une réponse vide n'est pas forcément un échec : le serveur a pu dire
   * « ce nom existe, mais pas pour ce type ».
   */
  private emptyVerdict(answer: UpstreamAnswer | null): ResolvedQueryOutcome['verdict'] {
    if (!answer) return 'failure';
    return answer.nxdomain ? 'nxdomain' : 'nodata';
  }

  /**
   * Ce que le stub fait d'une requête : cache, puis fil — chiffré ou non
   * selon le mode du lien — validation, puis cache. Asynchrone parce que
   * chiffrer demande une poignée de main et que valider demande de vraies
   * requêtes vers le haut de la chaîne de confiance (DNSKEY, DS).
   */
  async resolve(
    name: string, qtype: ResolvedQtype = 'A', ttlSeconds = 60,
  ): Promise<ResolvedQueryOutcome> {
    this.stats.transactions++;
    const key = name.toLowerCase().replace(/\.$/, '');
    const ck = this.cacheKey(key, qtype);
    const now = (this.deps.now ?? (() => Date.now()))();

    if (this.global.cache) {
      const cached = this.answers.get(ck);
      if (cached && cached.expiresAtMs > now) {
        this.stats.cacheHits++;
        return {
          addresses: [...cached.addresses], origin: 'cache',
          link: null, server: null, dnssec: cached.dnssec, encrypted: cached.encrypted,
          verdict: cached.verdict, protocol: cached.protocol,
        };
      }
      if (cached) this.answers.delete(ck);
      this.stats.cacheMisses++;
    }

    const { server, link } = this.selectServer(key);

    // Règle de systemd : `.local` appartient à mDNS et ne part jamais
    // vers un serveur unicast (RFC 6762 §3) ; un nom mono-label est
    // demandé au lien en LLMNR. Le DNS ne voit ni l'un ni l'autre.
    const linkLocal = this.usesLinkLocal(key, link);
    if (linkLocal === 'mdns') {
      return this.finishLinkLocal(
        'mdns', ck, link, qtype, now, ttlSeconds,
        await this.deps.resolveMdns!(key));
    }
    if (linkLocal === 'llmnr' && !server) {
      return this.finishLinkLocal(
        'llmnr', ck, link, qtype, now, ttlSeconds,
        await this.deps.resolveLlmnr!(key));
    }

    if (!server) {
      this.stats.failedTransactions++;
      return {
        addresses: [], origin: 'none', link: null, server: null,
        dnssec: 'unset', encrypted: false, verdict: 'failure', protocol: 'dns',
      };
    }

    const mode = this.dnssecModeFor(link);
    const wantDnssec = this.willValidate(link, key);
    const tls = this.dnsOverTlsModeFor(link);

    let answer: UpstreamAnswer | null = null;
    let encrypted = false;
    if (tls !== 'no') {
      answer = await this.deps.queryUpstream(server, key, qtype, wantDnssec, true);
      encrypted = answer !== null;
    }
    // `yes` est strict : plutôt aucune réponse qu'une réponse en clair.
    // `opportunistic` retombe sur le clair, ce qui est tout ce qu'il
    // promet — il protège d'un observateur passif, pas d'un actif.
    if (!answer && tls === 'yes') {
      this.stats.failedTransactions++;
      return {
        addresses: [], origin: 'none', link, server,
        dnssec: 'unset', encrypted: false, verdict: 'failure', protocol: 'dns',
        refusedBecause: 'no-encrypted-transport',
      };
    }
    if (!answer) answer = await this.deps.queryUpstream(server, key, qtype, wantDnssec, false);

    if (!answer || answer.addresses.length === 0) {
      // Le DNS n'a rien : c'est là que LLMNR prend le relais pour un nom
      // mono-label, exactement comme systemd — le lien répond de ce que
      // le serveur ignore.
      if (linkLocal === 'llmnr') {
        const viaLink = await this.deps.resolveLlmnr!(key);
        if (viaLink.length > 0) {
          return this.finishLinkLocal('llmnr', ck, link, qtype, now, ttlSeconds, viaLink);
        }
      }
      this.stats.failedTransactions++;
      return {
        addresses: [], origin: 'none', link, server, dnssec: 'unset', encrypted,
        verdict: this.emptyVerdict(answer), protocol: 'dns',
      };
    }

    let dnssec: DnssecStatus | 'unset' = 'unset';
    if (wantDnssec) {
      dnssec = await this.deps.validate!(answer.records);
      if (dnssec === 'secure') this.stats.secureTransactions++;
      // Une réponse falsifiée est refusée quel que soit le mode : c'est
      // tout l'objet de DNSSEC. Une zone non signée n'est refusée qu'en
      // mode strict, `allow-downgrade` l'acceptant par définition.
      if (dnssec === 'bogus') {
        this.stats.failedTransactions++;
        return {
          addresses: [], origin: 'none', link, server,
          dnssec, encrypted, verdict: 'failure', protocol: 'dns', refusedBecause: 'bogus',
        };
      }
      if (dnssec === 'insecure' && mode === 'yes') {
        this.stats.failedTransactions++;
        return {
          addresses: [], origin: 'none', link, server,
          dnssec, encrypted, verdict: 'failure', protocol: 'dns',
          refusedBecause: 'unsigned-but-required',
        };
      }
    }

    if (this.global.cache) {
      this.answers.set(ck, {
        addresses: [...answer.addresses], expiresAtMs: now + ttlSeconds * 1000,
        dnssec, encrypted, verdict: 'answer', protocol: 'dns',
      });
      this.stats.currentCacheSize = this.answers.size;
    }
    return {
      addresses: answer.addresses, origin: 'network', link, server,
      dnssec, encrypted, verdict: 'answer', protocol: 'dns',
    };
  }

  /**
   * Range une réponse venue du lien. Elle n'a ni serveur ni verdict
   * DNSSEC : personne ne l'a signée, et prétendre le contraire serait
   * exactement le genre d'affirmation que cette série corrige. Elle est
   * en revanche mise en cache comme les autres, et le TTL court des deux
   * protocoles est ce qui l'empêche de survivre au départ du pair.
   */
  private finishLinkLocal(
    protocol: 'llmnr' | 'mdns',
    ck: string,
    link: string | null,
    qtype: ResolvedQtype,
    now: number,
    ttlSeconds: number,
    addresses: string[],
  ): ResolvedQueryOutcome {
    // Le lien ne parle qu'IPv4 ici : une question AAAA n'a pas de
    // réponse à en tirer, et l'inventer serait mentir.
    const usable = qtype === 'A' ? addresses : [];
    if (usable.length === 0) {
      this.stats.failedTransactions++;
      return {
        addresses: [], origin: 'none', link, server: null,
        dnssec: 'unset', encrypted: false,
        verdict: qtype === 'A' ? 'nxdomain' : 'nodata', protocol,
      };
    }
    if (this.global.cache) {
      this.answers.set(ck, {
        addresses: [...usable], expiresAtMs: now + ttlSeconds * 1000,
        dnssec: 'unset', encrypted: false, verdict: 'answer', protocol,
      });
      this.stats.currentCacheSize = this.answers.size;
    }
    return {
      addresses: usable, origin: 'network', link, server: null,
      dnssec: 'unset', encrypted: false, verdict: 'answer', protocol,
    };
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
      currentCacheSize: this.answers.size, failedTransactions: 0, secureTransactions: 0,
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
