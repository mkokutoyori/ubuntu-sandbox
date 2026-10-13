/**
 * Les modes d'outil de nano rejoues contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus tools,
 * `nano -I`) : 600 sessions de trois a neuf etapes sur un fichier existant ou neuf, avec un a deux de `-t` (sauvegarde en
 * sortie), `-n` (pas de lecture) et `-R` (restreint), plus `-B -L -l -x -% -k -E -S`, qui melangent saisie, selection,
 * ^K / ^U, ^O et ses bascules (M-D M-M M-A M-P M-B, nom tape, ^Q, ^C), ^R / ^T (refus ou annulation), ^X avec ses reponses
 * et Location.  Apres chaque etape on compare les rangees du pane, la cellule du curseur et les fichiers du repertoire
 * (caches compris) ; un `Discard buffer` ou une sortie sont suivis du contenu final du repertoire.
 *
 * Methode : nano.c (do_exit), files.c (write_it_out), prompt.c (get_prompt_string, handle_editing, ask_user) et global.c
 * (shortcut_init, shown_entries_for) de nano 8.x confrontes au binaire 7.2 qui fait foi.  Trouve en route par ce
 * corpus : ^K, ^U et M-6 agissent sur la reponse des invites (le tampon de coupe est partage avec le texte) ; une
 * reponse vide a ^R annule ; ^N et ^Q repondent Non et ^Y Oui aux questions oui/non ; Location compte un caractere par
 * saut de ligne quel que soit le format.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 176 cas sur 200 (seed 1), 179 (seed 2) et
 * 176 (seed 3) tombaient avant, 0 apres.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 3 cas sur 600, qui ouvrent le navigateur de fichiers
 * (^T dans l'invite d'ecriture).  Un cas de la liste qui se met a passer fait echouer le test pour qu'on le retire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-tools';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['tol1-72', 'tol2-53', 'tol3-75']);

describe('nano tool modes recorded from a real nano', () => {
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
