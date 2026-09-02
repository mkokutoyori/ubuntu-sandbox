/*
 * UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE et la mesure l'a corrigee
 * plutot que le code : apres `no alias exec vv`, j'attendais que `vv`
 * soit REFUSE. Un vrai IOS ne refuse pas un mot inconnu en EXEC — il le
 * prend pour un nom d'hote et tente de le resoudre
 * (`Translating "vv"...domain server`), ce que ce simulateur fait aussi.
 * Le cas observe donc que `vv` n'est plus RECONNU comme un alias, ce
 * qui est la proposition, et non un refus qu'IOS ne rend pas.
 *
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS d'`alias`, avant
 * toute lecture du code.
 *
 * Ce que la reference dit :
 *   `alias <mode> <nom> <commande>` — `<mode>` est un mode de la CLI
 *   (`exec`, `configure`, `interface`, `router`), pas un mot libre ;
 *   `no alias <mode> <nom>` retire.
 *
 * Pourquoi un mode invente se paie : l'alias est range SOUS son mode,
 * donc un mode qui n'existe pas pose l'alias ailleurs que la ou
 * l'operateur croit. La configuration rendue est REJOUEE a l'import
 * d'une topologie, donc la ligne fautive revient telle quelle.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

async function jouer(d: Cli, lignes: string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, ['enable', 'configure terminal']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

function modesAnnonces(aide: string): string[] {
  return aide.split('\n')
    .map((l) => /^\s\s(\S+)/.exec(l)?.[1])
    .filter((m): m is string => !!m && !m.startsWith('<'));
}

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`alias\` sur un ${nom}`, () => {
    it('un alias se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('alias exec sr show running-config'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^alias exec sr show running-config\s*$/m);
    });

    it('et il RACCOURCIT vraiment la commande', async () => {
      const d = await fabrique();
      await d.executeCommand('alias exec vv show version');
      await jouer(d, ['end']);
      const sortie = await d.executeCommand('vv');
      expect(sortie).not.toMatch(REFUS);
      expect(sortie).toMatch(/IOS|Cisco/i);
    });

    it('`no alias` le retire, et le raccourci cesse', async () => {
      const d = await fabrique();
      await d.executeCommand('alias exec vv show version');
      expect(await d.executeCommand('no alias exec vv')).not.toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/^alias exec vv/m);
      expect(await d.executeCommand('vv')).not.toMatch(/IOS|Cisco/i);
    });

    it('un MODE inconnu est refuse, pas range', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('alias zorglub zz show version'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    /*
     * L'aide ANNONCE un jeu de modes ; c'est exactement ce jeu que la
     * machine doit accepter. Un mode annonce et refuse serait une aide
     * qui ment ; un mode accepte sans etre annonce est un alias que
     * personne ne peut trouver.
     */
    it('tous les modes ANNONCES sont acceptes', async () => {
      const d = await fabrique();
      const modes = modesAnnonces(d.cliHelp('alias '));
      expect(modes.length).toBeGreaterThan(0);
      for (const mode of modes) {
        expect(await d.executeCommand(`alias ${mode} zz show version`), mode)
          .not.toMatch(REFUS);
      }
    });

    it('la commande sans mode est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('alias')).toMatch(/Incomplete command/);
    });

    it('la commande sans NOM est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('alias exec')).toMatch(/Incomplete command/);
    });

    it('la commande sans COMMANDE est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('alias exec zz')).toMatch(/Incomplete command/);
    });

    it('`no alias` avec un mode inconnu est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('no alias zorglub zz')).toMatch(REFUS);
    });

    it('l aide annonce des modes et non un mot libre', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('alias ');
      expect(aide).toMatch(/^\s+exec\b/m);
      expect(aide).toMatch(/^\s+configure\b/m);
      expect(aide).not.toMatch(/WORD/);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'alias zorglub zz show version',
    'no alias zorglub zz',
    'alias',
    'alias exec',
    'alias exec zz',
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

  it('les deux annoncent les MEMES modes', async () => {
    const r = await routeur(); const s = await commutateur();
    const modes = modesAnnonces(r.cliHelp('alias '));
    expect(modes.length).toBeGreaterThan(0);
    expect(modesAnnonces(s.cliHelp('alias '))).toEqual(modes);
  });

  it('et la ligne de configuration est ECRITE PAREIL', async () => {
    const r = await routeur(); const s = await commutateur();
    const pose = 'alias exec sr show running-config';
    await r.executeCommand(pose); await s.executeCommand(pose);
    const ligne = (t: string) =>
      (t.split('\n').find((l) => l.startsWith('alias exec sr')) ?? '');
    expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
  });
});
