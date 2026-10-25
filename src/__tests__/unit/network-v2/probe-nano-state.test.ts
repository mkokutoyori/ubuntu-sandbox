/*
 * Laboratoires de `nano -H` et `nano -P` enregistres contre un vrai nano 7.2 (record_nano_screen.py --corpus state
 * --from labs ; sources lues dans history.c et files.c du tarball nano_7.2.orig).  Chaque laboratoire est une suite de
 * sessions sur un meme $HOME ; le test rejoue le moteur et compare les rangees, le curseur, le texte que nano ecrit
 * sur le terminal a la sortie, et l'arbre du $HOME apres chaque session (chemins, modes, contenus).
 *
 * Regles mesurees :
 *   - dossier d'etat : ~/.nano/ s'il existe (meme avec XDG_DATA_HOME), sinon $XDG_DATA_HOME/nano/, sinon
 *     ~/.local/share/nano/ ; .local, .local/share et nano naissent en 0700, les fichiers en 0600 (chmod apres
 *     l'ouverture) ; un dossier qui ne peut pas naitre donne « Unable to create directory D: <strerror> » suivi de
 *     « It is required for saving/loading search history or cursor positions. » et d'une ligne vide a la sortie, et
 *     « [ Problems with history file ] » sur la barre d'etat au demarrage (alerte : elle laisse en place une autre alerte
 *     du demarrage, suivie de « ... ») ; ~/.nano qui est un fichier est ignore ;
 *   - search_history : trois listes (recherche, remplacement, commande) separees par une ligne vide, chaque entree
 *     suivie d'un saut de ligne, les trois separateurs toujours ecrits (« \n\n\n » pour trois listes vides) ; reecrit
 *     seulement si une liste a change ; une entree deja presente passe en fin de liste, mais le chargement ne
 *     deduplique pas ; une quatrieme section s'ajoute a la liste des commandes ; un dernier saut de ligne manquant
 *     mange le dernier caractere ; l'historique de recherche garde 100 entrees (la 101e fait sortir la plus ancienne) ;
 *     l'aide ^G a sa propre recherche qui alimente la meme liste ; M-W et M-Q reprennent la derniere recherche de
 *     l'historique charge ; ^W vide n'en reprend aucune (« Cancelled ») ;
 *   - filepos_history : « chemin ligne colonne », la colonne etant la colonne d'ECRAN plus un (tabulations et caracteres
 *     larges comptes), au plus 200 entrees lues, la plus recente en fin de fichier ; le chargement S'ARRETE a la premiere
 *     ligne de 5 caracteres ou moins (saut de ligne compris) et saute les lignes sans deux espaces ; une position
 *     (1, 1) retire l'entree ; un nom nu qui n'existe pas n'est pas enregistre (get_full_path rend NULL), un nom avec
 *     barre l'est SANS barre de separation (« /lab/worknofile.txt », defaut de get_full_path de 7.2, reproduit tel quel) ;
 *   - restauration : +LIGNE,COL ou +/motif ecartent le journal ; +0 le laisse faire ; une ligne ou une colonne hors du
 *     fichier est ramenee au bord ; 0 0 laisse le curseur en haut ; -R desactive les deux journaux.
 *
 * Mesure : un moteur qui lit -H et -P sans en faire rien laissait tomber 68 laboratoires sur 70 ; les deux qui passent
 * avant comme apres sont les TEMOINS lab-flags-none (aucun drapeau, rien ne naît) et lab-restricted (-R).  Le premier
 * jet a montre une seule divergence du moteur sur les 70 : le chargement de filepos_history s'arrete a la premiere
 * ligne courte au lieu de la sauter ; les six autres echecs venaient du faux systeme de fichiers du test (dossiers
 * semes sans leurs parents, ecriture sur un chemin qui est un dossier), corriges dans le meme changement.
 *
 * Hors perimetre, constate : nano 7.2 plante (SIGSEGV) quand il charge un search_history de plus de 100 entrees dans
 * une meme liste, parce que delete_node() lit openfile->edittop avant qu'un tampon n'existe ; aucun fichier ecrit par
 * nano lui-meme n'en contient autant.  Le moteur garde alors les 100 plus recentes plutot que de planter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-state/state-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

describe('nano -H and -P labs recorded from a real nano', () => {
  it('records the version the labs were measured on', () => {
    expect(recorded.nano).toContain('7.2');
  });

  for (const lab of recorded.cases) {
    it(lab.id, () => {
      expect(replayNanoStateCase(lab)).toBeNull();
    });
  }
});
