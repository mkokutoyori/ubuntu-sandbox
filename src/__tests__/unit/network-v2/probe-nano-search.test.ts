/*
 * Sonde de la recherche et du remplacement de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus search --from, avec `disk: true` et `hidden: true`) : rangees du pane,
 * cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : la recherche saute le caractere sous le curseur, fait le tour du tampon une fois (« Search
 * Wrapped »), dit « This is the only occurrence » quand elle retombe sur son point de depart et « "x" not found » sinon ;
 * Entree sans texte reprend le terme entre crochets, le terme vide sans terme precedent dit « Cancelled » ; M-C, M-R et
 * M-B se basculent sans perdre le texte tape et se lisent dans l'invite (« [Case Sensitive] [Regexp] [Backwards] ») ; ^R
 * passe de Where Is a Replace et inversement, ^T ouvre « Go To Line » avec le texte tape, ^Y et ^V sautent a la premiere
 * ou a la derniere ligne et ferment l'invite ; Haut / Bas (ou ^P / ^N) parcourent l'historique sans doublon et Bas
 * rend le texte en cours ; ^Q ouvre un Where Is arriere, M-W et M-Q relancent la recherche sans invite, M-R ouvre Replace, M-B dit « No linter is defined for this type of file » (« No current
 * search pattern » sans terme) ; une regexp invalide dit « Bad regex "x": » suivi du texte de la glibc, et la seconde
 * recherche reprend le terme malgre tout ; une regexp ERE cherche la correspondance la plus longue (« a|al »,
 * « (a|ab)(c|bcd)? »), accepte `^`, `$`, `\<`, `\>`, `[[:upper:]]`, les references arriere, et une correspondance vide
 * avance d'un caractere a chaque fois ; au remplacement, \1 a \9 prennent les groupes, \0 et un numero sans groupe
 * restent litteraux ; le texte de remplacement n'est pas recherche a nouveau, Y / N / A / ^C et Alt+lettre repondent
 * a « Replace this instance? » ; avec une marque seule la selection est remplacee, la marque revient mais la lettre M
 * des etats disparait de la barre de titre au premier remplacement ; le remplacement revient au curseur de depart
 * (corrige de la variation de longueur) et a la fenetre d'avant, et chaque remplacement s'annule seul ; en lecture seule
 * ^\ et ^R de l'invite disent « Key is invalid in view mode » (600 ms sur la barre de l'invite).
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul) : 83 des 132 laboratoires tombaient avant, 0
 * apres, dont r08 et r24 (remplacer `$` et `.*` partout) qui faisaient boucler l'ancien moteur sur la correspondance
 * vide.  Passent dans les deux cas 49 laboratoires qui servent de temoins : les recherches litterales simples (s01 a
 * s05, h01, h03, h04), la fenetre des recherches lointaines (l01 a l05), les remplacements litteraux sans cas limite
 * (r14 a r17, r19, r30, r31, r33, r34), l'annulation avec marque (m04 a m08), le temoin de lecture seule v01 et les
 * recherches d'un mot au bord droit de la fenetre ou sous une marque (a07 a a11, a13), ou le surlignage ne change
 * rien a ce qui s'affiche.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-search/search-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano search and replace, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(132);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
