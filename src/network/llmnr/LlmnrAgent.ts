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
 * **Unicité (§4).** Au démarrage, l'hôte demande son propre nom au lien.
 * Si quelqu'un répond, le nom n'est pas à lui seul : LLMNR ne renomme
 * pas — c'est mDNS qui fait cela — il le *signale*, en posant le bit C
 * dans ses réponses. Pendant la vérification, le bit T dit que la
 * possession est encore provisoire.
 *
 * Reste hors de portée : le transport TCP/5355 (§2.4, réservé aux
 * réponses tronquées), sans objet tant qu'aucune réponse ne dépasse un
 * datagramme.
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
  bindMulticastDns, unbindMulticastDns, queryMulticastDns, queryMulticastDnsSync,
  type McastDnsReply,
} from '@/network/dns/transport/MulticastDnsTransport';
import {
  LLMNR_BINDING, LLMNR_RECORD_TTL, LLMNR_TIMEOUT_MS,
  LLMNR_UNIQUENESS_VERIFY_TIMES, llmnrFlagOverrides,
  type LlmnrNameState,
} from './types';

export class LlmnrAgent {
  private bound = false;
  private state: LlmnrNameState = 'tentative';
  private ready: Promise<void> | null = null;

  constructor(private readonly host: EndHost) {}

  /** Où en est la possession du nom. */
  nameState(): LlmnrNameState { return this.state; }

  /** Résolue quand la vérification d'unicité du démarrage est terminée. */
  whenReady(): Promise<void> { return this.ready ?? Promise.resolve(); }

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

