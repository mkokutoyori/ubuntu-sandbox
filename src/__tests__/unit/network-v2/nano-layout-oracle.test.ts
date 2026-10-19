/**
 * La mise en page de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus
 * layout, `nano -I`) : chaque cas combine des options de mise en page (`-x -e -% -_ -0`) avec `-l -S -c -v`, des
 * hauteurs de pane de 2 a 24 lignes, des deplacements, des editions, la marque (`M-a`), des invites
 * (`^W ^\\ ^_ ^O ^R ^T ^X`), des redimensionnements et des bascules `M-n`, `M-s`, `M-x` et `M-c`.  Apres chaque etape on compare
 * les rangees du pane et la cellule du curseur.
 *
 * Methode : window_init() de nano.c et titlebar() / show_states_at() de winio.c (version 8.x, confrontee au
 * binaire 7.2 qui fait foi) : la fenetre perd la ligne d'aide avec `-x`, gagne une ligne vide sous le titre avec
 * `-e` (seulement au-dela de 6 lignes), et le titre porte « +.xxxxx » a la place de « Modified » avec `-%` : « *
 * » apres le nom si le tampon est modifie, puis les lettres I M L R S des etats.  Le binaire 7.2 montre les barres
 * de raccourcis a partir de 6 lignes (le source 8.x les montre des 5) et la ligne vide a partir de 7.
 * Les cas trouves en route et corriges : couper ou copier une selection vide dit « Nothing was cut » / « Copied
 * nothing » et efface la marque ; `^O` avec une marque propose « Write Selection to File » sans nom ; une
 * bascule (`M-n`, `M-s`) ne touche pas la colonne souhaitee ; le remplacement restaure la fenetre d'avant
 * (edittop et firstcolumn de ask_for_and_do_replacements).
 *
 * `M-x` bascule les lignes d'aide meme dans une invite (prompt.c), sans message ni verification de hauteur ; hors
 * invite il dit « Help mode enabled / disabled » ou « Too tiny » sous 6 lignes.
 *
 * `-_` (minibar) : une seule barre en bas remplace le titre et la rangee d'etat (minibar() de winio.c) : nom
 * (« ... » et le nom a partir du 5e caractere quand il ne tient pas, ce que fait le binaire 7.2), « * » si modifie,
 * nombre de lignes au premier dessin quand la fenetre depasse 35 colonnes (il attend sinon le premier
 * redimensionnement assez large), position et code du caractere avec `-c`, lettres d'etat avec `-%`, pourcentage.
 * Un message de niveau REMARK ou plus prend la place de la barre jusqu'a la touche suivante (le moteur le montre
 * 1,5 s : `EditorScreen.hold`), les bascules `M-n` / `M-x` y sont muettes, « Read N lines » n'est pas dit.
 *
 * `-0` (zero, interface cachee) : plus de titre, plus de barres de raccourcis, plus de rangee d'etat ; la fenetre
 * d'edition prend tout l'ecran et la rangee d'etat n'est reprise que le temps d'un message (makeRoomForMessage :
 * la ligne du curseur remonte d'une rangee quand elle serait recouverte).  Un message de niveau inferieur a REMARK
 * reste invisible ; `M-z` bascule le mode en cours de route, `M-c` y est refusee (« Not possible »).  Le source 8.x
 * (nano.c, winio.c) a ete confronte au binaire 7.2 et le binaire l'a emporte : `-0` implique `-x`, et l'invite de
 * ^W ^O ^R retrouve sa rangee du bas.
 *
 * Tous les cas sont rejoues (SCREEN_PORTED_FLAGS couvre desormais `view constantshow linenumbers softwrap nohelp
 * emptyline stateflags minibar zero`).
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : l'ancien moteur n'a ni `-x` ni `-e`
 * ni `-%` ni `-_` ni `-0`, et ses barres de raccourcis apparaissent des 5 lignes.  Sans `-_` (premier increment) 117 cas
 * sur 137 (seed 1), 108 sur 124 (seed 2) et 100 sur 118 (seed 3) tombaient avant ; avec `-_` (second increment, mesure sur
 * le moteur du premier) 70 sur 70, 66 sur 66 et 75 sur 75 des cas a minibarre tombent avant.  Avec `-0` (troisieme
 * increment, corpus reenregistre avec la bascule `M-z`, mesure sur le moteur du second) 87 sur 104, 89 sur 101 et 99
 * sur 108 des cas a interface cachee tombent avant ; 0 apres, sauf les cas ci-dessous.  Le seed 1 a guide les
 * reglages, les seeds 2 et 3 ont ete enregistres ensuite.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 7 cas.  Aucun n'est epingle comme contrat : un
 * cas de la liste qui se met a passer fait echouer le test pour qu'on le retire.
 *   - lay1-31, lay1-44, lay1-46, lay2-32, lay2-148, lay3-32, lay3-209 : `^R` en mode lecture seule ouvre « File to
 *     read into new buffer » (lecture dans un nouveau tampon) ; le moteur n'a qu'un tampon et repond « Key is
 *     invalid in view mode » ;
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted } from '../../support/oracle/nanoCliReplay';
import { recordedArguments, replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

const dir = 'src/__tests__/support/oracle/nano-layout';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoScreenCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'lay1-31', 'lay1-44', 'lay1-46', 'lay2-32', 'lay2-148', 'lay3-32', 'lay3-209',
]);

describe('nano layout transcripts recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows and cursor cell`, () => {
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
