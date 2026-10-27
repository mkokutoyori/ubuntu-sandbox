/*
 * Laboratoires des fichiers nanorc enregistres contre un vrai nano 7.2 (record_nano_screen.py --corpus rc --from labs ;
 * sources lues dans rcfile.c et nano.c du tarball nano_7.2.orig).  Chaque laboratoire seme un ou plusieurs rc et lance nano
 * sans -I (sauf ceux qui le testent) ; le test rejoue le moteur et compare rangees, curseur, texte de sortie, dossier de
 * travail et arbres du $HOME.
 *
 * Regles mesurees :
 *   - ordre : /etc/nanorc, puis le premier bon de ~/.nanorc, $XDG_CONFIG_HOME/nano/nanorc, ~/.config/nano/nanorc (un
 *     ~/.nanorc qui est un dossier est saute, un nom de dossier XDG vide aussi) ; -f remplace les deux (« Specified rcfile
 *     does not exist », un dossier donne « "F/" is a directory ») ; -I (--ignorercfiles) les ignore tous, -f compris ;
 *   - syntaxe : set / unset, mots-cles sensibles a la casse, guillemets, CRLF et commentaires, derniere ligne sans saut
 *     de ligne ; chaque erreur donne « Error in F on line N: ... » a la sortie et « Mistakes in 'F' » au demarrage, le
 *     fichier nomme etant celui de la premiere erreur ;
 *   - fusion : un drapeau vaut ligne de commande OU derniere operation de rc ; une option a valeur vient de la ligne de
 *     commande si elle y est ; `unset nowrap` active la coupure automatique et -w / -b l'emportent ; `zero` implique
 *     nohelp, `restricted` desactive sauvegardes et journaux ; les menus de preserve et saveonexit ne viennent que de la
 *     ligne de commande ; `magic` est inconnu (cet Ubuntu n'a pas libmagic) ;
 *   - valeurs : tabsize, guidestripe, fill, punct, brackets, quotestr invalides remettent la valeur par defaut.
 *
 * Mesure : un moteur qui ne lit aucun nanorc laissait tomber 54 laboratoires sur 78.  Les 24 qui passent avant comme apres
 * sont des TEMOINS ou des cas structurels : la ligne de commande l'emporte (rc-cmdline-flag-beats-unset,
 * rc-tabsize-cmdline-wins, rc-guidestripe-cmdline-wins, rc-fill-cmdline-wins, rc-quotestr-cmdline-wins,
 * rc-breaklonglines-then-cmdline-w, rc-cmdline-b-with-set-nowrap, rc-casesensitive-plus-C-modifier,
 * rc-regexp-plus-R-modifier, rc-operatingdir-cmdline-wins) ; -I ignore tout (rc-ignored-by-I,
 * rc-ignored-by-long-ignorercfiles, rc-f-missing-with-I) ; les menus viennent de la ligne de commande
 * (rc-preserve-menus-from-cmdline-only, rc-preserve-in-menus-when-cmdline, rc-saveonexit-cmdline) ; des options sans
 * attribut enregistre (rc-guidestripe, rc-boldtext-quickblank) ; un verrou retire avant la sortie (rc-locking) ; des
 * options sans effet de session sur un fichier court (rc-noconvert-unix-trimblanks, rc-home-beats-xdg,
 * rc-set-nowrap-is-the-default) ; un nom de dossier XDG vide (rc-xdg-empty-dir-name) ; et le laboratoire non porte ci-dessous.
 *
 * Laboratoire non porte : rc-ignored-unsupported-commands (bind, unbind, syntax, color, include) attend un moteur qui les
 * evalue ; le test exige qu'il echoue encore et le fera sortir de la liste le jour ou il passera.  Ces commandes sont
 * acceptees sans effet pour l'instant (TODO.md).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-rc/rc-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

const UNPORTED_LABS: ReadonlySet<string> = new Set(['rc-ignored-unsupported-commands']);

describe('nano rc file labs recorded from a real nano', () => {
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
