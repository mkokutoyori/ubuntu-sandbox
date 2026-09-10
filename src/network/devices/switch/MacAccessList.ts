import { MACAddress } from '@/network/core/types';

/**
 * Une liste d'acces MAC, et ce qu'elle decide.
 *
 * Elle ne passe PAS par `ACLEngine` : une entree de ce moteur exige une
 * `srcIP`, parce qu'il repond a une question de couche 3. Celle-ci n'en
 * a pas — elle lit deux adresses MAC et rien d'autre. Les rapprocher
 * demanderait de rendre facultatif, dans un moteur eprouve, le champ
 * qui le definit.
 *
 * Ce qu'elle filtre est le trafic NON-IP, et cela seul :
 *
 *   « The IP access list filters only IP packets, and the MAC access
 *     list filters non-IP packets. »
 *     (Cisco, Configuring Network Security with ACLs)
 *
 * Une trame IPv4 ou IPv6 ne lui est donc jamais soumise ; c'est la
 * liste IP du meme port qui en repond. Les deux peuvent coexister sur
 * une interface, chacune sur son trafic.
 */

export type MacMatch =
  | { readonly kind: 'any' }
  | { readonly kind: 'host'; readonly mac: MACAddress };

export interface MacAce {
  readonly action: 'permit' | 'deny';
  readonly src: MacMatch;
  readonly dst: MacMatch;
}

export interface MacAccessList {
  readonly name: string;
  entries: MacAce[];
}

/** `xxxx.xxxx.xxxx` — la forme qu'IOS ecrit et accepte. */
const TRIPLETS_POINTES = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i;

export function isDottedMac(token: string): boolean {
  return TRIPLETS_POINTES.test(token);
}

export function parseDottedMac(token: string): MACAddress | null {
  if (!isDottedMac(token)) return null;
  const hex = token.replace(/\./g, '').toLowerCase();
  const octets = hex.match(/.{2}/g);
  return octets ? new MACAddress(octets.join(':')) : null;
}

export function renderDottedMac(mac: MACAddress): string {
  const hex = mac.toString().replace(/[:.-]/g, '').toLowerCase();
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

function renderMatch(match: MacMatch): string {
  return match.kind === 'any' ? 'any' : `host ${renderDottedMac(match.mac)}`;
}

export function renderMacAce(ace: MacAce): string {
  return `${ace.action} ${renderMatch(ace.src)} ${renderMatch(ace.dst)}`;
}

function matches(match: MacMatch, mac: MACAddress): boolean {
  return match.kind === 'any' || match.mac.equals(mac);
}

/**
 * Le verdict de la liste sur une trame, `deny` implicite compris.
 *
 * IOS termine toute liste d'acces par un refus muet : une liste VIDE ne
 * laisse donc rien passer. C'est le piege classique de la premiere
 * pose, et le reproduire est ce qui rend le laboratoire utile.
 */
export function evaluateMacAcl(
  list: MacAccessList, src: MACAddress, dst: MACAddress,
): 'permit' | 'deny' {
  for (const ace of list.entries) {
    if (matches(ace.src, src) && matches(ace.dst, dst)) return ace.action;
  }
  return 'deny';
}
