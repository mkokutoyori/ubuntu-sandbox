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

import { simulationNowMs } from '@/network/core/SystemClock';
import { isLoopbackServer, parseDnsServerWord } from './DnsServerWord';

import {
  DEFAULT_CACHE_LIMITS, DnsCache, type DnsCacheLimits, type DnsCacheLookup, type DnsReply,
} from '@/network/dns/resolver/DnsCache';
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';
import { rrTypeFromName } from '@/network/dns/compat/DnsWireCompat';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import {
  makeAaaaRecord, makeARecord,
  type AaaaRecordData, type ARecordData, type ResourceRecord, type ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';

export type TriState = 'yes' | 'no' | 'resolve';
export type DnssecMode = 'yes' | 'no' | 'allow-downgrade';
export type DnsOverTlsMode = 'yes' | 'no' | 'opportunistic';
export type CacheMode = 'yes' | 'no' | 'no-negative';
export type DnsStubListenerMode = 'yes' | 'no' | 'udp' | 'tcp';

export interface StubListenerExtra {
  readonly mode: DnsStubListenerMode;
  readonly address: string;
  readonly port: number;
}

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
  cacheMode: CacheMode;
  dnsStubListener: DnsStubListenerMode;
  dnsStubListenerExtra: StubListenerExtra[];
  readEtcHosts: boolean;
  resolveUnicastSingleLabel: boolean;
  cacheFromLocalhost: boolean;
  staleRetentionUsec: number;
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
    cacheMode: 'yes',
    dnsStubListener: 'yes',
    dnsStubListenerExtra: [],
    readEtcHosts: true,
    resolveUnicastSingleLabel: false,
    cacheFromLocalhost: false,
    staleRetentionUsec: 0,
  };
}

/** L'adresse du stub. Le résolveur NSS ne laisse passer qu'elle en 127.*. */
export const STUB_ADDRESS = '127.0.0.53';
export const RESOLVED_CONF_PATH = '/etc/systemd/resolved.conf';
export const RUN_STUB_RESOLV = '/run/systemd/resolve/stub-resolv.conf';
export const RUN_UPSTREAM_RESOLV = '/run/systemd/resolve/resolv.conf';
const ETC_RESOLV_CONF = '/etc/resolv.conf';
const RESOLVED_RUN_DIRECTORY = 'run/systemd/resolve/';

export interface ResolverLinkDeclaration {
  readonly servers: readonly string[];
  readonly domains: readonly string[];
  readonly useDns: boolean;
}

export function resolvConfFollowsResolved(vfs: { lstat(path: string): { type: string; target: string } | null }): boolean {
  const node = vfs.lstat(ETC_RESOLV_CONF);
  return node !== null && node.type === 'symlink' && node.target.includes(RESOLVED_RUN_DIRECTORY);
}

export type ResolvedQtype = string;

