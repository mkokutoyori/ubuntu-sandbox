/**
 * Les routes de bouclage d'une machine Windows.
 *
 * Elles sont permanentes : le noyau les pose au demarrage et aucune
 * commande ne les enleve. Elles etaient pourtant absentes de
 * `route print`, dont la table `Active Routes:` sortait vide sur une
 * machine fraiche, pendant que `Get-NetRoute` en declarait une, ecrite
 * en dur chez lui. Deux vues de la MEME table qui ne s'accordaient pas :
 * c'est le defaut, pas l'absence d'une ligne.
 *
 * Elles sont declarees ici une fois, avec la metrique que Windows leur
 * donne, et les deux vues les lisent.
 */

export interface WindowsLoopbackRoute {
  /** Adresse reseau, telle que `route print` l'ecrit. */
  readonly network: string;
  readonly mask: string;
  /** Longueur de prefixe, telle que `Get-NetRoute` l'ecrit. */
  readonly prefixLength: number;
  readonly metric: number;
}

export const LOOPBACK_IFALIAS = 'Loopback Pseudo-Interface 1';
export const LOOPBACK_IPV4 = '127.0.0.1';

/**
 * Les trois routes qu'un `route print` reel montre toujours : le reseau
 * 127.0.0.0/8, l'adresse elle-meme en /32, et le broadcast dirige de ce
 * reseau. Les trois, et pas seulement la premiere, parce que c'est ce
 * qui se lit sur une vraie machine et que le tutoriel les cite.
 */
export const WINDOWS_LOOPBACK_ROUTES: readonly WindowsLoopbackRoute[] = [
  { network: '127.0.0.0', mask: '255.0.0.0', prefixLength: 8, metric: 331 },
  { network: '127.0.0.1', mask: '255.255.255.255', prefixLength: 32, metric: 331 },
  { network: '127.255.255.255', mask: '255.255.255.255', prefixLength: 32, metric: 331 },
];
