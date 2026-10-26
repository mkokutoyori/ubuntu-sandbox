/*
 * La coloration syntaxique de nano (`syntax`, `header`, `color`, `icolor`, `extendsyntax`, `include`, `comment`, `tabgives`,
 * `-Y`, `M-Y`) rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus syntax, tmux 3.4,
 * TERM=xterm-256color, SANS -I, `~/.nanorc` et `/etc/nanorc` semes comme dans nano-rc-oracle.test.ts).  Le recorder lit
 * `capture-pane -e` et note, pour CHAQUE cellule, la couleur de premier plan et de fond (indice 0-255) et les attributs ;
 * une legende par cas donne la lettre de chaque combinaison.  Chaque cas tire au hasard un texte (code C, commentaires
 * de bloc sur une ou plusieurs lignes, mots, tabulations, caracteres larges), un `~/.nanorc` de 1 a 4 syntaxes
 * (extensions, en-tetes, couleurs simples et `start=` / `end=`, `icolor`, expressions invalides, `comment`, `tabgives`,
 * `extendsyntax`), parfois des fichiers inclus par `include` (globs, `~`, fichiers absents) et un `/etc/nanorc`, 0 a 2
 * options parmi -l -S -q -c -x -0 -_ -D -% -v -E -A -J et parfois -Y, puis 2 a 7 gestes (deplacements, frappe qui ouvre ou
 * ferme un commentaire, recherche, selection, commentaire `M-3`, tabulation, `M-Y`, enregistrement sous un autre nom).
 * Apres chaque etape on compare les rangees, la cellule du curseur et la couleur de chaque cellule.
 *
 * Methode : color.c, rcfile.c (parse_rcfile, parse_colors, grab_and_store, check_for_nonempty_syntax) et winio.c (draw_row,
 * precalc_multidata) du tarball nano_7.2.orig pour comprendre, le binaire 7.2-2ubuntu0.2 pour trancher.  Le seed 1 a guide
 * les reglages ; les seeds 2 et 3 ont ete enregistres ensuite.  Les regles mesurees sont dans probe-nano-syntax.test.ts
 * (139 laboratoires).
 *
 * Mesure : un moteur qui lit les syntaxes sans les evaluer (le commit precedent) laissait tomber 199 cas sur 200 (seed 1), 197
 * (seed 2) et 196 (seed 3) ; 0 apres, hors quatre cas non portes.  Chaque seed a ete enregistre une premiere fois sans fichiers
 * inclus ni commentaires : les divergences trouvees en rejouant sont toutes dans le moteur et resumees dans le message du
 * commit (peinture qui s'arrete au texte montre, `\t` avec REG_ICASE qui ne reconnait rien dans la libc, `~` developpe avant
 * le glob, `bind` / `unbind` qui ferment une syntaxe sans commande de couleur...).
 *
 * Cas non portes, 4 sur 600, tous mesures (un cas de la liste qui se met a passer fait echouer le test) :
 *   - repeint incremental (syn2-8, syn2-115, syn3-0, syn3-130) : une rangee que nano ne repeint pas, sans le guide `-J` que le
 *     moteur y dessine sur la nouvelle ligne magique ; voir TODO.md, « le repeint incremental ».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const dir = 'src/__tests__/support/oracle/nano-syntax';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoStateCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'syn2-8', 'syn2-115', 'syn3-0', 'syn3-130',
]);

describe('nano syntax colouring recorded from a real nano', () => {
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
