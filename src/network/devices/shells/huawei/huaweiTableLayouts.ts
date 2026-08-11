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

import { renderTable, VRP_TABLE, FIXED_TABLE, type TableColumn } from '../cli/TextTable';

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
 * Les interfaces dont VRP SIMULE l'etat du protocole de liaison.
 *
 * VRP appelle cela « spoofing » et l'ecrit de deux facons pour un meme
 * fait : `up(s)` dans le tableau bref, `UP (spoofing)` dans le detail de
 * `display interface`. Les deux vues lisent donc la MEME regle, sans
 * quoi une machine pourrait marquer une interface dans un tableau et pas
 * dans l'autre.
 *
 * Ce n'est pas un ornement : c'est la facon dont VRP dit que l'etat est
 * DECRETE et non observe, donc la propriete qui rend une loopback
 * utilisable comme Router ID.
 */
export function protocoleSpoofe(nom: string): boolean {
  return /^LoopBack/i.test(nom);
}

/**
 * Le protocole d'une interface de bouclage est SPOOFE, jamais simplement
 * « up » : c'est ce que la legende annonce, et le commutateur l'ecrivait
 * deja quand le routeur ne le faisait pas.
 */
export function protocoleVrp(nom: string, proto: string): string {
  return proto === 'up' && protocoleSpoofe(nom) ? 'up(s)' : proto;
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

// ── `display interface brief` et `display interface description` ────

/** Une ligne de la famille « brief » des interfaces. */
export interface LigneInterface {
  readonly nom: string;
  readonly physique: string;
  readonly protocole: string;
  readonly description: string;
}

/**
 * Les largeurs sont celles d'un vrai VRP, relevees sur une sortie
 * capturee — `probe-alignement-tableaux-cli.test.ts` les fixe au
 * caractere pres. Le commutateur en declarait d'autres (30/8/10) et
 * n'avait ni `inErrors` ni `outErrors` : deux tableaux pour une commande.
 */
export const COLONNES_INTERFACE_BRIEF: ReadonlyArray<TableColumn<LigneInterface>> = [
  { header: 'Interface', width: 28, value: (r) => r.nom },
  { header: 'PHY', width: 6, value: (r) => r.physique },
  { header: 'Protocol', width: 10, value: (r) => r.protocole },
  { header: 'InUti', width: 5, align: 'right', value: () => '0%' },
  { header: 'OutUti', width: 7, align: 'right', value: () => '0%' },
  { header: 'inErrors', width: 11, align: 'right', value: () => '0' },
  { header: 'outErrors', width: 11, align: 'right', value: () => '0' },
];

/**
 * La legende de cette vue. Elle declare `*down` — le marqueur qu'un port
 * ferme par l'operateur porte — et le commutateur ne l'imprimait pas,
 * cohérent avec le fait qu'il ne posait jamais le marqueur non plus.
 */
export const LEGENDE_INTERFACE_BRIEF = 'PHY: Physical   *down: administratively down';

export const COLONNES_INTERFACE_DESCRIPTION: ReadonlyArray<TableColumn<LigneInterface>> = [
  { header: 'Interface', width: 30, value: (r) => r.nom },
  { header: 'PHY', width: 8, value: (r) => r.physique },
  { header: 'Protocol', width: 9, value: (r) => r.protocole },
  { header: 'Description', value: (r) => r.description },
];

export function rendreInterfaceBrief(lignes: readonly LigneInterface[]): string {
  return [
    LEGENDE_INTERFACE_BRIEF,
    ...renderTable(lignes, COLONNES_INTERFACE_BRIEF, FIXED_TABLE),
  ].join('\n');
}

export function rendreInterfaceDescription(lignes: readonly LigneInterface[]): string {
  return renderTable(lignes, COLONNES_INTERFACE_DESCRIPTION, FIXED_TABLE).join('\n');
}

// ── L'ecriture d'une adresse MAC, et les tables qui en portent ──────

/**
 * VRP ecrit une adresse MAC en trois groupes de quatre chiffres
 * hexadecimaux — `0200-0000-0005` — la ou la notation IEEE en met six
 * de deux, `02:00:00:00:00:05`.
 *
 * Ce n'est pas une preference d'affichage. Les colonnes de `display arp`
 * et de `display mac-address` sont taillees pour QUATORZE caracteres,
 * comme tout le reste de ces tableaux qui reproduit VRP ; le rendu en
 * produisait dix-sept, si bien que la MAC debordait et AVALAIT la
 * colonne suivante :
 *
 * ```
 * 10.0.10.2       02:00:00:00:00:1120        dynamicGigabitEthernet0/0/1
 * 02:00:00:00:00:1110         GigabitEthernet0/0/1dynamic
 * ```
 *
 * Trois champs colles, une ligne illisible. Ce qui precede est mesure ;
 * que la bonne ecriture soit celle de VRP releve de la connaissance du
 * constructeur, et le PRD (§23) tient les deux separes.
 */
export function huaweiMacAddress(mac: { toString(): string } | string): string {
  const brut = String(mac).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (brut.length !== 12) return String(mac);
  return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}`;
}

/** Une entree de `display arp`. */
export interface LigneArp {
  readonly ip: string;
  readonly mac: string;
  readonly expire: string;
  readonly type: string;
  readonly iface: string;
}

export const COLONNES_ARP: ReadonlyArray<TableColumn<LigneArp>> = [
  { header: 'IP ADDRESS', width: 16, value: (r) => r.ip },
  { header: 'MAC ADDRESS', width: 16, value: (r) => r.mac },
  { header: 'EXPIRE(M)', width: 11, value: (r) => r.expire },
  { header: 'TYPE', width: 10, value: (r) => r.type },
  { header: 'INTERFACE', value: (r) => r.iface },
];

/**
 * La meme geometrie sur le commutateur, plus la colonne `VPN-INSTANCE`
 * que sa vue porte. La colonne `TYPE` y faisait SEPT caracteres, soit
 * exactement la longueur de `dynamic` : la valeur remplissait sa colonne
 * et se collait au nom d'interface.
 */
export const COLONNES_ARP_SWITCH: ReadonlyArray<TableColumn<LigneArp>> = [
  ...COLONNES_ARP.slice(0, 4),
  { header: 'INTERFACE', width: 13, value: (r) => r.iface },
  { header: 'VPN-INSTANCE', value: () => '' },
];

export function rendreArp(lignes: readonly LigneArp[], vide: string): string {
  if (lignes.length === 0) {
    return [renderTable([], COLONNES_ARP, FIXED_TABLE)[0], vide].join('\n');
  }
  return renderTable(lignes, COLONNES_ARP, FIXED_TABLE).join('\n');
}

/** Une entree de `display mac-address`. */
export interface LigneMac {
  readonly mac: string;
  readonly vlan: string;
  readonly port: string;
  readonly type: string;
}

/**
 * `Learned-From` faisait QUINZE caracteres pour un nom d'interface qui
 * en fait vingt (`GigabitEthernet0/0/1`) : le nom debordait et se
 * collait au type, `GigabitEthernet0/0/1dynamic`. La colonne porte
 * desormais la largeur de ce qu'elle contient.
 */
export const COLONNES_MAC: ReadonlyArray<TableColumn<LigneMac>> = [
  { header: 'MAC Address', width: 15, value: (r) => r.mac },
  { header: 'VLAN/VSI', width: 11, value: (r) => r.vlan },
  { header: 'Learned-From', width: 22, value: (r) => r.port },
  { header: 'Type', value: (r) => r.type },
];

export function rendreMacAddress(lignes: readonly LigneMac[]): string[] {
  return renderTable(lignes, COLONNES_MAC, FIXED_TABLE);
}

const FILET_ARP = '-'.repeat(78);

/** `display arp` du commutateur : sa geometrie, ses ornements. */
export function rendreArpSwitch(lignes: readonly LigneArp[]): string {
  const table = renderTable(lignes, COLONNES_ARP_SWITCH, FIXED_TABLE);
  const dyn = lignes.filter((l) => l.type === 'dynamic').length;
  return [
    table[0],
    '                                          VLAN/CEVLAN PVC',
    FILET_ARP,
    ...table.slice(1),
    FILET_ARP,
    `Total: ${lignes.length}        Dynamic: ${dyn}      Static: ${lignes.length - dyn}`,
  ].join('\n');
}

/** Une ligne de `display users` : une interface utilisateur occupee. */
export interface LigneUsers {
  readonly courante: boolean;
  readonly interfaceUtilisateur: string;
  readonly nomLigne: string;
  readonly delai: string;
  readonly type: string;
  readonly adresse: string;
  readonly authentification: string;
  readonly autorisation: string;
}

/**
 * `display users` — les largeurs sont celles de VRP.
 *
 * Deux faits de la vraie sortie que ce depot avait tous deux manques, et
 * qui ne s'inventent pas : l'en-tete ecrit **`User-Intf`** et non `UI`,
 * et le nom d'utilisateur n'est **pas une colonne** — VRP l'ecrit sur sa
 * propre ligne, `Username : admin`, sous la ligne qu'il concerne. Un
 * rendu qui en faisait une colonne devait donc soit la tronquer soit
 * decaler tout ce qui suit.
 *
 * `AuthorcmdFlag` vaut `no` ou `yes` : la lettre `N` venait du champ
 * homonyme d'une AUTRE sortie.
 */
export const COLONNES_USERS: ReadonlyArray<TableColumn<LigneUsers>> = [
  { header: '  User-Intf', width: 13, value: (r) => `${r.courante ? '+' : ' '} ${r.interfaceUtilisateur} ${r.nomLigne}` },
  { header: 'Delay', width: 9, value: (r) => r.delai },
  { header: 'Type', width: 7, value: (r) => r.type },
  { header: 'Network Address', width: 21, value: (r) => r.adresse },
  { header: 'AuthenStatus', width: 16, value: (r) => r.authentification },
  { header: 'AuthorcmdFlag', value: (r) => r.autorisation },
];

/**
 * Le tableau, puis sous CHAQUE ligne son `Username :`. La legende finale
 * est celle de VRP : elle explique le seul etat que la colonne `Delay`
 * ne dit pas.
 */
export function rendreDisplayUsers(lignes: readonly LigneUsers[], noms: readonly string[]): string {
  const table = renderTable(lignes, COLONNES_USERS, FIXED_TABLE);
  const sortie: string[] = [table[0]];
  table.slice(1).forEach((l, i) => {
    sortie.push(l.trimEnd());
    sortie.push(`  Username : ${noms[i] || 'Unspecified'}`);
  });
  sortie.push('');
  sortie.push('Wait     : Wait for the user to press ENTER.');
  return sortie.join('\n');
}
