/**
 * Les tableaux des CLI simulées, et le décalage qu'ils avaient.
 *
 * Le constat de départ est visuel et se mesure : dans une sortie CLI,
 * l'en-tête d'un tableau était une CHAÎNE LITTÉRALE et ses lignes de
 * données une AUTRE chaîne, chacune avec ses propres `padStart`/
 * `padEnd`. Rien ne reliait les deux, donc rien n'empêchait l'écart —
 * et l'écart était là, sur cinq tableaux de quatre familles de
 * commandes, jamais du même côté :
 *
 * ```
 * show interfaces … accounting   données un caractère À GAUCHE de l'en-tête
 * show interfaces … stats        deux lignes sur quatre décalées
 * show interfaces counters       toutes les colonnes un cran À DROITE
 * show interfaces status         dernière colonne un cran à droite,
 *                                et `Duplex`/`Speed` à gauche au lieu d'à droite
 * show interfaces summary        les neuf compteurs un cran à gauche,
 *                                plus deux blancs de fin par ligne
 * display interface brief        `PHY` large de 8 au lieu de 6, donc TOUT
 *                                le reste décalé de deux
 * ```
 *
 * Ces cas tiennent deux choses distinctes, et c'est délibéré :
 *
 * 1. **`TextTable` lui-même** — la mécanique qui rend le décalage
 *    impossible plutôt que rattrapé au coup par coup.
 * 2. **La conformité à des sorties RÉELLES** — parce qu'un tableau
 *    parfaitement aligné sur de mauvaises largeurs resterait faux. Les
 *    références citées ici sont du texte capturé sur de vraies machines
 *    (jeux `cisco_ios/show_interfaces_status` et
 *    `huawei_vrp/display_interface_brief` de `ntc-templates`), et non
 *    des exemples de documentation, dont le HTML écrase les blancs —
 *    ce qui est précisément l'information qu'on cherche ici.
 */
import { describe, it, expect } from 'vitest';
import {
  renderTable, renderTableText, renderCounterTable,
  IOS_TABLE, IOS_RULED_TABLE, FIXED_TABLE,
  type TableColumn,
} from '@/network/devices/shells/cli/TextTable';
import {
  INTERFACE_STATUS_COLUMNS, INTERFACE_STATUS_STYLE, type InterfaceStatusRow,
} from '@/network/devices/shells/cisco/ciscoTableLayouts';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

// ── Outils de mesure ─────────────────────────────────────────────────
// Un « champ » est une suite de non-blancs. On relève son bord gauche
// et son bord droit, parce qu'une colonne alignée à gauche se juge sur
// le premier et une colonne alignée à droite sur le second.

function bordsGauches(l: string): number[] {
  const o: number[] = []; let i = 0;
  while (i < l.length) {
    if (l[i] !== ' ') { o.push(i); while (i < l.length && l[i] !== ' ') i++; } else i++;
  }
  return o;
}

function bordsDroits(l: string): number[] {
  const o: number[] = []; let i = 0;
  while (i < l.length) {
    if (l[i] !== ' ') { let j = i; while (j < l.length && l[j] !== ' ') j++; o.push(j - 1); i = j; } else i++;
  }
  return o;
}

/**
 * Une colonne, telle qu'un lecteur la voit : les caractères qu'elle
 * occupe, et le bord sur lequel son contenu est calé. La dernière
 * colonne va jusqu'au bout de la ligne.
 */
interface Colonne { readonly debut: number; readonly fin: number; readonly align: 'left' | 'right' }

/** La dernière colonne n'a pas de bord droit : elle finit avec la ligne. */
const JUSQU_AU_BOUT = Number.POSITIVE_INFINITY;

/**
 * Les colonnes d'un tableau, données par les caractères que leur
 * CONTENU peut occuper — les blancs de séparation en sont exclus.
 *
 * C'est le point qui a fait échouer deux formulations plus courtes
 * avant celle-ci : quand un tableau mélange les deux alignements, le
 * blanc qui sépare deux colonnes n'appartient ni à l'une ni à l'autre.
 * L'attribuer à la précédente fait apparaître un blanc de fin dans une
 * colonne alignée à droite ; à la suivante, un blanc de tête dans une
 * colonne alignée à gauche. Les deux sont faux, et la seule
 * formulation juste est de nommer les bornes en clair — ce qui a en
 * prime l'avantage d'énoncer la mise en page attendue plutôt que de la
 * recalculer.
 */
