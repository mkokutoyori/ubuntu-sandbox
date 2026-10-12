/**
 * `showmatch` rejoue contre un vrai vim 9.1 pilote par tmux (scripts/oracle/record_vim_screen.py --corpus sm,
 * `vim -u DEFAULTS --noplugin -i NONE -n`) : chaque touche est envoyee seule, 0,12 s avant la suivante.  Apres
 * chaque etape on compare les lignes de la fenetre, la cellule du curseur, la regle (position de la parenthese
 * ouvrante pendant le saut) et les cellules Search / IncSearch.  Une etape suivie de `@wait` attend la fin de
 * `matchtime` : elle compare l'ecran apres le saut, les autres l'ecran pendant le saut.
 *   - tampons de 4 a 20 lignes (parentheses, crochets, accolades, chevrons, chaines, macros) dans des fenetres de
 *     5 a 24 lignes sur 30 a 80 colonnes ;
 *   - sessions d'Insertion (A, o, O, i, I, a, cc, S) qui tapent des morceaux contenant des fermantes, puis `r)` ;
 *   - reglages : `sm`, `sm` sans effet quand `nosm`, `mat=0`, `mps+=<:>`, `mps=`, `mps=(:)`, `nowrap` avec
 *     `ss=1`, `nu`, `list`, `ts=4`, `so=0`.
 *
 * Methode : showmatch() de search.c et ins_char_bytes() de change.c (vim 9.1.0016, lus dans l'archive source) : apres
 * l'insertion d'une fermante de `matchpairs`, findmatch() part du curseur, la parenthese ouvrante n'est montree que
 * si sa ligne est dans la fenetre (et sa colonne visible sans `wrap`), le curseur y va avec `scrolloff` et
 * `sidescrolloff` a zero, la regle suit, puis le curseur revient apres `matchtime` dixiemes de seconde.  Le moteur
 * rend ce saut par `EditorScreen.hold` : l'ecran du saut, puis l'ecran apaise que le terminal installe a l'echeance.
 *
 * Mesure avec `git stash push -- src/network src/components` : le moteur precedent lisait l'option sans l'evaluer,
 * les 3 fichiers tombent avant (seed 1 : 130 cas sur 273, seed 2 : 150 sur 300, seed 3 : 144 sur 300), 0 apres.
 * Le seed 1 a guide les reglages ; les seeds 2 et 3 ont ete enregistres ensuite.  Le seed 2 a donne un echec, un
 * artefact d'enregistrement (la machine chargee a retarde la capture au-dela de `matchtime`) : le cas a ete
 * re-enregistre seul et passe.  Les 27 cas du seed 1 qui posaient `mat=2` ont ete retires : 0,2 s est plus court que
 * la latence de la capture, le resultat depend de la charge de la machine et non de vim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

const dir = 'src/__tests__/support/oracle/vim-showmatch';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('vim-9.1')).sort().map((f) => ({ name: f, ...JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { vim: string; cases: ScreenCase[] } }));

describe('vim showmatch transcripts recorded from a real vim', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and highlighted cells`, () => {
      const failures = fixture.cases.map((c) => replayScreenCase(c)).filter((f): f is string => f !== null);
      expect(failures.length > 0 ? `${failures.length} of ${fixture.cases.length}\n${failures.slice(0, 3).join('\n')}` : '').toBe('');
    });
  }
});