  /**
   * The GLOBAL IPv6 addresses. Link-local is left out: it is ambiguous
   * off its link and the record carries no zone index.
   */
  private ownIpv6Addresses(): string[] {
    const out: string[] = [];
    for (const port of this.host.getPorts()) {
      if (port.getName() === 'lo') continue;
      for (const entree of port.getIPv6Addresses()) {
        if (entree.address.isLinkLocal()) continue;
        const s = entree.address.toString();
        if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  isRunning(): boolean { return this.bound; }

  start(): void {
    if (this.bound) return;
    try {
      bindMulticastDns(this.host, LLMNR_BINDING, (q, src, sport) => this.respond(q, src, sport));
      this.bound = true;
    } catch { return; }
    this.state = 'tentative';
    // La vérification part en tâche de fond : un démon ne bloque pas son
    // démarrage dessus, et il répond déjà — avec le bit T — pendant
    // qu'elle dure.
    this.ready = this.verifyUniqueness();
  }

  stop(): void {
    if (!this.bound) return;
    unbindMulticastDns(this.host, LLMNR_BINDING);
    this.bound = false;
    this.state = 'tentative';
  }

  /**
   * RFC 4795 §4.1 — l'hôte demande son propre nom au lien. Une réponse
   * signifie qu'un autre le porte déjà.
   *
   * La question part {@link LLMNR_UNIQUENESS_VERIFY_TIMES} fois : une
   * seule requête perdue ne doit pas faire conclure à l'unicité.
   */
  async verifyUniqueness(): Promise<void> {
    const label = this.ownName();
    for (let attempt = 0; attempt < LLMNR_UNIQUENESS_VERIFY_TIMES; attempt++) {
      const holders = await this.askLink(label, LLMNR_TIMEOUT_MS);
      if (holders.length > 0) {
        this.state = 'conflicted';
        this.host.getBus().publish({
          topic: 'llmnr.conflict.detected',
          payload: {
            deviceId: this.host.getId(), hostname: this.host.getHostname(),
            name: label, claimedBy: holders,
          },
        });
        return;
      }
    }
    this.state = 'unique';
  }

  /**
   * RFC 4795 §2.4 : on ne répond que si l'on possède le nom, et toujours
   * en unicast vers l'émetteur.
   *
   * Les deux bits de l'en-tête disent l'état de la possession, et pas
   * autre chose : `C` quand le nom est disputé, `T` tant qu'on le
   * vérifie. Poser ici le bit « autorité » du DNS ordinaire reviendrait
   * à annoncer un conflit à chaque réponse — la position est la même.
   */
  private respond(
    query: DnsMessage, sourceIP: IPAddress | IPv6Address, sourcePort: number,
  ): McastDnsReply | null {
    const question = query.questions[0];
    if (!question) return null;
    const asked = question.qname.toLowerCase().replace(/\.$/, '');
    if (asked !== this.ownName()) return null;
    const veutA = question.qtype === RRType.A || question.qtype === RRType.ANY;
    const veutAaaa = question.qtype === RRType.AAAA || question.qtype === RRType.ANY;
    if (!veutA && !veutAaaa) return null;

    // Answer the type that was asked: an A record in reply to an AAAA
    // question answers a different question.
    const answers: DnsRecord[] = [
      ...(veutA ? this.ownAddresses().map((ip) => ({
        name: question.qname, type: 'A' as const, value: ip, ttl: LLMNR_RECORD_TTL,
      })) : []),
      ...(veutAaaa ? this.ownIpv6Addresses().map((ip) => ({
        name: question.qname, type: 'AAAA' as const, value: ip, ttl: LLMNR_RECORD_TTL,
      })) : []),
    ];
    if (answers.length === 0) return null;

    const message = buildLegacyResponseMessage(query, 'NOERROR', answers);
    const bits = llmnrFlagOverrides({
      conflict: this.state === 'conflicted',
      tentative: this.state === 'tentative',
    });
    this.host.getBus().publish({
      topic: 'llmnr.responded',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: asked,
        addresses: answers.map((a) => a.value),
        to: sourceIP.toString(), toPort: sourcePort,
        conflict: this.state === 'conflicted',
      },
    });
    return { message: { ...message, flags: { ...message.flags, ...bits } }, unicast: true };
  }

  /**
   * Pose la question au lien et rend les adresses annoncées. Le chemin
   * est le même pour une résolution ordinaire et pour la vérification
   * d'unicité : c'est la seule façon que les deux ne puissent pas
   * diverger sur ce qui compte comme « quelqu'un a répondu ».
   */
  private async askLink(
    label: string, timeoutMs: number, qtype: 'A' | 'AAAA' = 'A',
  ): Promise<string[]> {
    const query = buildLegacyQueryMessage(nextDnsTransactionId(), label, qtype, {
      recursionDesired: false,
    });
    if (!query) return [];
    return announcedAddresses(
      await queryMulticastDns(
        this.host, LLMNR_BINDING, query, timeoutMs, { firstOnly: true }),
      qtype === 'AAAA' ? RRType.AAAA : RRType.A,
    );
  }

  /**
   * La même question, sans rendre la main. Windows résout par des
   * cmdlets qui n'ont pas de forme asynchrone, et un résolveur système
   * bloque de toute façon son appelant ; voir
   * {@link queryMulticastDnsSync} pour ce que cette forme ne modélise
   * pas.
   */
  resolveSync(name: string): string[] {
    const label = name.toLowerCase().replace(/\.$/, '');
    if (label.includes('.') || label === '') return [];

    this.host.getBus().publish({
      topic: 'llmnr.query.sent',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: label,
      },
    });
    const query = buildLegacyQueryMessage(nextDnsTransactionId(), label, 'A', {
      recursionDesired: false,
    });
    if (!query) return [];
    const addresses = announcedAddresses(
      queryMulticastDnsSync(this.host, LLMNR_BINDING, query));
    if (addresses.length > 0) {
      this.host.getBus().publish({
        topic: 'llmnr.resolved',
        payload: {
          deviceId: this.host.getId(), hostname: this.host.getHostname(),
          name: label, addresses, responders: addresses.length,
        },
      });
    }
    return addresses;
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

    this.host.getBus().publish({
      topic: 'llmnr.query.sent',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: label,
      },
    });
    const addresses = await this.askLink(label, timeoutMs);
    if (addresses.length > 0) {
      this.host.getBus().publish({
        topic: 'llmnr.resolved',
        payload: {
          deviceId: this.host.getId(), hostname: this.host.getHostname(),
          name: label, addresses, responders: addresses.length,
        },
      });
    }
    return addresses;
  }

  /**
   * The same question for the v6 family. This resolver could only ask
   * for an A record, so on a v6-only link the question could not even
   * be put.
   */
  async resolveAaaa(name: string, timeoutMs: number = LLMNR_TIMEOUT_MS): Promise<string[]> {
    const label = name.toLowerCase().replace(/\.$/, '');
    if (label.includes('.') || label === '') return [];

    this.host.getBus().publish({
      topic: 'llmnr.query.sent',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(), name: label,
      },
    });
    const addresses = await this.askLink(label, timeoutMs, 'AAAA');
    if (addresses.length > 0) {
      this.host.getBus().publish({
        topic: 'llmnr.resolved',
        payload: {
          deviceId: this.host.getId(), hostname: this.host.getHostname(),
          name: label, addresses, responders: addresses.length,
        },
      });
    }
    return addresses;
  }
}

/**
 * The addresses the responders announced, deduplicated, of the type that
 * was asked for.
 */
function announcedAddresses(
  responses: readonly DnsMessage[], type: number = RRType.A,
): string[] {
  const addresses: string[] = [];
  for (const r of responses) {
    for (const rr of r.answers) {
      if (rr.data.type !== type) continue;
      const ip = (rr.data as { address: { toString(): string } }).address.toString();
      if (!addresses.includes(ip)) addresses.push(ip);
    }
  }
  return addresses;
}
