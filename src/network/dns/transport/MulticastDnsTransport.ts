/**
 * Le transport partagé de LLMNR (RFC 4795) et de mDNS (RFC 6762).
 *
 * Les deux protocoles sont la même idée : le format de message DNS, posé
 * sur un port UDP bien connu et un groupe multicast de lien, où chaque
 * hôte ne répond que pour les noms qu'il possède. Ce qui les sépare —
 * quel groupe, quel port, quels noms, réponse en unicast ou en multicast
 * — reste chez chacun ; ce fichier ne porte que le fil.
 *
 * Un répondeur qui ne possède pas le nom **se tait**. C'est la règle
 * commune aux deux RFC et elle n'est pas une commodité : sur un groupe,
 * un NXDOMAIN prétendrait parler au nom de tout le lien.
 */
import { IPAddress } from '@/network/core/types';
import type { IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export interface McastDnsBinding {
  /** Port bien connu — 5355 pour LLMNR, 5353 pour mDNS. */
  readonly port: number;
  /** Groupe IPv4 de lien — 224.0.0.252 ou 224.0.0.251. */
  readonly group: string;
  /** Nom du processus, pour `ss`/`netstat`. */
  readonly processName: string;
}

/** Ce qu'un répondeur décide : se taire, ou répondre par tel chemin. */
export interface McastDnsReply {
  readonly message: DnsMessage;
  /**
   * True pour répondre directement à l'émetteur, false pour renvoyer sur
   * le groupe. LLMNR répond toujours en unicast ; mDNS répond sur le
   * groupe, sauf à une requête ponctuelle venue d'un port éphémère
   * (RFC 6762 §6.7).
   */
  readonly unicast: boolean;
}

export type McastDnsResponder = (
  query: DnsMessage,
  sourceIP: IPAddress | IPv6Address,
  sourcePort: number,
) => McastDnsReply | null;

/**
 * Ce qu'un hôte fait des *réponses* qu'il entend passer sur le groupe,
 * sans les avoir demandées. C'est par là qu'arrivent les annonces et
 * les adieux : sans écoute passive, une annonce n'apprendrait rien à
 * personne et n'aurait pas d'existence observable.
 */
export type McastDnsObserver = (response: DnsMessage) => void;

export function bindMulticastDns(
  host: EndHost, binding: McastDnsBinding, responder: McastDnsResponder,
  observer?: McastDnsObserver,
): void {
  host.udpBind(binding.port, ({ sourceIP, udp }) => {
    if (!(udp.payload instanceof Uint8Array)) return;
    let query: DnsMessage;
    try { query = decodeDnsMessage(udp.payload); } catch { return; }
    // Une réponse n'appelle pas de réponse : sans ce garde, deux hôtes
    // qui possèdent le même nom se répondraient sans fin. Elle est en
    // revanche écoutée : c'est ainsi qu'on apprend d'une annonce.
    if (query.flags.qr) { observer?.(query); return; }

    const reply = responder(query, sourceIP, udp.sourcePort);
    if (!reply) return;
    const bytes = encodeDnsMessage(reply.message);
    if (reply.unicast) {
      host.sendUdpDatagramTo(sourceIP, udp.sourcePort, binding.port, bytes, bytes.length);
    } else {
      host.sendUdpDatagram(
        new IPAddress(binding.group), binding.port, binding.port, bytes, bytes.length);
    }
  }, binding.processName);
}

export function unbindMulticastDns(host: EndHost, binding: McastDnsBinding): void {
  host.udpClose(binding.port);
}

/** Émet une annonce non sollicitée sur le groupe (mDNS §8.3). */
export function announceMulticastDns(
  host: EndHost, binding: McastDnsBinding, message: DnsMessage,
): boolean {
  const bytes = encodeDnsMessage(message);
  return host.sendUdpDatagram(
    new IPAddress(binding.group), binding.port, binding.port, bytes, bytes.length);
}

/**
 * Interroge le groupe et rassemble les réponses.
 *
 * Le port source est éphémère : c'est ce qui distingue une requête
 * ponctuelle d'un pair qui tient le port bien connu, et ce qui permet
 * aux répondeurs de renvoyer en unicast.
 *
 * `firstOnly` rend la main dès la première réponse — c'est ce que font
 * les deux agents pour résoudre un nom, puisqu'un résolveur n'a pas à
 * attendre un délai entier une fois servi. Sans l'option, on attend le
 * délai complet et l'on rapporte tous les répondeurs : plusieurs hôtes
 * peuvent légitimement répondre sur un lien, et c'est le seul moyen de
 * voir un nom disputé plutôt que de le masquer.
 */
/**
 * La même question, posée sans rendre la main.
 *
 * Un résolveur système bloque : `gethostbyname` ne rend pas la main
 * avant d'avoir une réponse ou un délai écoulé, et c'est aussi le cas
 * des cmdlets `Resolve-DnsName` / `Get-DnsClientCache` de Windows, qui
 * n'ont pas de forme asynchrone. Dans ce simulateur une trame est remise
 * par appel direct : la réponse d'un pair arrive donc pendant l'envoi,
 * et l'attente d'un vrai réseau est le seul élément qui manque.
 *
 * Ce qui en découle honnêtement : il n'y a pas de délai à attendre ici.
 * Un pair qui ne répond pas ne rend rien, immédiatement — là où un vrai
 * hôte patienterait sa seconde réglementaire.
 */
export function queryMulticastDnsSync(
  host: EndHost, binding: McastDnsBinding, query: DnsMessage,
): DnsMessage[] {
  let sourcePort: number;
  try { sourcePort = host.getSocketTable().allocateEphemeralPort(); }
  catch { return []; }

  const collected: DnsMessage[] = [];
  try {
    host.udpBind(sourcePort, ({ udp }) => {
      if (!(udp.payload instanceof Uint8Array)) return;
      let response: DnsMessage;
      try { response = decodeDnsMessage(udp.payload); } catch { return; }
      if (!response.flags.qr || response.id !== query.id) return;
      collected.push(response);
    }, `${binding.processName}-client`);
  } catch { return []; }

  const bytes = encodeDnsMessage(query);
  host.sendUdpDatagram(
    new IPAddress(binding.group), binding.port, sourcePort, bytes, bytes.length);
  host.udpClose(sourcePort);
  return collected;
}

export function queryMulticastDns(
  host: EndHost,
  binding: McastDnsBinding,
  query: DnsMessage,
  timeoutMs: number,
  options: { firstOnly?: boolean } = {},
): Promise<DnsMessage[]> {
  let sourcePort: number;
  try { sourcePort = host.getSocketTable().allocateEphemeralPort(); }
  catch { return Promise.resolve([]); }

  return new Promise<DnsMessage[]>((resolve) => {
    const collected: DnsMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      host.udpClose(sourcePort);
      resolve(collected);
    };

    try {
      host.udpBind(sourcePort, ({ udp }) => {
        if (!(udp.payload instanceof Uint8Array)) return;
        let response: DnsMessage;
        try { response = decodeDnsMessage(udp.payload); } catch { return; }
        if (!response.flags.qr || response.id !== query.id) return;
        collected.push(response);
        if (options.firstOnly) finish();
      }, `${binding.processName}-client`);
    } catch {
      resolve([]);
      return;
    }

    const bytes = encodeDnsMessage(query);
    const sent = host.sendUdpDatagram(
      new IPAddress(binding.group), binding.port, sourcePort, bytes, bytes.length);
    if (!sent) { finish(); return; }
    timer = setTimeout(finish, timeoutMs);
  });
}
