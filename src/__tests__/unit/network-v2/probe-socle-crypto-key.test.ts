/*
 * UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE et la mesure l'a corrigee
 * plutot que le code : j'attendais la TAILLE du module dans
 * `show crypto key mypubkey rsa`. Un vrai IOS ne l'y ecrit pas — il
 * rend la date, le nom, le support, l'usage, l'exportabilite et les
 * donnees de la cle, jamais le nombre de bits. Le cas observe donc ce
 * qu'IOS rend.
 *
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS de
 * `crypto key generate rsa` et `crypto key zeroize rsa`, avant toute
 * lecture du code.
 *
 * Ce que la reference dit :
 *   `crypto key generate rsa [general-keys | usage-keys]
 *      [label <nom>] [exportable] [modulus <taille>]`
 *   - IOS refuse tant qu'un nom de domaine n'est pas defini, le nom de
 *     la cle etant `<hote>.<domaine>`.
 *   - `crypto key zeroize rsa` detruit les cles.
 *   - ces deux commandes DECIDENT du serveur SSH : sans cle il ne peut
 *     rien presenter, et `ip ssh version 2` est refuse.
 *   - `show crypto key mypubkey rsa` rend ce que la machine porte.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie.
 *   - un Catalyst porte les memes commandes, l'IOS etant le meme.
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
  await jouer(r, ['enable', 'configure terminal', 'ip domain-name lab.local']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'ip domain-name lab.local']);
  return s;
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`crypto key\` sur un ${nom}`, () => {
    it('une cle se genere et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('crypto key generate rsa modulus 1024'))
        .not.toMatch(REFUS);
      await jouer(d, ['end']);
      const vue = await d.executeCommand('show crypto key mypubkey rsa');
      expect(vue).toMatch(/^Key name: /m);
      expect(vue).toMatch(/Key Data:/);
      expect(vue).toMatch(/Usage: General Purpose Key/);
    });

    it('`zeroize` la detruit', async () => {
      const d = await fabrique();
      await d.executeCommand('crypto key generate rsa modulus 1024');
      expect(await d.executeCommand('crypto key zeroize rsa')).not.toMatch(REFUS);
      await jouer(d, ['end']);
      expect(await d.executeCommand('show crypto key mypubkey rsa'))
        .toMatch(/No RSA/i);
    });

    it('un module qui n est PAS un nombre est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('crypto key generate rsa modulus zorglub'))
        .toMatch(REFUS);
      await jouer(d, ['end']);
      expect(await d.executeCommand('show crypto key mypubkey rsa'))
        .not.toMatch(/NaN/);
    });

    it('un module ABSURDE est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('crypto key generate rsa modulus 99999'))
        .toMatch(REFUS);
      expect(await d.executeCommand('crypto key generate rsa modulus 8'))
        .toMatch(REFUS);
    });

    it('un mot-cle INCONNU est refuse, pas avale', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('crypto key generate rsa zorglub 1024'))
        .toMatch(REFUS);
    });

    it('`label` nomme la cle', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'crypto key generate rsa general-keys label MACLE modulus 1024'))
        .not.toMatch(REFUS);
      await jouer(d, ['end']);
      expect(await d.executeCommand('show crypto key mypubkey rsa'))
        .toContain('MACLE');
    });

    it('l aide du MODULE annonce une plage, pas un mot libre', async () => {
      const d = await fabrique();
      expect(d.cliHelp('crypto key generate rsa modulus ')).toMatch(/<\d+-\d+>/);
    });

    it('l aide apres `crypto key` annonce `generate` et `zeroize`', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('crypto key ');
      expect(aide).toMatch(/^\s+generate\b/m);
      expect(aide).toMatch(/^\s+zeroize\b/m);
    });

    /*
     * Les deux commandes DECIDENT du serveur SSH : c'est leur
     * consequence observable, et sans ce cas un magasin bien rempli
     * mais jamais lu passerait pour un succes.
     */
    it('la cle est ce qui permet `ip ssh version 2`', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh version 2'))
        .toMatch(/Please create RSA keys/);
      await d.executeCommand('crypto key generate rsa modulus 1024');
      expect(await d.executeCommand('ip ssh version 2'))
        .not.toMatch(/Please create RSA keys/);
    });

    it('et `zeroize` la retire de nouveau', async () => {
      const d = await fabrique();
      await d.executeCommand('crypto key generate rsa modulus 1024');
      await d.executeCommand('crypto key zeroize rsa');
      expect(await d.executeCommand('ip ssh version 2'))
        .toMatch(/Please create RSA keys/);
    });

    it('`zeroize` sans cle le dit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('crypto key zeroize rsa'))
        .toMatch(/No Signature RSA Keys/i);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'crypto key generate rsa modulus zorglub',
    'crypto key generate rsa modulus 99999',
    'crypto key generate rsa zorglub 1024',
    'crypto key zeroize rsa',
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
