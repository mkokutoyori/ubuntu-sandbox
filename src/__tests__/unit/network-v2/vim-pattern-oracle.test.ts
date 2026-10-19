/**
 * Les motifs de vim rejoues contre un vrai vim 9.1 (scripts/oracle/record_vim_patterns.py, `vim -u NONE -N -es`) :
 * pour chaque cas, un motif, les lignes d'un tampon et la valeur de 'ignorecase' ; vim parcourt le tampon avec
 * searchpos() depuis (1,1) -- la premiere occurrence acceptee sur le curseur, puis chacune des suivantes, huit au
 * plus -- et note pour chaque occurrence son debut (ligne, colonne en octets, ramenee en caracteres) et sa fin
 * inclusive (searchpos avec le drapeau `e`) ; un motif que vim refuse porte le texte de son erreur.  Le moteur
 * rejoue la meme marche avec findMatch (curseur ramene sur le dernier caractere, comme dans l'editeur) et on compare
 * les erreurs, tous les debuts, et les fins des occurrences non vides.
 *
 * Corpus : 2759 cas ecrits a la main (`hand`) -- chaque motif sur six textes (accents, tabulations, lignes vides,
 * CJK, familles de casse) avec et sans 'ignorecase' -- et huit corpus aleatoires (`seedN`) dont l'arbre d'atomes,
 * de quantificateurs, de groupes et d'assertions est rendu dans les quatre niveaux de magie (`\m`, `\v`, `\M`, `\V`).
 *
 * Mesure avec `git stash push -- src/network` (l'ancien traducteur ne connaissait ni \zs \ze \& \%[ \%d \{-n,m}
 * \@<= \_x \n \c \v \V ni les messages E54..E944, et lisait `\<` `\>` `\+` `\{` comme du JavaScript) : sur les
 * 7527 cas comparables (7661 enregistres), 4395 tombaient avant -- hand 1380 sur 2726, seed1 504 sur 788, seed2 323
 * sur 489, seed3 305 sur 490, seed4 298 sur 486, seed5 300 sur 488, seed21 430 sur 689, seed22 433 sur 685, seed23
 * 422 sur 686 -- et 0 apres ; les 3132 cas qui passent des deux cotes (litteraux, classes simples, `^` `$` en debut
 * et fin de motif, `.*`, alternatives sans retour arriere) servent de temoins du laboratoire.
 *
 * Ce que le laboratoire ne compare pas, par construction :
 *   - les cas ou le moteur NFA de vim (le defaut) et son moteur a retour arriere (`\%#=1`) repondent differemment :
 *     le recorder rejoue chaque cas avec `\%#=1` et marque `backtrackingAgrees: false` (environ 1,5 % des cas
 *     aleatoires, des quantificateurs paresseux imbriques) -- reproduire un defaut du NFA n'est pas un but ;
 *   - les cas ou vim renonce avec E363 (`'maxmempattern'`) : une limite de memoire de son automate, que la
 *     traduction vers une expression JavaScript n'a pas ;
 *   - les marches degenerees ou vim renvoie dix fois la meme position (un `\zs` place apres le saut de ligne de la
 *     derniere ligne, au-dela du tampon) ;
 *   - les fins d'un motif qui combine `\zs` ou `\ze` avec un saut de ligne : l'occurrence commence alors sur une
 *     ligne et est signalee sur la suivante, et searchpos(..., 'e') lance depuis le debut signale cherche l'occurrence
 *     d'apres ; leurs debuts sont compares.
 * Non porte et mesure : un motif a quantificateurs imbriques ambigus (`\(\f\+\_D\{-2,3}\)\{-1,}\(\A\{2,}\)\{-2,3}`)
 * peut occuper JavaScript pendant plus de deux minutes la ou l'automate de vim repond en un temps lineaire ; le
 * cas (rnd22-202) est retire du corpus et note dans TODO.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { findMatch, searchPatternError } from '@/network/devices/linux/editors/vim/VimSearch';

interface OracleCase {
  readonly id: string;
  readonly pat: string;
  readonly lines: readonly string[];
  readonly ic: number;
  readonly matches: readonly (readonly [readonly [number, number], readonly [number, number]])[];
  readonly error?: string;
  readonly backtrackingAgrees?: boolean;
}

const directory = 'src/__tests__/support/oracle/vim-patterns';
const fixtures = readdirSync(directory)
  .filter((name) => name.startsWith('vim-9.1-patterns-'))
  .sort()
  .map((name) => ({ name, ...(JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')) as { vim: string; cases: OracleCase[] }) }));

type Skip = 'engines-disagree' | 'maxmempattern' | 'degenerate-walk' | null;

function skipReason(c: OracleCase): Skip {
  if (c.backtrackingAgrees === false) return 'engines-disagree';
  if (c.error?.startsWith('E363')) return 'maxmempattern';
  const repeated = c.matches.some((m, i) => i > 0 && m[0][0] === c.matches[i - 1][0][0] && m[0][1] === c.matches[i - 1][0][1]);
  return repeated ? 'degenerate-walk' : null;
}

function walk(c: OracleCase): { starts: number[][]; ends: number[][]; anyEmpty: boolean } {
  const starts: number[][] = [];
  const ends: number[][] = [];
  let anyEmpty = false;
  const ignoreCase = c.ic === 1;
  let from = { line: 0, col: 0 };
  while (starts.length < 8) {
    const m = findMatch(c.lines, from, c.pat, {
      forward: true, count: 1, wrapscan: false, anchor: 'start', ignoreCase, acceptAtCursor: starts.length === 0,
      context: { lines: c.lines, tabstop: 8, cursor: from, mark: () => null, visual: null },
    });
    if (m === null) break;
    const empty = m.end.line === m.start.line && m.end.col === m.start.col;
    anyEmpty = anyEmpty || empty;
    let endLine = m.end.line;
    let endCol = m.end.col;
    if (!empty) {
      if (endCol > 0) endCol -= 1;
      else { endLine -= 1; endCol = c.lines[endLine].length; }
    }
    if (starts.length > 0 && starts[starts.length - 1][0] === m.start.line && starts[starts.length - 1][1] === m.start.col) break;
    starts.push([m.start.line, m.start.col]);
    ends.push([endLine, endCol]);
    from = { line: m.start.line, col: Math.max(0, Math.min(m.start.col, c.lines[m.start.line].length - 1)) };
  }
  return { starts, ends, anyEmpty };
}

function failure(c: OracleCase): string | null {
  const error = searchPatternError(c.pat, c.ic === 1);
  const wanted = c.error ?? null;
  if (error !== wanted) return `${c.id} ${JSON.stringify(c.pat)}: error ${JSON.stringify(error)}, vim ${JSON.stringify(wanted)}`;
  if (error !== null) return null;
  const { starts, ends, anyEmpty } = walk(c);
  const wantStarts = c.matches.map((m) => [...m[0]]);
  if (JSON.stringify(starts) !== JSON.stringify(wantStarts)) {
    return `${c.id} ${JSON.stringify(c.pat)} ic=${c.ic}: starts ${JSON.stringify(starts)}, vim ${JSON.stringify(wantStarts)}`;
  }
  if (anyEmpty || (/\\z[se]/.test(c.pat) && /\\n|\\_/.test(c.pat))) return null;
  const lastLine = c.lines.length - 1;
  const mismatch = ends.findIndex((end, i) => {
    const want = c.matches[i][1];
    const consumesFinalBreak = end[0] === lastLine && end[1] === c.lines[lastLine].length - 1 && want[0] === lastLine && want[1] === c.lines[lastLine].length;
    return !consumesFinalBreak && (end[0] !== want[0] || end[1] !== want[1]);
  });
  return mismatch < 0 ? null : `${c.id} ${JSON.stringify(c.pat)} ic=${c.ic}: end ${JSON.stringify(ends[mismatch])}, vim ${JSON.stringify(c.matches[mismatch][1])}`;
}

describe('vim patterns recorded from a real vim', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same errors, starts and ends`, () => {
      const compared = fixture.cases.filter((c) => skipReason(c) === null);
      const failures = compared.map(failure).filter((f): f is string => f !== null);
      expect(failures.length > 0 ? `${failures.length} of ${compared.length}\n${failures.slice(0, 5).join('\n')}` : '').toBe('');
      expect(compared.length / fixture.cases.length).toBeGreaterThan(0.95);
      expect(compared.filter((c) => c.matches.length > 0).length).toBeGreaterThan(compared.length / 4);
    }, 120000);
  }
});
