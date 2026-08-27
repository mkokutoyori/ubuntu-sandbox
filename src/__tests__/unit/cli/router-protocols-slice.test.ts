/**
 * `router ospf|rip|eigrp|bgp` — les quatre portes des protocoles de
 * routage dynamique.
 *
 * C'est la famille la plus tapee de tout un cours de routage, et la
 * seule dont chaque commande CHANGE DE MODE : ce qui est mesure ici
 * n'est donc pas seulement l'acceptation mais le mode ou l'on se
 * retrouve, et ce que la configuration rend pour qu'un import de
 * topologie retrouve le meme processus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  getPrompt?(): string;
}

let serial = 0;

async function enConfig(...lignes: string[]): Promise<Cli> {
  const r = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  r.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await r.executeCommand(c);
  return r;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

const PORTES: ReadonlyArray<readonly [string, string, string]> = [
  ['router ospf 1', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0'],
  ['router rip', 'router rip', 'version 2'],
  ['router eigrp 100', 'router eigrp 100', 'network 10.0.0.0'],
  ['router bgp 65001', 'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002'],
];

describe('chaque porte ENTRE dans son sous-mode', () => {
  it.each(PORTES)('`%s` est acceptee, rendue, et la suite y est acceptee',
    async (porte, ligneConfig, suite) => {
      const cli = await enConfig(porte);

      expect(refuse(await cli.executeCommand(suite)), `${porte} > ${suite}`).toBe(false);
      expect(await configuration(cli), porte).toContain(ligneConfig);
    });

  it.each(PORTES)('`%s` change l INVITE', async (porte) => {
    const cli = await enConfig(porte);

    expect(cli.getPrompt?.() ?? '', porte).toMatch(/config-router/);
  });
});

describe('les identifiants sont bornes', () => {
  it.each([
    'router ospf 0',
    'router ospf 70000',
    'router ospf zorglub',
    'router eigrp 0',
    'router eigrp 70000',
    'router eigrp zorglub',
    'router bgp 0',
    'router bgp zorglub',
  ])('`%s` est refuse', async (ligne) => {
    const cli = await enConfig();
    const sortie = await cli.executeCommand(ligne);

    expect(sortie.length > 0, `${ligne} a ete accepte en silence`).toBe(true);
    expect(await configuration(cli), ligne).not.toContain(ligne);
  });

  it.each(['router ospf', 'router eigrp', 'router bgp'])(
    '`%s` sans identifiant est incomplete', async (ligne) => {
      const cli = await enConfig();

      expect(await cli.executeCommand(ligne), ligne).toContain('Incomplete');
    });

  it('un SECOND processus OSPF est refuse en nommant celui qui tourne', async () => {
    const cli = await enConfig('router ospf 1', 'exit');
    const sortie = await cli.executeCommand('router ospf 2');

    expect(sortie).toContain('1');
    expect(sortie).toMatch(/already running|only one/i);
  });

  it('un SECOND systeme autonome BGP est refuse de meme', async () => {
    const cli = await enConfig('router bgp 65001', 'exit');
    const sortie = await cli.executeCommand('router bgp 65002');

    expect(sortie).toContain('65001');
  });
});

describe('la NEGATION arrete le processus', () => {
  it.each([
    ['router ospf 1', 'no router ospf 1'],
    ['router rip', 'no router rip'],
    ['router eigrp 100', 'no router eigrp 100'],
    ['router bgp 65001', 'no router bgp 65001'],
  ])('`%s` puis `%s` laisse la configuration sans le processus',
    async (porte, negation) => {
      const cli = await enConfig(porte, 'exit', negation);

      expect(await configuration(cli), negation).not.toContain(porte);
    });
});

describe('l aide de la famille', () => {
  it('`router ?` annonce les quatre protocoles', async () => {
    const cli = await enConfig();
    const aide = cli.cliHelp('router ');

    for (const proto of ['bgp', 'eigrp', 'ospf', 'rip']) expect(aide, proto).toContain(proto);
  });

  it('`router ospf ?` annonce la plage du processus', async () => {
    const cli = await enConfig();

    expect(cli.cliHelp('router ospf ')).toMatch(/<1-65535>/);
  });

  it('`router eigrp ?` annonce la plage du systeme autonome', async () => {
    const cli = await enConfig();

    expect(cli.cliHelp('router eigrp ')).toMatch(/<1-65535>/);
  });

  it('`router bgp ?` annonce la plage a QUATRE octets', async () => {
    const cli = await enConfig();

    expect(cli.cliHelp('router bgp ')).toMatch(/<1-4294967295>/);
  });

  /*
   * Un systeme autonome a QUATRE octets (RFC 6793) est legitime depuis
   * 2009, et le gestionnaire l'acceptait deja ; seule la declaration
   * d'aide annoncait `<1-65535>`, et depuis que ce depot APPLIQUE les
   * plages annoncees, elle refusait ce que la commande accepte.
   */
  it('et un systeme autonome a quatre octets est ACCEPTE', async () => {
    const cli = await enConfig('router bgp 200000');

    expect(await configuration(cli)).toContain('router bgp 200000');
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const cli = await enConfig();
    const nues: string[] = [];
    for (const amont of ['router ', 'router ospf ', 'router eigrp ', 'router bgp ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
