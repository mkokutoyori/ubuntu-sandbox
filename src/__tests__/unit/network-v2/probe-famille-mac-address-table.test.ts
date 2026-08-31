/**
 * Ecrit A L'AVEUGLE depuis la reference IOS (Catalyst), avant toute
 * lecture du code.
 *
 * `mac address-table aging-time <n>` regle le vieillissement — 300
 * secondes par defaut, `0` le desactive. `mac address-table static
 * <H.H.H> vlan <id> interface <nom>` pose une entree qui ne vieillit
 * pas, et sa forme en `no` la retire. `show mac address-table` rend la
 * table, `show mac address-table count` les compteurs,
 * `show mac address-table aging-time` le reglage. `clear mac
 * address-table dynamic` vide ce qui a ete APPRIS sans toucher au
 * statique.
 *
 * Une adresse MAC s'ecrit `H.H.H` sur IOS (`0011.2233.4455`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
}

/**
 * Cette famille refuse avec SES PROPRES mots — `% Invalid aging time`,
 * `% Invalid MAC address (expected H.H.H)` — plus precis que le caret
 * generique. La sonde exigeait d'abord le caret, et c'etait elle qui
 * avait tort : c'est le refus le plus precis qui doit parler.
 */
const REFUS =
  /Invalid input|Incomplete command|Unknown command|Invalid aging time|Invalid MAC address/;

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

async function enConfig(d: Cli): Promise<Cli> {
  await taper(d, ['enable', 'configure terminal']);
  return d;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

describe('`mac address-table aging-time` regle le vieillissement', () => {
  it('la commande est acceptee', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('mac address-table aging-time 120'))
      .not.toMatch(REFUS);
  });

  it('la valeur se relit dans la configuration', async () => {
    const sw = await enConfig(catalyst());
    await sw.executeCommand('mac address-table aging-time 120');

    expect(await config(sw)).toContain('mac address-table aging-time 120');
  });

  it('`show mac address-table aging-time` la rend', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['mac address-table aging-time 120', 'end']);

    expect(await sw.executeCommand('show mac address-table aging-time'))
      .toContain('120');
  });

  it('le DEFAUT est 300 secondes', async () => {
    const sw = catalyst();
    await sw.executeCommand('enable');

    expect(await sw.executeCommand('show mac address-table aging-time'))
      .toContain('300');
  });

  it('le defaut ne parait PAS dans la configuration', async () => {
    const sw = await enConfig(catalyst());

    expect(await config(sw)).not.toMatch(/mac address-table aging-time 300/);
  });

  it('`0` est accepte — il desactive le vieillissement', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('mac address-table aging-time 0'))
      .not.toMatch(REFUS);
  });

  it('une valeur negative est refusee', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('mac address-table aging-time -5')).toMatch(REFUS);
  });

  it('un mot qui n est pas un nombre est refuse', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('mac address-table aging-time zorglub'))
      .toMatch(REFUS);
  });

  it('et il n entre pas dans la configuration', async () => {
    const sw = await enConfig(catalyst());
    await sw.executeCommand('mac address-table aging-time zorglub');

    expect(await config(sw)).not.toContain('zorglub');
  });
});

describe('`mac address-table static` pose une entree qui ne vieillit pas', () => {
  const MAC = '0011.2233.4455';

  async function avecStatique(): Promise<Cli> {
    const sw = await enConfig(catalyst());
    const port = sw.getPortNames()[0];
    await taper(sw, [
      'vlan 10', 'exit',
      `mac address-table static ${MAC} vlan 10 interface ${port}`,
    ]);
    return sw;
  }

  it('la commande est acceptee', async () => {
    const sw = await enConfig(catalyst());
    const port = sw.getPortNames()[0];
    await taper(sw, ['vlan 10', 'exit']);

    expect(await sw.executeCommand(
      `mac address-table static ${MAC} vlan 10 interface ${port}`))
      .not.toMatch(REFUS);
  });

  it('l entree parait dans `show mac address-table`', async () => {
    const sw = await avecStatique();
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show mac address-table')).toContain(MAC);
  });

  it('elle y est marquee STATIC', async () => {
    const sw = await avecStatique();
    await sw.executeCommand('end');
    const ligne = (await sw.executeCommand('show mac address-table'))
      .split('\n').find(l => l.includes(MAC));

    expect(ligne).toBeDefined();
    expect(ligne!.toUpperCase()).toContain('STATIC');
  });

  it('elle se relit dans la configuration', async () => {
    const sw = await avecStatique();

    expect(await config(sw)).toContain(`mac address-table static ${MAC}`);
  });

  it('le `no` la retire', async () => {
    const sw = await avecStatique();
    const port = sw.getPortNames()[0];
    await sw.executeCommand(
      `no mac address-table static ${MAC} vlan 10 interface ${port}`);
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show mac address-table')).not.toContain(MAC);
  });

  it('une adresse malformee est refusee', async () => {
    const sw = await enConfig(catalyst());
    const port = sw.getPortNames()[0];

    expect(await sw.executeCommand(
      `mac address-table static zorglub vlan 10 interface ${port}`))
      .toMatch(REFUS);
  });

  it('et elle n entre pas dans la table', async () => {
    const sw = await enConfig(catalyst());
    const port = sw.getPortNames()[0];
    await taper(sw, [
      `mac address-table static zorglub vlan 10 interface ${port}`, 'end',
    ]);

    expect(await sw.executeCommand('show mac address-table')).not.toContain('zorglub');
  });
});

describe('`clear mac address-table dynamic` ne vide que l APPRIS', () => {
  it('l entree statique survit', async () => {
    const sw = await enConfig(catalyst());
    const port = sw.getPortNames()[0];
    await taper(sw, [
      'vlan 10', 'exit',
      `mac address-table static 0011.2233.4455 vlan 10 interface ${port}`,
      'end', 'clear mac address-table dynamic',
    ]);

    expect(await sw.executeCommand('show mac address-table'))
      .toContain('0011.2233.4455');
  });
});

describe('`show mac address-table count` compte', () => {
  it('la vue existe et porte un nombre', async () => {
    const sw = catalyst();
    await sw.executeCommand('enable');

    const vue = await sw.executeCommand('show mac address-table count');
    expect(vue).not.toMatch(REFUS);
    expect(vue).toMatch(/\d/);
  });
});

describe('`mac address-table ?` decrit ses suites', () => {
  it('`aging-time` et `static` y sont decrits', async () => {
    const sw = await enConfig(catalyst());
    const vue = await sw.executeCommand('mac address-table ?');

    expect(vue).toMatch(/^\s*aging-time\s+\S/m);
    expect(vue).toMatch(/^\s*static\s+\S/m);
  });
});
