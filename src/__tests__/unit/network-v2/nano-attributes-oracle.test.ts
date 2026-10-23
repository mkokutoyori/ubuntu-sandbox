/**
 * Les attributs d'affichage de nano rejoues contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py
 * --corpus attrs|bar, `nano -I`, tmux 3.4, `capture-pane -e -p -N`) : apres chaque etape on compare les rangees, la
 * cellule du curseur ET l'attribut de chaque cellule (lettres b gras, r inverse, c couleur, ... d'apres le vocabulaire
 * SGR d'ncurses).  Les corpus « attrs » combinent `-D` (gras), `-J` (guide), `-U` (effacement rapide), `-S`, `-l`,
 * la marque, la recherche (surbrillance), les alertes et les redimensionnements ; les corpus « bar » combinent `-q`
 * (barre de defilement, sidebar) avec les pages, les deplacements et les editions sur des fichiers de 3 a 40 lignes.
 *
 * Methode : le source 8.x (winio.c : draw_scrollbar, edit_draw, minibar ; nano.c : handle_sigwinch) confronte au
 * binaire 7.2, qui fait foi.  Le guide (`GUIDE_STRIPE`) est en inverse sur la colonne `-J` de chaque rangee dessinee
 * (deux cellules sur un caractere large, replie sur la cellule precedente a la moitie d'un caractere large) ; le
 * texte trouve (`SPOTLIGHTED`) est noir sur jaune vif ; une alerte est en gras blanc sur rouge ; ncurses efface les
 * attributs invisibles d'une cellule vide, ce que le rejeu normalise.  La barre de defilement (`-q`) occupe la
 * derniere colonne, decale la fenetre d'une colonne (`sidebar`, et le marqueur `>`), et sa tranche allumee suit une
 * formule ajustee sur 240 cas (boucle softwrap de 8.x, plus `highest = rows` quand le fichier est plus court que la
 * fenetre).  `-U` efface un message au premier appui sur une touche au lieu de 1,5 s.
 *
 * Mesure avec `git stash push -- src/network src/components` : l'ancien moteur n'evalue ni `-D` ni `-J` ni `-q` ni
 * `-U` (le parseur les rangeait dans les reglages et aucun code ne les lisait), et son texte trouve etait en inverse.  94 cas sur 150 (attrs seed 1), 107
 * sur 150 (seed 2), 113 sur 150 (seed 3), 120 sur 120 (bar seed 1) et 120 sur 120 (bar seed 2) tombaient avant ;
 * 0 apres, sauf les cas ci-dessous.  Les seeds 1 et 2 d'attrs et le seed 1 de bar ont guide les reglages, les seeds 3
 * d'attrs et 2 de bar ont ete enregistres ensuite (hold-out).
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 5 cas.  Aucun n'est epingle comme contrat : un
 * cas de la liste qui se met a passer fait echouer le test pour qu'on le retire.
 *   - atr3-21, atr3-47, atr3-101, bar2-2 : un caractere tape sur la derniere ligne (la « ligne magique » que `PageDown`
 *     atteint) cree une nouvelle ligne magique en dessous ; nano 7.2 ne repeint que la rangee courante, la rangee
 *     de la nouvelle ligne magique reste donc vide SANS le guide `-J` ni la barre `-q`, que le repeint complet de la
 *     machine dessine ;
 *   - bar2-41 : `-S -l` sur une ligne de cinq tranches ; apres `M-\ PageDown C-d BSpace` le binaire laisse la rangee
 *     de la derniere tranche vide et le curseur colonne 0 de la rangee suivante, un etat de repeint incremental que
 *     le tampon ne justifie pas et que la machine, qui repeint tout, ne reproduit pas.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted } from '../../support/oracle/nanoCliReplay';
import { recordedArguments, replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

const dir = 'src/__tests__/support/oracle/nano-attrs';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoScreenCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'atr3-21', 'atr3-47', 'atr3-101', 'bar2-2', 'bar2-41',
]);

describe('nano attributes recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and attribute of every cell`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(recordedArguments(c)));
      expect(ported.length).toBeGreaterThan(100);
      const outcomes = ported.map((c) => ({ id: c.id, failure: replayNanoScreenCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${ported.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
