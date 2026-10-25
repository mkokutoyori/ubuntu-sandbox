/*
 * Sonde de la completion par Tab de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from labs.json --workdir /tmp/nano-lab, tmux 3.4).
 *
 * Mesure : dans les invites de fichier (`^R`, `^O`, hors mode restreint) Tab complete le nom (prefixe commun des
 * entrees du dossier, « / » ajoute a un dossier unique), le curseur doit etre en fin de reponse, les noms caches ne
 * se completent qu'apres un point ; s'il y a plusieurs possibilites nano trie (dossiers d'abord, sans tenir compte
 * de la casse, puis l'ordre des points de code) et dessine la liste au bas de la fenetre d'edition, colonnes de
 * `plus long + 2`, « (more) » en bout de derniere rangee ; la liste reste pendant que l'invite est ouverte et disparait
 * des qu'un Tab n'a plus qu'une possibilite ou que l'invite se ferme.  Dans les invites a historique (recherche,
 * remplacement, texte de remplacement, execution) Tab remplace la reponse par l'entree suivante, de la plus recente a
 * la plus ancienne, qui commence comme le fragment tape avant le premier Tab, en boucle ; toute autre touche renouvelle
 * le fragment ; le pointeur d'historique reste ou Tab l'a laisse jusqu'a la prochaine invite de la meme liste (seul
 * un Haut le remet en bas).  L'invite « Go To Line » n'a ni l'un ni l'autre.
 *
 * Mesure avec `git stash` du moteur (Tab ne faisait rien dans les invites) : 19 des 28 tests tombent avant, 0 apres.  Les
 * 9 qui passent avant comme apres : le test de chargement (structurel), tab-witness (TEMOIN : sans historique Tab ne
 * change rien dans la recherche), tab-no-match, tab-cursor-inside, tab-history-empty, tab-history-no-match,
 * tab-history-replace (aucune entree ne correspond), tab-goto-nothing et tab-restricted (Tab n'agit pas).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-tab/tab-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano Tab, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(27);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
