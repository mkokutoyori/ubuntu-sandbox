/*
 * Sonde de `-g` (--showcursor) de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from, tmux 3.4) : rangees du pane, cellule du curseur apres
 * chaque etape.
 *
 * Methode : help.c (do_help) de nano 8.x confronte au binaire 7.2 : avec `-g` le curseur est visible dans la
 * visionneuse d'aide et les fonctions do_left, do_right, do_up et do_down (Gauche, Droite, Haut, Bas, ^P, ^N)
 * deplacent ce curseur dans le texte d'aide au lieu de faire defiler ; ^F et ^B ne sont pas ces fonctions dans
 * l'aide (touches non liees).  Le navigateur de fichiers, l'autre endroit qui lit `-g`, n'est pas porte.
 *
 * Mesure avec `git stash push -- src/network` : 11 des 15 tests tombent sur le moteur d'avant, 0 apres.  Les 4
 * qui passent avant comme apres : le test de chargement (structurel), sc-witness (TEMOIN : sans `-g` les fleches
 * font defiler), sc-open (a l'ouverture le curseur est sur le premier caractere avec ou sans `-g`) et sc-main
 * (`-g` ne change rien dans la fenetre principale).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-showcursor/showcursor-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano -g, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(14);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
