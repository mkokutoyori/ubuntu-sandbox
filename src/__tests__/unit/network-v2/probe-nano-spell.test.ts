/*
 * Correcteur orthographique de nano (^T ^S, `-s PROGRAMME`, `set speller`) rejoue contre un vrai nano 7.2 : 46 laboratoires enregistres sous tmux
 * (scripts/oracle/record_nano_screen.py, corpus `lint`, fixtures nano-spell/spell-labs.json).  Le programme est un script sh pose dans le
 * dossier du laboratoire ; la commande tourne VRAIMENT dans le binaire comme dans le rejeu (LinuxPC simulee).
 *
 * Avec le moteur precedent (la valeur `speller` rangee dans les reglages et jamais lancee, ^T ^S repondant toujours « Error invoking "spell" »)
 * 38 laboratoires sur 46 tombent ; 0 apres.  Les 8 qui passent avant comme apres sont des TEMOINS : le correcteur interne absent de la
 * machine d'enregistrement (spell-internal-speller-missing, -missing-modified, -empty-buffer, -with-mark), l'entree du menu toujours
 * affichee (spell-menu-entry-always-shown), une valeur vide ou absente qui laisse le correcteur interne (spell-empty-rc-value-means-internal,
 * spell-rc-value-without-argument) et le mode restreint (spell-restricted-mode).  Le test de version passe aussi dans les deux etats.
 *
 * Lu dans text.c (do_spell, do_int_speller, do_alt_speller, treat) du tarball nano_7.2.orig : la valeur non guillemetee d'un `set speller`
 * ne garde que son premier mot (parse_argument), la marque limite le texte confie au programme a la selection (write_region_to_file
 * TEMPORARY, sans retour a la ligne ajoute), le code de retour 1 ou 2 fait dire « Program 'X' complained », plus de 2 « Error invoking 'X' »,
 * une date de modification inchangee « Nothing changed », sinon le tampon (ou la selection) est remplace, annulable (« spelling correction »),
 * puis « Finished checking spelling ».  Le correcteur interne (hunspell ou spell) n'existe pas dans la machine : voir TODO.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-spell/spell-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

const UNPORTED_LABS: ReadonlySet<string> = new Set([]);

describe('nano speller labs recorded from a real nano', () => {
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