function colonnes(
  spans: ReadonlyArray<readonly [number, number | null]>,
  aligns: ReadonlyArray<'left' | 'right'>,
): Colonne[] {
  return spans.map(([debut, fin], k) => ({ debut, fin: fin ?? JUSQU_AU_BOUT, align: aligns[k] }));
}

/**
 * Le contrat que tout ce module existe pour tenir : dans un tableau
 * rendu, chaque cellule est calée sur le MÊME bord de SA colonne que
 * l'intitulé qui la surmonte — le bord gauche si la colonne est à
 * gauche, le bord droit si elle est à droite.
 *
 * La vérification découpe la ligne aux bornes de colonnes plutôt que de
 * la séparer aux blancs, pour deux raisons qui ont chacune fait échouer
 * une première version de ce fichier : une cellule peut contenir un
 * blanc (`Switching path`, `2960S Port`) et une cellule peut être VIDE
 * (une interface sans description). Compter les mots répondrait alors à
 * une autre question que celle posée.
 *
 * On ne peut pas non plus exiger « tous les bords gauches coïncident » :
 * un vrai tableau d'IOS mélange les deux alignements dans la même ligne,
 * et c'est justement ce mélange qui rendait le défaut difficile à voir.
 */
function verifierColonnes(lignes: readonly string[], cols: readonly Colonne[]): void {
  for (const l of lignes) {
    if (!l.trim()) continue;
    for (const [k, c] of cols.entries()) {
      const brut = c.fin === JUSQU_AU_BOUT ? l.slice(c.debut) : l.padEnd(c.fin).slice(c.debut, c.fin);
      if (!brut.trim()) continue;
      // Une valeur qui déborde de sa colonne pousse la suite de la ligne
      // au lieu d'être coupée : elle remplit sa tranche des deux côtés,
      // et il n'y a plus de bord à mesurer.
      if (brut === brut.trim() && c.fin !== JUSQU_AU_BOUT) continue;
      const attendu = c.align === 'left' ? brut.trimStart() : brut.trimEnd();
      expect(brut, `colonne ${k} [${c.debut}..${c.fin}) de ${JSON.stringify(l)}`).toBe(attendu);
    }
  }
}

// ── 1. La mécanique ──────────────────────────────────────────────────

interface Ligne { a: string; b: string }
const COLS: ReadonlyArray<TableColumn<Ligne>> = [
  { header: 'Gauche', width: 10, value: (r) => r.a },
  { header: 'Droite', width: 8, align: 'right', value: (r) => r.b },
];

/** `Gauche` sur 10, deux blancs, `Droite` sur 8 — le style `IOS_TABLE`. */
const COLS_BORNES = colonnes([[0, 10], [12, 20]], ['left', 'right']);

