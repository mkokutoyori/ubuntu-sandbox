/**
 * mDNS — Multicast DNS (RFC 6762).
 *
 * L'hôte possède `<hostname>.local` et rien d'autre. Il écoute
 * 224.0.0.251 sur UDP/5353 et répond aux questions portant sur ce nom.
 *
 * Deux différences de fond avec LLMNR, et elles sont dans la RFC :
 *
 * - la réponse repart **sur le groupe** (§6), pour que tout le lien
 *   apprenne en même temps — sauf si la question vient d'un port
 *   éphémère, signe d'un demandeur ponctuel qui n'écoute pas le groupe :
 *   la réponse lui va alors en unicast, TTL plafonné à 10 s (§6.7) ;
 * - l'hôte **s'annonce** au démarrage, sans qu'on lui demande (§8.3),
 *   avec le bit cache-flush posé pour remplacer ce que les pairs
 *   croyaient savoir.
 *
 * **Sondage et conflit (§8.1, §8.2, §9).** Avant de revendiquer son nom,
 * l'hôte le sonde trois fois : une question `ANY` portant en section
 * Authority les enregistrements qu'il *compte* poser. Si quelqu'un
 * répond, ou si un autre sondage pour le même nom porte des
 * enregistrements qui l'emportent au départage lexicographique, le nom
 * est perdu — l'hôte en essaie un autre (`alpha-2.local`) et resonde.
 * C'est la différence de fond avec LLMNR, qui signale le conflit sans
 * jamais renommer.
 *
 * **Réponses connues (§7.1).** Un interrogateur joint à sa question ce
 * qu'il sait déjà ; un répondeur tait ce que l'autre a déjà, et se tait
 * complètement quand il n'a rien à ajouter. Sur un groupe, répéter à
 * tout le lien ce que le demandeur venait d'écrire serait du bruit pur.
 *
 * **DNS-SD (RFC 6763).** Le registre de services (`dnssd/`) répond aux
 * questions PTR/SRV/TXT en plus des adresses de l'hôte : c'est le même
 * répondeur, avec une source d'enregistrements de plus.
 */
import type { EndHost } from '@/network/devices/EndHost';
import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import {
  buildLegacyQueryMessage, buildLegacyResponseMessage, nextDnsTransactionId,
} from '@/network/dns/compat/DnsWireCompat';
import type { DnsRecord } from '@/network/dns/compat/DnsWireCompat';
import {
  bindMulticastDns, unbindMulticastDns, queryMulticastDns, announceMulticastDns,
  type McastDnsReply,
} from '@/network/dns/transport/MulticastDnsTransport';
import {
  MDNS_BINDING, MDNS_DOMAIN, MDNS_PORT, MDNS_RECORD_TTL, MDNS_LEGACY_TTL,
  MDNS_TIMEOUT_MS, MDNS_PROBE_COUNT, MDNS_PROBE_INTERVAL_MS, MDNS_MAX_RENAMES,
  isLocalName, nextCandidateName, type MdnsNameState,
} from './types';
import { getDefaultEventBus } from '@/events/EventBus';
import { DnsSdRegistry } from '@/network/dnssd/DnsSdRegistry';
import {
  DNSSD_ENUM_NAME, parseInstanceName, serviceTypeName,
  type ResolvedService,
} from '@/network/dnssd/types';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

/**
 * RFC 6762 §10.2 — le bit de poids fort de la classe d'un enregistrement
 * de réponse demande aux pairs de remplacer ce qu'ils ont en cache plutôt
 * que de l'accumuler.
 */
export const MDNS_CACHE_FLUSH = 0x8000;

/**
 * La clé de départage de §8.2. La RFC compare les enregistrements sous
 * forme canonique, octet par octet ; ici les seuls enregistrements en
 * jeu sont des adresses A, donc comparer leurs octets triés donne le
 * même ordre — et c'est une simplification qu'il vaut mieux écrire que
 * laisser deviner.
 */
