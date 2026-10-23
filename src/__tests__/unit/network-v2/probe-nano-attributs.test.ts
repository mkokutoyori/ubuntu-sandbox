/*
 * Sonde des attributs d'affichage de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus attrs --from, tmux 3.4) : rangees, cellule du curseur et attribut de
 * chaque cellule apres chaque etape.  Les corpus aleatoires de nano-attributes-oracle.test.ts couvrent le meme terrain
 * a l'echelle ; ici chaque cas nomme la regle qu'il isole (`-D`, `-J`, `-q`, `-U`, texte trouve, alerte, marque).
 *
 * Mesure avec `git stash push -- src/network src/components` : 31 des 41 tests tombent sur le moteur d'avant, 0
 * apres.  Les 10 qui passent avant comme apres sont : le test de chargement (structurel) ; atr-slow-blank (TEMOIN :
 * sans `-U` le meme message est encore la apres une touche, ce qui prouve que le laboratoire lit l'ecran) ;
 * atr-default-screen, atr-default-selection, atr-default-alert, atr-default-linenumbers et atr-default-more-marker
 * (non-regression : l'inverse du titre, de la selection, des numeros et du marqueur, et le gras blanc sur rouge de
 * l'alerte etaient deja justes) ; atr-stripe-out-of-view (un guide hors de la fenetre ne dessine rien, avant comme
 * apres), atr-bar-too-narrow et atr-bar-too-short (a 9 colonnes ou a 5 rangees nano ne dessine pas de barre, donc `-q`
 * n'y change pas l'ecran).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

interface Lab extends NanoScreenCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-attrs/attribute-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano attributes, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(40);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoScreenCase(lab) ?? '').toBe('');
  });
});
