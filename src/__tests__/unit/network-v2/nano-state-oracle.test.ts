/**
 * `nano -H` et `nano -P` rejoues contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus state,
 * tmux 3.4, `nano -I`) : chaque cas enchaine 1 a 3 sessions de nano sur le meme dossier de travail et le meme $HOME
 * (un dossier du laboratoire monte sur /root par `unshare -m`, car nano 7.2 lit l'entree de /etc/passwd quand il tourne
 * en root et ignore donc $HOME).  Le point de depart est tire au hasard parmi neuf etats : rien, historique seme,
 * positions semees, les deux, ancien dossier ~/.nano, XDG_DATA_HOME existant ou absent, ~/.local qui est un fichier,
 * .local/share/nano qui est un fichier.  Chaque session ouvre t.txt ou u.txt (nom nu ou ./nom, parfois +LIGNE,COL),
 * deplace le curseur, cherche, remplace, execute, tape, puis sort.  Apres chaque etape on compare les rangees et la
 * cellule du curseur ; a la sortie le texte que nano ecrit sur le terminal (exit_rows) et le dossier de travail ; a la fin
 * de chaque session l'arbre entier du $HOME (chemins, modes, contenus) et celui de XDG_DATA_HOME.
 *
 * Methode : history.c de nano 7.2 (tarball nano_7.2.orig de l'archive Ubuntu) pour comprendre, le binaire installe
 * (7.2-2ubuntu0.2) pour trancher : le source cree ~/.local en 0777 alors que le binaire le cree en 0700 (strace), c'est le
 * binaire qui fait foi.  Le seed 1 a guide les reglages ; les seeds 2 et 3 ont ete enregistres ensuite.  Les regles
 * mesurees sont dans probe-nano-state.test.ts (70 laboratoires) et probe-nano-state-machine.test.ts (utilisateur
 * ordinaire, droits, session).
 *
 * Mesure : un moteur qui lit -H et -P mais n'en fait rien laissait tomber 148 cas sur 200 (seed 1), 151 (seed 2) et 153
 * (seed 3) ; 0 apres.  Le premier jet a aussi montre une divergence sans rapport avec les journaux, corrigee dans le
 * meme changement : dans la visionneuse d'aide, une touche de code superieur a 0x7F dit « Unbound key » sans le
 * caractere (unbound_key de nano.c), le moteur ajoutait « : é ».  Les 52, 49 et 47 cas qui passent avant comme apres
 * sont ceux ou aucun drapeau ne demande un journal et ceux de -R (le mode restreint les desactive) : ils servent de
 * TEMOINS.
 *
 * Aucun cas non porte.  Un cas qui echouerait serait liste dans UNPORTED_CASES, et un cas de la liste qui se met a
 * passer fait echouer le test pour qu'on le retire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const dir = 'src/__tests__/support/oracle/nano-state';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoStateCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([]);

describe('nano history and position logs recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays rows, cursor, disk and state files`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayNanoStateCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 4).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
