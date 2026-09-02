/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS des listes de
 * methodes AAA, avant toute lecture du code.
 *
 * Ce que la reference dit :
 *   `aaa authentication login {default | <liste>} <methode> [<methode>…]`
 *     methodes : `enable`, `group <nom>`, `krb5`, `krb5-telnet`, `line`,
 *     `local`, `local-case`, `none`.
 *   `aaa authorization {exec | commands <0-15> | network | …}
 *      {default | <liste>} <methode> [<methode>…]`
 *     methodes : `group <nom>`, `if-authenticated`, `local`, `none`.
 *   `aaa accounting {exec | commands <0-15> | network | …}
 *      {default | <liste>} {start-stop | stop-only | none} [group <nom>]`
 *
 * Pourquoi une methode inventee se paie en ACCES : une liste de
 * methodes est essayee dans l'ordre, et une entree que rien ne sait
 * appliquer est une entree qui n'authentifie personne. L'operateur croit
 * avoir pose un repli — c'est precisement ce que ces listes servent a
 * decrire — et n'a rien pose. La configuration rendue est REJOUEE a
 * l'import d'une topologie, donc la ligne fautive revient telle quelle.
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

const AMORCE = ['enable', 'configure terminal', 'aaa new-model'];

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
  describe(`les methodes AAA sur un ${nom}`, () => {
    it('une liste d authentification VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      const ligne = 'aaa authentication login default local none';
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });

    it('une METHODE d authentification inventee est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authentication login default zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('une methode inventee APRES une valide est refusee aussi', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authentication login default local zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('une liste d autorisation VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      const ligne = 'aaa authorization exec default local';
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });

    it('une METHODE d autorisation inventee est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authorization exec default zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('`group` sans nom de groupe est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authentication login default group'))
        .toMatch(/Incomplete command/);
    });

    it('le NIVEAU de `aaa accounting commands` est un nombre', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'aaa accounting commands zorglub start-stop group tacacs+'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('et il est borne a 0-15', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'aaa accounting commands 16 default start-stop group tacacs+'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/commands 16/);
    });

    it('une liste de comptabilite VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      const ligne = 'aaa accounting commands 15 default start-stop group tacacs+';
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });

  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'aaa authentication login default zorglub',
    'aaa authentication login default local zorglub',
    'aaa authorization exec default zorglub',
    'aaa accounting commands zorglub start-stop group tacacs+',
    'aaa accounting commands 16 default start-stop group tacacs+',
    'aaa authentication login default group',
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
