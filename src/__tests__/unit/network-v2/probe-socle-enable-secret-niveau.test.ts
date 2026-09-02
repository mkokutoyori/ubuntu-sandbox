/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS d'`enable secret`
 * et d'`enable password`, avant toute lecture du code.
 *
 * Ce que la reference dit :
 *   `enable secret [level <0-15>] {<mot> | <0|5|8|9> <condense>}`
 *   `enable password [level <0-15>] {<mot> | 7 <condense>}`
 *   - sans `level`, le secret vaut pour le niveau 15.
 *
 * Pourquoi un niveau mal forme se paie en ACCES : la commande SANS
 * niveau pose le secret d'administration. Si un niveau invalide fait
 * retomber la commande sur cette forme, l'operateur qui croit poser le
 * secret d'un niveau intermediaire ECRASE celui de l'administrateur —
 * et la configuration rendue, rejouee a l'import d'une topologie,
 * reproduit l'ecrasement.
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

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`enable secret level\` sur un ${nom}`, () => {
    it('un niveau VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('enable secret level 5 Cisco123'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^enable secret level 5 /m);
    });

    it('un niveau qui n est PAS un nombre est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('enable secret level zorglub Cisco123'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    /*
     * Le cas qui donne son prix au defaut : la forme SANS niveau pose
     * le secret d'ADMINISTRATION. Un niveau invalide ne doit surtout
     * pas y retomber, sans quoi l'operateur ecrase le secret du
     * niveau 15 en croyant en poser un autre.
     */
    it('et il n ECRASE PAS le secret d administration', async () => {
      const d = await fabrique();
      await d.executeCommand('enable secret AdminSecret1');
      const avant = (await conf(d)).split('\n')
        .find((l) => /^enable secret \d/.test(l)) ?? '';
      expect(avant.length).toBeGreaterThan(0);

      await jouer(d, ['configure terminal']);
      await d.executeCommand('enable secret level zorglub AutreSecret');
      const apres = (await conf(d)).split('\n')
        .find((l) => /^enable secret \d/.test(l)) ?? '';
      expect(apres).toBe(avant);
    });

    it('un niveau HORS de 0-15 est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('enable secret level 99 Cisco123'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/level 99/);
    });

    it('`enable password level` suit la MEME regle', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('enable password level zorglub Cisco123'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('`enable secret level` sans niveau est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('enable secret level'))
        .toMatch(/Incomplete command/);
    });

    it('`enable secret level 5` sans secret est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('enable secret level 5'))
        .toMatch(/Incomplete command/);
    });

  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'enable secret level zorglub Cisco123',
    'enable secret level 99 Cisco123',
    'enable password level zorglub Cisco123',
    'enable secret level',
    'enable secret level 5',
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
});
