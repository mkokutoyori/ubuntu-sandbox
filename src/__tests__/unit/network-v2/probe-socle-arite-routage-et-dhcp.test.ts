/*
 * Sonde sur l'ARITE des quatre derniers sous-modes qui promettaient
 * `<cr>` sans le tenir : les trois protocoles de routage qui partagent
 * `config-router` — RIP, EIGRP, BGP — et le pool DHCP.
 *
 * Aucune formulation n'est exigee : cisco.com est bloque au
 * telechargement par le mandataire de sortie de ce reseau. Ce qui se
 * mesure sur la machine seule est l'invariant du depot — `?` n'annonce
 * `<cr>` que la ou la frappe VALIDE — et, pour les deux seuils DHCP, la
 * borne que le moteur APPLIQUE : `configurePoolUtilizationMark` refuse
 * zero pour le seuil haut et l'accepte pour le bas.
 *
 * VINGT frappes ont ete mesurees en promenant le balayage a profondeur
 * 3 dans les quatre modes. Elles se rangent en trois familles :
 *
 *   - le mot qui OUVRE une famille sans etre une commande :
 *     `redistribute`, `eigrp`, `offset-list` ;
 *   - le protocole redistribue qui exige SON PROCESSUS : `redistribute
 *     ospf`, `redistribute eigrp`, `redistribute bgp` designent un
 *     processus nomme, et sans son numero le moteur ne sait pas lequel ;
 *   - la place declaree FACULTATIVE qui ne l'est pas : le pourcentage
 *     d'un seuil DHCP, la valeur d'une option, l'adresse de
 *     `bgp router-id`.
 *
 * POURQUOI CELA COUTE CHER ICI : `redistribute` fait entrer dans une
 * table de routage ce qu'un autre protocole y a mis. L'operateur qui
 * valide sur la promesse de `?` croit avoir ouvert cette porte, et ne
 * l'a pas ouverte — ou pire, l'a ouverte sur le mauvais processus.
 *
 * Discriminee contre l'etat d'avant : 22 des 46 cas tombent. Les 24 qui
 * passent des deux cotes sont nommes :
 *
 *   - les vingt frappes COMPLETES gardaient deja leur `<cr>` et
 *     s'executaient. Ce sont les TEMOINS : exiger une place partout
 *     aurait ete un echange, pas une correction — `redistribute
 *     connected` se passe d'un numero, `bgp log-neighbor-changes` d'une
 *     valeur, et `no utilization mark high` s'arrete au mot-cle ;
 *   - `redistribute ?` annoncait deja ses protocoles, et
 *     `redistribute connected ?` son `<cr>` : c'est ce qui distingue un
 *     protocole qui NOMME un processus de celui qui n'en a pas ;
 *   - `utilization mark low 0` etait deja accepte. Il faut le garder :
 *     c'est la moitie qui prouve que les deux plages different
 *     vraiment, l'autre etant `high 0` qui doit rester refuse.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

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

async function dans(entree: readonly string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...entree]) {
    await d.executeCommand(c);
  }
  return d;
}

const MODES: ReadonlyArray<readonly [string, readonly string[], readonly string[], readonly string[]]> = [
  [
    'EIGRP', ['router eigrp 1'],
    ['eigrp', 'offset-list', 'redistribute',
      'redistribute bgp', 'redistribute eigrp', 'redistribute ospf'],
    ['redistribute connected', 'redistribute static', 'redistribute ospf 1',
      'eigrp router-id 1.1.1.1', 'network 10.0.0.0', 'variance 2'],
  ],
  [
    'BGP', ['router bgp 65000'],
    ['bgp router-id', 'redistribute',
      'redistribute bgp', 'redistribute eigrp', 'redistribute ospf'],
    ['bgp router-id 1.1.1.1', 'redistribute connected', 'redistribute ospf 1',
      'neighbor 10.0.0.2 remote-as 65001', 'bgp log-neighbor-changes'],
  ],
  [
    'RIP', ['router rip'],
    ['offset-list', 'redistribute',
      'redistribute bgp', 'redistribute eigrp', 'redistribute ospf'],
    ['redistribute connected', 'redistribute static', 'redistribute ospf 1',
      'version 2', 'network 10.0.0.0'],
  ],
  [
    'pool DHCP', ['ip dhcp pool P1'],
    ['option ascii', 'option hex', 'utilization mark high', 'utilization mark low'],
    ['utilization mark high 90', 'utilization mark low 10 log',
      'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1'],
  ],
];

for (const [nom, entree, incompletes, completes] of MODES) {
  describe(`l arite de ${nom}`, () => {
    for (const frappe of incompletes) {
      it(`\`${frappe} ?\` ne promet pas de \`<cr>\``, async () => {
        const d = await dans(entree);
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`)
          .toBe(false);
        expect(await d.executeCommand(frappe), frappe)
          .toMatch(/Incomplete command/);
      });
    }

    for (const frappe of completes) {
      it(`\`${frappe}\` s execute et garde son \`<cr>\` — le TEMOIN`, async () => {
        const d = await dans(entree);
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`)
          .toBe(true);
        expect(await d.executeCommand(frappe), frappe)
          .not.toMatch(/Invalid|Incomplete/);
      });
    }
  });
}

describe('les deux seuils DHCP ont deux plages, pas leur union', () => {
  const pool = () => dans(['ip dhcp pool P1']);

  it('le seuil HAUT refuse zero, et son aide le dit', async () => {
    const d = await pool();
    expect(mots(d.cliHelp('utilization mark high '))).toContain('<1-100>');
    expect(await d.executeCommand('utilization mark high 0')).toMatch(/Invalid input/);
  });

  it('le seuil BAS accepte zero, et son aide le dit', async () => {
    const d = await pool();
    expect(mots(d.cliHelp('utilization mark low '))).toContain('<0-100>');
    expect(await d.executeCommand('utilization mark low 0'))
      .not.toMatch(/Invalid|Incomplete/);
  });

  it('`no utilization mark high` s arrete au mot-cle — le TEMOIN', async () => {
    const d = await pool();
    await d.executeCommand('utilization mark high 90');
    expect(await d.executeCommand('no utilization mark high'))
      .not.toMatch(/Invalid|Incomplete/);
  });
});

describe('un protocole redistribue nomme SON processus', () => {
  it('`redistribute ospf ?` annonce le numero de processus', async () => {
    const d = await dans(['router eigrp 1']);
    expect(mots(d.cliHelp('redistribute ospf '))).toContain('<1-65535>');
  });

  it('`redistribute connected ?` n en demande pas — le TEMOIN', async () => {
    const d = await dans(['router eigrp 1']);
    expect(annonceCr(d.cliHelp('redistribute connected '))).toBe(true);
  });

  it('`redistribute ?` annonce les protocoles', async () => {
    const d = await dans(['router eigrp 1']);
    const rendus = mots(d.cliHelp('redistribute '));
    for (const proto of ['connected', 'static', 'ospf', 'bgp']) {
      expect(rendus, `redistribute ? tait ${proto}`).toContain(proto);
    }
  });
});
