/**
 * PRD-CLI-Fidelite-VRP.md §17 / lot V8 — la grammaire de `stp`.
 *
 * Le premier mot etait valide, et RIEN au-dela : `stp mode rstp extra`,
 * `stp priority 4096 extra`, `stp root primary extra`,
 * `stp edged-port default extra` prenaient tous en silence, et en vue
 * d'interface `stp cost abc`, `stp edged-port zzz`,
 * `stp port priority abc` etaient acceptes sans rien poser — la ligne
 * etant tout de meme conservee pour `display this`, donc rejouee a
 * l'import.
 *
 * Deuxieme defaut, moins visible : le curseur d'un refus se posait
 * toujours sur le PREMIER argument, c'est-a-dire sur le mot-cle que
 * l'operateur avait juste. `stp mode zzz` designait `mode`.
 *
 * La grammaire est une table, pas une suite de `if` : c'est ce qui rend
 * verifiable qu'aucune forme n'est oubliee, et c'est la meme forme que
 * le catalogue de `debugging` (lot V6).
 */

import type { ErreurGrammaireVrp } from '../cli-utils';
import type { ParamSpec } from '../CommandTrie';

/** Ce qu'un mot-cle attend derriere lui. */
type Attendu =
  | { forme: 'rien' }
  | { forme: 'enum'; valeurs: readonly string[] }
  | { forme: 'entier'; min: number; max: number; multiple?: number }
  | { forme: 'sequence'; parties: readonly Attendu[]; mots: readonly (string | null)[] }
  | { forme: 'alternative'; options: readonly Attendu[] };

interface RegleStp {
  mot: string;
  attendu: Attendu;
}

const RIEN: Attendu = { forme: 'rien' };
const ACTIVATION: Attendu = { forme: 'enum', valeurs: ['enable', 'disable'] };

/** VRP exprime ses temporisateurs STP en CENTIEMES de seconde. */
const TIMERS: Readonly<Record<string, readonly [number, number]>> = {
  hello: [100, 1000],
  'forward-delay': [400, 3000],
  'max-age': [600, 4000],
};

export const STP_SYSTEME: readonly RegleStp[] = [
  { mot: 'enable', attendu: RIEN },
  { mot: 'disable', attendu: RIEN },
  { mot: 'mode', attendu: { forme: 'enum', valeurs: ['stp', 'rstp', 'mstp'] } },
  { mot: 'priority', attendu: { forme: 'entier', min: 0, max: 61440, multiple: 4096 } },
  { mot: 'root', attendu: { forme: 'enum', valeurs: ['primary', 'secondary'] } },
  {
    mot: 'instance',
    attendu: {
      forme: 'alternative',
      options: [
        {
          forme: 'sequence',
          mots: [null, 'priority', null],
          parties: [
            { forme: 'entier', min: 0, max: 4094 },
            RIEN,
            { forme: 'entier', min: 0, max: 61440, multiple: 4096 },
          ],
        },
        {
          forme: 'sequence',
          mots: [null, 'root', null],
          parties: [
            { forme: 'entier', min: 0, max: 4094 },
            RIEN,
            { forme: 'enum', valeurs: ['primary', 'secondary'] },
          ],
        },
      ],
    },
  },
  { mot: 'bpdu-protection', attendu: RIEN },
  { mot: 'edged-port', attendu: { forme: 'enum', valeurs: ['default'] } },
  {
    mot: 'pathcost-standard',
    attendu: { forme: 'enum', valeurs: ['dot1d-1998', 'dot1t', 'legacy'] },
  },
  { mot: 'tc-protection', attendu: RIEN },
  { mot: 'converge', attendu: { forme: 'enum', valeurs: ['fast', 'normal'] } },
  {
    mot: 'timer',
    attendu: {
      forme: 'sequence',
      mots: [null, null],
      parties: [
        { forme: 'enum', valeurs: Object.keys(TIMERS) },
        { forme: 'entier', min: 100, max: 4000 },
      ],
    },
  },
  { mot: 'region-configuration', attendu: RIEN },
];

export const STP_INTERFACE: readonly RegleStp[] = [
  { mot: 'enable', attendu: RIEN },
  { mot: 'disable', attendu: RIEN },
  { mot: 'edged-port', attendu: ACTIVATION },
  { mot: 'bpdu-protection', attendu: ACTIVATION },
  { mot: 'bpdu-filter', attendu: ACTIVATION },
  { mot: 'cost', attendu: { forme: 'entier', min: 1, max: 200000000 } },
  {
    mot: 'instance',
    attendu: {
      forme: 'sequence',
      mots: [null, 'cost', null],
      parties: [
        { forme: 'entier', min: 0, max: 4094 },
        RIEN,
        { forme: 'entier', min: 1, max: 200000000 },
      ],
    },
  },
  {
    mot: 'port',
    attendu: {
      forme: 'sequence',
      mots: ['priority', null],
      parties: [RIEN, { forme: 'entier', min: 0, max: 240, multiple: 16 }],
    },
  },
  { mot: 'root-protection', attendu: RIEN },
  { mot: 'loop-protection', attendu: RIEN },
  { mot: 'tc-restriction', attendu: RIEN },
];