function tiebreakKey(addresses: readonly string[]): string {
  return [...addresses]
    .map((ip) => ip.split('.').map((o) => o.padStart(3, '0')).join('.'))
    .sort()
    .join(',');
}

/**
 * RFC 6762 §7.1 — un enregistrement déjà connu du demandeur est tu, à
 * condition que le TTL qu'il annonce dépasse la moitié du nôtre : en
 * dessous, sa copie est près d'expirer et il a besoin qu'on la
 * rafraîchisse.
 */
function suppressKnown(
  mine: ResourceRecord<ResourceRecordData>[],
  known: readonly ResourceRecord<ResourceRecordData>[],
): ResourceRecord<ResourceRecordData>[] {
  if (known.length === 0) return mine;
  return mine.filter((rr) => !known.some((k) => (
    k.name.toLowerCase().replace(/\.$/, '') === rr.name.toLowerCase().replace(/\.$/, '')
    && k.data.type === rr.data.type
    && sameRdata(k.data, rr.data)
    && k.ttl > rr.ttl / 2
  )));
}

/**
 * Comparaison de rdata par sérialisation : les données d'un
 * enregistrement sont des valeurs simples, et les comparer champ à
 * champ demanderait un cas par type sans rien gagner.
 */
function sameRdata(a: ResourceRecordData, b: ResourceRecordData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addressesOf(records: readonly ResourceRecord<ResourceRecordData>[]): string[] {
  return records
    .filter((rr) => rr.data.type === RRType.A)
    .map((rr) => (rr.data as { address: { toString(): string } }).address.toString());
}

export class MdnsAgent {
  private bound = false;
  private state: MdnsNameState = 'idle';
  /** Le nom effectivement revendiqué — il diffère du nom d'hôte après renommage. */
  private claimed: string | null = null;
  private ready: Promise<void> | null = null;
  private readonly sd = new DnsSdRegistry({
    hostName: () => this.ownName(),
    addresses: () => this.ownAddresses(),
  });

  constructor(private readonly host: EndHost) {}

  /** Le registre DNS-SD de cet hôte (RFC 6763). */
  services(): DnsSdRegistry { return this.sd; }

  /** `<hostname>.local`, ou le nom de repli obtenu après un conflit. */
  ownName(): string {
    return this.claimed ?? this.baseName();
  }

  private baseName(): string {
    return `${this.host.getHostname().split('.')[0].toLowerCase()}.${MDNS_DOMAIN}`;
  }

  nameState(): MdnsNameState { return this.state; }

  /** Résolue quand le sondage a tranché — nom acquis, ou abandonné. */
  whenReady(): Promise<void> { return this.ready ?? Promise.resolve(); }

  private ownAddresses(): string[] {
    const out: string[] = [];
    for (const port of this.host.getPorts()) {
      if (port.getName() === 'lo') continue;
      const ip = port.getIPAddress();
      if (ip) out.push(ip.toString());
    }
    return out;
  }

  isRunning(): boolean { return this.bound; }

  start(): void {
    if (this.bound) return;
    try {
      bindMulticastDns(this.host, MDNS_BINDING, (q, src, sport) => this.respond(q, src, sport));
      this.bound = true;
    } catch { return; }
    // §8.1 : on ne s'annonce qu'après avoir sondé. Le sondage part en
    // tâche de fond — un démon ne bloque pas son démarrage dessus.
    this.ready = this.claimName();
  }

  stop(): void {
    if (!this.bound) return;
    unbindMulticastDns(this.host, MDNS_BINDING);
    this.bound = false;
    this.state = 'idle';
    this.claimed = null;
  }

  /**
   * RFC 6762 §8.1 puis §9 : sonder, et si le nom est pris, en essayer un
   * autre. L'hôte ne s'annonce que le nom acquis.
   */
  private async claimName(): Promise<void> {
    for (let attempt = 1; attempt <= MDNS_MAX_RENAMES; attempt++) {
      const candidate = nextCandidateName(this.baseName(), attempt);
      this.claimed = candidate;
      this.state = 'probing';

      if (await this.probe(candidate)) {
        this.state = 'claimed';
        getDefaultEventBus().publish({
          topic: 'mdns.name.claimed',
          payload: {
            deviceId: this.host.getId(), hostname: this.host.getHostname(),
            name: candidate, renamed: attempt > 1,
          },
        });
        this.announce();
        return;
      }

      getDefaultEventBus().publish({
        topic: 'mdns.conflict.detected',
        payload: {
          deviceId: this.host.getId(), hostname: this.host.getHostname(),
          name: candidate, attempt,
        },
      });
    }
    // §9 impose de ralentir plutôt que de boucler : au bout du compte,
    // mieux vaut ne rien revendiquer que revendiquer n'importe quoi.
    this.state = 'defeated';
    this.claimed = null;
  }

  /**
   * Un sondage est une question `ANY` portant en section Authority les
   * enregistrements que l'on *compte* poser — c'est ce qui permet à deux
   * hôtes qui sondent en même temps de se départager (§8.2) sans que
   * l'un ni l'autre n'ait encore rien revendiqué.
   *
   * Rend true si le nom est libre.
   */
  private async probe(candidate: string): Promise<boolean> {
    for (let i = 0; i < MDNS_PROBE_COUNT; i++) {
      const query = buildLegacyQueryMessage(nextDnsTransactionId(), candidate, 'ANY', {
        recursionDesired: false,
      });
      if (!query) return false;
      const proposed = this.addressRecordsFor(candidate, MDNS_RECORD_TTL);
      const probeMessage: DnsMessage = {
        ...query,
        authorities: buildLegacyResponseMessage(query, 'NOERROR', proposed).answers,
      };
      this.probing = { name: candidate, tiebreak: tiebreakKey(proposed.map((r) => r.value)) };

      const responses = await queryMulticastDns(
        this.host, MDNS_BINDING, probeMessage, MDNS_PROBE_INTERVAL_MS, { firstOnly: true });
      // Une réponse au sondage veut dire que quelqu'un tient déjà le nom.
      if (responses.some((r) => r.answers.some(
        (rr) => rr.name.toLowerCase().replace(/\.$/, '') === candidate))) {
        this.probing = null;
        return false;
      }
      if (this.lostTiebreak) {
        this.probing = null;
        this.lostTiebreak = false;
        return false;
      }
    }
    this.probing = null;
    return true;
  }

  /** Ce que cet hôte est en train de sonder, pour le départage §8.2. */
  private probing: { name: string; tiebreak: string } | null = null;
  private lostTiebreak = false;

  /**
   * RFC 6762 §8.3 — l'annonce non sollicitée. Un pair qui l'entend peut
   * répondre à `ping monhote.local` sans avoir jamais rien demandé.
   */
  announce(): boolean {
    const records = this.addressRecords(MDNS_RECORD_TTL);
    if (records.length === 0) return false;
    const message = this.buildResponse(nextDnsTransactionId(), records, true);
    const sent = announceMulticastDns(this.host, MDNS_BINDING, message);
    if (sent) {
      getDefaultEventBus().publish({
        topic: 'mdns.announced',
        payload: {
          deviceId: this.host.getId(), hostname: this.host.getHostname(),
          name: this.ownName(), addresses: records.map((r) => r.value),
        },
      });
    }
    return sent;
  }

  private addressRecords(ttl: number): DnsRecord[] {
    return this.addressRecordsFor(this.ownName(), ttl);
  }

  private addressRecordsFor(name: string, ttl: number): DnsRecord[] {
    return this.ownAddresses().map((ip) => ({
      name, type: 'A' as const, value: ip, ttl,
    }));
  }

  /**
   * Une réponse mDNS n'a ni question rappelée ni bit de récursion : elle
   * vaut par elle-même (§6). Le bit cache-flush est posé sur la classe
   * des enregistrements d'adresse, qui sont uniques par définition.
   */
  private buildResponse(id: number, records: DnsRecord[], cacheFlush: boolean): DnsMessage {
    const base = buildLegacyResponseMessage(
      { id, flags: { qr: false, opcode: 0, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: 0 },
        questions: [], answers: [], authorities: [], additionals: [] },
      'NOERROR', records,
    );
    return {
      ...base,
      flags: { ...base.flags, aa: true, rd: false, ra: false },
      answers: cacheFlush
        ? base.answers.map((rr) => ({ ...rr, rrClass: (rr.rrClass ?? DnsClass.IN) | MDNS_CACHE_FLUSH }))
        : base.answers,
    };
  }

  private respond(
    query: DnsMessage, _sourceIP: IPAddress | IPv6Address, sourcePort: number,
  ): McastDnsReply | null {
    const question = query.questions[0];
    if (!question) return null;
    const asked = question.qname.toLowerCase().replace(/\.$/, '');

    // §8.2 — deux hôtes qui sondent le même nom en même temps ne peuvent
    // pas compter l'un sur l'autre pour répondre : aucun ne le possède
    // encore. Ils comparent alors les enregistrements qu'ils proposent,
    // et celui qui vient après cède. Sans ce départage, les deux
    // renonceraient ou les deux revendiqueraient.
    if (this.probing && asked === this.probing.name && query.authorities.length > 0) {
      const theirs = tiebreakKey(query.authorities
        .filter((rr) => rr.data.type === RRType.A)
        .map((rr) => (rr.data as { address: { toString(): string } }).address.toString()));
      if (theirs > this.probing.tiebreak) this.lostTiebreak = true;
      return null;
    }

    // Tant que le nom n'est pas acquis, on ne répond pas pour lui : ce
    // serait affirmer une possession qu'on est justement en train de
    // vérifier.
    if (this.state !== 'claimed') return null;

    // §6.7 : un port source différent de 5353 trahit un demandeur
    // ponctuel, qui n'écoute pas le groupe et attend sa réponse pour lui.
    const legacy = sourcePort !== MDNS_PORT;
    const ttl = legacy ? MDNS_LEGACY_TTL : MDNS_RECORD_TTL;

    const found = this.recordsFor(asked, question.qtype, ttl);
    if (found.answers.length === 0) return null;

    // §7.1 — retirer ce que le demandeur a déjà écrit dans sa question.
    const answers = suppressKnown(found.answers, query.answers);
    if (answers.length === 0) return null;

    const message = legacy
      // Une réponse ponctuelle rappelle la question et reprend l'ID, le
      // demandeur n'ayant que cela pour l'apparier.
      ? { ...buildLegacyResponseMessage(query, 'NOERROR', []), answers, additionals: found.additionals }
      : this.buildRecordResponse(query.id, answers, found.additionals);

    getDefaultEventBus().publish({
      topic: 'mdns.responded',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(),
        name: asked, addresses: addressesOf(answers), legacy,
      },
    });
    return { message, unicast: legacy };
  }

  /**
   * Tout ce que cet hôte a à dire sur une question : ses propres
   * adresses, et ce que le registre DNS-SD sait des services publiés.
   */
  private recordsFor(asked: string, qtype: number, ttl: number): {
    answers: ResourceRecord<ResourceRecordData>[];
    additionals: ResourceRecord<ResourceRecordData>[];
  } {
    if (asked === this.ownName() && (qtype === RRType.A || qtype === RRType.ANY)) {
      return {
        answers: this.ownAddresses().map((ip) => makeARecord(this.ownName(), ttl, ip)),
        additionals: [],
      };
    }
    return this.sd.answer(asked, qtype);
  }

  /** Une réponse mDNS portant des enregistrements déjà construits. */
  private buildRecordResponse(
    id: number,
    answers: ResourceRecord<ResourceRecordData>[],
    additionals: ResourceRecord<ResourceRecordData>[],
  ): DnsMessage {
    return {
      id,
      flags: {
        qr: true, opcode: 0, aa: true, tc: false,
        rd: false, ra: false, ad: false, cd: false, rcode: 0,
      },
      questions: [],
      answers: answers.map((rr) => ({
        ...rr, rrClass: (rr.rrClass ?? DnsClass.IN) | MDNS_CACHE_FLUSH,
      })),
      authorities: [],
      additionals,
    };
  }

  /**
   * RFC 6763 §4.1 — « quelles instances de ce type sur le lien ? ».
   * Rend les noms d'instance complets.
   */
  async browse(type: string, timeoutMs: number = MDNS_TIMEOUT_MS): Promise<string[]> {
    const name = type === DNSSD_ENUM_NAME ? DNSSD_ENUM_NAME : serviceTypeName(type);
    const found: string[] = [];
    for (const r of await this.askLink(name, 'PTR', timeoutMs)) {
      for (const rr of r.answers) {
        if (rr.data.type !== RRType.PTR) continue;
        const target = (rr.data as { ptrdname: string }).ptrdname;
        if (!found.includes(target)) found.push(target);
      }
    }
    return found;
  }

  /** Les types de services annoncés sur le lien (§9). */
  browseTypes(timeoutMs: number = MDNS_TIMEOUT_MS): Promise<string[]> {
    return this.browse(DNSSD_ENUM_NAME, timeoutMs);
  }

  /**
   * RFC 6763 §5 — d'un nom d'instance à l'hôte, au port et aux
   * métadonnées. Les additionnels de la réponse suffisent souvent : le
   * répondeur y a déjà mis l'adresse de l'hôte (§12).
   */
  async resolveService(
    fqdn: string, timeoutMs: number = MDNS_TIMEOUT_MS,
  ): Promise<ResolvedService | null> {
    const parsed = parseInstanceName(fqdn);
    if (!parsed) return null;

    for (const r of await this.askLink(fqdn, 'ANY', timeoutMs)) {
      const all = [...r.answers, ...r.additionals];
      const srv = all.find((rr) => rr.data.type === RRType.SRV);
      if (!srv) continue;
      const s = srv.data as { port: number; target: string };
      const txt = all
        .filter((rr) => rr.data.type === RRType.TXT)
        .flatMap((rr) => [...(rr.data as { text: readonly string[] }).text])
        .filter((seg) => seg !== '');
      const addresses = all
        .filter((rr) => rr.data.type === RRType.A
          && rr.name.toLowerCase().replace(/\.$/, '') === s.target.toLowerCase())
        .map((rr) => (rr.data as { address: { toString(): string } }).address.toString());
      return {
        instance: parsed.instance, type: parsed.type, domain: parsed.domain,
        host: s.target, port: s.port, txt, addresses,
      };
    }
    return null;
  }

  /**
   * Pose une question sur le groupe et rend les réponses brutes. Les
   * trois usages — adresse, parcours, résolution de service — passent
   * par ici : c'est ce qui garantit qu'ils voient le même fil.
   */
  private async askLink(
    name: string, qtype: string, timeoutMs: number,
  ): Promise<DnsMessage[]> {
    const query = buildLegacyQueryMessage(nextDnsTransactionId(), name, qtype, {
      recursionDesired: false,
    });
    if (!query) return [];
    return queryMulticastDns(this.host, MDNS_BINDING, query, timeoutMs, { firstOnly: true });
  }

  /** Interroge le lien pour un nom `.local`. */
  async resolve(name: string, timeoutMs: number = MDNS_TIMEOUT_MS): Promise<string[]> {
    const target = name.toLowerCase().replace(/\.$/, '');
    if (!isLocalName(target)) return [];

    getDefaultEventBus().publish({
      topic: 'mdns.query.sent',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: target,
      },
    });
    const responses = await this.askLink(target, 'A', timeoutMs);
    const addresses: string[] = [];
    for (const r of responses) {
      for (const rr of r.answers) {
        if (rr.data.type !== RRType.A) continue;
        if (rr.name.toLowerCase().replace(/\.$/, '') !== target) continue;
        const ip = (rr.data as { address: { toString(): string } }).address.toString();
        if (!addresses.includes(ip)) addresses.push(ip);
      }
    }
    return addresses;
  }
}
