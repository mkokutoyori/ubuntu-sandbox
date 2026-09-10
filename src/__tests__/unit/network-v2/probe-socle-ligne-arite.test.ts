/*
 * Sonde sur l'ARITE des commandes de `config-line`.
 *
 * Aucune formulation n'est exigee ici : cisco.com est bloque au
 * telechargement par le mandataire de sortie de ce reseau, et rien
 * d'atteignable ne donne le texte que le mode `line` affiche. Ce qui se
 * mesure sur la machine SEULE, sans citer personne, est l'invariant du
 * depot :
 *
 *   `?` n'annonce `<cr>` que la ou la frappe VALIDE.
 *
 * Un `<cr>` promis pour une frappe que la meme machine refuse par
 * `% Incomplete command.` est le defaut que le garde-fou
 * `probe-aide-cr-tient-sa-promesse` existe pour empecher — et
 * `config-line` en portait TREIZE, mesures en le promenant dans le mode
 * a profondeur 3. Ils sont l'objet de cette sonde ; les compter n'a
 * demande aucune reference, seulement de taper ce que l'aide propose.
 *
 * POURQUOI CELA COUTE CHER ICI : `accounting`, `authorization` et
 * `transport` gouvernent QUI entre par cette ligne et COMMENT. Un
 * operateur qui valide sur la promesse de `?` croit avoir pose une
 * regle d'acces, et n'a rien pose du tout.
 *
 * Les deux plateformes sont comparees : un routeur et un Catalyst
 * partagent ce mode, et une divergence y serait la meme frappe rendant
 * deux reponses.
 *
 * Discriminee contre l'etat d'avant : 28 des 62 cas tombent, QUATORZE
 * par plateforme — les treize `<cr>` menteurs, plus `transport ?` qui
 * annoncait davantage que ses deux directions. Les 34 autres :
 *
 *   - les huit frappes COMPLETES gardent leur `<cr>` et s'executent des
 *     deux cotes. Ce sont les TEMOINS : rendre l'arite EXIGEE partout
 *     aurait ete un echange, pas une correction — `login` seul active
 *     bien la verification du mot de passe, et `exec-timeout 5` se
 *     passe de ses secondes ;
 *   - les six listes de methodes nommees etaient acceptees avant comme
 *     apres : ce lot declare des PLACES, il ne touche pas au
 *     gestionnaire qui les range ;
 *   - `accounting ?`, `authorization ?` et `transport input ?`
 *     annoncaient deja leurs suites — c'est le `<cr>` a cote qui
 *     mentait, pas la liste ;
 *   - les huit comparaisons entre plateformes passaient : les deux
 *     etaient fausses de la MEME facon, ce mode etant declare une seule
 *     fois pour les deux.
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
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function ligne(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'line vty 0 4']) {
    await d.executeCommand(c);
  }
  return d;
}

/** Les treize frappes que la machine refuse, et que `?` disait completes. */
const INCOMPLETES: readonly string[] = [
  'accounting',
  'accounting commands',
  'accounting connection',
  'accounting exec',
  'authorization',
  'authorization commands',
  'authorization exec',
  'exec-timeout',
  'login authentication',
  'login-timeout',
  'transport',
  'transport input',
  'transport output',
];

/** Ce qui valide vraiment a cette place, et doit garder son `<cr>`. */
const COMPLETES: readonly string[] = [
  'login',
  'exec-timeout 5',
  'exec-timeout 5 30',
  'login-timeout 30',
  'transport input ssh',
  'transport output telnet',
  'password secret',
  'session-timeout 10',
];

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`l arite de \`config-line\`, sur un ${plateforme}`, () => {
    for (const frappe of INCOMPLETES) {
      it(`\`${frappe} ?\` ne promet pas de \`<cr>\``, async () => {
        const d = await ligne(fabrique);
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`)
          .toBe(false);
        expect(await d.executeCommand(frappe), frappe)
          .toMatch(/Incomplete command/);
      });
    }

    for (const frappe of COMPLETES) {
      it(`\`${frappe} ?\` promet un \`<cr>\` qui tient — le TEMOIN`, async () => {
        const d = await ligne(fabrique);
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`)
          .toBe(true);
        expect(await d.executeCommand(frappe), frappe)
          .not.toMatch(/Invalid|Incomplete/);
      });
    }

    it('`transport ?` annonce ses deux directions, et rien d autre', async () => {
      const d = await ligne(fabrique);
      expect(mots(d.cliHelp('transport ')).sort()).toEqual(['input', 'output']);
    });

    it('`transport input ?` annonce les quatre protocoles', async () => {
      const d = await ligne(fabrique);
      const rendus = mots(d.cliHelp('transport input '));
      for (const proto of ['all', 'none', 'ssh', 'telnet']) {
        expect(rendus, `transport input ? tait ${proto}`).toContain(proto);
      }
    });

    it('`accounting ?` annonce ses trois sortes', async () => {
      const d = await ligne(fabrique);
      const rendus = mots(d.cliHelp('accounting '));
      for (const sorte of ['commands', 'connection', 'exec']) {
        expect(rendus, `accounting ? tait ${sorte}`).toContain(sorte);
      }
    });

    it('`authorization ?` annonce ses deux sortes', async () => {
      const d = await ligne(fabrique);
      const rendus = mots(d.cliHelp('authorization '));
      for (const sorte of ['commands', 'exec']) {
        expect(rendus, `authorization ? tait ${sorte}`).toContain(sorte);
      }
    });

    it('une liste de methodes nommee reste acceptee — le TEMOIN', async () => {
      const d = await ligne(fabrique);
      for (const frappe of [
        'accounting exec PARDEFAUT',
        'accounting commands 15 PARDEFAUT',
        'accounting connection PARDEFAUT',
        'authorization exec PARDEFAUT',
        'authorization commands 15 PARDEFAUT',
        'login authentication PARDEFAUT',
      ]) {
        expect(await d.executeCommand(frappe), frappe)
          .not.toMatch(/Invalid|Incomplete/);
      }
    });

    it('`exec-timeout` refuse ce qui n est pas un nombre', async () => {
      const d = await ligne(fabrique);
      expect(await d.executeCommand('exec-timeout zorglub')).toMatch(/Invalid input/);
    });
  });
}

describe('les deux plateformes decrivent `config-line` avec les memes mots', () => {
  const PLACES: readonly string[] = [
    '', 'accounting ', 'authorization ', 'transport ', 'transport input ',
    'exec-timeout ', 'login ', 'login-timeout ',
  ];
  for (const place of PLACES) {
    it(`\`${place}?\``, async () => {
      const r = await ligne(FABRIQUES[0][1]);
      const s = await ligne(FABRIQUES[1][1]);
      expect(s.cliHelp(place)).toBe(r.cliHelp(place));
    });
  }
});
