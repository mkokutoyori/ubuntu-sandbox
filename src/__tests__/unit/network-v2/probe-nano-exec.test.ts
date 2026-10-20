/**
 * Sonde de l'invite Execute Command de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus search --from, avec `disk: true` et `hidden: true`) : rangees du pane,
 * cellule du curseur et fichiers du repertoire apres chaque etape.  Les commandes tournent dans le shell simule (voir
 * l'en-tete de nano-exec-oracle.test.ts).
 *
 * Ce que le binaire a montre : run-* (sortie inseree, stdout et stderr melanges, « Read N lines », « Error: » sur code non nul
 * avec la derniere ligne apres « : », « --- » sans « : », « Read 0 lines » sur `true`, ecriture d'un fichier, annulation
 * « insertion », bascule vers Read File), pipe-* (M-\ filtre le tampon ou la region, « Error: --- » sur echec, historique
 * gardant le `|`, texte de remplacement, « filtering »), mark-* (la region donnee a la commande, le curseur qui reste ou se
 * pose apres le texte, la fenetre qui suit la coupe), flip-* (^X garde le texte et la barre `|`), misc-* (minibarre, -0, ^T
 * dans l'invite = correcteur, reponse vide, espaces en tete), empty-* (un echec apres une insertion vide passe le tampon a
 * Modified, l'annulation M-u l'en empeche), keep-* (la marque survit a un succes, un echec l'efface).
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/NanoUndo.ts nano/NanoMessages.ts` (le moteur seul) : 142 des 151
 * laboratoires tombaient avant, 0 apres.  Passent dans les deux cas 9 laboratoires de non-regression : ^T refuse sous -R et -v
 * (run-e24, run-e25), la barre de l'invite (run-e32), l'annulation ^C (run-e33), ^R qui ne bascule pas (pipe-x37), le filtre
 * sous -v (mark-y20), la bascule sous -R (flip-p13), la reponse vide (flip-p14) et ^R en minibarre (misc-m03).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-exec/exec-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano Execute Command, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(151);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
