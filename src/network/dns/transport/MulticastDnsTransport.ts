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
  /**
   * Groupe IPv6 de lien — `ff02::1:3` ou `ff02::fb`. Les deux RFC en
   * demandent un, et il etait declare « pour memoire » faute d'un
   * chemin d'emission vers un groupe IPv6 quelconque ; ce chemin
   * existe (`EndHost.sendIPv6ToGroup`), donc le groupe sert.
   */
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


/** Toute interface sauf la boucle locale. */
function ifacesReelles(host: EndHost): string[] {
  return host.getPorts()
    .map((p) => p.getName())
    .filter((n) => n !== 'lo');
}

/**
 * Les interfaces qui portent effectivement IPv6, donc celles par
 * lesquelles un envoi peut sortir. Un hote sans aucune interface v6
 * n'emet rien sur le groupe v6 — et c'est ce qui distingue « pas de
 * pile » de « personne n'ecoute ».
 */
function ifacesV6(host: EndHost): string[] {
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
 * Emet sur les DEUX groupes du lien, comme le fait un vrai
 * systemd-resolved : un pair peut n'ecouter que l'un des deux, et
 * n'emettre que sur v4 le rendrait invisible sur un lien v6.
 *
 * Rend vrai des qu'UNE des deux emissions a eu lieu : sur un lien sans
 * IPv6, l'absence d'emission v6 n'est pas un echec.
 */
function envoyerSurLesGroupes(
  host: EndHost, binding: McastDnsBinding, sourcePort: number, bytes: Uint8Array,
): boolean {
  let envoye = host.sendUdpDatagram(
    new IPAddress(binding.group), binding.port, sourcePort, bytes, bytes.length);
  if (binding.group6 && ifacesV6(host).length > 0) {
    const v6 = host.sendUdpDatagram6(
      new IPv6Address(binding.group6), binding.port, sourcePort, bytes, bytes.length);
    envoye = envoye || v6;
  }
  return envoye;
}

/**
 * Rejoindre le groupe v6 sur CHAQUE interface, et non sur les seules
 * qui portent deja IPv6.
 *
 * C'est un defaut mesure et non une precaution : le demon est lie au
 * demarrage de la machine, donc avant toute configuration d'adresse.
 * Filtrer sur `isIPv6Enabled()` a cet instant ne joignait rien du tout,
 * et une adresse configuree ensuite n'ouvrait aucun groupe — l'hote
 * emettait ses questions sans jamais pouvoir entendre les reponses.
 * L'appartenance vaut pour l'interface ; elle prend effet des que
 * celle-ci porte IPv6, comme un noyau programme un groupe sur un lien.
 */
function rejoindreGroupeV6(host: EndHost, binding: McastDnsBinding): void {
  if (!binding.group6) return;
  for (const iface of ifacesReelles(host)) host.joinIPv6Group(iface, binding.group6);
}

function quitterGroupeV6(host: EndHost, binding: McastDnsBinding): void {
  if (!binding.group6) return;
  for (const iface of ifacesReelles(host)) host.leaveIPv6Group(iface, binding.group6);
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
      envoyerSurLesGroupes(host, binding, binding.port, bytes);
    }
  }, binding.processName);
  rejoindreGroupeV6(host, binding);
}

export function unbindMulticastDns(host: EndHost, binding: McastDnsBinding): void {
  host.udpClose(binding.port);
  quitterGroupeV6(host, binding);
}

/** Émet une annonce non sollicitée sur le groupe (mDNS §8.3). */
export function announceMulticastDns(
  host: EndHost, binding: McastDnsBinding, message: DnsMessage,
): boolean {
  const bytes = encodeDnsMessage(message);
  return envoyerSurLesGroupes(host, binding, binding.port, bytes);
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
  envoyerSurLesGroupes(host, binding, sourcePort, bytes);
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
    const sent = envoyerSurLesGroupes(host, binding, sourcePort, bytes);
    if (!sent) { finish(); return; }
    timer = setTimeout(finish, timeoutMs);
  });
}
