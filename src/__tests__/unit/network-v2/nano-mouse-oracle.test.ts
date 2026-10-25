/**
 * La souris de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus mouse,
 * `nano -I -m`, tmux 3.4, rapports SGR injectes) : chaque cas melange touches (deplacements, edition, marque,
 * invites `^W ^O ^R ^\\ ^_`, aide `^G`, question de sortie `^X`) et evenements de souris (clics dans le texte,
 * sur le titre, la rangee d'etat, les barres de raccourcis, dans les invites ; molette ; `click@cursor` pose
 * le clic sur la cellule du curseur du moment) sur des tampons de 2 a 30 lignes, des fenetres de 5 a 24 lignes
 * et les options `-l -S -q -x -_ -0 -e -v -c -%`.  Apres chaque etape on compare les rangees et la cellule du curseur.
 *
 * Methode : process_click(), get_mouseinput() et process_prompt_click() (nano 8.x) confrontes au binaire 7.2,
 * qui fait foi ; les regles mesurees sont dans probe-nano-mouse.test.ts.  Le seed 1 a guide les reglages (54
 * cas sur 200 tombaient au premier jet : touches Echap / Tab / ^T retirees du generateur, clics ignores qui
 * comptent comme des touches, decalage horizontal commun a toutes les rangees, colonne `-q` = clic ordinaire,
 * clic a gauche de la reponse d'une invite qui ne bouge pas) ; les seeds 2 et 3 ont ete enregistres ensuite.
 *
 * Mesure : l'ancien moteur (clic toujours actif, sans barres, invites ni molette) laissait tomber 154 cas sur
 * 200 (seed 1), 165 (seed 2) et 150 (seed 3) ; 0 apres, sauf les cas ci-dessous.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 6 cas.  Aucun n'est epingle comme contrat : un
 * cas de la liste qui se met a passer fait echouer le test pour qu'on le retire.
 *   - mou1-25 : clic sur `^T Browse` de l'invite de ^R ; le navigateur de fichiers n'existe pas ;
 *   - mou2-32, mou2-68, mou2-169 : `^R` en vue seule (`-v`) ouvre « File to read into new buffer » (lecture dans
 *     un nouveau tampon) ; le moteur n'a qu'un tampon et repond « Key is invalid in view mode » ;
 *   - mou3-100 : clic sur `M-F New Buffer` de l'invite de ^R, meme cause (plusieurs tampons) ;
 *   - mou2-72 : avec `-0` la rangee de texte couverte par l'invite n'est pas redessinee par nano quand `^O` ferme
 *     l'invite sans defilement ; le moteur la repeint toujours (voir TODO.md, [nano] repeint incremental).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted } from '../../support/oracle/nanoCliReplay';
import { recordedArguments, replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

const dir = 'src/__tests__/support/oracle/nano-mouse';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoScreenCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'mou1-25', 'mou2-32', 'mou2-68', 'mou2-72', 'mou2-169', 'mou3-100',
]);

describe('nano mouse sessions recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows and cursor cell`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(recordedArguments(c)));
      expect(ported.length).toBeGreaterThan(100);
      const outcomes = ported.map((c) => ({ id: c.id, failure: replayNanoScreenCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${ported.length}\n${unexpected.slice(0, 4).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
