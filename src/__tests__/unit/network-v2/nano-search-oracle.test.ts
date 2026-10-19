/**
 * La recherche et le remplacement de nano rejoues contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py
 * --corpus search, `nano -I`) : 600 sessions (4 x 150 tirees de 200, seeds 2 a 5) de trois a neuf gestes melant ^W, ^\\, ^Q, M-W, M-Q,
 * M-C / M-R / M-B, ^R, ^T, l'historique (Haut / Bas), des motifs litteraux et reguliers (valides ou non), les reponses
 * Y / N / A / ^C / Alt+lettre, la marque, M-U / M-E et des deplacements, avec 0 a 2 options parmi `-x -l -S -i -E -L -k -A
 * -% -_ -j -e -v`.  Apres chaque etape on compare les rangees du pane, la cellule du curseur et les fichiers du repertoire.
 *
 * Methode : search.c (search_init, findnextstr, go_looking, do_replace_loop, replace_line, ask_for_and_do_replacements),
 * utils.c (strstrwrapper), chars.c (mbstrcasestr, mbrevstrcasestr, revstrstr), prompt.c (acquire_an_answer, ask_user) et
 * winio.c (spotlight, edit_refresh) de nano 8.x confrontes au binaire 7.2 qui fait foi.  La regexp est une ERE POSIX
 * (regex/PosixEre.ts, rejouee a part contre la glibc dans posix-ere-oracle.test.ts) ; le moteur ne garde plus de
 * position a plat : la recherche parcourt les lignes comme findnextstr, saute un caractere au depart, fait le tour du
 * tampon une seule fois, et le remplacement suit la boucle de nano (saut apres « Non », correspondance vide, marque,
 * region, curseur de depart corrige de la variation de longueur).
 *
 * Ce que le binaire 7.2 a montre et qui n'est pas dans le source 8.x : Alt+lettre vaut la lettre aux questions Oui /
 * Non (Echap puis `a` repond « All ») ; M-B n'y est pas « Previous » mais le correcteur de syntaxe (« No linter is
 * defined for this type of file ») ; un remplacement dans une selection ne redessine pas la barre de titre quand le
 * tampon vient de devenir modifie : la lettre M des etats disparait au premier remplacement alors que la marque
 * revient ; une recherche qui trouve une correspondance surligne le caractere sous le curseur jusqu'a la touche
 * suivante (un espace en video inverse pour la correspondance vide), sauf si la marque est posee, et le surlignage
 * reste affiche pendant la saisie de l'invite suivante.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul) : 57, 63, 73 et 73 cas sur 150 tombaient avant (266
 * sur 600), 0 apres sauf le cas ci-dessous ; l'ancien moteur lancait une exception sur une regexp invalide et
 * bouclait jusqu'a saturer la memoire sur un remplacement de correspondance vide (`o*`), ce que le laboratoire
 * probe-nano-search.test.ts isole.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 1 cas sur 600.  Un cas de la liste qui se met a
 * passer fait echouer le test pour qu'on le retire.
 *   - sea3-96 : apres un remplacement, le surlignage d'une correspondance vide sur un caractere large laisse un blanc de
 *     moins dans la capture de tmux que dans le moteur (deux colonnes) ; cause non elucidee, peut-etre l'ecran virtuel de
 *     ncurses plutot que nano.
 * Non rejoues : ^R en mode lecture seule (« File to read into new buffer », plusieurs tampons), les touches tapees
 * pendant la pause de 600 ms de « Key is invalid in view mode » (le rejeu n'a pas de file d'attente).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-search';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['sea3-96']);

describe('nano search and replace recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and files on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(c.args));
      expect(ported.length).toBe(fixture.cases.length);
      const outcomes = ported.map((c) => ({ id: c.id, failure: replayNanoCliCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${ported.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
