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
