/*
 * Laboratoires des couleurs d'interface de nano enregistres contre un vrai nano 7.2 (record_nano_screen.py --corpus
 * colors --from labs ; sources lues dans color.c, rcfile.c et winio.c du tarball nano_7.2.orig).  Chaque laboratoire
 * seme un `~/.nanorc` (parfois `/etc/nanorc`, parfois NO_COLOR) et rejoue rangees, curseur et couleur de chaque cellule.
 *
 * Regles mesurees :
 *   - une couleur se lit « [bold,][italic,]AVANT-PLAN[,FOND] » ; `bold,` et `italic,` exigent une virgule (« An attribute
 *     requires a subsequent comma »), l'ordre est bold puis italic ; le premier plan vide (« ,vert ») est la couleur
 *     par defaut ; `normal` aussi ; les noms sont en minuscules (« Color "Red" not understood ») ;
 *   - `light` ajoute 8 a l'indice (premier plan et fond), `bright` ajoute le gras au premier plan (prefixe deprecie) et
 *     8 au fond ; ni l'un ni l'autre ne se combinent avec `normal`, les noms etendus (pink ... gray) ou #rgb (« Color
 *     'lightgrey' takes no prefix ») ; #rgb prend le point du cube 6x6x6 le plus proche (niveaux 0 0 0 0 1 1 1 1 2 2 3 3
 *     4 4 5 5) ; #12, #12345 et #xyz sont inconnus ;
 *   - la derniere ligne gagne, meme invalide (« set titlecolor red » puis « set titlecolor nosuchcolor » remet le defaut) ;
 *     `unset` d'une couleur et une couleur sans argument sont des erreurs (« Cannot unset option », « requires an
 *     argument ») ;
 *   - defauts : titre, numeros, selection, statut et touches en video inverse (gras avec `boldtext`) ; guide en
 *     inverse ; barre de defilement sans attribut (la partie allumee en inverse) ; projecteur noir sur jaune vif ; erreur
 *     blanc gras sur rouge ; minibarre (-_) et invite prennent la couleur du TITRE (donc la couleur configuree) ; etiquette de
 *     fonction sans attribut ; une couleur configuree sur la barre de defilement colore aussi les rangees eteintes ;
 *     avec NO_COLOR dans l'environnement et aucune couleur configuree le projecteur et l'erreur sont en inverse ;
 *   - la question oui / non et les invites utilisent la couleur de l'invite, les messages d'erreur (ALERT, AHEM, MILD)
 *     celle de l'erreur, les autres celle du statut ; les flèches « < » et « > » de defilement horizontal gardent
 *     l'attribut de mise en valeur (inverse ou gras) quelle que soit la couleur de selection.
 *
 * Mesure : un moteur qui lit les couleurs sans les evaluer laissait tomber 45 laboratoires sur 58.  Les 13 qui passent
 * avant comme apres sont des TEMOINS ou des cas structurels : le defaut sans rc (color-default-everything,
 * color-spotlight-default, color-boldtext-default, color-scroller-default-reverse-lit), NO_COLOR (color-no-colour-env,
 * lu hors rc), les erreurs que la lecture du rc produisait deja (color-invalid-resets-to-default, color-missing-argument,
 * color-bad-prefix-errors, color-attribute-errors, color-bad-hex-errors, color-case-sensitive-names, color-bad-background)
 * et -I (color-ignored-by-I).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-colors/color-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

const UNPORTED_LABS: ReadonlySet<string> = new Set([]);

describe('nano interface colour labs recorded from a real nano', () => {
  it('records the version the labs were measured on', () => {
    expect(recorded.nano).toContain('7.2');
  });

  for (const lab of recorded.cases) {
    it(lab.id, () => {
      const failure = replayNanoStateCase(lab);
      if (UNPORTED_LABS.has(lab.id)) expect(failure).not.toBeNull();
      else expect(failure).toBeNull();
    });
  }
});
