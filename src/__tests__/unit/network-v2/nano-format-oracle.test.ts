/*
 * Les fins de ligne de nano rejouees contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus cli
 * --from, `nano -I`) : 900 fichiers aleatoires melant LF, CRLF, CR isoles, CR en fin de fichier et lignes vides, ouverts
 * seuls ou avec `-u`, `-N`, `-L`, puis enregistres avec ^O (sans ou avec M-D / M-M).  Apres chaque etape on compare les
 * rangees du pane (caracteres de controle compris : `^M`), la cellule du curseur et les octets du fichier.
 *
 * Methode : files.c (read_file, write_file, get_newline_format) de nano 8.x confronte au binaire 7.2 qui fait foi.  Ce
 * que le binaire a montre : un CR final est retire et suivi d'une ligne vide meme avec -L ; le format Mac ne se decide
 * que sur la premiere ligne ; le nombre de lignes lues compte la ligne partielle finale mais pas la ligne magique.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 201 cas sur 300 (seed 1), 230 (seed 2) et
 * 236 (seed 3) tombaient avant, 0 apres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted, replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-format';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

describe('nano line endings recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and bytes on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(c.args));
      expect(ported.length).toBe(fixture.cases.length);
      const failures = ported.map((c) => replayNanoCliCase(c)).filter((f): f is string => f !== null);
      expect(failures.length > 0 ? `${failures.length} of ${ported.length}\n${failures.slice(0, 3).join('\n')}` : '').toBe('');
    });
  }
});