describe('TextTable — en-tête et données sortent du même calcul', () => {
  it('une colonne à gauche cale ses données sur le bord gauche de son intitulé', () => {
    const out = renderTable([{ a: 'x', b: '1' }, { a: 'plus-long', b: '22' }], COLS);
    verifierColonnes(out, COLS_BORNES);
    expect(bordsGauches(out[1])[0]).toBe(bordsGauches(out[0])[0]);
  });

  it('une colonne à droite fait finir intitulé et données au même caractère', () => {
    const out = renderTable([{ a: 'x', b: '1' }, { a: 'y', b: '123456' }], COLS);
    const [entete, ...donnees] = out;
    const fin = bordsDroits(entete)[1];
    for (const d of donnees) expect(bordsDroits(d)[1]).toBe(fin);
  });

  it('la largeur imposée est tenue, y compris quand tout le contenu est plus court', () => {
    const out = renderTable([{ a: 'x', b: '1' }], COLS, { gap: 0, rule: false });
    // `Gauche` sur 10 puis `Droite` sur 8, écart nul : 18 caractères.
    expect(out[0]).toBe('Gauche      Droite');
    expect(out[1]).toBe('x                1');
  });

  it('la largeur automatique suit le plus large entre intitulé et contenu', () => {
    const auto: ReadonlyArray<TableColumn<Ligne>> = [
      { header: 'A', value: (r) => r.a },
      { header: 'B', value: (r) => r.b },
    ];
    const out = renderTable([{ a: 'court', b: 'x' }, { a: 'beaucoup-plus-long', b: 'y' }], auto, IOS_TABLE);
    expect(bordsGauches(out[0])[1]).toBe('beaucoup-plus-long'.length + 2);
    verifierColonnes(out, colonnes([[0, 18], [20, null]], ['left', 'left']));
  });

  /**
   * Le choix qu'il faut connaître : une valeur trop longue POUSSE la
   * suite de la ligne au lieu d'être coupée. Sur une vraie machine,
   * c'est ce qui arrive ; perdre un caractère de donnée pour sauver un
   * alignement serait le mauvais échange.
   */
  it('une valeur plus longue que sa colonne n\'est jamais tronquée', () => {
    const out = renderTable([{ a: 'un-nom-vraiment-tres-long', b: '1' }], COLS, { gap: 1, rule: false });
    expect(out[1]).toContain('un-nom-vraiment-tres-long');
  });

  it('le filet de tirets épouse la largeur de chaque colonne', () => {
    const out = renderTable([{ a: 'x', b: '1' }], COLS, IOS_RULED_TABLE);
    expect(out[1]).toBe('----------  --------');
  });

  it('le retrait s\'applique à l\'en-tête comme aux données', () => {
    const out = renderTable([{ a: 'x', b: '1' }], COLS, { gap: 1, rule: false, indent: '  ' });
    for (const l of out) expect(l.startsWith('  ')).toBe(true);
  });

  it('aucune ligne ne traîne de blanc de fin', () => {
    const out = renderTable([{ a: 'x', b: '' }], COLS, IOS_TABLE);
    for (const l of out) expect(l).toBe(l.trimEnd());
  });

  it('un tableau sans ligne rend son en-tête seul', () => {
    expect(renderTable([], COLS, IOS_TABLE)).toEqual(['Gauche        Droite']);
  });

  it('renderTableText est le même, d\'un seul tenant', () => {
    const rows = [{ a: 'x', b: '1' }];
    expect(renderTableText(rows, COLS)).toBe(renderTable(rows, COLS).join('\n'));
  });
});

/** Les bornes d'IOS pour cette forme : 24, puis 11/12/12/12. */
const COMPTEURS = colonnes([[0, 24], [24, 35], [35, 47], [47, 59], [59, 71]],
  ['right', 'right', 'right', 'right', 'right']);

describe('renderCounterTable — la forme « étiquette à droite puis compteurs » d\'IOS', () => {
  it('reproduit les bords 24/35/47/59/71 de la sortie réelle', () => {
    const out = renderCounterTable('Protocol', ['Pkts In', 'Chars In', 'Pkts Out', 'Chars Out'], [
      { label: 'IP', cells: ['0', '0', '0', '0'] },
    ]);
    // Les intitulés portent un blanc (`Pkts In`) : c'est la ligne
    // entière qui se compare, pas un découpage aux blancs.
    expect(out[0]).toBe('                Protocol    Pkts In    Chars In    Pkts Out   Chars Out');
    expect(out[1]).toBe('                      IP          0           0           0           0');
    verifierColonnes(out, COMPTEURS);
  });

  it('l\'étiquette la plus longue ne décale pas les autres', () => {
    const out = renderCounterTable('Switching path', ['Pkts In', 'Chars In', 'Pkts Out', 'Chars Out'], [
      { label: 'Processor', cells: ['1', '2', '3', '4'] },
      { label: 'Distributed cache', cells: ['0', '0', '0', '0'] },
      { label: 'Total', cells: ['1', '2', '3', '4'] },
    ]);
    verifierColonnes(out, COMPTEURS);
  });
});

// ── 2. La conformité aux sorties réelles ─────────────────────────────

/**
 * Extrait du jeu de référence `ntc-templates`, capturé sur un vrai
 * Catalyst. La ligne qui compte est la deuxième : `auto`, `a-full` et
 * `a-half` finissent TOUS à la colonne 58, et `auto`/`a-100`/`a-1000`
 * tous à la 65. `Duplex` et `Speed` sont donc alignées à DROITE, ce que
 * l'en-tête seul ne peut pas trahir — `Duplex` fait exactement six
 * caractères, si bien qu'un rendu à gauche donne le MÊME en-tête et ne
 * diverge que sur les données.
 */
