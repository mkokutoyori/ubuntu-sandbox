/**
 * L'invite Execute Command de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus
 * exec, `nano -I`) : 600 sessions (4 x 150, seeds 1 a 4) de deux a sept gestes melant ^T <commande> Entree, ^T M-\ <filtre>
 * Entree, les raccourcis de l'invite (^S ^Y ^O ^J ^V ^X ^T ^C), l'historique (Haut / Bas), des commandes qui reussissent,
 * echouent, ecrivent sur stderr ou dans un fichier, la marque (M-a), l'annulation (M-u), le deplacement et la saisie, dans des
 * fenetres de 8 x 30 a 24 x 80, avec 0 a 2 options parmi `-x -l -S -i -E -L -k -A -% -_ -e -0`.  Apres chaque etape on compare
 * les rangees du pane, la cellule du curseur et les fichiers du repertoire.
 *
 * Methode : execute_command et do_insertfile de files.c, prompt.c et nano.c de nano 8.x confrontes au binaire 7.2 qui fait
 * foi.  Les commandes tournent dans le VRAI shell simule (LinuxPC, nanoShellBridge.ts) : le rejeu recopie le repertoire dans le
 * systeme de fichiers de la machine, y lance `commande` comme un enfant de l'editeur (LinuxMachine.runChildShellForEditor :
 * etat du shell intact, sortie brute avec stdout et stderr melanges, code de retour conserve, entree standard donnee a la
 * premiere commande qui la lit) et recopie le resultat.
 *
 * Ce que le binaire 7.2 a montre : stdout et stderr melanges sont inseres a l'endroit du curseur (« Read N lines », annulable
 * sous le nom « insertion ») ; un code de retour non nul n'insere rien et dit « Error: » suivi de la DERNIERE ligne de la
 * sortie privee de tout ce qui precede le premier « : » (« --- » sans « : » ou sans sortie) ; en mode filtre (`|` en tete de la
 * reponse, M-\ la pose ou la retire, l'historique la garde) la reponse est TOUJOURS « Error: --- », le texte donne a la commande
 * est la region marquee (sans retour a la ligne final) ou, sans marque, le tampon entier avec son retour final, et la sortie la
 * remplace (« filtering » pour M-u) : sans marque le curseur reste sur la meme ligne, colonne 0, avec marque il se pose apres le
 * texte insere ; un echec efface la marque et, si une insertion vide « Read 0 lines » a laisse un element d'annulation, passe le
 * tampon a Modified ; ^S dit « Error invoking "spell" » (ce binaire n'a pas `spell`), ^T aussi, ^Y et ^O « No linter / formatter
 * is defined », ^J justifie tout le fichier, ^V coupe jusqu'a la fin, tous ferment l'invite ; ^X bascule vers « File to insert »
 * en gardant le texte et ^X revient ; la ligne minibarre montre « (N lines) » apres une insertion ; une reponse vide dit
 * « Cancelled ».
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/NanoUndo.ts nano/NanoMessages.ts` (le moteur seul, l'invite inserait la
 * sortie sans code de retour) : 131, 138, 138 et 136 sessions sur 150 tombaient avant (543 sur 600), 0 apres.  Passent dans les
 * deux cas 57 sessions dont les touches n'invoquent aucune commande qui aboutisse (annulations, raccourcis refuses).
 *
 * Non rejoue (liste dans docs/ASSESSMENT-EDITEURS-NON-PORTE.md) : M-F (nouveau tampon : un seul tampon par session), la mort du
 * shell par signal (« Cancelled »), les commandes dont la sortie depend de la machine ($HOME, `od` absent du simulateur) et les
 * filtres dont l'entree ou la sortie n'a pas de retour a la ligne final (le simulateur termine toujours par une fin de ligne la
 * sortie de `tr`, `cat`, `sort` ou d'un tube : `printf abc | cat` rend « abc\n »).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-exec';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

describe('nano Execute Command recorded from a real nano', () => {
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
