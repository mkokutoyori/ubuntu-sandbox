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
