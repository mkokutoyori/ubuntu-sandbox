/**
 * La justification et la coupure de ligne de nano rejouees contre un vrai GNU nano 7.2 (scripts/oracle/
 * record_nano_screen.py --corpus wrap, `nano -I`) : chaque cas est un tampon de un a quatre paragraphes (citations
 * `> ` `# ` `// `, indentations, blancs en fin de ligne, mots a tabulation), 0 a 3 options parmi `-O -M -b -r -i -w
 * -S -a -k -E` et des touches qui exercent `^J`, `M-J`, la marque, la frappe de longues phrases et les
 * deplacements.  Apres chaque etape on compare les rangees du pane, la cellule du curseur et les fichiers du
 * repertoire.  Le recorder envoie le texte tape un caractere a la fois : nano coupe une rafale de caracteres une
 * seule fois, a sa fin.
 *
 * Methode : text.c (do_wrap, break_line, begpar, inpar, find_paragraph, concat_paragraph, squeeze, rewrap_paragraph,
 * justify_paragraph, justify_text), move.c (do_para_begin / end) et winio.c (get_softwrap_breakpoint) de nano 8.x,
 * confrontes au binaire 7.2 qui fait foi.  Ce que le binaire a montre : la coupe garde l'espace de fin de ligne sans
 * `-M` ; la largeur est `COLS - 8` quand `fill` est negatif (le moteur justifiait a 72) ; la marque reste au debut
 * de la region apres la justification de la selection et le curseur va a la fin du texte replace, sans echange
 * de la marque et du curseur ; `M-J` replace le curseur sur le numero de ligne qu'il avait ; couper la region
 * remet une ligne magique avant le collage, si bien qu'une selection qui finit sur la derniere ligne en laisse une de
 * plus.  Trouve en route : `Enter` et les coupures automatiques font suivre la fenetre (focusing) ; taper dans une
 * ligne qui change de nombre de segments en `-S` aussi ; couper la ligne du haut de la fenetre garde la rangee du
 * curseur ; un collage sans rien a coller ou un `^K` qui ne coupe rien gardent la colonne souhaitee.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 127 cas sur 300 (seed 1), 137 sur 300
 * (seed 2) et 138 sur 300 (seed 3) tombaient avant, 0 apres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted } from '../../support/oracle/nanoCliReplay';
import { recordedArguments, replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

const dir = 'src/__tests__/support/oracle/nano-wrap';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoScreenCase[] }) }));

describe('nano justification and hard wrapping recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and file on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(recordedArguments(c)));
      expect(ported.length).toBe(fixture.cases.length);
      const failures = ported.map((c) => replayNanoScreenCase(c)).filter((f): f is string => f !== null);
      expect(failures.length > 0 ? `${failures.length} of ${ported.length}\n${failures.slice(0, 3).join('\n')}` : '').toBe('');
    });
  }
});
