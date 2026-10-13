/*
 * Sonde de l'annulation et du retablissement de nano (M-U, M-E), un laboratoire minimal par regle, enregistres sur
 * nano 7.2 (scripts/oracle/record_nano_screen.py --corpus cli --from, avec `disk: true`, `files` et `hidden: true`) :
 * rangees du pane, cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : une frappe continue est UNE addition tant que le curseur est la ou la frappe s'est
 * arretee (s'en eloigner puis y revenir ne la coupe pas) ; Entree, un collage, une insertion de fichier, une
 * justification, une indentation et une mise en commentaire sont chacun un element ; les Retour arriere se
 * regroupent (« deletion »), les Suppr aussi, les deux ne se melangent pas, une suppression ailleurs sur la ligne en
 * ouvre un nouveau ; joindre deux lignes est « line join » ; Retour arriere sur la ligne magique ne change rien mais
 * fait un element (il rend le tampon « Modified » et son annulation ramene le curseur en debut de ligne) ; les
 * couper se regroupent tant qu'aucun autre geste ne s'intercale (une copie, un deplacement, un collage les coupent) ;
 * -Z efface (« erasure ») ; Remplacer annule ligne par ligne (« replacement ») ; la coupe automatique de -b et la
 * frappe qui l'a causee sont UNE addition ; annuler vide la marque et la ligne magique revient avec le tampon ;
 * revenir a l'etat enregistre retire « Modified », l'enregistrement coupe la frappe en cours, une nouvelle
 * modification apres une annulation efface le retablissement ; `Nothing to undo` / `Nothing to redo` sans point
 * d'exclamation ; M-T coupe jusqu'a la fin du tampon, M-3 (re)met `#` devant les lignes.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul) : 62 des 66 tests tombent, 0 apres ; passent
 * dans les deux cas le test de chargement (structurel), undo-backspace-magic-modified (le tampon etait deja modifie),
 * undo-zero et undo-minibar (aucun message a montrer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-undo/undo-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano undo and redo, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(65);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
