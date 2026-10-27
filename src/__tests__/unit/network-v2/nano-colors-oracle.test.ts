/**
 * Les couleurs d'interface de nano (`titlecolor`, `numbercolor`, `stripecolor`, `scrollercolor`, `selectedcolor`,
 * `spotlightcolor`, `minicolor`, `promptcolor`, `statuscolor`, `errorcolor`, `keycolor`, `functioncolor`) rejouees
 * contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus colors, tmux 3.4, TERM=xterm-256color,
 * SANS -I, `~/.nanorc` et `/etc/nanorc` semes comme dans nano-rc-oracle.test.ts).  Le recorder lit `capture-pane -e`
 * et note, pour CHAQUE cellule, la couleur de premier plan et de fond (indice 0-255 de la palette, `-` pour la couleur
 * par defaut) et les attributs gras, italique, souligne, inverse ; une legende par cas donne la lettre de chaque
 * combinaison.  Chaque cas tire au hasard de 1 a 6 lignes `set ...color` (noms de couleurs, prefixes light / bright,
 * triplets #rgb, attributs bold, / italic, spécifications invalides), parfois NO_COLOR, 0 a 3 options parmi
 * -l -S -q -c -x -0 -_ -D -% -v -E -A et -J, puis des gestes qui font apparaitre chaque element : selection, recherche
 * (projecteur), invites, question oui / non, messages d'etat et d'erreur, aide.  Apres chaque etape on compare les
 * rangees, la cellule du curseur et la couleur de chaque cellule.
 *
 * Methode : color.c (set_interface_colorpairs), rcfile.c (parse_combination, color_to_short) et winio.c (draw_row,
 * titlebar, minibar, statusline, post_one_key) du tarball nano_7.2.orig pour comprendre, le binaire 7.2-2ubuntu0.2 pour
 * trancher.  Le seed 1 a guide les reglages ; les seeds 2 et 3 ont ete enregistres ensuite.  Les regles mesurees sont
 * dans probe-nano-colors.test.ts (58 laboratoires).
 *
 * Comparaison des cellules blanches : ncurses n'emet ni la couleur de premier plan ni le gras ni l'italique pour une
 * espace (sauf en video inverse, ou le premier plan devient le fond) ; la comparaison les ecarte des DEUX cotes.
 *
 * Mesure : un moteur qui lit les couleurs sans les evaluer laissait tomber 141 cas sur 200 (seed 1), 136 (seed 2) et
 * 131 (seed 3) ; 0 apres, hors cas non portes.  Le premier jet a aussi montre trois divergences qui n'avaient rien de
 * colore, corrigees dans le meme changement : une touche refusee en mode vue (« Key is invalid in view mode ») laissait
 * le moteur recalculer la colonne voulue alors que nano n'execute alors aucune fonction (le PageDown suivant atterrissait
 * au mauvais endroit), une touche Ctrl-6 inconnue de l'aide s'appelle « ^^ » et non « ^6 », et la sortie de l'invite
 * `^_` par `^W` / `^O` avec `-0` laisse la derniere rangee vide.
 *
 * Cas non portes, 19 sur 600, tous mesures (un cas de la liste qui se met a passer fait echouer le test) :
 *   - `^R` en mode vue (12 cas : col1-67, col1-117, col1-138, col1-151, col1-153, col1-169, col2-6, col2-48, col2-58,
 *     col3-137, col3-170, col3-190) : nano ouvre l'invite « File to read into new buffer » ; il faut les tampons
 *     multiples ;
 *   - `^R` puis `^T` (3 cas : col3-20, col3-28, col3-173) : le navigateur de fichiers n'existe pas ;
 *   - repeint incremental (4 cas : col1-82, col2-18, col3-42, col3-65) : une rangee que nano ne repeint pas, sans le
 *     guide `-J` que le moteur y dessine, ou la derniere rangee de `-0` ; voir TODO.md, « le repeint incremental ».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const dir = 'src/__tests__/support/oracle/nano-colors';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoStateCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'col1-67', 'col1-117', 'col1-138', 'col1-151', 'col1-153', 'col1-169', 'col2-6', 'col2-48', 'col2-58', 'col3-137', 'col3-170', 'col3-190',
  'col3-20', 'col3-28', 'col3-173',
  'col1-82', 'col2-18', 'col3-42', 'col3-65',
]);

describe('nano interface colours recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays rows, cursor and the colour of every cell`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayNanoStateCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 4).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
