/*
 * Laboratoires du linter (`^T ^Y`, `M-B`) et du formateur (`^T ^O`, `M-F`) de nano enregistres contre un vrai nano 7.2 (record_nano_screen.py
 * --corpus lint --from labs ; sources lues dans text.c : do_linter, do_formatter, treat, replace_buffer, et files.c : safe_tempfile,
 * write_it_out).  Chaque laboratoire seme un `~/.nanorc` qui declare `linter` / `formatter` pour `t.txt`, des scripts `sh` qui jouent le
 * role du programme (sortie et code de retour au choix) et rejoue rangees, curseur et couleur de chaque cellule APRES que la commande ait
 * vraiment tourne (le rejeu la confie a une LinuxPC, comme pour `^T`).  `settle` laisse passer les 600 ms de « At first / last message »,
 * que le moteur ne modelise pas : on compare l'etat apres le delai.
 *
 * Linter :
 *   - sans linter pour la syntaxe choisie (ou sans syntaxe) : « No linter is defined for this type of file » ; la marque est abandonnee ;
 *     un tampon modifie demande « Save modified buffer before linting? » : oui ecrit AU MEME NOM sans invite (une invite « File Name to
 *     Write » seulement si le tampon n'a pas de nom), non lance le linter sur le fichier du disque, ^C affiche « Cancelled » ;
 *   - la commande est la chaine `linter` coupee sur les espaces, le nom du fichier en dernier argument, sortie et erreur melangees ; un code
 *     de retour superieur a 2 donne « Error invoking 'LINTER' » (chaine complete), aucune ligne reconnue « Got 0 parsable lines from
 *     command: LINTER » ;
 *   - une ligne est « fichier:ligne:colonne: message », « fichier:ligne,colonne: message » ou « fichier:ligne: message » (colonne 1) ; le
 *     message est ce qui suit le PREMIER espace ; une ligne sans espace est ignoree ; un numero de ligne nul ou negatif est ignore ET fait
 *     perdre la ligne suivante (la boucle de nano 7.2 ne passe pas a la ligne d'apres : defaut reproduit tel quel) ;
 *   - affichage : titre « Linting -- NOM », barres reduites a Help / Cancel / Previous Linter message / Next Linter message (meme avec -x,
 *     -0 ou -_), message au centre de la barre d'etat, curseur sur la ligne et la colonne indiquees (colonne en cellules d'ecran, tabulations
 *     comprises, bornee a la ligne), vue recentree sur la ligne ; PageUp / ^Y et PageDown / ^V changent de message, ^C / ^X / Entree sortent
 *     et laissent la barre d'etat vide, ^G ouvre l'aide « === Linter === » et la fermeture reaffiche le message, les autres touches n'ont
 *     aucun effet ;
 *   - un message pour un AUTRE fichier existant demande « This message is for unopened file F, open it in a new buffer? » : non retire les
 *     messages de ce fichier (et sort si aucun ne reste), ^C sort ; pour un fichier absent il vaut pour le tampon ouvert.  « Oui » ouvre un
 *     nouveau tampon : non porte (tampons multiples), il n'a pas de laboratoire ;
 * Formateur :
 *   - sans formateur : « No formatter is defined for this type of file » ; sinon le tampon est ecrit dans `nano.XXXXXX` + l'extension du
 *     nom, dans $TMPDIR s'il est un dossier accessible, sinon /tmp/ ; la commande recoit ce fichier en dernier argument ; tampon vide :
 *     « Buffer is empty » ; code de retour superieur a 2 : « Error invoking 'PROGRAMME' » (premier mot seulement) ; code 1 ou 2 : « Program
 *     'PROGRAMME' complained », message que « Nothing changed » et « Buffer has been processed » ne remplacent pas (un message moins
 *     important que le precedent est ignore) ;
 *   - date de modification du fichier temporaire inchangee : « Nothing changed » ; sinon le tampon est remplace par le contenu du fichier,
 *     le curseur reste sur la meme ligne et la meme colonne (fin de ligne retrouvee, colonne voulue conservee), la marque est abandonnee,
 *     le tampon est modifie et M-U annule « formatting » ; un programme qui reecrit le meme texte compte comme un changement.
 *
 * Mesure : avec un moteur dont ^Y et ^O repondent toujours « No ... is defined » (le commit precedent), 78 laboratoires sur 87 tombent.  Les
 * 9 qui passent avant comme apres sont des TEMOINS : lint-no-syntax-at-all, lint-syntax-without-linter, lint-shortcut-without-linter,
 * lint-menu-entries-always-shown, lint-view-mode-has-no-execute-menu, lint-linter-without-argument, format-no-syntax-at-all,
 * format-syntax-without-formatter et format-shortcut-without-formatter (les cas ou nano repond lui aussi qu'aucun programme n'est defini).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-lint/lint-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

const UNPORTED_LABS: ReadonlySet<string> = new Set([]);

describe('nano linter and formatter labs recorded from a real nano', () => {
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
