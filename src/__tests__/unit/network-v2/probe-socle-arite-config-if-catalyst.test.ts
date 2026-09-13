/*
 * Sonde sur quatre frappes d'un CATALYST qui promettaient `<cr>` sans le
 * tenir, dans les sous-modes que le garde-fou de l'aide ne visitait pas
 * encore : la configuration d'interface et celle d'un VLAN.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. la meme commande AVEC son argument garde son `<cr>` et s'execute.
 *
 * Le point 2 porte la moitie du sens. Une arite se declare en retirant
 * un `<cr>`, et il est facile de le retirer d'un rang de trop : une
 * frappe complete qui perd son `<cr>` est le meme defaut vu de l'autre
 * cote. Chaque tete mesuree ici vient donc avec la forme qui la complete.
 *
 * POURQUOI CES QUATRE-LA : ce sont celles qu'une declaration d'arite sur
 * l'arbre sait porter. Six autres frappes du meme balayage — `duplex`,
 * `speed`, `l2protocol-tunnel`, `no storm-control`,
 * `private-vlan association` et `monitor session` — ne l'acceptent pas : leur noeud porte
 * deja des indications d'argument, et y poser une arite soit ne fait
 * rien, soit fait rendre « % Invalid input » a l'aide d'une commande qui
 * existe. Elles attendent leur declaration au socle, ou l'arite se deduit
 * des places — ce que le ROUTEUR fait deja pour `duplex` et `speed`, avec
 * une place enumeree, pendant que le Catalyst en garde un glouton a lui.
 *
 * Discriminee contre l'etat d'avant : 4 des 12 cas tombent — les quatre
 * tetes. Les 8 qui passent des deux cotes sont les TEMOINS, et ils sont
 * ce qui rend la correction sure plutot que seulement verte : les quatre
 * formes COMPLETES gardaient deja leur `<cr>` et s'executaient, et
 * l'aide des quatre tetes decrivait deja quelque chose. C'est exactement
 * ce que les six autres frappes ont perdu quand on a essaye la meme
 * declaration sur elles — `duplex ?` s'est mis a repondre au caret —
 * donc ces huit temoins mesurent le risque qu'on a pris ici, et non une
 * evidence.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

const INTERFACE = ['configure terminal', 'interface FastEthernet0/1'];
const VLAN = ['configure terminal', 'vlan 10'];
/** La tete incomplete, la forme qui la complete, et le mode ou on les tape. */
const CAS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['description', 'description Liaison vers le coeur', INTERFACE],
  ['storm-control', 'storm-control broadcast level 10', INTERFACE],
  ['switchport voice', 'switchport voice vlan 20', INTERFACE],
  ['private-vlan', 'private-vlan primary', VLAN],
];

describe('une tete de famille d un Catalyst ne promet pas `<cr>`', () => {
  for (const [tete, , mode] of CAS) {
    it(`\`${tete} ?\``, async () => {
      const d = await commutateur(...mode);
      expect(annonceCr(d.cliHelp(`${tete} `)), `${tete} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(tete), tete).toMatch(/Incomplete command/);
    });
  }
});

describe('la forme COMPLETE garde son `<cr>` — les TEMOINS', () => {
  for (const [tete, complete, mode] of CAS) {
    it(`\`${complete}\``, async () => {
      const d = await commutateur(...mode);
      expect(annonceCr(d.cliHelp(`${complete} `)), `${complete} ? tait <cr>`).toBe(true);
      expect(await d.executeCommand(complete), `${tete} complete`)
        .not.toMatch(/Invalid|Incomplete/);
    });
  }
});

describe('l aide de ces tetes reste une AIDE', () => {
  /*
   * Poser une arite sur un noeud qui porte deja des indications
   * d'argument fait rendre « % Invalid input » a son aide : la commande
   * existe, et `?` repond qu'elle n'existe pas. C'est ce qui est arrive
   * a `duplex` et `speed` au premier essai, et c'est pour cela qu'ils ne
   * sont pas dans la liste ci-dessus.
   */
  for (const [tete, , mode] of CAS) {
    it(`\`${tete} ?\` decrit encore quelque chose`, async () => {
      const d = await commutateur(...mode);
      expect(d.cliHelp(`${tete} `), `${tete} ? repond au caret`)
        .not.toMatch(/Invalid input/);
    });
  }
});
