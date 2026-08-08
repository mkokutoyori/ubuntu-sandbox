/**
 * Ce que TOUTE vue d'un VRP porte, et les types d'interface qu'il ouvre.
 *
 * Deux manques mesurés sur un `HuaweiRouter` et un `HuaweiSwitch` réels,
 * consignés dans `docs/PRD-Completion-CLI.md` :
 *
 *  - **`quit` et `return` s'exécutent et ne sont annoncés nulle part.**
 *    Les deux commandes les plus tapées d'un VRP changent bien de vue —
 *    vérifié en lisant l'invite avant et après — mais aucune des deux
 *    n'apparaît dans `?` ni ne se complète par tabulation, dans aucune
 *    vue, sur aucune des deux plateformes. C'est le pendant exact du
 *    trou que `CiscoShellBase.universalCommands()` a fermé côté IOS, en
 *    pire : IOS listait au moins `exit` dans son aide.
 *
 *  - **`interface ?` ne liste aucun type.** Le routeur répondait
 *    `WORD  Enter interface view` et le commutateur `range`, là où un
 *    vrai VRP énumère les types qu'il sait ouvrir. Faute de types dans
 *    l'arbre, `interface Gi` ne complétait rien sur le routeur (ses
 *    ports s'appellent `GE0/0/0`) et noyait le commutateur sous
 *    vingt-quatre noms de ports.
 *
 * Les deux listes de types sont MESURÉES, pas recopiées d'une
 * documentation : chaque type ci-dessous a été ouvert sur la machine
 * correspondante, et ceux qu'elle refuse n'y figurent pas — le routeur
 * n'a pas d'`Ethernet`, le commutateur n'a ni `NULL` ni `Tunnel`. Un
 * test rentre dans chaque vue pour que la liste ne puisse pas s'écarter
 * de ce que l'analyseur accepte vraiment.
 */

export interface VrpKeyword {
  keyword: string;
  description: string;
}

/** La vue courante, du point de vue de ce module : racine ou pas. */
export type VrpViewKind = 'user' | 'other';

/**
 * `quit` existe partout ; `return` n'a de sens qu'en dehors de la vue
 * utilisateur, où il n'y a rien à remonter — et un vrai VRP ne le
 * propose pas là non plus.
 */
export function vrpCommonCommands(view: VrpViewKind): VrpKeyword[] {
  const out: VrpKeyword[] = [
    { keyword: 'quit', description: 'Exit from current command view' },
  ];
  if (view !== 'user') {
    out.push({ keyword: 'return', description: 'Exit to user view' });
  }
  return out;
}

/**
 * Fusionne les commandes communes dans un menu d'aide.
 *
 * Seul le menu RACINE d'une vue les porte : `quit` n'est pas une suite
 * de `display`, et `display quit` n'existe pas.
 */
export function withVrpCommonHelp(
  view: VrpViewKind,
  input: string,
  completions: VrpKeyword[],
): VrpKeyword[] {
  if (input.trim() !== '') return completions;
  const deja = new Set(completions.map((c) => c.keyword.toLowerCase()));
  const out = [...completions];
  for (const u of vrpCommonCommands(view)) {
    if (!deja.has(u.keyword)) out.push(u);
  }
  return out.sort((a, b) => a.keyword.localeCompare(b.keyword));
}

/**
 * Le pendant pour la complétion, à partir de la MÊME liste que l'aide —
 * une seconde liste rouvrirait l'écart qu'on ferme ici.
 */
export function withVrpCommonCandidates(
  view: VrpViewKind,
  input: string,
  candidates: string[],
): string[] {
  if (/\s/.test(input.trim()) || input.endsWith(' ')) return candidates;
  const partiel = input.trim().toLowerCase();
  if (partiel.length === 0) return candidates;
  const deja = new Set(candidates.map((c) => c.toLowerCase()));
  const out = [...candidates];
  for (const u of vrpCommonCommands(view)) {
    if (u.keyword.startsWith(partiel) && !deja.has(u.keyword)) out.push(u.keyword);
  }
  return out;
}

/** Les types qu'un AR ouvre. `Ethernet` n'en fait pas partie : mesuré. */
export const VRP_ROUTER_INTERFACE_TYPES: readonly VrpKeyword[] = [
  { keyword: 'Eth-Trunk', description: 'Ethernet-Trunk interface' },
  { keyword: 'GigabitEthernet', description: 'GigabitEthernet interface' },
  { keyword: 'LoopBack', description: 'LoopBack interface' },
  { keyword: 'NULL', description: 'NULL interface' },
  { keyword: 'Tunnel', description: 'Tunnel interface' },
  { keyword: 'Vlanif', description: 'Vlan interface' },
];

/** Ceux d'un S5700. Ni `NULL` ni `Tunnel` : mesuré aussi. */
export const VRP_SWITCH_INTERFACE_TYPES: readonly VrpKeyword[] = [
  { keyword: 'Eth-Trunk', description: 'Ethernet-Trunk interface' },
  { keyword: 'GigabitEthernet', description: 'GigabitEthernet interface' },
  { keyword: 'LoopBack', description: 'LoopBack interface' },
  { keyword: 'Vlanif', description: 'Vlan interface' },
];
