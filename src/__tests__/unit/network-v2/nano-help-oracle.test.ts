/**
 * L'aide ^G de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus help, `nano -I`) :
 * 600 sessions (4 x 150, seeds 1 a 4) qui ouvrent l'aide depuis l'edition ou depuis une invite (Where Is, Replace,
 * Replace With, Go To Line, Write Out, Insert File, Execute), dans des fenetres de 5 x 60 a 40 x 74, avec 0 a 2 options
 * parmi `-x -0 -e -_ -% -l -S -c -i -R -p -t -v`, puis de zero a dix touches de la visionneuse (fleches, pages, M-\ M-/,
 * Espace, b, - +, ^N ^P ^Y ^V ^L, q x e ^X), la recherche (^W, M-W, M-Q, Entree vide, expression invalide, Haut),
 * des touches que l'aide ne connait pas et les touches d'edition d'une invite (^B ^F ^A ^E ^D ^H).  Apres chaque etape
 * on compare les rangees du pane, la cellule du curseur et les fichiers du repertoire.
 *
 * Methode : help.c (help_init, wrap_help_text_into_buffer, show_help), nano.c (do_exit, break_line avec inhelp), search.c
 * (do_research dans l'aide), prompt.c (do_statusbar_input) et winio.c (titlebar centree, tiny footer) de nano 8.x
 * confrontes au binaire 7.2 qui fait foi.  Le texte de l'aide est assemble comme help_init : introduction coupee a
 * clamp(COLS, 40, 74), puis une entree par fonction du menu courant avec la colonne des touches de 7 cellules et celle de
 * la touche alternative de 10, la suite des phrases indentee a COLS - 18 ; la visionneuse est un second NanoEngine
 * (NanoWindow, defilement, recherche, historiques partages) dont les touches suivent interpret() de help.c.
 *
 * Ce que le binaire 7.2 a montre et qui n'est pas dans le source 8.x : M-F, M-B, ^F, ^B, F1 et F2 n'existent pas dans
 * la visionneuse de la 7.2 ; sous -p, ^Q et ^S n'y font rien du tout (pas de « Unbound key ») et la barre de l'aide garde
 * la place de ^L et de ^Q ; dans une fenetre de moins de 6 rangees il n'y a pas de barre et la rangee du bas garde ce
 * qu'elle portait avant l'aide jusqu'au premier message ; le curseur de l'aide reste en colonne 0 sur la derniere
 * ligne ; sous -p la barre principale perd « Where Was » sans laisser de trou ; ^B ^F ^A ^E ^D ^H editent la reponse d'une
 * invite comme les fleches, Debut, Fin, Suppr et Retour arriere.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul, l'aide etait un texte fixe de 25 lignes) :
 * 121, 134, 139 et 133 sessions sur 150 tombaient avant (527 sur 600), 0 apres.  Passent dans les deux cas 73 sessions
 * sans aucune etape, qui ne font qu'ouvrir nano : elles servent de temoin que le laboratoire lui-meme est sain.
 *
 * Non rejoues : les touches F1 a F12 et les sequences M-Left, M-Right, C-Up, C-Down, M-Home, M-End, M-PageUp, M-PageDown,
 * M-Space (tmux les transmet sous une forme que ncurses coupe en touches isolees : « Unbound key: 1 »), la
 * redimension de la fenetre pendant l'aide, et ^R en mode lecture seule (« File to read into new buffer », plusieurs
 * tampons).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-help';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

describe('nano help recorded from a real nano', () => {
  it('loads the recorded sessions', () => {
    expect(fixtures.map((fixture) => fixture.cases.length)).toEqual([150, 150, 150, 150]);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and files on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(c.args));
      expect(ported.length).toBe(fixture.cases.length);
      const failures = ported.map((c) => replayNanoCliCase(c)).filter((failure) => failure !== null);
      expect(failures.length > 0 ? `${failures.length} of ${ported.length}\n${failures.slice(0, 3).join('\n')}` : '').toBe('');
    });
  }
});