/**
 * L'aide de `stp` est DERIVEE de cette table, comme l'analyse.
 *
 * Le defaut mesure : `stp converge ?` rendait `WORD  Spanning Tree
 * Protocol configuration` et un `<cr>`, alors que la table dit depuis
 * toujours que ce mot attend `fast` ou `normal` et que la commande nue
 * repond « Incomplete command ». La grammaire et l'aide etaient deux
 * enonces separes sur la meme syntaxe, donc capables de se contredire.
 *
 * `stp` est glouton : l'arite seule ne peut pas le decrire, puisque
 * `stp enable` se valide avec un argument et `stp converge` non. C'est
 * le CONTENU de l'argument qui tranche, et la table le sait.
 */
export function declarerAideStp(
  trie: {
    describeArgs(path: string, specs: readonly ParamSpec[]): void;
    requireArgs(path: string, n: number): void;
    executableWhen(path: string, pred: (args: readonly string[]) => boolean): void;
    describeNode?(path: string, description: string): void;
  },
  regles: readonly RegleStp[],
  chemin: string,
  descriptions: ReadonlyArray<{ keyword: string; description: string }> = [],
): void {
  // La table de grammaire ne porte pas de description : elle sert
  // l'ANALYSE. Declarer un argument cree pourtant le noeud, et un noeud
  // sans description propre se rabat sur la table generale des
  // mots-cles — d'ou `mode  Set trunking mode of the interface` sous
  // `stp ?`, la description d'une AUTRE commande. Les descriptions
  // curatees sont donc passees ici, et c'est la meme liste que l'ENUM
  // deja rendu, si bien que les deux ne peuvent pas diverger.
  const decrit = new Map(descriptions.map((d) => [d.keyword.toLowerCase(), d.description]));
  const specDe = (a: Attendu): ParamSpec | null => {
    if (a.forme === 'enum') {
      return {
        name: 'valeur', type: 'ENUM', description: 'Value',
        values: a.valeurs.map((v) => ({ keyword: v, description: descriptionValeurStp(v) })),
      };
    }
    if (a.forme === 'entier') {
      return { name: 'valeur', type: 'INT', description: 'Value', range: [a.min, a.max] };
    }
    return null;
  };
  /** Les mots qui se valident SEULS, donc les seuls a porter `<cr>`. */
  const seuls = new Set<string>();
  for (const r of regles) {
    const p = `${chemin} ${r.mot}`;
    const propre = decrit.get(r.mot.toLowerCase());
    // `describeNode` sort en SILENCE sur un noeud absent : l'appel doit
    // donc SUIVRE la declaration qui cree le noeud, jamais la preceder.
    const nommer = () => { if (propre) trie.describeNode?.(p, propre); };
    if (r.attendu.forme === 'rien') { seuls.add(r.mot.toLowerCase()); continue; }
    if (r.attendu.forme === 'sequence') {
      const specs = r.attendu.parties
        .map((partie) => specDe(partie))
        .filter((x): x is ParamSpec => x !== null);
      if (specs.length > 0) trie.describeArgs(p, specs);
      trie.requireArgs(p, specs.length);
      nommer();
      continue;
    }
    const spec = specDe(r.attendu);
    if (spec) { trie.describeArgs(p, [spec]); trie.requireArgs(p, 1); nommer(); }
  }
  trie.executableWhen(chemin,
    (args) => args.length !== 1 || seuls.has(args[0].toLowerCase()));
}

/**
 * Ce que vaut une valeur de la grammaire, en un mot.
 *
 * La table n'en portait aucune : elle sert l'analyse, qui n'a pas
 * besoin de decrire. L'aide, elle, en a besoin — un mot offert sans
 * description est le troisieme garde-fou de la campagne.
 */
