/**
 * La cible d'ouverture de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus open,
 * `nano -I`) : 571 ouvertures de fichier existant, neuf, en sous-dossier, dossier (`sub`, `sub/`, `.`, `..`, `/`),
 * peripherique (`/dev/null`), dossier absent (`nodir/x`, `nodir/a/b.txt`), chemin sous un fichier (`t.txt/x`), nom a
 * barre finale, fichier en lecture seule et chemins `./t.txt`, `sub/../t.txt`, avec 0 a 2 options parmi `-x -l -S -G -v
 * -n -R -t -B -% -_ -0 -e` et 0 a 3 gestes (saisie, ^O avec ou sans Entree, ^X, ^R, ^W, ^C).  Apres chaque etape on
 * compare les rangees du pane, la cellule du curseur et les fichiers du repertoire.  `nano -` (entree standard) n'est
 * pas rejoue.
 *
 * Methode : files.c (open_buffer, has_valid_path, get_full_path, do_writeout) de nano 8.x confronte au binaire 7.2.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul : les coutures de EditorFsContext restent) :
 * 108 cas sur 193 (seed 1), 103 sur 187 (seed 2) et 105 sur 191 (seed 3) tombaient avant, 0 apres.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 2 cas sur 571.  Un cas de la liste qui se met a
 * passer fait echouer le test pour qu'on le retire.
 *   - opn2-162, opn3-112 : ^R en vue seule (-v) ouvre « File to read into new buffer » : la lecture va dans un NOUVEAU
 *     tampon et le moteur n'en a qu'un.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-open';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['opn2-162', 'opn3-112']);

describe('nano open target recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and files on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(c.args));
      expect(ported.length).toBe(fixture.cases.length);
      const outcomes = ported.map((c) => ({ id: c.id, failure: replayNanoCliCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${ported.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
