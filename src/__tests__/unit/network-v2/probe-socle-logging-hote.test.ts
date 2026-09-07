/*
 * Sonde ECRITE A L'AVEUGLE sur la forme HERITEE `logging <adresse>`,
 * avant toute lecture de sa declaration.
 *
 * LA REFERENCE N'A PAS PU ETRE ATTEINTE : cisco.com est bloque par le
 * mandataire de sortie de ce reseau. Rien n'est donc invente ici. Ce
 * que la sonde exige vient de deux sources qui, elles, sont
 * atteignables :
 *   - la grammaire que le MOTEUR evalue deja
 *     (`LoggingConfig.applyHost`) : `logging host <ip> [discriminator
 *     <nom>] [transport {udp|tcp} [port <1-65535>]]`, le nom d'un
 *     discriminateur devant EXISTER ;
 *   - la forme heritee `logging <ip>`, qu'IOS range en `logging host
 *     <ip>` dans la configuration.
 * Les mots qu'IOS accepte peut-etre ailleurs — `vrf`, `xml`,
 * `filtered`, `sequence-num-session` — ne sont ni exiges ni refuses par
 * cette sonde : le moteur ne les porte pas, et rien d'atteignable ne
 * dit ce qu'ils feraient.
 *
 * Ce que la sonde mesure est une CONTRADICTION interne, qui ne demande
 * aucune reference exterieure : deux ecritures d'une meme commande ne
 * peuvent pas annoncer deux vocabulaires differents, et `?` ne peut pas
 * proposer un mot que la meme machine refuse a la meme place. Les deux
 * sont mesurables sur la machine seule.
 *
 * Discriminee contre l'etat d'avant : 18 des 82 cas tombent. Les 64
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - tout ce que la forme NOMMEE accepte passait deja, et le doit :
 *     `logging host <ip>` etait declare sur le socle depuis sa
 *     migration. Ces cas gardent que la refonte ne lui a rien pris —
 *     seule son ANNONCE de `port` manquait ;
 *   - tout ce que la forme HERITEE accepte passait aussi, et par une
 *     autre route : le noeud glouton `logging` du trie avalait la ligne
 *     entiere et la passait telle quelle au moteur. Les DEUX ecritures
 *     atteignaient donc le meme `applyHost`, ce qui explique que les
 *     rendus, les refus et les incompletudes soient deja justes des
 *     deux cotes. Le defaut n'etait pas dans ce que la machine FAIT,
 *     mais dans ce qu'elle DIT pouvoir faire ;
 *   - `la tete \`logging\`` en entier — le `% Incomplete command.` du
 *     mot seul, `A.B.C.D` dans son aide, le refus d'un mot invente et
 *     d'une adresse malformee — est le TEMOIN : il passe des deux
 *     cotes, et doit, sinon le laboratoire ne mesure rien. C'est lui
 *     qui prouve que retirer le noeud du trie n'a pas emporte la
 *     famille avec ;
 *   - les sept saisies croisees entre plateformes passaient : les deux
 *     Cisco partagent `CiscoShellBase`, donc leurs refus etaient deja
 *     mot pour mot les memes. Elles restent parce que la refonte aurait
 *     pu les separer, l'une gardant son noeud glouton ;
 *   - `rendent la MEME ligne de configuration` passait pour la meme
 *     raison que les rendus : c'est le meme moteur qui ecrit les deux.
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

const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => /^\s\s(\S+)/.exec(l)?.[1]).filter((m): m is string => !!m);

async function jouer(d: Cli, lignes: readonly string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

const AMORCE = ['enable', 'configure terminal',
  'logging discriminator D1 severity drops 7'];

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, AMORCE);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, AMORCE);
  return s;
}

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const ADRESSE = '10.0.0.1';

const ECRITURES: ReadonlyArray<readonly [string, string]> = [
  ['heritee', `logging ${ADRESSE}`],
  ['nommee', `logging host ${ADRESSE}`],
];

for (const [nom, fabrique] of PLATEFORMES) {
  for (const [ecriture, prefixe] of ECRITURES) {
    describe(`\`${prefixe}\` (${ecriture}) sur un ${nom}`, () => {
      it('chaque mot annonce apres l adresse EXECUTE', async () => {
        const d = await fabrique();
        for (const mot of mots(d.cliHelp(`${prefixe} `))) {
          if (mot === '<cr>') continue;
          const reponse = await d.executeCommand(`${prefixe} ${mot}`);
          expect(reponse, `${prefixe} ? offre ${mot}, qui est refuse`)
            .not.toMatch(/Invalid input/);
        }
      });

      it('annonce `transport` et `discriminator`', async () => {
        const d = await fabrique();
        expect(mots(d.cliHelp(`${prefixe} `)))
          .toEqual(expect.arrayContaining(['transport', 'discriminator']));
      });

      it('annonce `port` apres `transport tcp`', async () => {
        const d = await fabrique();
        expect(mots(d.cliHelp(`${prefixe} transport tcp `))).toContain('port');
      });

      it('annonce `port` apres `transport udp`', async () => {
        const d = await fabrique();
        expect(mots(d.cliHelp(`${prefixe} transport udp `))).toContain('port');
      });

      it('n annonce pas les sous-commandes de `logging`', async () => {
        const d = await fabrique();
        const rendus = mots(d.cliHelp(`${prefixe} `));
        for (const parasite of ['buffered', 'console', 'monitor', 'on', 'trap', 'host']) {
          expect(rendus, `${prefixe} ? offre ${parasite}`).not.toContain(parasite);
        }
      });

      it('pose l hote et le rend en forme NOMMEE', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(prefixe)).not.toMatch(REFUS);
        expect(await conf(d)).toContain(`logging host ${ADRESSE}`);
      });

      it('porte son transport et son port', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} transport tcp port 1470`))
          .not.toMatch(REFUS);
        expect(await conf(d))
          .toContain(`logging host ${ADRESSE} transport tcp port 1470`);
      });

      it('porte son discriminateur', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} discriminator D1`)).not.toMatch(REFUS);
        expect(await conf(d)).toContain(`logging host ${ADRESSE} discriminator D1`);
      });

      it('`no` retire l hote', async () => {
        const d = await fabrique();
        await d.executeCommand(prefixe);
        expect(await d.executeCommand(`no ${prefixe}`)).not.toMatch(REFUS);
        expect(await conf(d)).not.toContain(`logging host ${ADRESSE}`);
      });

      it('un transport invente est refuse', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} transport zorglub`))
          .toMatch(/Invalid input/);
      });

      it('un port hors plage est refuse', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} transport tcp port 99999`))
          .toMatch(/Invalid input/);
      });

      it('un discriminateur INEXISTANT est refuse', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} discriminator ZORG`))
          .toMatch(/Invalid input/);
        expect(await conf(d)).not.toContain('ZORG');
      });

      it('un mot de trop est refuse', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} zorglub`)).toMatch(/Invalid input/);
      });

      it('`transport` sans sa valeur est INCOMPLET', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} transport`))
          .toMatch(/Incomplete command/);
      });

      it('`port` sans sa valeur est INCOMPLET', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${prefixe} transport tcp port`))
          .toMatch(/Incomplete command/);
      });
    });
  }

  describe(`les deux ecritures disent la MEME chose sur un ${nom}`, () => {
    it('annoncent le meme vocabulaire apres l adresse', async () => {
      const d = await fabrique();
      const herite = mots(d.cliHelp(`logging ${ADRESSE} `)).sort();
      const nomme = mots(d.cliHelp(`logging host ${ADRESSE} `)).sort();
      expect(herite).toEqual(nomme);
    });

    it('annoncent le meme vocabulaire apres `transport tcp`', async () => {
      const d = await fabrique();
      expect(mots(d.cliHelp(`logging ${ADRESSE} transport tcp `)).sort())
        .toEqual(mots(d.cliHelp(`logging host ${ADRESSE} transport tcp `)).sort());
    });

    it('rendent la MEME ligne de configuration', async () => {
      const a = await fabrique(); const b = await fabrique();
      await a.executeCommand(`logging ${ADRESSE} transport tcp port 1470`);
      await b.executeCommand(`logging host ${ADRESSE} transport tcp port 1470`);
      const ligne = (t: string) => t.split('\n').filter(l => /logging host/.test(l));
      expect(ligne(await conf(a))).toEqual(ligne(await conf(b)));
    });
  });

  describe(`la tete \`logging\` sur un ${nom}`, () => {
    it('seule, elle est INCOMPLETE — le TEMOIN', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('logging')).toMatch(/Incomplete command/);
    });

    it('annonce `A.B.C.D` et les sous-commandes', async () => {
      const d = await fabrique();
      expect(mots(d.cliHelp('logging ')))
        .toEqual(expect.arrayContaining(['A.B.C.D', 'host', 'buffered', 'trap']));
    });

    it('un mot invente est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('logging zorglub')).toMatch(/Invalid input/);
    });

    it('une adresse malformee est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('logging 999.1.1.1')).toMatch(/Invalid input/);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    `logging ${ADRESSE} transport zorglub`,
    `logging ${ADRESSE} transport tcp port 99999`,
    `logging ${ADRESSE} zorglub`,
    `logging ${ADRESSE} transport`,
    'logging zorglub',
    'logging 999.1.1.1',
    'logging',
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

  it('annoncent le meme vocabulaire apres l adresse', async () => {
    const r = await routeur(); const s = await commutateur();
    expect(mots(r.cliHelp(`logging ${ADRESSE} `)).sort())
      .toEqual(mots(s.cliHelp(`logging ${ADRESSE} `)).sort());
  });
});
