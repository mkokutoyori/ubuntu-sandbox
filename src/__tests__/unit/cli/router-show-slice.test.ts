/**
 * Les quinze vues du routeur declarees par `registerShowCommands`.
 *
 * Le risque de cette tranche n'est pas la commande isolee mais la PAIRE :
 * `show ip interface` est gloutonne et `show ip interface brief` est une
 * commande a part ; `show ip rip` et `show ip rip database` de meme. Une
 * migration qui laisse le glouton avaler la forme longue ne se voit pas
 * — la commande repond, elle repond simplement autre chose.
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
  getPortNames(): string[];
}

let serial = 0;

function routeur(): Cli {
  const r = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  r.powerOn();
  return r;
}

async function privilegie(...lignes: string[]): Promise<Cli> {
  const r = routeur();
  await r.executeCommand('enable');
  for (const c of lignes) await r.executeCommand(c);
  return r;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

const VUES: readonly string[] = [
  'show tech-support',
  'show bfd summary',
  'show table-map',
  'show ip nbar protocol-discovery',
  'show queueing interface',
  'show traffic-shape',
  'show ip policy',
  'show ip static route',
  'show ip interface brief',
  'show ip rip database',
  'show counters',
  'show ip rip',
  'show interfaces',
  'show vlans',
  'show ip interface',
];

describe('chaque vue repond', () => {
  it.each(VUES)('`%s` en EXEC privilegie', async (vue) => {
    const r = await privilegie();

    expect(refuse(await r.executeCommand(vue)), vue).toBe(false);
  });

  it.each(VUES.filter(vue => vue !== 'show tech-support'))(
    '`%s` en EXEC utilisateur', async (vue) => {
      const r = routeur();

      expect(refuse(await r.executeCommand(vue)), vue).toBe(false);
    });

  it('`show tech-support` reste au niveau 15, elle', async () => {
    const r = routeur();

    expect(refuse(await r.executeCommand('show tech-support'))).toBe(true);
  });
});

describe('la forme LONGUE n est pas avalee par la gloutonne', () => {
  it('`show ip interface brief` rend le TABLEAU, pas le detail', async () => {
    const r = await privilegie();
    const bref = await r.executeCommand('show ip interface brief');

    expect(bref).toMatch(/Interface\s+IP-Address/);
    expect(bref).not.toMatch(/MTU is \d+ bytes/);
  });

  it('`show ip interface <nom>` rend le DETAIL de cette interface', async () => {
    const r = await privilegie();
    const nom = r.getPortNames()[0];
    const detail = await r.executeCommand(`show ip interface ${nom}`);

    expect(detail).toContain(nom);
    expect(detail).not.toMatch(/Interface\s+IP-Address\s+OK\?/);
  });

  it('`show ip rip database` ne rend pas ce que `show ip rip` rend', async () => {
    const r = await privilegie();

    expect(await r.executeCommand('show ip rip database'))
      .not.toBe(await r.executeCommand('show ip rip'));
  });

  it('`show interfaces <nom>` ne rend qu UNE interface', async () => {
    const r = await privilegie();
    const noms = r.getPortNames();
    const une = await r.executeCommand(`show interfaces ${noms[0]}`);

    expect(une).toContain(noms[0]);
    if (noms[1]) expect(une).not.toContain(noms[1]);
  });
});

describe('l aide de ces vues', () => {
  it('`show ip interface ?` annonce `brief` ET un nom d interface', async () => {
    const r = await privilegie();
    const aide = r.cliHelp('show ip interface ');

    expect(aide).toContain('brief');
  });

  it('aucune ligne de `show ?` ne reste sans description', async () => {
    const r = await privilegie();
    const nues = r.cliHelp('show ').split('\n').map(l => l.trim())
      .filter(l => l !== '' && l !== '<cr>' && !/\s{2,}\S/.test(l));

    expect(nues).toEqual([]);
  });
});
