/*
 * Laboratoires de la coloration syntaxique de nano enregistres contre un vrai nano 7.2 (record_nano_screen.py --corpus syntax
 * --from labs ; sources lues dans rcfile.c, color.c et winio.c du tarball nano_7.2.orig).  Chaque laboratoire seme un
 * `~/.nanorc` (parfois `/etc/nanorc` et des fichiers inclus) et rejoue rangees, curseur et couleur de chaque cellule.
 *
 * Regles mesurees :
 *   - choix de la syntaxe : l'option -Y (nom exact, sensible a la casse ; `none` coupe ; un nom inconnu affiche « Unknown
 *     syntax name: X » puis retombe sur le choix automatique), puis l'expression d'extension cherchee dans le chemin COMPLET du
 *     fichier, puis l'en-tete cherche dans la PREMIERE ligne, puis la syntaxe `default` ; la derniere definition d'un meme
 *     motif l'emporte ; un nouveau nom de fichier (^O) refait le choix, sauf avec -Y ; `default` refuse extensions et en-tetes,
 *     `none` est reserve ;
 *   - le corps d'une syntaxe n'est lu QUE quand elle est choisie : une couleur invalide d'une syntaxe inutilisee ne dit rien, celle
 *     d'une syntaxe choisie (a l'ouverture ou apres ^O) produit « Error in F on line N: ... » et l'alerte « Mistakes in 'F' » ;
 *   - peinture : les regles s'appliquent dans l'ordre du fichier, la derniere recouvre les precedentes ; `icolor` ignore la casse ;
 *     une correspondance vide ne peint rien ; `^` ne s'ancre qu'au debut de la ligne ; la peinture s'arrete a 2000 octets ; une
 *     rangee defilee ne peint que ce qu'elle montre ; la selection et le projecteur recouvrent la syntaxe ;
 *   - `start=` / `end=` : une ouverture sans fermeture sur la meme ligne peint jusqu'a la fin du tampon, taper la fermeture
 *     referme, effacer l'ouverture rouvre le texte ; une rangee dont le debut est hors de l'ecran reste peinte ;
 *   - `comment` (avec « avant|apres ») et `tabgives` : `M-3` utilise la chaine de la syntaxe, la tabulation et l'indentation de
 *     bloc utilisent `tabgives`, `M-O` est refusee (« Current syntax determines Tab ») ; une chaine vide refuse le commentaire ;
 *     `M-Y` coupe et remet la coloration (« Color syntax highlighting enabled / disabled ») ;
 *   - `extendsyntax` ajoute des commandes a une syntaxe deja definie (apres coup, y compris par /etc/nanorc), « Could not find
 *     syntax "X" to extend » sinon, et une commande inconnue n'est dite qu'au chargement ;
 *   - `include` : chemin absolu, `~`, glob (ordre alphabetique, derniere syntaxe definie gagnante), « Error expanding PATTERN »,
 *     « Error reading F: No such file or directory », refus d'un dossier, refus a l'interieur d'une syntaxe ;
 *   - erreurs de rc : « A 'color' command requires a preceding 'syntax' command », « Missing syntax name », « Unpaired quote in
 *     syntax name », « Syntax "t" has no color commands » (aussi apres bind / unbind / set / syntax), « Regex strings must begin
 *     and end with a " character », « Empty regex string », « Bad regex », « "start=" requires a corresponding "end=" ».
 *
 * Mesure : un moteur qui lit les syntaxes sans les evaluer laissait tomber 129 laboratoires sur 139.  Les 10 qui passent avant comme
 * apres sont des TEMOINS ou des cas structurels : l'absence de correspondance (syntax-extension-no-match,
 * syntax-extension-case-sensitive, syntax-header-misses-first-line), les cas sans syntaxe active (syntax-override-none,
 * syntax-override-unknown-without-syntaxes, minus-i-ignores-syntaxes), le motif « delta\tTAB » qui ne reconnait pas une vraie
 * tabulation dans la libc (color-tab-inside-match), les correspondances vides (multi-empty-start-and-end), le `M-3` general
 * sans syntaxe (comment-without-syntax-is-hash), et extend-adds-extension (la commande « extension » n'existe pas, et l'erreur
 * est paresseuse sur une syntaxe qui n'est pas choisie).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-syntax/syntax-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

const UNPORTED_LABS: ReadonlySet<string> = new Set([]);

describe('nano syntax labs recorded from a real nano', () => {
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