const REF_STATUS = [
  'Port      Name               Status       Vlan       Duplex  Speed Type',
  'Gi1/0/1                      notconnect   1            auto   auto 10/100/1000BaseTX',
  'Gi1/0/2   AccessPoint        connected    8          a-full a-1000 10/100/1000BaseTX',
  'Gi1/0/4   SingleName         connected    1          a-full  a-100 10/100/1000BaseTX',
  'Gi1/0/11  2960S Port         notconnect   16         a-half   auto 10/100BaseTX',
];

describe('show interfaces status — la mise en page d\'un vrai Catalyst', () => {
  it('les colonnes déclarées rejouent le texte de référence au caractère près', () => {
    const rows: InterfaceStatusRow[] = [
      { port: 'Gi1/0/1', name: '', status: 'notconnect', vlan: '1', duplex: 'auto', speed: 'auto', type: '10/100/1000BaseTX' },
      { port: 'Gi1/0/2', name: 'AccessPoint', status: 'connected', vlan: '8', duplex: 'a-full', speed: 'a-1000', type: '10/100/1000BaseTX' },
      { port: 'Gi1/0/4', name: 'SingleName', status: 'connected', vlan: '1', duplex: 'a-full', speed: 'a-100', type: '10/100/1000BaseTX' },
      { port: 'Gi1/0/11', name: '2960S Port', status: 'notconnect', vlan: '16', duplex: 'a-half', speed: 'auto', type: '10/100BaseTX' },
    ];
    expect(renderTable(rows, INTERFACE_STATUS_COLUMNS, INTERFACE_STATUS_STYLE))
      .toEqual(REF_STATUS.map((l) => l.trimEnd()));
  });

  it('`Duplex` et `Speed` finissent aux colonnes 58 et 65, quelle que soit la valeur', () => {
    for (const l of REF_STATUS.slice(1)) {
      const bd = bordsDroits(l);
      expect(bd[bd.length - 3], l).toBe(58);
      expect(bd[bd.length - 2], l).toBe(65);
    }
  });
});

/**
 * Même origine, côté VRP. Ici c'est la largeur de `PHY` qui se mesure et
 * ne s'invente pas : six caractères, pas huit — une colonne trop large
 * décale silencieusement les cinq suivantes.
 */
const REF_VRP_BRIEF = [
  'Interface                   PHY   Protocol  InUti OutUti   inErrors  outErrors',
  'Aux0/0/1                    down  down         0%     0%          0          0',
  'Eth-Trunk2                  up    up           0%  0.38%          0          0',
  'Eth-Trunk4                  up    down      0.69% 13.57%       4625          0',
];

describe('display interface brief — la mise en page d\'un vrai VRP', () => {
  const COLS_VRP: ReadonlyArray<TableColumn<string[]>> = [
    { header: 'Interface', width: 28, value: (r) => r[0] },
    { header: 'PHY', width: 6, value: (r) => r[1] },
    { header: 'Protocol', width: 10, value: (r) => r[2] },
    { header: 'InUti', width: 5, align: 'right', value: (r) => r[3] },
    { header: 'OutUti', width: 7, align: 'right', value: (r) => r[4] },
    { header: 'inErrors', width: 11, align: 'right', value: (r) => r[5] },
    { header: 'outErrors', width: 11, align: 'right', value: (r) => r[6] },
  ];

  it('rejoue le texte de référence au caractère près', () => {
    expect(renderTable([
      ['Aux0/0/1', 'down', 'down', '0%', '0%', '0', '0'],
      ['Eth-Trunk2', 'up', 'up', '0%', '0.38%', '0', '0'],
      ['Eth-Trunk4', 'up', 'down', '0.69%', '13.57%', '4625', '0'],
    ], COLS_VRP, FIXED_TABLE)).toEqual(REF_VRP_BRIEF);
  });
});

// ── 3. Les commandes elles-mêmes ─────────────────────────────────────
// Ce que les deux blocs précédents garantissent en théorie, vérifié sur
// les sorties que les équipements produisent vraiment.

const BORNES_STATUS = colonnes([[0, 9], [10, 28], [29, 41], [42, 52], [53, 59], [60, 66], [67, null]],
  ['left', 'left', 'left', 'left', 'right', 'right', 'left']);
