/**
 * Les tableaux d'une sortie CLI, déclarés une fois au lieu d'être
 * dessinés à la main.
 *
 * Le défaut que ce module ferme est structurel, pas cosmétique : partout
 * dans le dépôt, l'en-tête d'un tableau est une CHAÎNE LITTÉRALE et ses
 * lignes de données une AUTRE chaîne, avec leurs `padStart`/`padEnd`
 * comptés séparément. Rien ne relie les deux, donc rien n'empêche
 * l'écart — et l'écart est là. Mesuré sur un routeur et un commutateur
 * réels avant d'écrire une ligne ici :
 *
 * ```
 * show interfaces … accounting   en-tête finit à 24/35/47/59/71
 *                                données finissent à 22/34/46/58/70
 * show interfaces … switching    deux lignes sur quatre décalées d'un cran
 * show interfaces counters       toutes les colonnes décalées d'un cran
 * show interfaces status         la dernière colonne décalée d'un cran
 * ```
 *
 * Ici, une colonne porte SON en-tête, SA largeur et SON alignement, et
 * l'en-tête comme les données sortent du même calcul. Un décalage
 * redevient impossible plutôt que rattrapé au coup par coup.
 *
 * ── Ce que ce module ne fait pas, et pourquoi ────────────────────────
 *
 * Il n'impose aucune largeur « jolie ». Les équipements simulés ici
 * doivent reproduire des sorties RÉELLES, dont les largeurs sont celles
 * qu'IOS et VRP ont figées il y a vingt ans ; une colonne peut donc
 * déclarer sa largeur exacte (`width`), et c'est le cas normal pour un
 * tableau qu'on rejoue d'après une machine. La largeur automatique
 * (`max(en-tête, contenu)`) n'est là que pour les tableaux dont la
 * référence ne fixe rien.
 *
 * Il ne dessine pas non plus de bordures : ni IOS ni VRP n'en ont. Le
 * seul ornement des deux est un filet de tirets sous l'en-tête, que
 * certaines familles de commandes portent et d'autres pas — d'où un
 * style par famille plutôt qu'un style par constructeur.
 */

export type ColumnAlign = 'left' | 'right';

export interface TableColumn<R> {
  /** L'intitulé, tel que la vraie machine l'écrit. */
  readonly header: string;
  /**
   * Largeur imposée de la colonne. Absente, la largeur est celle du plus
   * large entre l'en-tête et les valeurs — ce qui convient à un tableau
   * dont aucune sortie réelle ne fixe la mise en page, et jamais à un
   * tableau qu'on reproduit.
   */
  readonly width?: number;
  /** `left` par défaut, comme la quasi-totalité des colonnes d'IOS. */
  readonly align?: ColumnAlign;
  readonly value: (row: R) => string;
}

export interface TableStyle {
  /** Espaces séparant deux colonnes. */
  readonly gap: number;
  /** Un filet de tirets sous l'en-tête, à la largeur de chaque colonne. */
  readonly rule: boolean;
  /** Décalage appliqué à toutes les lignes, en-tête compris. */
  readonly indent?: string;
  /**
   * Certaines vues sont des tableaux SANS intitulé de colonne — la table
   * des processus de `diagnose sys top`, la liste étiquette/valeur de
   * `diagnose hardware sysinfo conserve`. Leurs colonnes ont bien une
   * largeur et un alignement ; il leur manque seulement la ligne du haut.
   */
  readonly header?: boolean;
}

/**
 * Le cas courant d'IOS : deux espaces entre colonnes, pas de filet.
 * `show ip interface brief`, `show interfaces counters`.
 */
export const IOS_TABLE: TableStyle = { gap: 2, rule: false };

/**
 * Les familles d'IOS qui portent un filet : `show vlan`,
 * `show interfaces status`. Un seul espace entre colonnes, parce que le
 * filet fait déjà la séparation visuelle.
 */
export const IOS_RULED_TABLE: TableStyle = { gap: 2, rule: true };

/**
 * Les tableaux dont la référence fixe des colonnes de largeur PLEINE,
 * blancs de séparation compris. C'est le cas dès que deux colonnes
 * voisines ne sont pas séparées du même nombre d'espaces —
 * `display interface brief` met un blanc entre `InUti` et `OutUti`,
 * trois entre `OutUti` et `inErrors`. Un écart uniforme ne peut pas
 * reproduire cela ; une largeur qui contient son blanc, si.
 *
 * Ce style n'est pas étiqueté par constructeur, à la différence des
 * précédents : « la largeur porte son propre blanc » est une façon de
 * mesurer, pas une convention d'IOS ou de VRP, et les deux plateformes
 * ont des tableaux de cette forme.
 */
