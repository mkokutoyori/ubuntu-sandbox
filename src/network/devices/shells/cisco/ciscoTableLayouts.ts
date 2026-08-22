/**
 * Les mises en page d'IOS, relevées sur des sorties réelles.
 *
 * Une largeur de colonne d'IOS n'est pas un choix esthétique : c'est un
 * nombre figé depuis vingt ans, que les scripts d'exploitation du monde
 * entier découpent par position. Ce fichier est donc une TABLE DE
 * RÉFÉRENCE, pas un style maison — chaque layout porte la sortie d'où il
 * a été mesuré.
 */
import { type TableColumn, type TableStyle } from '../cli/TextTable';

/**
 * `show interfaces status`.
 *
 * Mesuré sur le jeu de référence de `ntc-templates`
 * (`tests/cisco_ios/show_interfaces_status/*.raw`), qui est du texte
 * capturé sur de vraies machines plutôt que recopié d'une documentation
 * dont le HTML écrase les blancs. Les bords y sont invariants d'une
 * ligne à l'autre :
 *
 * ```
 * Port      Name               Status       Vlan       Duplex  Speed Type
 * Gi1/0/1                      notconnect   1            auto   auto 10/100/1000BaseTX
 * Gi1/0/2   AccessPoint        connected    8          a-full a-1000 10/100/1000BaseTX
 * Gi1/0/4   SingleName         connected    1          a-full  a-100 10/100/1000BaseTX
 * ```
 *
 * Le point qu'on n'invente pas et qu'il fallait mesurer : **`Duplex` et
 * `Speed` sont alignées à DROITE**. `auto`, `a-full` et `a-half`
 * finissent tous les trois à la colonne 58, `auto`, `a-100` et `a-1000`
 * tous les trois à la 65 — alors que les quatre premières colonnes sont
 * à gauche. Les deux implémentations qu'avait ce dépôt les alignaient à
 * gauche, ce que l'en-tête seul ne pouvait pas trahir : `Duplex` fait
 * exactement six caractères, donc l'en-tête sort identique dans les deux
 * cas et seules les données divergent.
 */
export interface InterfaceStatusRow {
  port: string; name: string; status: string; vlan: string;
  duplex: string; speed: string; type: string;
}

export const INTERFACE_STATUS_COLUMNS: ReadonlyArray<TableColumn<InterfaceStatusRow>> = [
  { header: 'Port', width: 9, value: (r) => r.port },
  { header: 'Name', width: 18, value: (r) => r.name },
  { header: 'Status', width: 12, value: (r) => r.status },
  { header: 'Vlan', width: 10, value: (r) => r.vlan },
  { header: 'Duplex', width: 6, align: 'right', value: (r) => r.duplex },
  { header: 'Speed', width: 6, align: 'right', value: (r) => r.speed },
  { header: 'Type', value: (r) => r.type },
];

/** Un seul blanc de séparation, les largeurs ci-dessus ne le portant pas. */
export const INTERFACE_STATUS_STYLE: TableStyle = { gap: 1, rule: false };

/**
 * `show ipv6 neighbors`.
 *
 * ```
 * IPv6 Address                              Age Link-layer Addr State Interface
 * 2001:DB8::2                                 0 0003.a0d6.141e  REACH Gi0/0
 * FE80::203:A0FF:FED6:141E                    3 0003.a0d6.141e  STALE Gi0/0
 * ```
 *
 * Limite assumee et ecrite ici plutot que tue : ce layout vient de la
 * documentation de commande d'IOS et non d'une capture, contrairement a
 * `show interfaces status` ci-dessus. Les bords sont donc deduits d'un
 * en-tete dont l'espacement est verifiable, pas mesures ligne a ligne.
 * `Age` est la seule colonne alignee a DROITE, etant un nombre, et un
 * voisin statique y porte `-` plutot qu'un age.
 */
