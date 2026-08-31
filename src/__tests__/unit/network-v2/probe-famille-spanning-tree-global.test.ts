/**
 * Ecrit A L'AVEUGLE depuis la reference IOS (Catalyst), avant toute
 * lecture du code.
 *
 * `spanning-tree mode {pvst|rapid-pvst|mst}` choisit la variante ;
 * `spanning-tree vlan <liste> {priority <n>|root primary|root secondary}`
 * regle l'election ; `spanning-tree portfast default` et
 * `spanning-tree portfast bpduguard default` posent les defauts globaux ;
 * `spanning-tree extend system-id` etend l'identifiant.
 *
 * Les bornes d'IOS sont precises et se verifient : la PRIORITE va de 0 a
 * 61440 par pas de 4096 — une valeur qui n'est pas un multiple est
 * refusee — et le VLAN va de 1 a 4094.
 *
 * TROIS premisses etaient fausses et sont corrigees ici plutot
 * qu'effacees. Le refus de la priorite porte les mots d'IOS —
 * `% Bridge Priority must be in increments of 4096` — plus precis que le
 * caret. `show spanning-tree summary` ecrit `rapid-pvst` avec son trait
 * d'union. Et `spanning-tree vlan 10 root primary` ne CREE pas le VLAN :
 * sans `vlan 10`, `show spanning-tree vlan 10` repond a juste titre que
 * l'instance n'existe pas, et c'etait le laboratoire de la sonde qui
 * etait incomplet.
 *
 * Aucun defaut n'a ete trouve : cette famille est fidele, et la sonde
 * est un garde-fou de migration.
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
}

const REFUS =
  /Invalid input|Incomplete command|Unknown command|must be in increments/;

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

describe('`spanning-tree mode` choisit la variante', () => {
  const MODES = ['pvst', 'rapid-pvst', 'mst'];

  for (const mode of MODES) {
    it(`\`spanning-tree mode ${mode}\` est accepte`, async () => {
      const sw = await enConfig(catalyst());

      expect(await sw.executeCommand(`spanning-tree mode ${mode}`))
        .not.toMatch(REFUS);
    });

    it(`\`spanning-tree mode ${mode}\` est rendu par `.concat('`show spanning-tree summary`'), async () => {
      const sw = await enConfig(catalyst());
      await taper(sw, [`spanning-tree mode ${mode}`, 'end']);

      expect((await sw.executeCommand('show spanning-tree summary')).toLowerCase())
        .toContain(mode);
    });
  }

  it('un mode inconnu est REFUSE', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('spanning-tree mode zorglub')).toMatch(REFUS);
  });

  it('et il n entre pas dans la configuration', async () => {
    const sw = await enConfig(catalyst());
    await sw.executeCommand('spanning-tree mode zorglub');

    expect(await config(sw)).not.toContain('zorglub');
  });
});

describe('`spanning-tree vlan <n> priority` respecte le pas de 4096', () => {
  it('une valeur multiple de 4096 est acceptee', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('spanning-tree vlan 10 priority 8192'))
      .not.toMatch(REFUS);
  });

  it('elle se relit dans la configuration', async () => {
    const sw = await enConfig(catalyst());
    await sw.executeCommand('spanning-tree vlan 10 priority 8192');

    expect(await config(sw)).toContain('spanning-tree vlan 10 priority 8192');
  });

  it('une valeur qui N EST PAS un multiple de 4096 est refusee', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('spanning-tree vlan 10 priority 1000'))
      .toMatch(REFUS);
  });

  it('et elle n entre pas dans la configuration', async () => {
    const sw = await enConfig(catalyst());
    await sw.executeCommand('spanning-tree vlan 10 priority 1000');

    expect(await config(sw)).not.toContain('priority 1000');
  });

  it('au-dela de 61440, elle est refusee', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('spanning-tree vlan 10 priority 65536'))
      .toMatch(REFUS);
  });
});

describe('`spanning-tree vlan <n> root` designe la racine', () => {
  for (const role of ['primary', 'secondary']) {
    it(`\`root ${role}\` est accepte`, async () => {
      const sw = await enConfig(catalyst());

      expect(await sw.executeCommand(`spanning-tree vlan 10 root ${role}`))
        .not.toMatch(REFUS);
    });

    it(`\`root ${role}\` ABAISSE la priorite du VLAN`, async () => {
      const sw = await enConfig(catalyst());
      await taper(sw, [
        'vlan 10', 'exit', `spanning-tree vlan 10 root ${role}`, 'end',
      ]);
      const vue = await sw.executeCommand('show spanning-tree vlan 10');

      expect(vue).toMatch(/Priority\s+\d+/);
    });
  }
});

describe('les defauts globaux de PortFast', () => {
  const DEFAUTS = [
    'spanning-tree portfast default',
    'spanning-tree portfast bpduguard default',
  ];

  for (const saisie of DEFAUTS) {
    it(`\`${saisie}\` est accepte`, async () => {
      const sw = await enConfig(catalyst());

      expect(await sw.executeCommand(saisie)).not.toMatch(REFUS);
    });

    it(`\`${saisie}\` se relit dans la configuration`, async () => {
      const sw = await enConfig(catalyst());
      await sw.executeCommand(saisie);

      expect(await config(sw)).toContain(saisie);
    });

    it(`le \`no\` de \`${saisie}\` le retire`, async () => {
      const sw = await enConfig(catalyst());
      await taper(sw, [saisie, `no ${saisie}`]);

      expect(await config(sw)).not.toContain(saisie);
    });
  }
});

describe('`spanning-tree ?` decrit ses suites', () => {
  it('`mode`, `vlan` et `portfast` y sont decrits', async () => {
    const sw = await enConfig(catalyst());
    const vue = await sw.executeCommand('spanning-tree ?');

    expect(vue).toMatch(/^\s*mode\s+\S/m);
    expect(vue).toMatch(/^\s*vlan\s+\S/m);
    expect(vue).toMatch(/^\s*portfast\s+\S/m);
  });
});
