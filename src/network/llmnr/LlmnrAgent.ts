/**
 * LLMNR — Link-Local Multicast Name Resolution (RFC 4795).
 *
 * Un hôte n'est autorité que pour lui-même. Il écoute le groupe
 * 224.0.0.252 sur UDP/5355, et ne répond qu'aux questions portant sur
 * son propre nom mono-label — en unicast vers celui qui a demandé
 * (§2.4). Toute autre question reste sans réponse : sur un lien
 * multicast, prétendre qu'un nom n'existe pas serait parler au nom des
 * autres.
 *
 * Ce qui est délibérément hors de portée, et pourquoi : la détection de
 * conflit de noms (§4, bit C et sondage au démarrage) suppose un état de
 * possession disputé que rien ici ne modélise, et le transport TCP/5355
 * (§2.4, réservé aux réponses tronquées) n'a pas d'objet tant qu'aucune
 * réponse ne dépasse un datagramme.
 */
import type { EndHost } from '@/network/devices/EndHost';
import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { RRType } from '@/network/dns/wire/RRType';
import {
  buildLegacyQueryMessage, buildLegacyResponseMessage, nextDnsTransactionId,
} from '@/network/dns/compat/DnsWireCompat';
import type { DnsRecord } from '@/network/dns/compat/DnsWireCompat';
import {
  bindMulticastDns, unbindMulticastDns, queryMulticastDns,
  type McastDnsReply,
} from '@/network/dns/transport/MulticastDnsTransport';
import { LLMNR_BINDING, LLMNR_RECORD_TTL, LLMNR_TIMEOUT_MS } from './types';
import { getDefaultEventBus } from '@/events/EventBus';

export class LlmnrAgent {
  private bound = false;

  constructor(private readonly host: EndHost) {}

  /** Le nom que cet hôte défend : son hostname, en un seul label. */
  ownName(): string {
    return this.host.getHostname().split('.')[0].toLowerCase();
  }

  /** Les adresses qu'il annonce pour ce nom. */
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
      bindMulticastDns(this.host, LLMNR_BINDING, (q, src, sport) => this.respond(q, src, sport));
      this.bound = true;
    } catch { /* port déjà tenu */ }
  }

  stop(): void {
    if (!this.bound) return;
    unbindMulticastDns(this.host, LLMNR_BINDING);
    this.bound = false;
  }

  /**
   * RFC 4795 §2.4 : on ne répond que si l'on possède le nom, et toujours
   * en unicast vers l'émetteur. Le bit AA est posé — un répondeur LLMNR
   * est par construction autorité pour ce qu'il annonce.
   */
  private respond(
    query: DnsMessage, sourceIP: IPAddress | IPv6Address, sourcePort: number,
  ): McastDnsReply | null {
    const question = query.questions[0];
    if (!question) return null;
    const asked = question.qname.toLowerCase().replace(/\.$/, '');
    if (asked !== this.ownName()) return null;
    if (question.qtype !== RRType.A && question.qtype !== RRType.ANY) return null;

    const answers: DnsRecord[] = this.ownAddresses().map((ip) => ({
      name: question.qname, type: 'A' as const, value: ip, ttl: LLMNR_RECORD_TTL,
    }));
    if (answers.length === 0) return null;

    const message = buildLegacyResponseMessage(query, 'NOERROR', answers);
    getDefaultEventBus().publish({
      topic: 'llmnr.responded',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: asked,
        addresses: answers.map((a) => a.value),
        to: sourceIP.toString(), toPort: sourcePort,
      },
    });
    return { message: { ...message, flags: { ...message.flags, aa: true } }, unicast: true };
  }

  /**
   * Interroge le lien. Rend les adresses annoncées par les répondeurs,
   * dans l'ordre où elles sont arrivées.
   */
  async resolve(name: string, timeoutMs: number = LLMNR_TIMEOUT_MS): Promise<string[]> {
    const label = name.toLowerCase().replace(/\.$/, '');
    // RFC 4795 §2.1 : LLMNR ne sert que les noms mono-label. Un nom
    // qualifié relève du DNS, et l'envoyer sur le groupe serait diffuser
    // une question qui ne regarde pas le lien.
    if (label.includes('.') || label === '') return [];

    const query = buildLegacyQueryMessage(nextDnsTransactionId(), label, 'A', {
      recursionDesired: false,
    });
    if (!query) return [];

    getDefaultEventBus().publish({
      topic: 'llmnr.query.sent',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: label,
      },
    });
    const responses = await queryMulticastDns(this.host, LLMNR_BINDING, query, timeoutMs, { firstOnly: true });
    const addresses: string[] = [];
    for (const r of responses) {
      for (const rr of r.answers) {
        if (rr.data.type !== RRType.A) continue;
        const ip = (rr.data as { address: { toString(): string } }).address.toString();
        if (!addresses.includes(ip)) addresses.push(ip);
      }
    }
    if (addresses.length > 0) {
      getDefaultEventBus().publish({
        topic: 'llmnr.resolved',
        payload: {
          deviceId: this.host.getId(), hostname: this.host.getHostname(),
          name: label, addresses, responders: responses.length,
        },
      });
    }
    return addresses;
  }
}
