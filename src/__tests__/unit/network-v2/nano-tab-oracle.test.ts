/**
 * La completion par Tab de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus
 * tab, `nano -I`, tmux 3.4) : chaque cas pose une arborescence de 3 a 40 fichiers (dossiers, noms caches, majuscules,
 * non ASCII, espaces), construit parfois un historique de recherche / remplacement, puis ouvre `^R`, `^O`, `^W`, `^\\`
 * ou `^T` et appuie sur Tab apres un fragment (dossier, prefixe commun, nom unique, aucun), entre des frappes, des
 * deplacements du curseur et des annulations, dans des fenetres de 5 a 24 lignes et de 14 a 100 colonnes.  Apres chaque
 * etape on compare les rangees et la cellule du curseur.
 *
 * Methode : input_tab(), filename_completion(), diralphasort() de files.c et acquire_an_answer() de prompt.c (nano 8.x)
 * confrontes au binaire 7.2, qui fait foi ; les regles mesurees sont dans probe-nano-tab.test.ts.  Le seed 1 a guide les
 * reglages (12 cas sur 200 au premier jet : tri sans casse, liste qui doit disparaitre avec la question « Save file under
 * DIFFERENT NAME? », et deux messages de bash que nano relaie) ; les seeds 2 et 3 ont ete enregistres ensuite.
 *
 * Mesure : l'ancien moteur (Tab sans effet dans les invites) laissait tomber 113 cas sur 200 (seed 1), 123 (seed 2) et
 * 119 (seed 3) ; 0 apres, sauf le cas ci-dessous.  Le premier jet a aussi montre trois defauts du shell simule, corriges
 * dans le meme changement : une commande contenant un « / » qui n'existe pas disait « command not found » (bash dit
 * « No such file or directory », ou « Is a directory » pour un dossier), et `.` ou `source` sans argument ne disaient rien.
 *
 * Divergence connue, mesuree et NON portee (UNPORTED_CASES) : 1 cas.  Aucun n'est epingle comme contrat : un cas de la
 * liste qui se met a passer fait echouer le test pour qu'on le retire.
 *   - tab3-99 : `^T Browse` de l'invite d'ecriture ouvre le navigateur de fichiers, qui n'existe pas.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted } from '../../support/oracle/nanoCliReplay';
import { recordedArguments, replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

const dir = 'src/__tests__/support/oracle/nano-tab';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoScreenCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['tab3-99']);

describe('nano tab completion sessions recorded from a real nano', () => {
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
