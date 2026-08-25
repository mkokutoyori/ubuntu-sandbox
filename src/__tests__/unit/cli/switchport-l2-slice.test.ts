/**
 * `switchport` — mode, VLAN d'acces, agregation, telephonie.
 *
 * Les formes viennent de la reference Catalyst. Le comportement L2 est
 * mesure ailleurs (VLAN, DTP, agregation) : cette suite pose les
 * questions de la CLI — ce qui est accepte, ce qui est REFUSE, ce que la
 * configuration rend, et ce que `?` decrit de chaque place.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

async function surUnPort(...prealable: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...prealable,
    `interface ${sw.getPortNames()[0]}`]) {
    await sw.executeCommand(c);
  }
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized|% Invalid/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe('le MODE d une interface', () => {
  it.each([
    ['switchport mode access', 'switchport mode access'],
    ['switchport mode trunk', 'switchport mode trunk'],
    ['switchport mode dynamic auto', 'switchport mode dynamic auto'],
    ['switchport mode dynamic desirable', 'switchport mode dynamic desirable'],
  ])('`%s` est accepte et rendu', async (ligne, attendu) => {
    const cli = await surUnPort();
    expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
    expect(await configuration(cli), ligne).toContain(attendu);
  });

  it('`switchport mode zorglub` est refuse', async () => {
    const cli = await surUnPort();
    expect(refuse(await cli.executeCommand('switchport mode zorglub'))).toBe(true);
  });

  it('`switchport mode ?` annonce les modes d IOS', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('switchport mode ');

    for (const mot of ['access', 'dynamic', 'trunk']) expect(aide, mot).toContain(mot);
  });

  it('`switchport nonegotiate` coupe DTP, et `no` le rend', async () => {
    const cli = await surUnPort();
    await cli.executeCommand('switchport mode trunk');
    expect(refuse(await cli.executeCommand('switchport nonegotiate'))).toBe(false);
    expect(await configuration(cli)).toContain('switchport nonegotiate');

    await cli.executeCommand('configure terminal');
    await cli.executeCommand(`interface ${cli.getPortNames()[0]}`);
    expect(refuse(await cli.executeCommand('no switchport nonegotiate'))).toBe(false);
    expect(await configuration(cli)).not.toContain('switchport nonegotiate');
  });
});

describe('le VLAN d ACCES', () => {
  it('`switchport access vlan 20` est accepte et rendu', async () => {
    const cli = await surUnPort('vlan 20', 'exit');
    await cli.executeCommand('switchport mode access');
    expect(refuse(await cli.executeCommand('switchport access vlan 20'))).toBe(false);
    expect(await configuration(cli)).toContain('switchport access vlan 20');
  });

  it('un numero HORS PLAGE est refuse', async () => {
    const cli = await surUnPort();
    expect(refuse(await cli.executeCommand('switchport access vlan 5000'))).toBe(true);
  });

  it('`switchport access vlan ?` annonce la plage, pas un mot', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('switchport access vlan ');

    expect(aide).toMatch(/<1-4094>/);
    expect(aide).not.toContain('WORD');
  });
});

describe('l AGREGATION', () => {
  it('`switchport trunk native vlan 99` est accepte et rendu', async () => {
    const cli = await surUnPort('vlan 99', 'exit');
    await cli.executeCommand('switchport mode trunk');
    expect(refuse(await cli.executeCommand('switchport trunk native vlan 99'))).toBe(false);
    expect(await configuration(cli)).toContain('switchport trunk native vlan 99');
  });

  it.each([
    'switchport trunk allowed vlan 10,20',
    'switchport trunk allowed vlan add 30',
    'switchport trunk allowed vlan remove 20',
    'switchport trunk allowed vlan all',
    'switchport trunk allowed vlan none',
    'switchport trunk allowed vlan except 10',
  ])('`%s` est accepte', async (ligne) => {
    const cli = await surUnPort('vlan 10', 'exit', 'vlan 20', 'exit', 'vlan 30', 'exit');
    await cli.executeCommand('switchport mode trunk');
    await cli.executeCommand('switchport trunk allowed vlan 10,20');
    expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
  });

  it('`switchport trunk allowed vlan ?` annonce ses mots-cles', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('switchport trunk allowed vlan ');

    for (const mot of ['add', 'all', 'except', 'none', 'remove']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`switchport trunk encapsulation dot1q` est accepte', async () => {
    const cli = await surUnPort();
    expect(refuse(await cli.executeCommand('switchport trunk encapsulation dot1q'))).toBe(false);
  });

  it('`switchport trunk ?` annonce ses quatre places', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('switchport trunk ');

    for (const mot of ['allowed', 'encapsulation', 'native', 'pruning']) {
      expect(aide, mot).toContain(mot);
    }
  });
});

describe('le VLAN DE TELEPHONIE', () => {
  it('`switchport voice vlan 150` est accepte et rendu', async () => {
    const cli = await surUnPort('vlan 150', 'exit');
    await cli.executeCommand('switchport mode access');
    expect(refuse(await cli.executeCommand('switchport voice vlan 150'))).toBe(false);
    expect(await configuration(cli)).toContain('switchport voice vlan 150');
  });

  it('`no switchport voice vlan` le retire', async () => {
    const cli = await surUnPort('vlan 150', 'exit');
    await cli.executeCommand('switchport voice vlan 150');
    expect(refuse(await cli.executeCommand('no switchport voice vlan'))).toBe(false);
    expect(await configuration(cli)).not.toContain('switchport voice vlan 150');
  });

  it('`switchport voice vlan ?` annonce la plage ET les mots-cles', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('switchport voice vlan ');

    expect(aide).toMatch(/<1-4094>/);
    for (const mot of ['dot1p', 'none', 'untagged']) expect(aide, mot).toContain(mot);
  });
});

describe('le PORT PROTEGE', () => {
  it('`switchport protected` est accepte, rendu, et `no` le retire', async () => {
    const cli = await surUnPort();
    expect(refuse(await cli.executeCommand('switchport protected'))).toBe(false);
    expect(await configuration(cli)).toContain('switchport protected');

    await cli.executeCommand('configure terminal');
    await cli.executeCommand(`interface ${cli.getPortNames()[0]}`);
    expect(refuse(await cli.executeCommand('no switchport protected'))).toBe(false);
    expect(await configuration(cli)).not.toContain('switchport protected');
  });
});

describe('l aide de la famille decrit chaque mot', () => {
  it('`switchport ?` annonce les sous-commandes du commutateur', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('switchport ');

    for (const mot of ['access', 'mode', 'nonegotiate', 'port-security', 'trunk', 'voice']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const cli = await surUnPort();
    const nues: string[] = [];
    for (const amont of ['switchport ', 'switchport mode ', 'switchport trunk ',
      'switchport access ', 'switchport voice ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
