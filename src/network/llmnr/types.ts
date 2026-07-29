/**
 * LLMNR — Link-Local Multicast Name Resolution (RFC 4795).
 *
 * Le protocole de secours de la résolution de noms sur un lien : quand
 * aucun serveur DNS ne connaît un nom mono-label, l'hôte demande au
 * lien lui-même, et celui qui porte ce nom répond.
 */
import type { McastDnsBinding } from '@/network/dns/transport/MulticastDnsTransport';

export const LLMNR_PORT = 5355;
export const LLMNR_IPV4_GROUP = '224.0.0.252';
/** Le groupe IPv6, pour mémoire : la pile v6 de ce simulateur ne porte
 *  pas encore l'émission vers un groupe arbitraire. */
export const LLMNR_IPV6_GROUP = 'ff02::1:3';

export const LLMNR_BINDING: McastDnsBinding = {
  port: LLMNR_PORT,
  group: LLMNR_IPV4_GROUP,
  processName: 'systemd-resolved',
};

/**
 * RFC 4795 §2.1.1 — le TTL d'un enregistrement LLMNR est court : la
 * réponse ne vaut que tant que le pair est là.
 */
export const LLMNR_RECORD_TTL = 30;

/** Délai d'attente d'une réponse, RFC 4795 §2.6 (LLMNR_TIMEOUT). */
export const LLMNR_TIMEOUT_MS = 1000;
