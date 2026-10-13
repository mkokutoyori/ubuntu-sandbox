/**
 * L'annulation et le retablissement de nano rejoues contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py
 * --corpus undo et undo2, `nano -I`) : 900 sessions (3 x 200 puis 3 x 100) de quatre a seize gestes melant saisie, Entree, Retour arriere,
 * Suppr, couper / copier / coller, marque, indentation, commentaire, M-T, justification, insertion de fichier,
 * Remplacer, recherche, enregistrement et surtout M-U / M-E, avec 0 a 2 options parmi `-x -l -S -i -E -L -k -Z -A -b -O
 * -M -%`.  Apres chaque etape on compare les rangees du pane, la cellule du curseur et les fichiers du repertoire.
 *
 * Methode : text.c (add_undo, update_undo, do_undo, do_redo, expunge, do_enter, do_wrap, do_comment, justify_text),
 * cut.c (cut_text, zap_text, cut_till_eof, do_snip) et nano.c (inject_into_buffer) de nano 8.x confrontes au binaire 7.2
 * qui fait foi.  Le moteur garde des instantanes (`before`, `after`) plutot que de rejouer les modifications une a
 * une, mais regroupe, nomme et replace le curseur comme nano.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul) : 169, 165 et 160 cas sur 200 (corpus undo, seeds 1
 * a 3) puis 70, 77 et 74 cas sur 100 (corpus undo2, seeds 4 a 6) tombaient avant, 0 apres.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 3 cas sur 900.  Un cas de la liste qui se met a
 * passer fait echouer le test pour qu'on le retire.
 *   - und3-175 : avec -k, nano 7.2 annule une justification en laissant un tampon VIDE (le texte est perdu) : le defaut
 *     n'est volontairement pas reproduit.
 *   - und3-183 : la longueur de l'en-tete d'un paragraphe est un decalage en OCTETS dans nano (un caractere large
 *     coupe en deux dans la premiere ligne change la largeur restante) ; le moteur compte en caracteres.
 *   - un24-6 : frappe au milieu d'une ligne deja trop longue avec -b : nano coupe a un autre blanc que le moteur ; pas
 *     encore analyse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-undo';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['und3-175', 'und3-183', 'un24-6']);

describe('nano undo and redo recorded from a real nano', () => {
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
