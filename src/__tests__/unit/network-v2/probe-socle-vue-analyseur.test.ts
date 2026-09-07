/*
 * Sonde ECRITE A L'AVEUGLE sur le sous-mode `parser view`, avant toute
 * lecture de ses declarations.
 *
 * LA REFERENCE N'A PAS PU ETRE ATTEINTE : cisco.com est bloque par le
 * mandataire de sortie de ce reseau. Rien n'est donc invente. Ce que la
 * sonde exige vient de ce qui est atteignable :
 *   - la grammaire que le MOTEUR evalue : `commands <mode> {include |
 *     include-exclusive | exclude} [all] <commande>`, ou `<mode>` est
 *     l'un des quatre espaces de nommage d'`AUTH_SCOPE_VALUES` ;
 *   - `parser view <nom> [superview]`, `secret <mot>`, `view <membre>` ;
 *   - la forme `commands exec include all show`, que le depot cite de
 *     la documentation Cisco.
 *
 * Ce que la sonde mesure ne demande aucune reference exterieure : `?`
 * ne peut pas promettre un `<cr>` que la meme machine refuse, et un mot
 * que la machine ACCEPTE doit etre annonce comme un mot, pas cache dans
 * la phrase qui decrit un autre argument.
 *
 * POURQUOI CELA COUTE CHER ICI PLUS QU'AILLEURS : une vue d'analyseur
 * EST le mecanisme d'autorisation. `commands exec include` valide en
 * apparence — `?` annonce `<cr>` — mais ne pose aucune regle ; la vue
 * reste vide, et une vue vide ne montre rien a qui la porte. L'operateur
 * croit avoir accorde `show version` a son equipe et lui a ferme la CLI.
 *
 * Discriminee contre l'etat d'avant : 16 des 74 cas tombent. Les 58
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - toute la tete `parser view` passait deja — declaration, nom
 *     manquant, mot de trop, `superview`, `no parser view` : elle
 *     etait GLOUTONNE, mais son gestionnaire controlait son unique mot
 *     de suite et refusait le reste. Ces cas gardent que la migration
 *     ne lui a rien pris ;
 *   - `secret`, `view` et leurs refus passaient pour la meme raison ;
 *     `%View is not a superview`, `%Error: View … is not present` et
 *     `%Command not found` sont des verdicts du MOTEUR, que la
 *     migration ne deplace pas ;
 *   - `commands ?` annoncait deja ses quatre espaces et `commands exec
 *     ?` ses trois sens : l'adaptateur du trie les declarait. C'est
 *     leur ARITE qu'il ne savait pas dire — d'ou le `<cr>` — et le mot
 *     `all`, cache dans la PHRASE qui decrit un autre argument au lieu
 *     d'etre un mot ;
 *   - `une regle se pose et se relit` et `\`all\` se pose et se relit`
 *     sont les TEMOINS : ils passent des deux cotes, et doivent, sinon
 *     le laboratoire ne mesure rien. Ce sont eux qui prouvent que
 *     retirer les trois noeuds du trie n'a pas emporte la famille ;
 *   - les trois saisies croisees entre plateformes passaient : les deux
 *     Cisco partagent `CiscoShellBase`, donc leurs refus etaient deja
 *     mot pour mot les memes. Elles restent parce que la refonte aurait
 *     pu les separer.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

async function jouer(d: Cli, lignes: readonly string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

const AMORCE = ['enable', 'configure terminal', 'aaa new-model'];

let serie = 0;

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter(`R${serie++}`) as unknown as Cli;
  r.powerOn();
  await jouer(r, AMORCE);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', `SW${serie++}`, 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, AMORCE);
  return s;
}

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

async function dansLaVue(fabrique: () => Promise<Cli>): Promise<Cli> {
  const d = await fabrique();
  await d.executeCommand('parser view NOC');
  return d;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const ESPACES = ['configure', 'exec', 'interface', 'line'] as const;
const SENS = ['include', 'include-exclusive', 'exclude'] as const;

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`parser view\` sur un ${nom}`, () => {
    it('la vue se declare et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('parser view NOC')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('parser view NOC');
    });

    it('`superview` se declare et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('parser view SUP superview')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('parser view SUP superview');
    });

    it('sans nom, elle est INCOMPLETE — le TEMOIN', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('parser view')).toMatch(/Incomplete command/);
    });

    it('un mot de trop est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('parser view NOC zorglub')).toMatch(/Invalid input/);
    });

    it('`no parser view` retire la vue', async () => {
      const d = await fabrique();
      await jouer(d, ['parser view NOC', 'exit']);
      expect(await d.executeCommand('no parser view NOC')).not.toMatch(REFUS);
      expect(await conf(d)).not.toContain('parser view NOC');
    });

    it('`no parser view` sans nom est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('no parser view')).toMatch(/Incomplete command/);
    });
  });

  describe(`\`commands\` sous une vue, sur un ${nom}`, () => {
    for (const espace of ESPACES) {
      it(`\`commands ${espace} ?\` ne promet pas de \`<cr>\``, async () => {
        const d = await dansLaVue(fabrique);
        expect(annonceCr(d.cliHelp(`commands ${espace} `))).toBe(false);
        expect(await d.executeCommand(`commands ${espace}`))
          .toMatch(/Incomplete command/);
      });

      it(`\`commands ${espace} ?\` annonce les trois sens`, async () => {
        const d = await dansLaVue(fabrique);
        expect(mots(d.cliHelp(`commands ${espace} `)))
          .toEqual(expect.arrayContaining([...SENS]));
      });
    }

    it('`commands ?` annonce les quatre espaces', async () => {
      const d = await dansLaVue(fabrique);
      expect(mots(d.cliHelp('commands '))).toEqual(expect.arrayContaining([...ESPACES]));
    });

    for (const sens of SENS) {
      it(`\`commands exec ${sens} ?\` annonce \`all\``, async () => {
        const d = await dansLaVue(fabrique);
        expect(mots(d.cliHelp(`commands exec ${sens} `))).toContain('all');
      });

      it(`\`commands exec ${sens}\` seul est INCOMPLET`, async () => {
        const d = await dansLaVue(fabrique);
        expect(await d.executeCommand(`commands exec ${sens}`))
          .toMatch(/Incomplete command/);
      });
    }

    it('`commands exec include all ?` ne promet pas de `<cr>`', async () => {
      const d = await dansLaVue(fabrique);
      expect(annonceCr(d.cliHelp('commands exec include all '))).toBe(false);
      expect(await d.executeCommand('commands exec include all'))
        .toMatch(/Incomplete command/);
    });

    it('`commands exec include all ?` ne redit plus `all`', async () => {
      const d = await dansLaVue(fabrique);
      expect(mots(d.cliHelp('commands exec include all '))).not.toContain('all');
    });

    it('une regle se pose et se relit', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('commands exec include show version'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toContain('commands exec include show version');
    });

    it('`all` se pose et se relit', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('commands exec include all show')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('commands exec include all show');
    });

    it('un espace de nommage invente est refuse', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('commands zorglub include show'))
        .toMatch(/Invalid input/);
    });

    it('un sens invente est refuse', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('commands exec zorglub show'))
        .toMatch(/Invalid input/);
    });

    it('une commande INEXISTANTE ne pose pas de regle', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('commands exec include zorglub'))
        .toContain('%Command not found');
      expect(await conf(d)).not.toContain('zorglub');
    });
  });

  describe(`\`secret\` et \`view\` sous une vue, sur un ${nom}`, () => {
    it('`secret` seul est INCOMPLET', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('secret')).toMatch(/Incomplete command/);
    });

    it('`secret ?` ne promet pas de `<cr>`', async () => {
      const d = await dansLaVue(fabrique);
      expect(annonceCr(d.cliHelp('secret '))).toBe(false);
    });

    it('le secret se pose', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('secret Cisco123!')).not.toMatch(REFUS);
    });

    it('`view` seul est INCOMPLET', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('view')).toMatch(/Incomplete command/);
    });

    it('une vue MEMBRE ne rejoint qu une superview', async () => {
      const d = await dansLaVue(fabrique);
      expect(await d.executeCommand('view AUTRE')).toContain('%View is not a superview');
    });

    it('une superview accepte un membre EXISTANT', async () => {
      const d = await fabrique();
      await jouer(d, ['parser view MEMBRE', 'exit', 'parser view SUP superview']);
      expect(await d.executeCommand('view MEMBRE')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('view MEMBRE');
    });

    it('une superview refuse un membre ABSENT', async () => {
      const d = await fabrique();
      await jouer(d, ['parser view SUP superview']);
      expect(await d.executeCommand('view ZORG'))
        .toContain('%Error: View ZORG is not present in the system');
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'parser view',
    'parser view NOC zorglub',
    'no parser view',
  ];
  for (const saisie of SAISIES) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
      const cote = nettoie(await r.executeCommand(saisie));
      expect(cote.length).toBeGreaterThan(0);
      expect(nettoie(await s.executeCommand(saisie))).toBe(cote);
    });
  }

  it('annoncent le meme vocabulaire sous `commands exec`', async () => {
    const r = await dansLaVue(routeur); const s = await dansLaVue(commutateur);
    expect(mots(r.cliHelp('commands exec ')).sort())
      .toEqual(mots(s.cliHelp('commands exec ')).sort());
  });
});