function descriptionValeurStp(v: string): string {
  const table: Readonly<Record<string, string>> = {
    stp: 'Spanning Tree Protocol (802.1D)',
    rstp: 'Rapid Spanning Tree Protocol (802.1w)',
    mstp: 'Multiple Spanning Tree Protocol (802.1s)',
    primary: 'Set the device as the primary root bridge',
    secondary: 'Set the device as the secondary root bridge',
    default: 'Restore the default value',
    'dot1d-1998': 'IEEE 802.1D-1998 path cost standard',
    dot1t: 'IEEE 802.1t path cost standard',
    legacy: 'Huawei legacy path cost standard',
    fast: 'Fast convergence mode',
    normal: 'Normal convergence mode',
    enable: 'Enable the function',
    disable: 'Disable the function',
    hello: 'Hello timer',
    'forward-delay': 'Forward delay timer',
    'max-age': 'Maximum age timer',
  };
  return table[v.toLowerCase()] ?? '';
}

export type StpAnalyse =
  | { statut: 'ok'; mot: string; args: readonly string[] }
  | { statut: 'refus'; err: ErreurGrammaireVrp };

/** Les bornes du temporisateur nomme, plus etroites que la regle generale. */
export function borneTimerStp(nom: string): readonly [number, number] | null {
  return TIMERS[nom.toLowerCase()] ?? null;
}

function verifier(
  attendu: Attendu, mots: readonly string[], depuis: number,
): { consomme: number } | { err: ErreurGrammaireVrp } {
  switch (attendu.forme) {
    case 'rien':
      return { consomme: 0 };
    case 'enum': {
      const v = mots[depuis];
      if (v === undefined) return { err: { kind: 'incomplete' } };
      if (!attendu.valeurs.includes(v.toLowerCase())) {
        return { err: { kind: 'wrong', token: v } };
      }
      return { consomme: 1 };
    }
    case 'entier': {
      const v = mots[depuis];
      if (v === undefined) return { err: { kind: 'incomplete' } };
      if (!/^\d+$/.test(v)) return { err: { kind: 'wrong', token: v } };
      const n = parseInt(v, 10);
      if (n < attendu.min || n > attendu.max) return { err: { kind: 'wrong', token: v } };
      if (attendu.multiple && n % attendu.multiple !== 0) {
        return { err: { kind: 'wrong', token: v } };
      }
      return { consomme: 1 };
    }
    case 'sequence': {
      let curseur = depuis;
      for (const [i, partie] of attendu.parties.entries()) {
        const litteral = attendu.mots[i];
        if (litteral !== null && litteral !== undefined) {
          const v = mots[curseur];
          if (v === undefined) return { err: { kind: 'incomplete' } };
          if (v.toLowerCase() !== litteral) return { err: { kind: 'wrong', token: v } };
          curseur += 1;
          continue;
        }
        const r = verifier(partie, mots, curseur);
        if ('err' in r) return r;
        curseur += r.consomme;
      }
      return { consomme: curseur - depuis };
    }
    case 'alternative': {
      let dernier: ErreurGrammaireVrp = { kind: 'incomplete' };
      let profondeur = -1;
      for (const option of attendu.options) {
        const r = verifier(option, mots, depuis);
        if (!('err' in r)) return r;
        const atteint = motsConsommables(option, mots, depuis);
        if (atteint > profondeur) { profondeur = atteint; dernier = r.err; }
      }
      return { err: dernier };
    }
  }
}

function motsConsommables(
  attendu: Attendu, mots: readonly string[], depuis: number,
): number {
  if (attendu.forme !== 'sequence') return 0;
  let curseur = depuis;
  for (const [i, partie] of attendu.parties.entries()) {
    const litteral = attendu.mots[i];
    if (litteral !== null && litteral !== undefined) {
      if (mots[curseur]?.toLowerCase() !== litteral) return curseur - depuis;
      curseur += 1;
      continue;
    }
    const r = verifier(partie, mots, curseur);
    if ('err' in r) return curseur - depuis;
    curseur += r.consomme;
  }
  return curseur - depuis;
}

/**
 * Analyse `stp <mot> …` contre la table de la vue. Le mot-cle inconnu et
 * le mot en trop sont deux fautes distinctes, et chacune designe SON
 * jeton.
 */
export function analyserStp(
  args: readonly string[], table: readonly RegleStp[],
): StpAnalyse {
  const mots = args.filter((a) => a.length > 0);
  if (mots.length === 0) return { statut: 'refus', err: { kind: 'incomplete' } };

  const regle = table.find((r) => r.mot === mots[0].toLowerCase());
  if (!regle) return { statut: 'refus', err: { kind: 'unrecognized', token: mots[0] } };

  const r = verifier(regle.attendu, mots, 1);
  if ('err' in r) return { statut: 'refus', err: r.err };

  const attendus = 1 + r.consomme;
  if (mots.length > attendus) {
    return { statut: 'refus', err: { kind: 'too-many', token: mots[attendus] } };
  }
  return { statut: 'ok', mot: regle.mot, args: mots.slice(1) };
}
