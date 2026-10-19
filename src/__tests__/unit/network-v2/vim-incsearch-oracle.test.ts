/**
 * `incsearch` rejoue contre un vrai vim 9.1 pilote par tmux (scripts/oracle/record_vim_screen.py --corpus is et
 * isex, `vim -u DEFAULTS --noplugin -i NONE -n`, defaults.vim allume `incsearch`) : chaque touche est envoyee seule,
 * 0,12 s avant la suivante, pour que vim redessine entre deux frappes comme devant un humain (tapees d'un bloc,
 * vim reporte la recherche incrementale tant qu'un caractere attend).  Apres chaque etape on compare les lignes de
 * la fenetre, la cellule du curseur (sur la ligne de commande pendant la saisie) et les cellules en video inverse
 * (groupe IncSearch, SGR 7) et en fond Search (SGR 103).
 *   - `is` : `/` et `?` avec ou sans compte, motifs saisis par morceaux, retour arriere, CTRL-G / CTRL-T / CTRL-L /
 *     CTRL-W / CTRL-U, Entree et Echap, buffers de 20 a 150 lignes dans des fenetres de 6 a 24 lignes, `so`, `nu`,
 *     `nowrap`, `sidescroll=0`, `ic`, `nows`, `list`, `hls`, `nois` ;
 *   - `isex` : `:s`, `:%s`, `:2,5s`, `:.,+3s`, `:$s`, `:s#..#`, `:g`, `:g!` et `:v`, la recherche etant limitee a la plage.
 *
 * Methode : may_do_incsearch_highlighting, may_adjust_incsearch_highlighting, may_add_char_to_search et
 * finish_incsearch_highlighting de ex_getln.c (vim 9.1.0016, lus dans l'archive source, avec le binaire trace pour la
 * validite de la topline).  La vue est enregistree a l'ouverture de la ligne de commande ; a chaque frappe elle est
 * restauree, le curseur va a l'occurrence (update_topline, puis la fin du match pour `nowrap`, puis le debut) ; la
 * topline n'est recalculee que si la ligne du curseur a change depuis la derniere validation, comme w_valid_cursor ;
 * a la fin la vue est restauree et le curseur revient au point de depart (ou a celui que CTRL-G / CTRL-T a retenu).
 * Un motif vide masque le surlignage precedent, un motif qui ne contraint rien (`\|` final) masque `hlsearch`, un
 * CTRL-G/T/L sans `incsearch` s'insere comme ^G dans la ligne de commande, une tabulation sous le curseur se dessine
 * a son premier octet apres une saisie incrementale tant que le curseur ne bouge pas.
 *
 * Mesure avec `git stash push -- src/network src/components` : le moteur precedent ne fait rien pendant la frappe,
 * les 3 fichiers tombent avant ; apres, il reste 12 + 7 cas du corpus `is` et 2 du corpus `isex`, listes ci-dessous (ise2-109, ise2-178 et is3-71 passent depuis le traducteur de motifs).
 * Les seeds 2 et 3 (`is`) et 2 (`isex`) ont ete enregistres apres tout ajustement, sans que les echecs de seed 3 et de
 * isex 2 aient guide un reglage : 7 divergences sur 300 et 2 sur 200.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES), aucune n'est epinglee comme contrat : un cas de la
 * liste qui se met a passer fait echouer le test pour qu'on le retire.  Les causes identifiees (une partie des cas
 * n'a pas encore de cause attribuee) :
 *   - un motif qui peut etre vide (`x*`, `b\|`) avec un compte ou CTRL-G : vim enumere les occurrences vides une a
 *     une depuis la position, ce moteur compte celles de l'enumeration JavaScript ;
 *   - CTRL-L alors que le prochain caractere est la fin de ligne (is2-274) : vim avance quand meme le curseur de la
 *     ligne de commande d'une cellule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'is2-46', 'is2-75', 'is2-80', 'is2-93', 'is2-95', 'is2-164', 'is2-202', 'is2-227', 'is2-254', 'is2-260', 'is2-274', 'is2-284',
  'is3-47', 'is3-169', 'is3-214', 'is3-226', 'is3-228', 'is3-256', 'is3-299',
  'ise2-91', 'ise2-188',
]);

const dir = 'src/__tests__/support/oracle/vim-incsearch';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('vim-9.1')).sort().map((f) => ({ name: f, ...JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { vim: string; cases: ScreenCase[] } }));

describe('vim incsearch transcripts recorded from a real vim', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell, IncSearch and Search cells`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayScreenCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
