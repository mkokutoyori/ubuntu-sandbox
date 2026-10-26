/*
 * Laboratoires du paquet nano d'Ubuntu enregistres contre un vrai nano 7.2 qui lit le vrai /etc/nanorc (record_nano_screen.py --corpus
 * package --from labs).  Chaque laboratoire ouvre un fichier dont le nom ou la premiere ligne designe une des 42 syntaxes livrees, ou
 * exerce un des trois reglages par defaut d'Ubuntu, et rejoue rangees, curseur et couleur de chaque cellule.
 *
 * Regles mesurees :
 *   - toutes les syntaxes livrees (c, cpp, python, sh, perl, json, yaml, xml, html, css, javascript, go, ruby, sql, markdown, asm, man,
 *     cmake, makefile, elisp, tcl, debian, java, rust, patch, guile, haskell, ocaml, autoconf, nftables, tex, texinfo, php, lua, awk, po,
 *     objc, email, changelog, spec, povray, nanorc, groff, sources.list) colorent leur exemple comme nano, y compris les regles
 *     `start=` / `end=` ; la syntaxe `default` colore les dates, les adresses, les URL, les commentaires, les espaces avant une tabulation
 *     et les codes de controle de n'importe quel texte ;
 *   - choix : l'extension, puis l'en-tete de la premiere ligne (`#!/bin/sh`, `<?xml`, `<!DOCTYPE html>`, `-*- C -*-`...), puis le nom
 *     (Makefile, CMakeLists.txt, ChangeLog, sources.list, .bashrc, control), puis `default` ; -Y force une syntaxe, `none` la coupe ;
 *   - `comment` de chaque syntaxe pour M-3 (`//`, `#`, `--`, `-- `, `;`, `%`, `@c `, `<!--|-->`, le bloc C de css, `(*|*)`, `.\"`) et le refus pour
 *     json et patch (« Commenting is not supported for this file type ») ; yaml donne deux espaces au Tab et refuse M-O ;
 *   - `set stateflags` : le drapeau I (-i), S (-S), M (marque) dans la barre de titre, y compris sur une fenetre etroite ;
 *   - `set historylog` : une recherche, un remplacement sont ecrits dans ~/.local/share/nano/search_history a la sortie et relus au
 *     lancement suivant ; -I les ignore ;
 *   - `set locking` : le verrou `.t.c.swp` du dossier est pose a l'ouverture, retire a la sortie ; la vue (-v) n'en pose pas ;
 *   - un ~/.nanorc passe apres /etc/nanorc : `unset locking`, `unset stateflags`, `extendsyntax c ...` et une syntaxe qui redefinit
 *     `\.c$` l'emportent, et -f remplace /etc/nanorc et ~/.nanorc.
 *
 * Mesure : sans les fichiers du paquet 113 laboratoires sur 115 tombent.  Les 2 qui passent avant comme apres sont des TEMOINS :
 * package-historylog-off-by-minus-I (-I ignore tout rc, le paquet compris) et package-home-minus-f-skips-package (-f remplace
 * /etc/nanorc par un rc qui ne fait que `set linenumbers`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-package/package-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

const UNPORTED_LABS: ReadonlySet<string> = new Set([]);

describe('nano package labs recorded from a real nano', () => {
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
