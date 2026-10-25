/**
 * Fichiers nanorc rejoues contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus rc, tmux 3.4,
 * SANS -I) : chaque cas seme /etc/nanorc (monte par `unshare -m`), ~/.nanorc, ~/.config/nano/nanorc ou
 * $XDG_CONFIG_HOME/nano/nanorc, parfois un fichier donne a -f, puis enchaine une session de nano (options de ligne de
 * commande tirees au hasard parmi les drapeaux, les options a valeur et les erreurs de syntaxe) et sort.  Apres chaque
 * etape on compare les rangees et la cellule du curseur ; a la sortie le texte que nano ecrit sur le terminal, le
 * dossier de travail, l'arbre du $HOME et celui de XDG_DATA_HOME.
 *
 * Methode : rcfile.c et nano.c de nano 7.2 (tarball nano_7.2.orig) pour comprendre, le binaire installe
 * (7.2-2ubuntu0.2) pour trancher.  Le seed 1 a guide les reglages ; les seeds 2 et 3 ont ete enregistres ensuite.  Les
 * regles mesurees sont dans probe-nano-rc.test.ts (78 laboratoires), probe-nano-rc-machine.test.ts (utilisateur ordinaire,
 * droits, session) et ssh-nano-rc.test.ts.
 *
 * Mesure : un moteur qui ne lit aucun nanorc laissait tomber 155 cas sur 200 (seed 1), 153 (seed 2) et 152 (seed 3) ;
 * 0 apres, sauf rcf3-40.  Les 45, 47 et 48 cas qui passent avant comme apres sont ceux ou la ligne de commande l'emporte
 * sur le fichier, ceux de -I et ceux dont les options n'ont pas d'effet visible sur une session.  Le premier jet a aussi
 * montre trois divergences sans rapport avec la lecture des fichiers, corrigees dans le meme changement : la justification
 * applique lead_len EN OCTETS a la premiere ligne (voir probe-nano-justify-bytes.test.ts), les menus de `preserve` et de
 * `saveonexit` ne viennent que de la ligne de commande (le menu est dessine avant la lecture des rc), et les chemins de
 * sauvegarde que le recorder normalise en `!tmp...` sont denormalises avant la comparaison.
 *
 * Cas non porte : rcf3-40, ou nano 7.2 ecrit « Span has underflowed -- please report a bug » sur le terminal (defaut de
 * 7.2 dans le calcul des intervalles du rendu, hors du perimetre des rc) ; un cas de la liste qui se met a passer fait
 * echouer le test et doit en sortir.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const dir = 'src/__tests__/support/oracle/nano-rc';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoStateCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['rcf3-40']);

describe('nano rc files recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays rows, cursor, disk, exit text and state files`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayNanoStateCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 4).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
