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

export type ColumnAlign = 'left' | 'right' | 'center';

export type ColumnOverflow = 'spill' | 'truncate' | 'ellipsis' | 'wrap';

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
  /**
   * Rendre `false` pour qu'une valeur soit ÉCRITE sans être MESURÉE :
   * elle déborde alors sa colonne au lieu de l'élargir. C'est le
   * `fullrow` de `NmapOutputTable` (`NmapOutputTable.cc:171`, qui
   * restaure `maxColLen` après l'ajout), dont se sert la ligne
   * « Hops 1-N are the same as for … » d'une section `TRACEROUTE`.
   */
  readonly measured?: (row: R) => boolean;
  readonly headerWidth?: number;
  readonly minWidth?: number;
  /**
   * Première ligne d'un en-tête sur deux (`Hello`/`Max`/`Fwd` au-dessus
   * de `Time`/`Age`/`Dly` dans `show spanning-tree bridge`) : rendue
   * dans la même largeur et le même alignement que la colonne.
   */
  readonly superHeader?: string;
  /**
   * Plafond de la largeur AUTOMATIQUE. Sans `overflow`, une valeur plus
   * large que le plafond déborde (`spill`) ; avec, elle est tronquée,
   * suivie de `...`, ou coupée sur plusieurs lignes.
   */
  readonly maxWidth?: number;
  readonly overflow?: ColumnOverflow;
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
  /**
   * WMIC est la seule vue reproduite ici qui LAISSE ses blancs de fin :
   * chaque colonne est calée à sa largeur, la dernière comprise, et un
   * script qui découpe par position s'appuie dessus. Les vues IOS et VRP
   * n'en laissent pas, d'où le retrait par défaut.
   */
  readonly padTrailing?: boolean;
  /** Caractère du filet : `-` par défaut, `=` pour `whoami`. */
  readonly ruleChar?: string;
  readonly ruleFitsHeader?: boolean;
  /** Lignes écrites sous le tableau, calées sur ses colonnes (totaux). */
  readonly footer?: ReadonlyArray<ReadonlyArray<string>>;
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

/**
 * `NmapOutputTable` : chaque colonne prend la largeur de son contenu et
 * un seul blanc les sépare (`NmapOutputTable.cc:247`, qui écrit
 * `clen - strlength + 1` espaces). C'est le tableau de `nmap -h`, de
 * `--iflist` et de la section `TRACEROUTE`.
 */
export const NMAP_TABLE: TableStyle = { gap: 1, rule: false };

const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

function isCombining(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f;
}

/**
 * Largeur d'affichage d'un texte dans un terminal : les séquences ANSI
 * ne comptent pas, un caractère combinant non plus, et une idéographie
 * ou un emoji en prend deux. `String.length` compte des unités UTF-16,
 * ce qui décale une colonne dès qu'un accent décomposé ou un caractère
 * hors du plan de base y figure.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(ANSI_ESCAPE, '')) {
    const code = ch.codePointAt(0)!;
    if (isCombining(code)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function sliceToWidth(text: string, limit: number): string {
  let width = 0;
  let out = '';
  for (const ch of text) {
    const next = width + displayWidth(ch);
    if (next > limit) break;
    out += ch;
    width = next;
  }
  return out;
}

export function padToWidth(text: string, width: number, align: ColumnAlign = 'left'): string {
  const missing = width - displayWidth(text);
  if (missing <= 0) return text;
  if (align === 'right') return ' '.repeat(missing) + text;
  if (align === 'center') {
    const before = Math.floor(missing / 2);
    return ' '.repeat(before) + text + ' '.repeat(missing - before);
  }
  return text + ' '.repeat(missing);
}

function columnWidth<R>(
  col: TableColumn<R>, rows: readonly R[], index: number, footer: ReadonlyArray<ReadonlyArray<string>> = [],
): number {
  if (col.width !== undefined) return col.width;
  const fromRows = rows.reduce(
    (m, r) => (col.measured?.(r) === false ? m : Math.max(m, ...col.value(r).split('\n').map(displayWidth))),
    Math.max(displayWidth(col.header), displayWidth(col.superHeader ?? '')));
  const natural = footer.reduce((m, cells) => Math.max(m, displayWidth(cells[index] ?? '')), fromRows);
  const capped = col.maxWidth !== undefined && col.overflow !== undefined && col.overflow !== 'spill'
    ? Math.min(natural, col.maxWidth) : natural;
  return Math.max(capped, col.minWidth ?? 0);
}

function wrapToWidth(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (displayWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      let rest = word;
      while (displayWidth(rest) > width) {
        const head = sliceToWidth(rest, width);
        lines.push(head);
        rest = rest.slice(head.length);
      }
      current = rest;
    }
    lines.push(current);
  }
  return lines;
}

function cellLines(text: string, width: number, overflow: ColumnOverflow | undefined): string[] {
  const firstLine = (value: string): string => value.split('\n')[0];
  if (overflow === 'wrap') return wrapToWidth(text, width);
  if (overflow === 'truncate') return [sliceToWidth(firstLine(text), width)];
  if (overflow === 'ellipsis') {
    const line = firstLine(text);
    return [displayWidth(line) <= width ? line : `${sliceToWidth(line, Math.max(0, width - 3))}...`];
  }
  return [firstLine(text)];
}

/**
 * Cale une cellule dans sa colonne.
 *
 * Une valeur PLUS LONGUE que sa colonne n'est jamais tronquée par
 * défaut : sur une vraie machine, un nom d'interface qui déborde pousse
 * la suite de la ligne plutôt que de disparaître, et perdre un
 * caractère de donnée pour sauver un alignement serait le mauvais
 * échange. Une colonne qui veut le contraire le déclare (`overflow`).
 */
