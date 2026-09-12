/*
 * `copy` lit DEUX mots et son aide en annoncait trois — ou zero.
 *
 * Le gestionnaire lit `args[0]` et `args[1]`, et rien d'autre. Son noeud,
 * lui, etait un glouton sans place, avec une liste de suites affichee a
 * cote. D'ou trois defauts sur une seule famille :
 *
 *     copy flash: ?                        ->  <cr>  puis % Incomplete
 *     copy running-config startup-config ? ->  % Invalid input,
 *                                              puis la commande PASSE
 *     copy flash: tftp: ?                  ->  un 3e rang de sources,
 *                                              que le gestionnaire ignore
 *
 * Les trois disent la meme chose : l'aide ne savait pas COMBIEN de mots
 * la commande prend. Le premier promet qu'on peut valider a un mot ; le
 * deuxieme declare inexistante une frappe qui s'execute ; le troisieme
 * annonce un troisieme mot dont rien ne fera jamais rien — la faute que
 * ce depot appelle « un critere range sans etre evalue », vue du cote de
 * l'aide.
 *
 * `copy flash: ?` merite un mot de plus. C'est la SAUVEGARDE qui se joue
 * la : un operateur qui suit le `<cr>` croit avoir copie un fichier et
 * n'a rien copie, ce qu'il ne decouvrira qu'en restaurant.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. une frappe que la machine EXECUTE n'est pas decrite comme
 *      inexistante par sa propre aide ;
 *   3. l'aide annonce les mots que le gestionnaire LIT, et pas un de
 *      plus ;
 *   4. un routeur et un Catalyst repondent pareil.
 *
 * Ce que la sonde n'exige PAS : la liste exacte des systemes de fichiers
 * d'IOS. Ce simulateur en sert cinq (`flash:`, `tftp:`, `scp:`,
 * `running-config`, `startup-config`) ; en annoncer d'autres reviendrait
 * a proposer ce que la machine refuse, et savoir lesquels un vrai
 * Catalyst annonce demanderait la reference.
 *
 * Discriminee contre l'etat d'avant : 10 des 25 cas tombent. Les 15 qui
 * passent des deux cotes sont les TEMOINS, et ils portent ici le risque
 * propre a cette migration — `copy` est la commande de SAUVEGARDE, donc
 * une declaration qui refuserait une forme legitime coute plus cher que
 * le defaut qu'elle corrige :
 *
 *   - `copy ?` et `copy running-config ?` ne promettaient deja pas
 *     `<cr>` et nommaient deja leurs suites, chacun avec SES
 *     descriptions — « Local flash filesystem » d'un cote, « Save to
 *     flash filesystem » de l'autre. Deux listes pour un seul mot, et la
 *     migration devait les garder distinctes : c'est pour cela que
 *     `copy running-config <destination>` est declaree a part ;
 *   - la sauvegarde elle-meme, sa forme abregee `cop run start` — celle
 *     qui traverse le dialogue `Destination filename [startup-config]?`,
 *     donc le planificateur d'interaction — et l'erreur d'ouverture d'un
 *     fichier absent s'obtenaient deja. Ce sont les trois chemins que le
 *     gestionnaire distingue, et il n'a pas change : seules les places
 *     qui y menent sont declarees ;
 *   - `copy` reste refuse avant `enable` : la commande est privilegiee,
 *     et une migration qui l'ouvrirait a l'EXEC utilisateur donnerait la
 *     configuration entiere a qui n'a pas le mot de passe.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const nomsAnnonces = (aide: string): string[] =>
  mots(aide).filter((m) => m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

type Fabrique = () => Promise<Cli>;

const routeur: Fabrique = async () => {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  await d.executeCommand('enable');
  return d;
};

const commutateur: Fabrique = async () => {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  await d.executeCommand('enable');
  return d;
};

const PLATEFORMES: ReadonlyArray<readonly [string, Fabrique]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

const SOURCES = ['flash:', 'running-config', 'scp:', 'startup-config', 'tftp:'];

for (const [plateforme, fabrique] of PLATEFORMES) {
  describe(`\`copy\`, sur un ${plateforme}`, () => {
    it.each([
      'copy',
      'copy flash:',
      'copy tftp:',
      'copy startup-config',
      'copy running-config',
    ])('`%s ?` ne promet pas `<cr>`', async (frappe) => {
      const d = await fabrique();
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
    });

    it('`copy ?` nomme les cinq systemes qu il sert', async () => {
      const d = await fabrique();
      expect(nomsAnnonces(d.cliHelp('copy '))).toEqual(expect.arrayContaining(SOURCES));
    });

    it('`copy running-config ?` nomme ses destinations', async () => {
      const d = await fabrique();
      expect(nomsAnnonces(d.cliHelp('copy running-config ')))
        .toEqual(expect.arrayContaining(['flash:', 'scp:', 'startup-config', 'tftp:']));
    });

    it('`copy running-config startup-config ?` decrit une commande qui EXISTE', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('copy running-config startup-config ');
      expect(aide, 'l aide repond au caret').not.toMatch(/Invalid input/);
      expect(annonceCr(aide), 'l aide tait <cr>').toBe(true);
    });

    it('un troisieme mot n est pas annonce', async () => {
      const d = await fabrique();
      expect(nomsAnnonces(d.cliHelp('copy flash: tftp: ')),
        'un 3e rang est annonce').toEqual([]);
      expect(annonceCr(d.cliHelp('copy flash: tftp: '))).toBe(true);
    });

    it('`copy running-config startup-config` sauvegarde — le TEMOIN', async () => {
      const d = await fabrique();
      await d.executeCommand('configure terminal');
      await d.executeCommand('hostname SAUVE');
      await d.executeCommand('end');
      expect(await d.executeCommand('copy running-config startup-config'))
        .toMatch(/Destination filename/);
      expect(await d.executeCommand('show startup-config')).toContain('hostname SAUVE');
    });

    it('`cop run start` abrege comme IOS — le TEMOIN', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('cop run start')).toMatch(/Destination filename/);
    });

    it('`copy flash:absent running-config` rend l erreur d ouverture — le TEMOIN',
      async () => {
        const d = await fabrique();
        expect(await d.executeCommand('copy flash:absent running-config'))
          .toMatch(/No such file or directory/);
      });
  });
}

describe('`copy` reste refuse avant `enable` — le TEMOIN', () => {
  it('en EXEC utilisateur', async () => {
    const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
    d.powerOn();
    expect(await d.executeCommand('copy running-config startup-config'))
      .toMatch(/Invalid input/);
  });
});