export interface ResolvedQueryOutcome {
  addresses: string[];
  records: readonly ResourceRecord<ResourceRecordData>[];
  authorities: readonly ResourceRecord<ResourceRecordData>[];
  /** D'où vient la réponse — `resolvectl query` le dit à l'opérateur. */
  origin: 'cache' | 'network' | 'hosts' | 'none';
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

export type UpstreamAnswer = DnsReply;

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
  /** Cherche un nom dans `/etc/hosts` : `known` dit qu'il y figure, `addresses` ce qui répond au type demandé. */
  hostsLookup?(name: string, qtype: ResolvedQtype): { known: boolean; addresses: string[] };
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

const RESOLVED_CACHE_LIMITS: DnsCacheLimits = {
  ...DEFAULT_CACHE_LIMITS, maxTtlSeconds: 7200, maxNegativeTtlSeconds: 7200,
};
const STRANGE_RCODE_TTL_SECONDS = 10;
const SYNTHETIC_TTL_SECONDS = 0;
const LINK_LOCAL_TTL_SECONDS = { llmnr: 30, mdns: 120 } as const;
const USEC_PER_MILLISECOND = 1000;

interface Asked {
  readonly answer: UpstreamAnswer | null;
  readonly server: string | null;
  readonly encrypted: boolean;
  readonly strange: boolean;
  readonly strictRefusals: number;
}

function typeOf(qtype: ResolvedQtype): number {
  return rrTypeFromName(qtype) ?? RRType.A;
}

function isAddressType(qtype: ResolvedQtype): boolean {
  return qtype === 'A' || qtype === 'AAAA';
}

function addressesOf(records: readonly ResourceRecord<ResourceRecordData>[], qtype: ResolvedQtype): string[] {
  if (!isAddressType(qtype)) return [];
  const wanted = typeOf(qtype);
  return records.filter((rr) => rr.data.type === wanted).map((rr) => (rr.data as ARecordData | AaaaRecordData).address.toString());
}

function addressRecords(
  name: string, qtype: ResolvedQtype, addresses: readonly string[], ttl: number,
): ResourceRecord<ResourceRecordData>[] {
  return addresses.map((address) => (qtype === 'AAAA' ? makeAaaaRecord(name, ttl, address) : makeARecord(name, ttl, address)));
}

function outcomeOf(fields: Partial<ResolvedQueryOutcome>): ResolvedQueryOutcome {
  return {
    addresses: [], records: [], authorities: [], origin: 'none', link: null, server: null,
    dnssec: 'unset', encrypted: false, protocol: 'dns', verdict: 'failure', ...fields,
  };
}

function usable(answer: UpstreamAnswer): boolean {
  return answer.rcode === DnsRcode.NOERROR || answer.rcode === DnsRcode.NXDOMAIN;
}

function verdictOf(answer: UpstreamAnswer, qtype: ResolvedQtype): ResolvedQueryOutcome['verdict'] {
  if (answer.rcode === DnsRcode.NXDOMAIN) return 'nxdomain';
  if (answer.rcode !== DnsRcode.NOERROR) return 'failure';
  const wanted = typeOf(qtype);
  return answer.answers.some((rr) => wanted === RRType.ANY || rr.data.type === wanted) ? 'answer' : 'nodata';
}

export class ResolvedService {
  private global = defaultGlobalConfig();
  private readonly links = new Map<string, ResolvedLinkConfig>();
  private readonly cache: DnsCache;
  private stats: ResolvedStatistics = {
    transactions: 0, cacheHits: 0, cacheMisses: 0,
    currentCacheSize: 0, failedTransactions: 0, secureTransactions: 0,
  };

  constructor(private readonly deps: ResolvedDeps) {
    this.cache = new DnsCache(
      () => this.now(), () => RESOLVED_CACHE_LIMITS, () => this.global.staleRetentionUsec / USEC_PER_MILLISECOND,
    );
  }

  private now(): number {
    return (this.deps.now ?? (() => simulationNowMs()))();
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
    const { servers, link } = this.selectServers(name);
    return { server: servers[0] ?? null, link };
  }

