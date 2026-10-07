/**
 * La mise en colonnes de `ss` n'est pas un `padEnd` : le code de colonnes de `misc/ss.c` mesure
 * d'abord le plus long champ de chaque colonne, puis, sur un terminal, repartit l'espace restant
 * entre les colonnes d'une ligne (le reste de la division va aux dernieres) et casse la ligne quand
 * les colonnes ne tiennent pas ; dans un tube (`ss | cat`) il garde chaque colonne a la largeur
 * mesuree. `SsTable` est ce moteur.
 *
 * Mesure de depart (origin/mandeng 75c5280d8) : `ss` n'avait pas ce moteur, ses colonnes avaient des
 * largeurs fixes, les memes sur un terminal de quarante colonnes et dans un tube. Les valeurs
 * attendues (`support/ssColumnsOracle.json`) viennent du code de colonnes de `misc/ss.c` (iproute2
 * v5.15.0, lu : tampon de jetons, `render_calc_width`, `render`) extrait tel quel dans un programme C
 * compile avec gcc et rejoue sur 108 scenarios : 96 tires au hasard, 24 pour chacune des largeurs
 * 40, 80, 132 et pour le tube, et douze construits (un champ de processus de 150 caracteres, une
 * adresse de 100 caracteres, une ligne courte suivie d'une ligne large) pour les largeurs que le
 * hasard n'atteint pas.
 *
 * Discrimination : le module n'existe pas sur origin/mandeng 75c5280d8, donc les CENT NEUF cas
 * tombent a l'import ; c'est structurel. Contre une erreur du module, six mutations de `SsTable`
 * (le reste de la division non reparti, la repartition prise dans l'autre sens, le delimiteur
 * gauche oublie dans la largeur, la colonne qui deborde conservee, l'alignement a droite traite a
 * gauche, la largeur du tube bornee a 80) font tomber de 1 a 91 cas, une septieme (la largeur de
 * colonne non bornee a l'ecran) ne termine plus, et une huitieme survit : elle est equivalente, une
 * colonne desactivee ne recoit jamais de jeton, sa largeur mesuree vaut 0 qu'on la saute ou non.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SsTable } from '@/network/devices/linux/commands/net/ss/SsTable';

interface OracleCase {
  readonly script: readonly string[];
  readonly width: number | null;
  readonly expected: string;
}

const CASES: readonly OracleCase[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../support/ssColumnsOracle.json', import.meta.url)), 'utf8'),
);

function replay(script: readonly string[], width: number | null): string {
  const table = new SsTable();
  for (const line of script) {
    if (line.startsWith('disable ')) table.disable(Number(line.slice(8)));
    else if (line === 'header') table.printHeader();
    else if (line.startsWith('set ')) table.set(Number(line.slice(4)));
    else if (line.startsWith('out ')) table.out(line.slice(4));
    else if (line === 'next') table.next();
  }
  return table.render(width);
}

describe('the bench is sound (witnesses)', () => {
  it('the oracle holds cases for the three layouts that matter, tty widths and the compact pipe', () => {
    expect(CASES.length).toBeGreaterThan(80);
    expect(new Set(CASES.map((entry) => entry.width))).toEqual(new Set([80, 132, null, 40]));
    expect(CASES.every((entry) => entry.expected.endsWith('\n'))).toBe(true);
  });
});

describe('SsTable lays columns out exactly as the column code of iproute2 5.15 does', () => {
  it.each(CASES.map((entry, index) => [index, entry.width, entry] as const))(
    'case %i at width %s',
    (_index, width, entry) => {
      expect(replay(entry.script, width)).toBe(entry.expected);
    },
  );
});
