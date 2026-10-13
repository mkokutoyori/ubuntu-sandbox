/**
 * ^R Read File de nano rejoue contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus insert,
 * `nano -I`) : 600 sessions de un a huit gestes dans des fenetres de 6 a 24 lignes, melant saisie, deplacements,
 * selection, ^K / ^U, des insertions de fichiers (avec ou sans saut de ligne final, vide, DOS, long de 30 lignes,
 * absent, dossier, `.`, nom vide, M-N, ^C) et ^O.  Apres chaque etape on compare les rangees du pane, la cellule du
 * curseur et les fichiers du repertoire.
 *
 * Methode : files.c (insert_a_file_or, open_buffer, read_file, open_file) et winio.c (less_than_a_screenful,
 * go_back_chunks) de nano 8.x confrontes au binaire 7.2 qui fait foi.  Le chemin `~/x` n'est pas rejoue : nano le
 * developpe avec le HOME reel du processus.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 161 cas sur 200 (seed 1), 157 (seed 2) et
 * 152 (seed 3) tombaient avant, 0 apres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-insert';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

describe('nano Read File recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and files on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(c.args));
      expect(ported.length).toBe(fixture.cases.length);
      const failures = ported.map((c) => replayNanoCliCase(c)).filter((f): f is string => f !== null);
      expect(failures.length > 0 ? `${failures.length} of ${ported.length}\n${failures.slice(0, 3).join('\n')}` : '').toBe('');
    });
  }
});