export const FIXED_TABLE: TableStyle = { gap: 0, rule: false };

/** VRP sépare de deux espaces et ne met pas de filet sur ses tableaux brefs. */
export const VRP_TABLE: TableStyle = { gap: 2, rule: false };

/** Les vues VRP qui soulignent leur en-tête (`display vlan`). */
export const VRP_RULED_TABLE: TableStyle = { gap: 2, rule: true };

function largeur<R>(col: TableColumn<R>, rows: readonly R[]): number {
  if (col.width !== undefined) return col.width;
  return rows.reduce((m, r) => Math.max(m, col.value(r).length), col.header.length);
}

/**
 * Cale une cellule dans sa colonne.
 *
 * Une valeur PLUS LONGUE que sa colonne n'est jamais tronquée : sur une
 * vraie machine, un nom d'interface qui déborde pousse la suite de la
 * ligne plutôt que de disparaître, et perdre un caractère de donnée
 * pour sauver un alignement serait le mauvais échange.
 */
function caler(texte: string, w: number, align: ColumnAlign): string {
  if (texte.length >= w) return texte;
  return align === 'right' ? texte.padStart(w) : texte.padEnd(w);
}

/**
 * Rend le tableau, en-tête compris, une chaîne par ligne.
 *
 * Les blancs de fin sont retirés : aucune des deux plateformes n'en
 * laisse, et les tests de sortie du dépôt comparent des lignes entières.
 */
export function renderTable<R>(
  rows: readonly R[],
  columns: ReadonlyArray<TableColumn<R>>,
  style: TableStyle = IOS_TABLE,
): string[] {
  const largeurs = columns.map((c) => largeur(c, rows));
  const sep = ' '.repeat(style.gap);
  const indent = style.indent ?? '';
  const ligne = (cellules: readonly string[]): string =>
    (indent + cellules.map((c, i) => caler(c, largeurs[i], columns[i].align ?? 'left')).join(sep)).trimEnd();

  const out: string[] = [];
  if (style.header !== false) out.push(ligne(columns.map((c) => c.header)));
  if (style.rule) out.push(ligne(largeurs.map((w) => '-'.repeat(w))));
  for (const r of rows) out.push(ligne(columns.map((c) => c.value(r))));
  return out;
}

/** Le même, d'un seul tenant. */
export function renderTableText<R>(
  rows: readonly R[],
  columns: ReadonlyArray<TableColumn<R>>,
  style: TableStyle = IOS_TABLE,
): string {
  return renderTable(rows, columns, style).join('\n');
}

/**
 * Le tableau « étiquette à droite puis compteurs », qu'IOS emploie pour
 * `show interfaces … switching` et `… accounting`.
 *
 * Sa forme ne ressemble à aucune autre : la première colonne est
 * ALIGNÉE À DROITE — l'intitulé et les libellés finissent au même
 * caractère — et les colonnes de compteurs suivent, à droite elles
 * aussi. C'est précisément ce tableau que les deux commandes dessinaient
 * à la main, chacune avec son propre décompte d'espaces, et chacune avec
 * son décalage.
 *
 * Les largeurs sont celles d'IOS et sont donc imposées, pas calculées.
 */
export interface CounterRow {
  readonly label: string;
  readonly cells: readonly string[];
}

export function renderCounterTable(
  labelHeader: string,
  cellHeaders: readonly string[],
  rows: readonly CounterRow[],
  labelWidth = 24,
  cellWidths: readonly number[] = [11, 12, 12, 12],
): string[] {
  const colonnes: Array<TableColumn<CounterRow>> = [
    { header: labelHeader, width: labelWidth, align: 'right', value: (r) => r.label },
    ...cellHeaders.map((h, i) => ({
      header: h,
      width: cellWidths[i] ?? cellWidths[cellWidths.length - 1] ?? 12,
      align: 'right' as const,
      value: (r: CounterRow) => r.cells[i] ?? '',
    })),
  ];
  // Écart nul : chaque largeur porte déjà son blanc, ce qui est la seule
  // façon de retrouver les bords 24/35/47/59/71 de la sortie réelle.
  return renderTable(rows, colonnes, FIXED_TABLE);
}
