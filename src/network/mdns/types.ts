/**
 * mDNS — Multicast DNS (RFC 6762).
 *
 * Le pendant de LLMNR pour le domaine `.local` : mêmes messages DNS, même
 * principe de possession, mais les réponses repartent sur le groupe pour
 * que tout le lien en profite, et l'hôte s'annonce sans qu'on lui demande.
 */
import type { McastDnsBinding } from '@/network/dns/transport/MulticastDnsTransport';

export const MDNS_PORT = 5353;
export const MDNS_IPV4_GROUP = '224.0.0.251';
/** Le groupe IPv6, pour mémoire — non émis ici, comme pour LLMNR. */
export const MDNS_IPV6_GROUP = 'ff02::fb';

/** Le seul domaine que mDNS sert (RFC 6762 §3). */
export const MDNS_DOMAIN = 'local';

export const MDNS_BINDING: McastDnsBinding = {
  port: MDNS_PORT,
  group: MDNS_IPV4_GROUP,
  processName: 'systemd-resolved',
};

/** RFC 6762 §10 : le TTL d'un enregistrement d'adresse mDNS. */
export const MDNS_RECORD_TTL = 120;

/**
 * RFC 6762 §6.7 : une réponse à une requête ponctuelle (port source
 * éphémère) porte un TTL plafonné à 10 s, le demandeur n'écoutant pas le
 * groupe pour recevoir les annulations.
 */
export const MDNS_LEGACY_TTL = 10;

export const MDNS_TIMEOUT_MS = 1000;

/** True pour un nom du domaine `.local`, seul terrain de mDNS. */
export function isLocalName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  return n === MDNS_DOMAIN || n.endsWith(`.${MDNS_DOMAIN}`);
}
