/*
 * Sonde sur les TETES DE FAMILLE qui promettaient `<cr>` sans le tenir,
 * trouvees en promenant le balayage de l'aide sur un CATALYST — la
 * plateforme ou ce garde-fou n'avait jamais ete promene, puisqu'il ne
 * connaissait que le routeur.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. un mot annonce DEUX FOIS est annonce une fois de trop — l'aide
 *      decrit un arbre, et un arbre n'a pas deux fois la meme branche ;
 *   3. `clear line vty` nomme une SORTE de ligne et attend son rang,
 *      tandis que `clear line 5` compte en absolu : la premiere forme
 *      est incomplete, la seconde se suffit.
 *
 * Le point 3 est celui qui vaut la mesure. `clear line` REINITIALISE une
 * session : la frappe qui s'arrete a la sorte ne designe aucune ligne,
 * et la machine le disait — mais son aide promettait qu'on pouvait
 * valider. L'operateur qui suit la promesse croit avoir ferme une
 * session et ne l'a pas fermee.
 *
 * Le point 2 vient d'une DEDUPLICATION manquante : le socle declare le
 * type d'interface a la fois comme forme de sa place et comme commande
 * a part entiere, si bien que `interface ?` rendait `FastEthernet` deux
 * fois, `GigabitEthernet` deux fois, et ainsi de suite sur les DEUX
 * plateformes. La fusion avec l'arbre dedupliquait deja ; le socle, non.
 *
 * Discriminee contre l'etat d'avant : 14 des 24 cas tombent. Les 10 qui
 * passent des deux cotes sont nommes :
 *
 *   - `clear line 5` et `clear line vty 0` gardaient deja leur `<cr>` et
 *     demandaient deja confirmation. Ce sont les TEMOINS : ils prouvent
 *     que la famille marche, et que seule la forme TRONQUEE mentait —
 *     exiger un rang partout aurait ete un echange, pas une correction ;
 *   - `show queuing` et `arp` nus ne promettaient deja pas `<cr>`, et
 *     `show vlan` en promettait un qui TIENT — c'est une commande a part
 *     entiere, pas une tete de famille. Ecrit a l'aveugle, ce fichier
 *     rangeait `show vlan` avec les deux autres ; la mesure l'en a
 *     sorti, et la difference entre les trois est precisement ce qui
 *     distingue une tete d'une commande ;
 *   - la liste des types d'interface etait deja COMPLETE et deja triee ;
 *     seul le nombre d'exemplaires etait faux, ce que le comptage
 *     mesure et qu'une simple recherche de mot n'aurait pas vu.
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
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function priv(fabrique: () => Cli, ...prelude: string[]): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

/** Les sortes de ligne : chacune NOMME une ligne et attend son rang. */
const SORTES = ['aux', 'console', 'tty', 'vty'];

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`\`clear line\`, sur un ${plateforme}`, () => {
    for (const sorte of SORTES) {
      it(`\`clear line ${sorte}\` est INCOMPLET, et son aide le dit`, async () => {
        const d = await priv(fabrique);
        expect(annonceCr(d.cliHelp(`clear line ${sorte} `)),
          `clear line ${sorte} ? promet <cr>`).toBe(false);
        expect(await d.executeCommand(`clear line ${sorte}`), sorte)
          .toMatch(/Incomplete command/);
      });
    }

    it('`clear line 5` se suffit — le TEMOIN', async () => {
      const d = await priv(fabrique);
      expect(annonceCr(d.cliHelp('clear line 5 '))).toBe(true);
      expect(await d.executeCommand('clear line 5')).not.toMatch(/Invalid|Incomplete/);
    });

    it('`clear line vty 0` se suffit — le TEMOIN', async () => {
      const d = await priv(fabrique);
      expect(annonceCr(d.cliHelp('clear line vty 0 '))).toBe(true);
      expect(await d.executeCommand('clear line vty 0')).not.toMatch(/Invalid|Incomplete/);
    });

    it('`clear line ?` annonce les quatre sortes ET le rang absolu', async () => {
      const d = await priv(fabrique);
      const rendus = mots(d.cliHelp('clear line '));
      for (const sorte of SORTES) expect(rendus, `clear line ? tait ${sorte}`).toContain(sorte);
      expect(rendus.some((m) => /^<0-\d+>$/.test(m)),
        'clear line ? tait le rang absolu').toBe(true);
    });
  });

  describe(`\`interface ?\` n annonce chaque type qu UNE fois, sur un ${plateforme}`, () => {
    it('aucun doublon', async () => {
      const d = await priv(fabrique, 'configure terminal');
      const rendus = mots(d.cliHelp('interface '));
      const doublons = rendus.filter((m, i) => rendus.indexOf(m) !== i);
      expect(doublons, `annonces deux fois : ${doublons.join(', ')}`).toEqual([]);
      expect(rendus.length, 'interface ? n annonce rien').toBeGreaterThan(3);
    });
  });
}

describe('les tetes de famille d un Catalyst', () => {
  const commutateur = FABRIQUES[1][1];

  it.each([
    ['show lacp', []],
    ['show vlan name', []],
    ['show queuing interface', []],
    ['udld', ['configure terminal']],
  ] as Array<[string, string[]]>)('`%s` est INCOMPLET, et son aide le dit',
    async (frappe, prelude) => {
      const d = await priv(commutateur, ...prelude);
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
    });

  it.each([
    ['show queuing', []],
    ['arp', ['configure terminal']],
  ] as Array<[string, string[]]>)('`%s` ne promettait deja pas `<cr>` — le TEMOIN',
    async (frappe, prelude) => {
      const d = await priv(commutateur, ...prelude);
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    });

  it('`show vlan` promet un `<cr>` qui TIENT — le TEMOIN', async () => {
    const d = await priv(commutateur);
    expect(annonceCr(d.cliHelp('show vlan '))).toBe(true);
    expect(await d.executeCommand('show vlan')).not.toMatch(/Invalid|Incomplete/);
  });
});
