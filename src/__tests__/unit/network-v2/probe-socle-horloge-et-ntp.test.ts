/*
 * `ntp source` tout seul etait ACCEPTE, et ne posait rien.
 *
 *     ntp source ?
 *       IFACE  Interface to use for source address
 *       <cr>
 *
 *     (config)# ntp source
 *     (config)#
 *
 * L'aide promettait donc que la frappe valide, la frappe validait, et
 * l'interface — le seul mot que la commande existe pour porter — etait
 * perdue. Sur IOS `ntp source` EXIGE son interface. La cause est
 * mesurable : la declaration du trie porte `undoArgs: []`, pour que
 * `no ntp source` se passe d'argument, et le noeud nu devient alors
 * executable dans les DEUX polarites. Le socle nomme exactement cette
 * difference — `undoOmitsArguments` —, ce qui est la raison de migrer
 * cette famille plutot que de la rustiner.
 *
 * Les familles `clock` et `ntp` sont les deux dernieres du bloc que les
 * DEUX plateformes partagent en configuration globale. `clock` etait en
 * plus a MOITIE migree : `clock calendar-valid` vivait deja au socle
 * (`globalHeadSpecs`) tandis que `set`, `timezone` et `summer-time`
 * restaient a l'arbre — la meme situation que `key chain` et la porte
 * EEM plus tot dans cette campagne, ou il faut se demander, pour chaque
 * frappe, quel moteur repond.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation, et la
 * grammaire migree est celle que le trie servait deja — le lot la
 * PRESERVE, il ne l'invente pas :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. une borne annoncee est une borne appliquee ;
 *   3. ce que le moteur n'evalue pas est REFUSE, pas ignore ;
 *   4. ce qui se pose se relit dans la configuration ;
 *   5. les deux plateformes repondent la MEME chose.
 *
 * Le point 5 est celui qui vaut la sonde : chaque cas est joue sur le
 * routeur ET sur le commutateur, par une table unique. Une declaration
 * partagee qui ne serait cablee que d'un cote reussirait la moitie des
 * cas en silence.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 4 des 66 cas
 * tombent, deux defauts sur les deux plateformes.
 *
 *   - `ntp source` nu : l'aide promet `<cr>`, et la frappe valide en
 *     jetant l'interface. C'est le defaut ci-dessus.
 *   - `clock set 10:00:00` : l'aide promet `<cr>` alors que la machine
 *     repond `% Incomplete command.` — un `<cr>` qui MENT, sans
 *     acceptation derriere. Sur IOS la date est exigee apres l'heure,
 *     donc c'est bien le refus qui a raison et l'aide qui a tort. Ce
 *     cas n'etait pas prevu en ecrivant la sonde ; c'est elle qui l'a
 *     trouve, et l'en-tete le dit plutot que de se relire juste.
 *
 * Les 62 autres sont des NON-REGRESSIONS de la grammaire migree, et
 * c'est leur role : ils disent que le deplacement d'un moteur a l'autre
 * ne perd ni une forme, ni une borne, ni une ligne de configuration.
 * Trois d'entre eux sont des TEMOINS explicites — `clock
 * calendar-valid`, deja au socle avant ce lot ; `ntp master` nu, qui
 * DOIT rester accepte parce que sa strate a un defaut documente ; et le
 * tour complet qui relit quatre lignes posees — sans quoi une table
 * faite de refus serait satisfaite par un laboratoire ou rien ne se
 * pose.
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
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const PLATEFORMES: Array<[string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serie++}`, 2, 2) as unknown as Cli],
  ['commutateur', () => new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli],
];

async function config(make: () => Cli, ...prelude: string[]): Promise<Cli> {
  const d = make();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe.each(PLATEFORMES)('%s — `clock` et `ntp` au socle', (_nom, make) => {
  describe('une frappe incomplete le dit, et son aide ne promet pas <cr>', () => {
    it.each([
      'clock',
      'clock set',
      'clock set 10:00:00',
      'clock timezone',
      'clock timezone CET',
      'clock summer-time',
      'ntp',
      'ntp source',
      'ntp server',
      'ntp peer',
      'ntp trusted-key',
    ])('`%s`', async (frappe) => {
      const d = await config(make);
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
    });
  });

  describe('les bornes annoncees sont les bornes appliquees', () => {
    it.each([
      ['clock timezone CET 99', 'heures hors [-23,23]'],
      ['clock timezone CET 1 99', 'minutes hors [0,59]'],
      ['ntp master 99', 'strate hors [1,15]'],
      ['clock set 99:99:99', 'heure impossible'],
      ['ntp server zorglub', 'adresse qui n est pas une adresse'],
      ['ntp zorglub', 'mot inconnu'],
      ['clock summer-time CEST zorglub', 'regle inconnue'],
    ] as Array<[string, string]>)('`%s` est refuse — %s', async (frappe) => {
      const d = await config(make);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
    });

    it('`ntp master ?` annonce sa plage', async () => {
      const d = await config(make);
      expect(nomsAnnonces(d.cliHelp('ntp master '))).toContain('<1-15>');
    });

    it('`ntp master` nu est accepte — la strate a un defaut', async () => {
      const d = await config(make);
      expect(annonceCr(d.cliHelp('ntp master '))).toBe(true);
      expect(await d.executeCommand('ntp master')).not.toMatch(/Invalid|Incomplete/);
    });
  });

  describe('ce qui se pose se relit', () => {
    it.each([
      ['clock timezone CET 1 30', /clock timezone CET 1 30/],
      ['clock summer-time CEST recurring', /clock summer-time CEST recurring/],
      ['ntp server 10\\.0\\.0\\.1', /ntp server 10\.0\.0\.1/],
      ['ntp master 5', /ntp master 5/],
      ['ntp source GigabitEthernet0/0', /ntp source GigabitEthernet0\/0/],
    ] as Array<[string, RegExp]>)('`%s`', async (frappe, attendu) => {
      const d = await config(make, frappe.replace(/\\/g, ''));
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show running-config'))).toMatch(attendu);
    });

    it('le tour complet relit les quatre lignes — le TEMOIN', async () => {
      const d = await config(make,
        'clock timezone CET 1 30', 'clock summer-time CEST recurring',
        'ntp server 10.0.0.1', 'ntp master 5');
      await d.executeCommand('end');
      const cfg = String(await d.executeCommand('show running-config'));
      for (const attendu of [
        /clock timezone CET 1 30/, /clock summer-time CEST recurring/,
        /ntp server 10\.0\.0\.1/, /ntp master 5/,
      ]) expect(cfg).toMatch(attendu);
    });

    it('`clock calendar-valid` — le TEMOIN deja au socle', async () => {
      const d = await config(make, 'clock calendar-valid');
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show running-config')))
        .toMatch(/clock calendar-valid/);
    });
  });

  describe('la negation retire ce que la pose a mis', () => {
    it('`no ntp source` se passe d\'argument', async () => {
      const d = await config(make, 'ntp source GigabitEthernet0/0');
      expect(await d.executeCommand('no ntp source')).not.toMatch(/Invalid|Incomplete/);
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show running-config')))
        .not.toMatch(/ntp source/);
    });

    it('`no ntp server` retire le serveur', async () => {
      const d = await config(make, 'ntp server 10.0.0.1');
      expect(await d.executeCommand('no ntp server 10.0.0.1'))
        .not.toMatch(/Invalid|Incomplete/);
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show running-config')))
        .not.toMatch(/ntp server 10\.0\.0\.1/);
    });

    it('`no clock summer-time` se passe d\'argument', async () => {
      const d = await config(make, 'clock summer-time CEST recurring');
      expect(await d.executeCommand('no clock summer-time'))
        .not.toMatch(/Invalid|Incomplete/);
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show running-config')))
        .not.toMatch(/clock summer-time/);
    });
  });

  describe('l aide nomme les suites', () => {
    it('`clock ?` nomme ses quatre suites', async () => {
      const d = await config(make);
      expect(nomsAnnonces(d.cliHelp('clock ')))
        .toEqual(expect.arrayContaining(['set', 'summer-time', 'timezone', 'calendar-valid']));
    });

    it('`ntp ?` nomme ses suites', async () => {
      const d = await config(make);
      expect(nomsAnnonces(d.cliHelp('ntp ')))
        .toEqual(expect.arrayContaining([
          'authenticate', 'master', 'peer', 'server', 'source', 'trusted-key']));
    });

    it('chaque mot annonce sous `ntp ?` porte une description', async () => {
      const d = await config(make);
      const lignes = d.cliHelp('ntp ').split('\n')
        .filter((l) => MOT.test(l) && !/^\s\s<cr>/.test(l));
      expect(lignes.length).toBeGreaterThan(0);
      for (const l of lignes) {
        expect(l.trim().split(/\s{2,}/).length, `sans description : ${l}`)
          .toBeGreaterThanOrEqual(2);
      }
    });
  });
});
