/*
 * Justification d'un paragraphe dont la premiere ligne porte des caracteres multi-octets avant la fin de l'indentation
 * de la ligne d'exemple, enregistree contre un vrai nano 7.2 (record_nano_screen.py --corpus rc --from labs ; sources lues
 * dans justify.c / text.c du tarball nano_7.2.orig, le binaire 7.2-2ubuntu0.2 tranche).
 *
 * Regle mesuree : do_justify calcule lead_len EN OCTETS sur la ligne d'exemple (la deuxieme du paragraphe, sinon la
 * premiere) puis l'applique a la premiere ligne, ou break_line() demarre a `line + lead_len` : un lead_len qui tombe au
 * milieu d'un caractere fait demarrer la recherche de coupure sur un octet de continuation, et wideness() compte la
 * largeur du caractere entame.  Une premiere ligne moins indentee que la deuxieme appartient au meme paragraphe
 * (begpar), c'est le seul cas ou le decalage en octets rencontre un caractere multi-octets.
 *
 * Mesure : avec l'ancien rewrapParagraph (lead_len en unites UTF-16) 3 des 10 tests tombent
 * (jb-first-line-multibyte-before-sample-lead, jb-quoted-first-line-multibyte, jb-full-justify-two-paragraphs) ; les
 * sept autres passent avant comme apres : le test de version, les TEMOINS jb-ascii-witness, jb-equal-indent-multibyte-
 * witness et jb-no-indent-multibyte-witness (pas de decalage entre octets et unites), et trois laboratoires ou la coupure
 * tombe au meme endroit par coincidence (jb-first-line-cjk-before-tab-lead, jb-first-line-four-byte-before-indent,
 * jb-break-after-lead-bytes), gardes comme non-regression.  Le defaut a ete vu d'abord sur le cas aleatoire rcf1-163 du
 * corpus rc, dont ce fichier isole la cause.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/nano-rc/justify-bytes-labs.json', 'utf8')) as { nano: string; cases: NanoStateCase[] };

describe('nano justify cuts the first line at the byte length of the sample lead, recorded from a real nano', () => {
  it('records the version the labs were measured on', () => {
    expect(recorded.nano).toContain('7.2');
  });

  for (const lab of recorded.cases) {
    it(lab.id, () => {
      expect(replayNanoStateCase(lab)).toBeNull();
    });
  }
});
