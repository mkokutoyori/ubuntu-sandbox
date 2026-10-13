/*
 * Sonde des modes d'outil de nano (-t sauvegarde en sortie, -n pas de lecture, -R restreint), un laboratoire minimal
 * par regle, enregistres sur nano 7.2 (scripts/oracle/record_nano_screen.py --corpus cli --from, avec `disk: true`,
 * `hidden: true` et `files`) : rangees du pane, cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : avec -t, ^X sur un tampon modifie et nomme ecrit sans rien demander (et quitte), sur un
 * tampon sans nom il avertit « No file name » (barres videes le temps de la pause) puis pose la question habituelle,
 * et l'invite d'ecriture annonce ^Q « Discard buffer » (neuvieme entree de la grille, absente sans -t et avec -p)
 * qui quitte sans ecrire ; avec -n le fichier nomme n'est pas lu et aucun message ne s'affiche, meme pour un fichier
 * qui n'existe pas ; avec -R le titre dit « Restricted » (« Modified » le remplace, « View » l'emporte), les barres
 * remplacent ^R / ^T par ^J (Justify) et retirent Append / Prepend / Backup / Browse de l'invite d'ecriture, ^R et ^T
 * repondent « This function is disabled in restricted mode » (en vue seule ^R donne ce message et ^T « Key is invalid
 * in view mode »), l'invite d'ecriture d'un tampon nomme est gelee (saisie, Retour arriere et Suppr sans effet, les
 * deplacements restent), une selection n'est pas ecrite seule, -B est ignore et un tampon sans nom ne peut pas
 * ecraser un fichier existant (« File exists -- cannot overwrite », barres videes le temps de la pause) ; `-R -h` retire
 * de l'usage les huit options qui ecrivent ailleurs (-B -C -F -H -P -R -Y -s), mais seulement si -R precede -h.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 53 des 65 tests tombent sur le moteur
 * d'avant, 0 apres ; passent dans les deux cas le test de chargement (structurel), usage-plain, usage-restricted-after et usage-restricted-version (temoins : texte inchange), tool-saveonexit-clean et
 * tool-saveonexit-view (rien a ecrire), tool-view-write et tool-view-execute (refus de la vue seule deja presents),
 * tool-discard-without-t, tool-discard-without-t-key et tool-discard-preserve (temoins : l'ancien moteur n'annonce
 * jamais Discard buffer) et tool-discard-bar-narrow (la grille de 8 entrees a 40 colonnes ne le montre pas).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-tools/tool-labs.json', 'utf8')) as { cases: Lab[] }).cases;
const usageLabs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-tools/usage-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano tool modes (-t, -n, -R), one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(58);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });

  it.each(usageLabs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