export interface Ipv6NeighborRow {
  address: string; age: string; mac: string; state: string; iface: string;
}

export const IPV6_NEIGHBORS_COLUMNS: ReadonlyArray<TableColumn<Ipv6NeighborRow>> = [
  { header: 'IPv6 Address', width: 41, value: (r) => r.address },
  { header: 'Age', width: 3, align: 'right', value: (r) => r.age },
  { header: 'Link-layer Addr', width: 15, value: (r) => r.mac },
  { header: 'State', width: 5, value: (r) => r.state },
  { header: 'Interface', value: (r) => r.iface },
];

export const IPV6_NEIGHBORS_STYLE: TableStyle = { gap: 1, rule: false };

/**
 * `show users`.
 *
 * ```
 *     Line       User       Host(s)              Idle       Location
 * *  0 con 0                idle                 00:00:00
 *    2 vty 0     jean-bapt  idle                 00:02:14 192.168.1.55
 * ```
 *
 * L'en-tete n'est PAS aligne sur ses propres donnees sur une vraie
 * machine — `Line` commence a la colonne 4 quand la valeur commence a la
 * 1, `Host(s)` a la 26 quand `idle` commence a la 22. Il reste donc une
 * constante mesuree (`SHOW_USERS_HEADER`) et seules les DONNEES passent
 * par la table, meme regle que `chronyc sources` et `ntpq -p`.
 */
export interface ShowUsersRow {
  marker: string; line: string; lineName: string;
  user: string; idle: string; location: string;
}

export const SHOW_USERS_HEADER =
  '    Line       User       Host(s)              Idle       Location';

export const SHOW_USERS_COLUMNS: ReadonlyArray<TableColumn<ShowUsersRow>> = [
  { header: '', width: 4, align: 'right', value: (r) => `${r.marker} ${r.line}` },
  { header: '', width: 10, value: (r) => ` ${r.lineName}` },
  { header: '', width: 11, value: (r) => ` ${r.user}` },
  { header: '', width: 21, value: () => ' idle' },
  { header: '', width: 9, value: (r) => ` ${r.idle}` },
  { header: '', width: 16, value: (r) => ` ${r.location}` },
];

export const SHOW_USERS_STYLE: TableStyle = { gap: 0, rule: false };

/**
 * `show spanning-tree`.
 *
 * Mesuré sur le jeu de référence de `ntc-templates`
 * (`tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw`),
 * texte capturé sur une vraie machine :
 *
 * ```
 * Interface           Role Sts Cost      Prio.Nbr Type
 * ------------------- ---- --- --------- -------- --------------------------------
 * Gi0/2               Desg FWD 4         128.3    Shr
 * Gi0/3               Root FWD 4         128.4    Shr
 * ```
 *
 * Les deux implémentations qu'avait ce dépôt écrivaient un tableau plus
 * étroit, séparé de DEUX blancs et coiffé d'un filet de la largeur des
 * intitulés — donc un tableau qu'aucun script découpant par position ne
 * lit. La colonne `Type` porte ici trente-deux caractères parce que la
 * référence y écrit des mentions longues (`P2p Peer(STP)`), et son filet
 * les porte tous.
 */
export interface SpanningTreePortRow {
  iface: string; role: string; state: string;
  cost: string; prioNbr: string; type: string;
}

export const SPANNING_TREE_COLUMNS: ReadonlyArray<TableColumn<SpanningTreePortRow>> = [
  { header: 'Interface', width: 19, value: (r) => r.iface },
  { header: 'Role', width: 4, value: (r) => r.role },
  { header: 'Sts', width: 3, value: (r) => r.state },
  { header: 'Cost', width: 9, value: (r) => r.cost },
  { header: 'Prio.Nbr', width: 8, value: (r) => r.prioNbr },
  { header: 'Type', width: 32, value: (r) => r.type },
];

export const SPANNING_TREE_STYLE: TableStyle = { gap: 1, rule: true };
