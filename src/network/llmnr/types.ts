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

/**
 * RFC 4795 §4.1 — nombre de requêtes de vérification d'unicité envoyées
 * au démarrage avant de considérer le nom comme à soi.
 */
export const LLMNR_UNIQUENESS_VERIFY_TIMES = 3;

/**
 * L'en-tête LLMNR **redéfinit deux bits** du header DNS (RFC 4795 §2.1.1).
 * Aux positions où le DNS place AA et RD, LLMNR place :
 *
 * - bit 10 → `C` (Conflict) : le répondeur sait que le nom n'est pas unique ;
 * - bit 8  → `T` (Tentative) : il est encore en train de le vérifier.
 *
 * Le codec de ce dépôt encode `flags.aa` en bit 10 et `flags.rd` en bit 8.
 * Poser `aa: true` sur une réponse LLMNR ne dit donc pas « autorité », mais
 * « conflit » — c'est exactement l'erreur que ces deux helpers existent pour
 * empêcher de refaire.
 */
export interface LlmnrHeaderBits {
  conflict: boolean;
  tentative: boolean;
}

export function llmnrFlagOverrides(bits: LlmnrHeaderBits): { aa: boolean; rd: boolean } {
  return { aa: bits.conflict, rd: bits.tentative };
}

export function readLlmnrBits(flags: { aa: boolean; rd: boolean }): LlmnrHeaderBits {
  return { conflict: flags.aa, tentative: flags.rd };
}

/** Où en est le nom que cet hôte défend. */
export type LlmnrNameState = 'tentative' | 'unique' | 'conflicted';
