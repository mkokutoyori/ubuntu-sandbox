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
 * Délibérément hors de portée : le sondage de conflit préalable (§8.1),
 * la suppression par réponses connues (§7.1) et l'énumération de
 * services DNS-SD (RFC 6763). Les deux premiers demandent un état de
 * possession disputé qui n'existe nulle part ici ; le troisième est un
 * protocole à part entière, avec ses propres types SRV/TXT/PTR.
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
  MDNS_TIMEOUT_MS, isLocalName,
} from './types';
import { getDefaultEventBus } from '@/events/EventBus';

/**
 * RFC 6762 §10.2 — le bit de poids fort de la classe d'un enregistrement
 * de réponse demande aux pairs de remplacer ce qu'ils ont en cache plutôt
 * que de l'accumuler.
 */
export const MDNS_CACHE_FLUSH = 0x8000;

export class MdnsAgent {
  private bound = false;

  constructor(private readonly host: EndHost) {}

  /** `<hostname>.local` — le seul nom que cet hôte défend. */
  ownName(): string {
    return `${this.host.getHostname().split('.')[0].toLowerCase()}.${MDNS_DOMAIN}`;
  }

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
    this.announce();
  }

  stop(): void {
    if (!this.bound) return;
    unbindMulticastDns(this.host, MDNS_BINDING);
    this.bound = false;
  }

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
    return this.ownAddresses().map((ip) => ({
      name: this.ownName(), type: 'A' as const, value: ip, ttl,
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
    if (asked !== this.ownName()) return null;
    if (question.qtype !== RRType.A && question.qtype !== RRType.ANY) return null;

    // §6.7 : un port source différent de 5353 trahit un demandeur
    // ponctuel, qui n'écoute pas le groupe et attend sa réponse pour lui.
    const legacy = sourcePort !== MDNS_PORT;
    const records = this.addressRecords(legacy ? MDNS_LEGACY_TTL : MDNS_RECORD_TTL);
    if (records.length === 0) return null;

    const message = legacy
      // Une réponse ponctuelle rappelle la question et reprend l'ID, le
      // demandeur n'ayant que cela pour l'apparier.
      ? buildLegacyResponseMessage(query, 'NOERROR', records)
      : this.buildResponse(query.id, records, true);

    getDefaultEventBus().publish({
      topic: 'mdns.responded',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(),
        name: asked, addresses: records.map((r) => r.value), legacy,
      },
    });
    return { message, unicast: legacy };
  }

  /** Interroge le lien pour un nom `.local`. */
  async resolve(name: string, timeoutMs: number = MDNS_TIMEOUT_MS): Promise<string[]> {
    const target = name.toLowerCase().replace(/\.$/, '');
    if (!isLocalName(target)) return [];

    const query = buildLegacyQueryMessage(nextDnsTransactionId(), target, 'A', {
      recursionDesired: false,
    });
    if (!query) return [];

    getDefaultEventBus().publish({
      topic: 'mdns.query.sent',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: target,
      },
    });
    const responses = await queryMulticastDns(this.host, MDNS_BINDING, query, timeoutMs, { firstOnly: true });
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