const BORNES_VRP_BRIEF = colonnes([[0, 28], [28, 34], [34, 44], [44, 49], [49, 56], [56, 67], [67, 78]],
  ['left', 'left', 'left', 'right', 'right', 'right', 'right']);

describe('les sorties des équipements, mesurées', () => {
  it('routeur Cisco : `show interfaces … accounting`', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    const out = String(await r.executeCommand('show interfaces GigabitEthernet0/0 accounting'));
    // La première ligne nomme l'interface ; le tableau commence après.
    verifierColonnes(out.split('\n').slice(1), COMPTEURS);
  });

  it('routeur Cisco : `show interfaces … stats`, dont les quatre lignes s\'alignaient entre elles à deux près', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    const out = String(await r.executeCommand('show interfaces GigabitEthernet0/0 stats'));
    verifierColonnes(out.split('\n').slice(1), COMPTEURS);
  });

  it('routeur Cisco : `show interfaces summary`, filet et retrait compris', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    const lignes = String(await r.executeCommand('show interfaces summary')).split('\n');
    // L'en-tête que cette commande écrivait déjà est la référence : il
    // était juste, seules les données s'en écartaient.
    expect(lignes[0]).toBe(' Interface                IHQ   IQD  OHQ   OQD  RXBS RXPS  TXBS  TXPS  TRTL');
    expect(lignes[1]).toBe('-'.repeat(74));
    verifierColonnes([lignes[0], ...lignes.slice(2)],
      colonnes([[1, 25], [25, 29], [29, 35], [35, 40], [40, 46], [46, 52], [52, 57], [57, 63], [63, 69], [69, 75]],
        ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    for (const l of lignes) expect(l).toBe(l.trimEnd());
  });

  // Cette commande rendait UNE table mêlant les deux sens, forme
  // qu'aucun IOS ne produit : la vraie en rend DEUX, l'entrée puis la
  // sortie, chacune avec ses colonnes unicast, multicast et diffusion.
  // L'ancien en-tête n'était pas attesté, seulement cohérent avec
  // lui-même — et sa colonne `InUcastPkts` comptait TOUTES les trames,
  // diffusions comprises.
  it('commutateur Cisco : `show interfaces counters`', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await s.executeCommand('enable');
    const texte = String(await s.executeCommand('show interfaces counters'));
    const [entree, sortie] = texte.split('\n\n').map((t) => t.split('\n'));
    expect(entree[0]).toBe(
      'Port                InOctets    InUcastPkts    InMcastPkts    InBcastPkts');
    expect(sortie[0]).toBe(
      'Port               OutOctets   OutUcastPkts   OutMcastPkts   OutBcastPkts');
    const bornes = colonnes([[0, 16], [16, 28], [28, 43], [43, 58], [58, 73]],
      ['left', 'right', 'right', 'right', 'right']);
    verifierColonnes(entree, bornes);
    verifierColonnes(sortie, bornes);
  });

  it('commutateur Cisco : `show interfaces status` rend exactement l\'en-tête d\'un vrai Catalyst', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await s.executeCommand('enable');
    const lignes = String(await s.executeCommand('show interfaces status')).split('\n');
    expect(lignes[0]).toBe(REF_STATUS[0]);
    verifierColonnes(lignes, BORNES_STATUS);
  });

  /**
   * La commande n'existe PAS sur un routeur IOS. Ce fichier en portait
   * pourtant un second rendu, que rien n'appelait — deux mises en page
   * pour une commande qu'une des deux plateformes n'a pas. Il est
   * supprimé ; le refus, lui, doit rester.
   */
  it('routeur Cisco : `show interfaces status` reste refusé, la commande étant propre au commutateur', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('show interfaces status'))).toContain('% Invalid input detected');
  });

  it('routeur Huawei : `display interface brief`', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    const lignes = String(await r.executeCommand('display interface brief')).split('\n');
    // La première ligne est la légende `PHY:` ; le tableau suit.
    expect(lignes[1]).toBe(REF_VRP_BRIEF[0]);
    verifierColonnes(lignes.slice(1), BORNES_VRP_BRIEF);
    for (const l of lignes) expect(l).toBe(l.trimEnd());
  });
});