function caler(texte: string, w: number, align: ColumnAlign): string {
  return padToWidth(texte, w, align);
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
  const widths = columns.map((c, i) => columnWidth(c, rows, i, style.footer));
  const headerWidths = columns.map((c, i) => c.headerWidth ?? widths[i]);
  const sep = ' '.repeat(style.gap);
  const indent = style.indent ?? '';
  const ruleChar = style.ruleChar ?? '-';
  const joinCells = (cells: readonly string[], measures: readonly number[]): string => {
    const raw = indent + cells.map((c, i) => caler(c, measures[i], columns[i].align ?? 'left')).join(sep);
    return style.padTrailing ? raw : raw.trimEnd();
  };
  const physicalLines = (cells: readonly string[]): string[] => {
    const split = cells.map((c, i) => cellLines(c, widths[i], columns[i].overflow));
    const height = Math.max(1, ...split.map((lines) => lines.length));
    return Array.from({ length: height }, (_, k) => joinCells(split.map((lines) => lines[k] ?? ''), widths));
  };

  const out: string[] = [];
  if (style.header !== false) {
    if (columns.some((c) => c.superHeader !== undefined)) {
      out.push(joinCells(columns.map((c) => c.superHeader ?? ''), headerWidths));
    }
    out.push(joinCells(columns.map((c) => c.header), headerWidths));
  }
  if (style.rule) {
    const ruleWidths = style.ruleFitsHeader ? columns.map((c) => displayWidth(c.header)) : widths;
    out.push(joinCells(ruleWidths.map((w) => ruleChar.repeat(w)), widths));
  }
  for (const r of rows) out.push(...physicalLines(columns.map((c) => c.value(r))));
  for (const footer of style.footer ?? []) out.push(...physicalLines(footer));
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

export interface KeyValueOptions {
  /** Texte entre l'étiquette calée et la valeur : `' : '`, `': '`, `'  '`. */
  readonly separator?: string;
  /** Largeur imposée de l'étiquette ; sinon la plus large des étiquettes. */
  readonly labelWidth?: number;
  readonly indent?: string;
  /** Les valeurs qui contiennent des retours à la ligne reviennent sous la colonne des valeurs. */
  readonly alignContinuations?: boolean;
}

/**
 * Le bloc « étiquette  valeur » (`net accounts`, `net user NAME`,
 * `ipconfig /all`, `Format-List`) : les étiquettes sont calées à la
 * même largeur, donc les valeurs commencent toutes à la même colonne.
 * Une étiquette vide laisse la ligne de continuation d'une valeur
 * multiple (une adresse DNS de plus) sous la colonne des valeurs.
 */
export function renderKeyValue(
  entries: ReadonlyArray<readonly [string, string]>,
  options: KeyValueOptions = {},
): string[] {
  const separator = options.separator ?? '  ';
  const indent = options.indent ?? '';
  const labelWidth = options.labelWidth
    ?? entries.reduce((m, [label]) => Math.max(m, displayWidth(label)), 0);
  const out: string[] = [];
  for (const [label, value] of entries) {
    const [first, ...rest] = value.split('\n');
    out.push((indent + padToWidth(label, labelWidth) + separator + first).trimEnd());
    for (const more of rest) {
      const lead = options.alignContinuations === false ? '' : ' '.repeat(labelWidth + separator.length);
      out.push((indent + lead + more).trimEnd());
    }
  }
  return out;
}

export interface GridOptions {
  /** Nombre de colonnes ; sinon déduit de `lineWidth`. */
  readonly columns?: number;
  /** Largeur de ligne à ne pas dépasser (80 par défaut). */
  readonly lineWidth?: number;
  /** Largeur imposée d'une colonne ; sinon le plus large élément plus `gap`. */
  readonly cellWidth?: number;
  readonly gap?: number;
  /** `row` remplit ligne après ligne (`net user`), `column` colonne après colonne (`ls`). */
  readonly fill?: 'row' | 'column';
  readonly trimTrailing?: boolean;
}

/**
 * Une liste d'éléments disposée en colonnes de même largeur
 * (`net user`, `net localgroup`, `dir /w`, `ls`).
 */
export function renderGrid(items: readonly string[], options: GridOptions = {}): string[] {
  if (items.length === 0) return [];
  const gap = options.gap ?? 2;
  const widest = items.reduce((m, item) => Math.max(m, displayWidth(item)), 0);
  const cellWidth = options.cellWidth ?? widest + gap;
  const columns = Math.max(1, options.columns ?? Math.floor((options.lineWidth ?? 80) / cellWidth));
  const rowCount = Math.ceil(items.length / columns);
  const out: string[] = [];
  for (let row = 0; row < rowCount; row++) {
    const cells: string[] = [];
    for (let col = 0; col < columns; col++) {
      const index = options.fill === 'column' ? col * rowCount + row : row * columns + col;
      if (index < items.length) cells.push(padToWidth(items[index], cellWidth));
    }
    const line = cells.join('');
    out.push(options.trimTrailing === false ? line : line.trimEnd());
  }
  return out;
}

/**
 * Colonnes déclarées par leurs seules clés : pour un tableau dont les
 * lignes sont déjà des enregistrements, `columnsFromKeys(['Name', 'Id'])`
 * suffit. `overrides` ajuste l'une d'elles (alignement, largeur).
 */
export function columnsFromKeys<R extends Record<string, unknown>>(
  keys: ReadonlyArray<keyof R & string>,
  overrides: Partial<Record<keyof R & string, Partial<Omit<TableColumn<R>, 'header' | 'value'>>>> = {},
): Array<TableColumn<R>> {
  return keys.map((key) => ({
    header: key,
    value: (row: R) => String(row[key] ?? ''),
    ...(overrides[key] ?? {}),
  }));
}
