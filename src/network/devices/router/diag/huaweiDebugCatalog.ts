/**
 * PRD-CLI-Fidelite-VRP.md §14 / lot V6 — la table des `debugging` de VRP.
 *
 * Elle existe parce que la meme question avait quatre reponses sur une
 * seule machine : deux magasins pour ICMP (`debugging icmp` marchait,
 * `debugging ip icmp` etait rendu par `display debugging` et n'emettait
 * rien), trois formats de confirmation, et `debugging zzz` accepte.
 *
 * Une categorie n'entre ici que si un EMETTEUR existe pour elle. Les
 * modules que VRP connait et que ce simulateur ne peut pas tracer sont
 * dans `HUAWEI_DEBUG_SANS_SOURCE`, refuses en nommant ce qui manque —
 * cette liste-la ne doit que retrecir.
 */

export type HuaweiDebugCategory =
  | 'ospf-event'
  | 'ospf-packet'
  | 'ospf-spf'
  | 'ospf-hello'
  | 'ip-icmp'
  | 'ip-packet'
  | 'arp-packet'
  | 'stp'
  | 'vrrp'
  | 'bgp'
  | 'rip';

export type HuaweiDebugPlatform = 'router' | 'switch';

export interface HuaweiDebugSpec {
  category: HuaweiDebugCategory;
  /** L'ecriture canonique de VRP, celle que l'operateur tape. */
  words: readonly string[];
  /** La designation unique de la categorie : confirmation ET listage. */
  label: string;
  platforms: readonly HuaweiDebugPlatform[];
}

const TOUTES: readonly HuaweiDebugPlatform[] = ['router', 'switch'];

export const HUAWEI_DEBUG_CATALOG: readonly HuaweiDebugSpec[] = [
  { category: 'ospf-event', words: ['ospf', 'event'], label: 'OSPF event', platforms: TOUTES },
  { category: 'ospf-packet', words: ['ospf', 'packet'], label: 'OSPF packet', platforms: TOUTES },
  { category: 'ospf-spf', words: ['ospf', 'spf'], label: 'OSPF SPF', platforms: TOUTES },
  { category: 'ospf-hello', words: ['ospf', 'hello'], label: 'OSPF Hello', platforms: TOUTES },
  { category: 'ip-icmp', words: ['ip', 'icmp'], label: 'ip icmp', platforms: TOUTES },
  { category: 'ip-packet', words: ['ip', 'packet'], label: 'IP packet', platforms: TOUTES },
  { category: 'arp-packet', words: ['arp', 'packet'], label: 'ARP packet', platforms: TOUTES },
  { category: 'stp', words: ['stp'], label: 'STP', platforms: ['switch'] },
  { category: 'vrrp', words: ['vrrp'], label: 'VRRP', platforms: ['router'] },
  { category: 'bgp', words: ['bgp'], label: 'BGP', platforms: ['router'] },
  { category: 'rip', words: ['rip'], label: 'RIP', platforms: ['router'] },
];

/**
 * Ce que VRP sait faire et que ce simulateur ne sait pas tracer. Refuse
 * en nommant la brique absente, plutot qu'accepte en silence — un
 * `debugging` qui ne peut rien emettre promet une trace qui ne viendra
 * jamais.
 */
export const HUAWEI_DEBUG_SANS_SOURCE: ReadonlyArray<{
  words: readonly string[];
  raison: string;
}> = [
  { words: ['isis'], raison: 'The IS-IS module produces no debugging information in this simulator.' },
];

export type HuaweiDebugLookup =
  | { kind: 'ok'; spec: HuaweiDebugSpec; scope: string | null }
  | { kind: 'incomplete' }
  | { kind: 'sans-source'; raison: string }
  | { kind: 'autre-plateforme'; token: string }
  | { kind: 'inconnu'; token: string };

function commencePar(mots: readonly string[], prefixe: readonly string[]): boolean {
  return prefixe.every((p, i) => (mots[i] ?? '').toLowerCase() === p);
}

/**
 * Resout `debugging <mots>` sur une plateforme. Le plus long prefixe
 * gagne, pour que `ospf packet` ne soit pas confondu avec `ospf event`,
 * et ce qui suit est un SCOPE (`debugging rip 1`) plutot qu'une erreur :
 * VRP admet un argument de portee derriere le module.
 */
export function resoudreDebugHuawei(
  mots: readonly string[],
  plateforme: HuaweiDebugPlatform,
): HuaweiDebugLookup {
  const utiles = mots.filter((m) => m.length > 0);
  if (utiles.length === 0) return { kind: 'incomplete' };

  const candidats = HUAWEI_DEBUG_CATALOG
    .filter((s) => commencePar(utiles, s.words))
    .sort((a, b) => b.words.length - a.words.length);

  const surPlateforme = candidats.find((s) => s.platforms.includes(plateforme));
  if (surPlateforme) {
    const reste = utiles.slice(surPlateforme.words.length);
    return { kind: 'ok', spec: surPlateforme, scope: reste.length ? reste.join(' ') : null };
  }
  if (candidats.length > 0) return { kind: 'autre-plateforme', token: utiles[0] };

  const sansSource = HUAWEI_DEBUG_SANS_SOURCE.find((s) => commencePar(utiles, s.words));
  if (sansSource) return { kind: 'sans-source', raison: sansSource.raison };

  // Un prefixe strict d'une ecriture connue est INCOMPLET, pas inconnu :
  // `debugging ospf` designe une famille dont il manque le membre.
  const partiel = HUAWEI_DEBUG_CATALOG.some(
    (s) => s.platforms.includes(plateforme) && commencePar(s.words, utiles),
  );
  if (partiel) return { kind: 'incomplete' };

  return { kind: 'inconnu', token: utiles[0] };
}

export function categoriesDeLaPlateforme(
  plateforme: HuaweiDebugPlatform,
): readonly HuaweiDebugSpec[] {
  return HUAWEI_DEBUG_CATALOG.filter((s) => s.platforms.includes(plateforme));
}

export function labelDeCategorie(categorie: HuaweiDebugCategory): string {
  return HUAWEI_DEBUG_CATALOG.find((s) => s.category === categorie)?.label ?? categorie;
}
