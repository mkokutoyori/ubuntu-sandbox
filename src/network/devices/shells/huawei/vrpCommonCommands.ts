/**
 * Ce que TOUTE vue d'un VRP porte : `quit` et `return`.
 *
 * Manque mesuré sur un `HuaweiRouter` et un `HuaweiSwitch` réels : les
 * deux commandes les plus tapées d'un VRP CHANGENT bien de vue —
 * vérifié en lisant l'invite avant et après — et n'étaient annoncées
 * nulle part, ni par `?` ni par la tabulation, dans aucune vue, sur
 * aucune des deux plateformes. C'est le pendant exact du trou que
 * `CiscoShellBase.universalCommands()` a fermé côté IOS, en pire : IOS
 * listait au moins `exit` dans son aide.
 *
 * Les deux shells VRP n'ont aucune base commune ; ce module est leur
 * seule définition partagée, pour que l'aide et la complétion ne
 * puissent pas se contredire à quatre endroits.
 *
 * Ce qui `interface ?` propose N'EST PAS ici : `huaweiInterfaceHelp.ts`
 * s'en charge, en dérivant les types de la table du résolveur plutôt
 * que d'une seconde liste tenue à la main. Voir `PRD-Completion-CLI.md`
 * pour pourquoi cette moitié-là a été retirée d'ici.
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
