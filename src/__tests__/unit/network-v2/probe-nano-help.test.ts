/**
 * Sonde de l'aide de nano, un laboratoire minimal par regle, enregistres sur nano 7.2 (scripts/oracle/record_nano_screen.py
 * --corpus help --from, avec `disk: true` et `hidden: true`) : rangees du pane, cellule du curseur et fichiers du
 * repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : ^G ouvre « Main nano help text » (titre centre, ligne vide, introduction coupee a
 * clamp(COLS, 40, 74), une entree par fonction avec ses touches) ; -R retire Execute, Justify et la navigation de
 * fichiers, -p dit que ^Q et ^S ne sont pas liees, -t change la phrase de la sortie, -v retire les fonctions qui
 * modifient ; depuis une invite ^G ouvre l'aide de cette invite (recherche, remplacement, texte de remplacement, Aller a
 * la ligne, ecrire, inserer, executer) et la ferme sur la meme invite avec sa reponse ; la visionneuse defile avec Haut
 * et Bas, les pages avec PageUp / PageDown / ^Y / ^V / Espace / b, saute aux extremites avec M-\ et M-/ (curseur en
 * colonne 0 sur la derniere ligne), ferme avec ^X, q, x, e, et dit « Unbound key » pour ^O ^K ^U ^J ou une lettre
 * inconnue ; ^W y cherche (seule ^C annule), le terme tapé devient celui de la recherche suivante dans l'editeur, M-W
 * et M-Q repetent, la recherche fait le tour du texte, une regexp invalide dit « Bad regex » ; une fenetre de 6
 * rangees a les barres, de 5 et moins la rangee du bas garde ce qu'elle portait ; ^B ^F ^A ^E ^D ^H editent la reponse
 * d'une invite.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul) : les 62 laboratoires tombaient avant, 0 apres.
 * Aucun ne passe dans les deux cas : l'ancienne aide etait un texte de 25 lignes, identique pour tous les menus, qui
 * se fermait avec Echap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-help/help-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano help, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(62);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