  selectServers(name: string): { servers: string[]; link: string | null } {
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
    if (bestLink) return { servers: [...this.links.get(bestLink)!.dnsServers], link: bestLink };

    for (const [iface, cfg] of this.links) {
      if (cfg.defaultRoute && cfg.dnsServers.length > 0) return { servers: [...cfg.dnsServers], link: iface };
    }
    for (const [iface, cfg] of this.links) {
      if (cfg.dnsServers.length > 0) return { servers: [...cfg.dnsServers], link: iface };
    }
    if (this.global.dnsServers.length > 0) return { servers: [...this.global.dnsServers], link: null };
    if (this.global.fallbackDns.length > 0) return { servers: [...this.global.fallbackDns], link: null };
    return { servers: [], link: null };
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

  private cacheEnabled(): boolean { return this.global.cacheMode !== 'no'; }

  private mayRemember(server: string | null): boolean {
    if (!this.cacheEnabled()) return false;
    return server === null || !isLoopbackServer(server) || this.global.cacheFromLocalhost;
  }

  private fromCache(known: DnsCacheLookup, qtype: ResolvedQtype): ResolvedQueryOutcome {
    if (known.kind === 'hit') {
      return outcomeOf({
        addresses: addressesOf(known.records, qtype), records: known.records, origin: 'cache',
        dnssec: known.security ?? 'unset', encrypted: known.origin?.encrypted ?? false,
        protocol: known.origin?.protocol ?? 'dns', verdict: 'answer',
      });
    }
    if (known.kind === 'negative') {
      return outcomeOf({
        records: known.aliases ?? [], authorities: [known.soa], origin: 'cache',
        verdict: known.rcode === DnsRcode.NXDOMAIN ? 'nxdomain' : 'nodata',
      });
    }
    return outcomeOf({ origin: 'cache' });
  }

  private cachedOutcome(key: string, qtype: ResolvedQtype): ResolvedQueryOutcome | null {
    if (!this.cacheEnabled()) return null;
    const known = this.cache.lookup(key, typeOf(qtype));
    if (known.kind === 'miss') return null;
    this.stats.cacheHits++;
    return this.fromCache(known, qtype);
  }

  private staleOutcome(key: string, qtype: ResolvedQtype): ResolvedQueryOutcome | null {
    if (!this.cacheEnabled() || this.global.staleRetentionUsec <= 0) return null;
    const known = this.cache.lookup(key, typeOf(qtype), true);
    return known.kind === 'hit' && known.stale === true ? this.fromCache(known, qtype) : null;
  }

  private fromHosts(key: string, qtype: ResolvedQtype): ResolvedQueryOutcome | null {
    if (!this.global.readEtcHosts || this.deps.hostsLookup === undefined || !isAddressType(qtype)) return null;
    const found = this.deps.hostsLookup(key, qtype);
    if (!found.known) return null;
    return outcomeOf({
      addresses: found.addresses, records: addressRecords(key, qtype, found.addresses, SYNTHETIC_TTL_SECONDS),
      origin: 'hosts', dnssec: 'secure', encrypted: true, verdict: found.addresses.length > 0 ? 'answer' : 'nodata',
    });
  }

  private refusesUnicast(key: string): boolean {
    return isLlmnrName(key) && !this.global.resolveUnicastSingleLabel;
  }

  private counted(outcome: ResolvedQueryOutcome): ResolvedQueryOutcome {
    if (outcome.verdict !== 'answer') this.stats.failedTransactions++;
    return outcome;
  }

  private failed(fields: Partial<ResolvedQueryOutcome> = {}): ResolvedQueryOutcome {
    return this.counted(outcomeOf(fields));
  }

  private conclude(
    key: string, qtype: ResolvedQtype, answer: UpstreamAnswer,
    via: { link: string | null; server: string; dnssec: DnssecStatus | 'unset'; encrypted: boolean },
  ): ResolvedQueryOutcome {
    const verdict = verdictOf(answer, qtype);
    const negative = verdict !== 'answer';
    if (this.mayRemember(via.server) && !(negative && this.global.cacheMode === 'no-negative')) {
      this.cache.storeReply(key, typeOf(qtype), answer, {
        security: via.dnssec === 'unset' ? undefined : via.dnssec, trust: 'answer',
        origin: { protocol: 'dns', encrypted: via.encrypted },
      });
    }
    if (verdict === 'nxdomain') this.stats.failedTransactions++;
    return outcomeOf({
      addresses: addressesOf(answer.answers, qtype), records: answer.answers,
      authorities: negative ? answer.authorities : [], origin: 'network', link: via.link, server: via.server,
      dnssec: via.dnssec, encrypted: via.encrypted, verdict,
    });
  }

  private noAnswer(
    key: string, qtype: ResolvedQtype, link: string | null, servers: readonly string[], asked: Asked,
  ): ResolvedQueryOutcome {
    const stale = this.staleOutcome(key, qtype);
    if (stale !== null) return stale;
    if (asked.strange && this.mayRemember(null)) this.cache.storeServfail(key, typeOf(qtype), STRANGE_RCODE_TTL_SECONDS);
    return this.failed({ link, server: servers[0] ?? null });
  }

  private askSync(servers: readonly string[], key: string, qtype: ResolvedQtype): Asked | null {
    let strange = false;
    for (const server of servers) {
      const reply = this.deps.queryUpstreamSync!(server, key, qtype);
      if (reply === null) return null;
      if (usable(reply)) return { answer: reply, server, encrypted: false, strange, strictRefusals: 0 };
      strange = true;
    }
    return { answer: null, server: null, encrypted: false, strange, strictRefusals: 0 };
  }

  private countTransaction(): void {
    this.stats.transactions++;
    if (this.cacheEnabled()) this.stats.cacheMisses++;
  }

  resolveSync(name: string, qtype: ResolvedQtype = 'A'): ResolvedQueryOutcome | null {
    const key = name.toLowerCase().replace(/\.$/, '');
    const hosts = this.fromHosts(key, qtype);
    if (hosts !== null) return hosts;
    const known = this.cachedOutcome(key, qtype);
    if (known !== null) {
      this.stats.transactions++;
      return known;
    }
    if (this.usesLinkLocal(key, null) || this.refusesUnicast(key)) return null;
    const { servers, link } = this.selectServers(key);
    if (this.requiresAsync(link, key) || !this.deps.queryUpstreamSync) return null;
    if (servers.some((server) => (parseDnsServerWord(server)?.port ?? 0) !== 0)) return null;

    if (servers.length === 0) {
      this.countTransaction();
      return this.failed();
    }
    const asked = this.askSync(servers, key, qtype);
    if (asked === null) return null;
    this.countTransaction();
    if (asked.answer === null) return this.noAnswer(key, qtype, link, servers, asked);
    return this.conclude(key, qtype, asked.answer, { link, server: asked.server!, dnssec: 'unset', encrypted: false });
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

  private async askInOrder(
    servers: readonly string[], key: string, qtype: ResolvedQtype, wantDnssec: boolean, tls: DnsOverTlsMode,
  ): Promise<Asked> {
    let strange = false;
    let strictRefusals = 0;
    for (const server of servers) {
      let reply: UpstreamAnswer | null = null;
      let encrypted = false;
      if (tls !== 'no') {
        reply = await this.deps.queryUpstream(server, key, qtype, wantDnssec, true);
        encrypted = reply !== null;
      }
      if (reply === null && tls === 'yes') {
        strictRefusals++;
        continue;
      }
      if (reply === null) reply = await this.deps.queryUpstream(server, key, qtype, wantDnssec, false);
      if (reply === null) continue;
      if (usable(reply)) return { answer: reply, server, encrypted, strange, strictRefusals };
      strange = true;
    }
    return { answer: null, server: null, encrypted: false, strange, strictRefusals };
  }

  private async viaLinkLocal(
    protocol: 'llmnr' | 'mdns', key: string, link: string | null, qtype: ResolvedQtype,
  ): Promise<ResolvedQueryOutcome> {
    const addresses = await (protocol === 'mdns' ? this.deps.resolveMdns!(key) : this.deps.resolveLlmnr!(key));
    return this.finishLinkLocal(protocol, key, link, qtype, addresses);
  }

  async resolve(name: string, qtype: ResolvedQtype = 'A'): Promise<ResolvedQueryOutcome> {
    const key = name.toLowerCase().replace(/\.$/, '');
    const hosts = this.fromHosts(key, qtype);
    if (hosts !== null) return hosts;
    this.stats.transactions++;
    const known = this.cachedOutcome(key, qtype);
    if (known !== null) return known;
    if (this.cacheEnabled()) this.stats.cacheMisses++;

    const { servers, link } = this.selectServers(key);

    const linkLocal = this.usesLinkLocal(key, link);
    if (linkLocal === 'mdns') return this.counted(await this.viaLinkLocal('mdns', key, link, qtype));
    if (linkLocal === 'llmnr' && (servers.length === 0 || this.refusesUnicast(key))) {
      return this.counted(await this.viaLinkLocal('llmnr', key, link, qtype));
    }
    if (this.refusesUnicast(key) || servers.length === 0) return this.failed();

    const mode = this.dnssecModeFor(link);
    const wantDnssec = this.willValidate(link, key);
    const tls = this.dnsOverTlsModeFor(link);
    const asked = await this.askInOrder(servers, key, qtype, wantDnssec, tls);

    if (asked.answer === null && tls === 'yes' && asked.strictRefusals > 0) {
      return this.failed({ link, server: servers[0], refusedBecause: 'no-encrypted-transport' });
    }
    if (asked.answer === null) {
      const stale = this.staleOutcome(key, qtype);
      if (stale !== null) return stale;
      if (linkLocal === 'llmnr') {
        const viaLink = await this.viaLinkLocal('llmnr', key, link, qtype);
        if (viaLink.verdict === 'answer') return viaLink;
      }
      return this.noAnswer(key, qtype, link, servers, asked);
    }

    const answer = asked.answer;
    const { server, encrypted } = asked;
    if (verdictOf(answer, qtype) !== 'answer' && linkLocal === 'llmnr') {
      const viaLink = await this.viaLinkLocal('llmnr', key, link, qtype);
      if (viaLink.verdict === 'answer') return viaLink;
    }

    let dnssec: DnssecStatus | 'unset' = 'unset';
    if (wantDnssec && verdictOf(answer, qtype) === 'answer') {
      dnssec = await this.deps.validate!(answer.answers);
      if (dnssec === 'secure') this.stats.secureTransactions++;
      if (dnssec === 'bogus') {
        return this.failed({ link, server: server!, dnssec, encrypted, refusedBecause: 'bogus' });
      }
      if (dnssec === 'insecure' && mode === 'yes') {
        return this.failed({ link, server: server!, dnssec, encrypted, refusedBecause: 'unsigned-but-required' });
      }
    }
    return this.conclude(key, qtype, answer, { link, server: server!, dnssec, encrypted });
  }

  private finishLinkLocal(
    protocol: 'llmnr' | 'mdns', key: string, link: string | null, qtype: ResolvedQtype, addresses: string[],
  ): ResolvedQueryOutcome {
    const usableAddresses = qtype === 'A' ? addresses : [];
    if (usableAddresses.length === 0) {
      return outcomeOf({ link, verdict: qtype === 'A' ? 'nxdomain' : 'nodata', protocol });
    }
    const records = addressRecords(key, qtype, usableAddresses, LINK_LOCAL_TTL_SECONDS[protocol]);
    if (this.mayRemember(null)) {
      this.cache.storePositive(records, key, undefined, 'answer', { protocol, encrypted: false });
    }
    return outcomeOf({
      addresses: usableAddresses, records, origin: 'network', link, protocol, verdict: 'answer',
    });
  }

  flushCaches(): void {
    this.cache.flush();
    this.stats.currentCacheSize = 0;
  }

  private cacheItemCount(): number {
    const held = this.cache.snapshot();
    return held.recordSets.length + held.negatives.length;
  }

  statistics(): Readonly<ResolvedStatistics> {
    return { ...this.stats, currentCacheSize: this.cacheItemCount() };
  }

  resetStatistics(): void {
    this.stats = {
      transactions: 0, cacheHits: 0, cacheMisses: 0,
      currentCacheSize: this.cacheItemCount(), failedTransactions: 0, secureTransactions: 0,
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
    for (const s of servers) lines.push(`nameserver ${parseDnsServerWord(s)?.address ?? s}`);
    if (search.length) lines.push(`search ${search.join(' ')}`);
    return `${lines.join('\n')}\n`;
  }
}
