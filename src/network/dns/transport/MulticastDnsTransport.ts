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
import { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export interface McastDnsBinding {
  /** Port bien connu — 5355 pour LLMNR, 5353 pour mDNS. */
  readonly port: number;
  /** Groupe IPv4 de lien — 224.0.0.252 ou 224.0.0.251. */
  readonly group: string;
  /** Link-scoped IPv6 group — `ff02::1:3` or `ff02::fb`. */
  readonly group6?: string;
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


/** Every interface except loopback. */
function realInterfaces(host: EndHost): string[] {
  return host.getPorts()
    .map((p) => p.getName())
    .filter((n) => n !== 'lo');
}

/** Interfaces that actually carry IPv6, so the ones a send can leave by. */
function ipv6Interfaces(host: EndHost): string[] {
  const out: string[] = [];
  for (const port of host.getPorts()) {
    const name = port.getName();
    if (name === 'lo') continue;
    if (!port.isIPv6Enabled()) continue;
    out.push(name);
  }
  return out;
}

/**
 * Send on BOTH link groups, as a real systemd-resolved does: a peer may
 * listen on only one, and v4-only would make this host invisible on a
 * v6 link. True as soon as either send happened.
 */
function sendOnBothGroups(
  host: EndHost, binding: McastDnsBinding, sourcePort: number, bytes: Uint8Array,
): boolean {
  let envoye = host.sendUdpDatagram(
    new IPAddress(binding.group), binding.port, sourcePort, bytes, bytes.length);
  if (binding.group6 && ipv6Interfaces(host).length > 0) {
    const v6 = host.sendUdpDatagram6(
      new IPv6Address(binding.group6), binding.port, sourcePort, bytes, bytes.length);
    envoye = envoye || v6;
  }
  return envoye;
}

/**
 * Join on EVERY interface, not only those already carrying IPv6: the
 * daemon binds at boot, before any address is configured, so filtering
 * on `isIPv6Enabled()` here joined nothing at all. Membership belongs to
 * the interface and takes effect once it gains IPv6.
 */
function joinIpv6Group(host: EndHost, binding: McastDnsBinding): void {
  if (!binding.group6) return;
  for (const iface of realInterfaces(host)) host.joinIPv6Group(iface, binding.group6);
}

function leaveIpv6Group(host: EndHost, binding: McastDnsBinding): void {
  if (!binding.group6) return;
  for (const iface of realInterfaces(host)) host.leaveIPv6Group(iface, binding.group6);
}

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
      sendOnBothGroups(host, binding, binding.port, bytes);
    }
  }, binding.processName);
  joinIpv6Group(host, binding);
}

export function unbindMulticastDns(host: EndHost, binding: McastDnsBinding): void {
  host.udpClose(binding.port);
  leaveIpv6Group(host, binding);
}

/** Émet une annonce non sollicitée sur le groupe (mDNS §8.3). */
export function announceMulticastDns(
  host: EndHost, binding: McastDnsBinding, message: DnsMessage,
): boolean {
  const bytes = encodeDnsMessage(message);
  return sendOnBothGroups(host, binding, binding.port, bytes);
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
  sendOnBothGroups(host, binding, sourcePort, bytes);
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
    const sent = sendOnBothGroups(host, binding, sourcePort, bytes);
    if (!sent) { finish(); return; }
    timer = setTimeout(finish, timeoutMs);
  });
}
