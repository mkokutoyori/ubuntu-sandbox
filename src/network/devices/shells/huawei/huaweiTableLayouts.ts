/**
 * PRD-CLI-Fidelite-VRP.md §21 / lot V12 — les tableaux de VRP, declares
 * une fois pour les deux plateformes.
 *
 * Meme raison d'etre que `cisco/ciscoTableLayouts.ts` : un tableau porte
 * SES colonnes et SES largeurs a un seul endroit, et l'en-tete comme les
 * donnees en sortent. Ici s'ajoute une raison propre a VRP — le routeur
 * et le commutateur rendaient LE MEME tableau chacun de son cote,
 * l'un en 34 colonnes et l'autre en 28, avec un bloc de compteurs d'un
 * seul cote et un marqueur `(s)` d'un seul cote.
 */

import { renderTable, VRP_TABLE, type TableColumn } from '../cli/TextTable';

/** Une ligne de `display ip interface brief`. */
export interface LigneIpBrief {
  readonly nom: string;
  readonly adresse: string;
  readonly physique: string;
  readonly protocole: string;
}

/**
 * Les largeurs sont celles de VRP, pas celles qui « rendent bien » : un
 * nom d'interface VRP va jusqu'a `GigabitEthernet0/0/0.100`, d'ou une
 * premiere colonne large. Le commutateur en declarait 28 et tronquait
 * donc sa mise en page des qu'un nom depassait.
 */
export const COLONNES_IP_BRIEF: ReadonlyArray<TableColumn<LigneIpBrief>> = [
  { header: 'Interface', width: 32, value: (r) => r.nom },
  { header: 'IP Address/Mask', width: 19, value: (r) => r.adresse },
  { header: 'Physical', width: 9, value: (r) => r.physique },
  { header: 'Protocol', value: (r) => r.protocole },
];

/**
 * La legende que VRP imprime en tete. Elle est la SPECIFICATION des
 * marqueurs employes plus bas : c'est parce qu'elle declare
 * `(s): spoofing` qu'un LoopBack doit porter `up(s)`.
 */
export const LEGENDE_IP_BRIEF: readonly string[] = [
  '*down: administratively down',
  '^down: standby',
  '(l): loopback',
  '(s): spoofing',
];

/**
 * Le protocole d'une interface de bouclage est SPOOFE, jamais simplement
 * « up » : c'est ce que la legende annonce, et le commutateur l'ecrivait
 * deja quand le routeur ne le faisait pas.
 */
export function protocoleVrp(nom: string, proto: string): string {
  return proto === 'up' && /^LoopBack/i.test(nom) ? 'up(s)' : proto;
}

/**
 * Le bloc de compteurs de VRP. Il etait rendu par le routeur et absent
 * du commutateur, pour le meme tableau.
 */
export function compteursIpBrief(lignes: readonly LigneIpBrief[]): string[] {
  const up = (v: string) => v.startsWith('up');
  const upPhys = lignes.filter((l) => up(l.physique)).length;
  const upProto = lignes.filter((l) => up(l.protocole)).length;
  return [
    `The number of interface that is UP in Physical is ${upPhys}`,
    `The number of interface that is DOWN in Physical is ${lignes.length - upPhys}`,
    `The number of interface that is UP in Protocol is ${upProto}`,
    `The number of interface that is DOWN in Protocol is ${lignes.length - upProto}`,
  ];
}

/** `display ip interface brief` en entier : legende, compteurs, tableau. */
export function rendreIpInterfaceBrief(lignes: readonly LigneIpBrief[]): string {
  return [
    ...LEGENDE_IP_BRIEF,
    ...compteursIpBrief(lignes),
    '',
    ...renderTable(lignes, COLONNES_IP_BRIEF, VRP_TABLE),
  ].join('\n');
}
