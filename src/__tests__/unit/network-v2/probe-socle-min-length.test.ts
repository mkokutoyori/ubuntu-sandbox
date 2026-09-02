/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS de
 * `security passwords min-length`, la commande qui impose une longueur
 * minimale aux mots de passe de la machine.
 *
 * Ce que la reference dit : la valeur va de 0 a 16 caracteres, et 0
 * signifie « aucun minimum ». Ce n'est pas un reglage d'affichage —
 * IOS REFUSE ensuite un mot de passe plus court, donc une valeur qui
 * n'entre pas dans le magasin laisse la machine sans politique alors
 * que l'operateur croit en avoir pose une.
 *
 * La configuration rendue est REJOUEE a l'import d'une topologie : une
 * valeur hors plage qu'on accepte y revient telle quelle.
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
  describe(`\`security passwords min-length\` sur un ${nom}`, () => {
    it('une valeur valide se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('security passwords min-length 10'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^security passwords min-length 10\s*$/m);
    });

    it('la borne HAUTE est 16', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('security passwords min-length 16'))
        .not.toMatch(REFUS);
      expect(await d.executeCommand('security passwords min-length 17'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/min-length 17/);
    });

    it('une valeur qui n est PAS un nombre est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('security passwords min-length zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('une valeur NEGATIVE est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('security passwords min-length -5'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/min-length -5/);
    });

    it('la commande sans valeur est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('security passwords min-length'))
        .toMatch(/Incomplete command/);
    });

    it('l aide annonce <0-16> et non un mot libre', async () => {
      const d = await fabrique();
      expect(d.cliHelp('security passwords min-length ')).toContain('<0-16>');
    });

    /*
     * Le reglage n'est pas decoratif : IOS refuse ensuite un mot de
     * passe plus court. Sans ce cas, une valeur bien rangee mais jamais
     * lue passerait pour un succes.
     */
    it('la longueur posee REFUSE un mot de passe trop court', async () => {
      const d = await fabrique();
      await d.executeCommand('security passwords min-length 10');
      expect(await d.executeCommand('username zoe secret court'))
        .toMatch(/at least 10 characters/);
      expect(await d.executeCommand('username zoe secret AssezLongPourPasser'))
        .not.toMatch(/at least/);
    });

    it('une valeur REFUSEE ne change pas la politique en place', async () => {
      const d = await fabrique();
      await d.executeCommand('security passwords min-length 10');
      await d.executeCommand('security passwords min-length zorglub');
      expect(await d.executeCommand('username zoe secret court'))
        .toMatch(/at least 10 characters/);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'security passwords min-length zorglub',
    'security passwords min-length 17',
    'security passwords min-length',
    'security passwords min-length -5',
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
