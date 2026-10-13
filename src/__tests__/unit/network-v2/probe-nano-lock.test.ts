/*
 * Sonde du verrou de nano (-G) et des confirmations de Write Out, un laboratoire minimal par regle, enregistres sur
 * nano 7.2 (scripts/oracle/record_nano_screen.py --corpus cli --from, avec `disk: true` et `hidden: true`) : rangees
 * du pane, cellule du curseur et fichiers du repertoire, caches compris, apres chaque etape.  Les verrous sont
 * relus champ par champ (programme, nom, etat modifie, et un PID / utilisateur / hote non vides : ceux du vrai
 * nano ne sont pas ceux du simulateur) ; `locks` pose avant le lancement un verrou etranger (alice, PID 4242).
 *
 * Ce que le binaire a montre : aucun verrou sans -G (le moteur en ecrivait toujours un) ; le verrou garde le nom
 * tel que tape, passe a « modifie » a la premiere modification et y reste apres l'enregistrement ; il disparait a la
 * sortie, suit le tampon quand ^O l'enregistre sous un autre nom (la question « Save file under DIFFERENT NAME? »
 * precede, puis « File "x" exists; OVERWRITE? »), et un verrou etranger pose une question avant meme le premier
 * dessin (l'ecran est vide), dont le nom de fichier est omis quand la ligne est trop courte.  Y laisse la question
 * affichee, N ouvre un tampon vierge, ^C quitte, un verrou illisible est ignore avec « Bad lock file is ignored ».
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 24 des 25 tests tombent sur le moteur
 * d'avant, 0 apres ; seul passe le test de chargement (structurel).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-lock/lock-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano lock file (-G) and Write Out confirmations, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(24);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
