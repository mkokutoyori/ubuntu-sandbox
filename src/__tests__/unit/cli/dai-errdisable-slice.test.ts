/**
 * L'inspection ARP dynamique du Catalyst, et la reprise apres
 * err-disable qui va avec.
 *
 * Seize chemins repartis sur TROIS modes — configuration, configuration
 * d'interface, EXEC privilegie — donc une tranche a portee mixte comme
 * 802.1X. Le comportement du moteur est mesure ailleurs ; ici c'est la
 * CLI qui est en question.
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

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

async function surUnPort(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal',
    `interface ${sw.getPortNames()[0]}`, ...lignes]) {
    await sw.executeCommand(c);
  }
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe('l inspection ARP se declare par VLAN', () => {
  it('`ip arp inspection vlan 10` est accepte et rendu', async () => {
    const cli = await commutateur('vlan 10', 'exit', 'ip arp inspection vlan 10');

    expect(await configuration(cli)).toContain('ip arp inspection vlan 10');
  });

  it('`no ip arp inspection vlan 10` la retire', async () => {
    const cli = await commutateur('vlan 10', 'exit',
      'ip arp inspection vlan 10', 'no ip arp inspection vlan 10');

    expect(await configuration(cli)).not.toContain('ip arp inspection vlan 10');
  });

  it('`ip arp inspection validate src-mac dst-mac ip` est accepte et rendu', async () => {
    const cli = await commutateur('ip arp inspection validate src-mac dst-mac ip');
    const cfg = await configuration(cli);

    expect(cfg).toContain('ip arp inspection validate');
    for (const mot of ['src-mac', 'dst-mac', 'ip']) expect(cfg, mot).toContain(mot);
  });

  it('`ip arp inspection filter <acl> vlan <n>` est accepte', async () => {
    const cli = await commutateur('arp access-list POSTES', 'exit',
      'vlan 10', 'exit');

    expect(refuse(await cli.executeCommand('ip arp inspection filter POSTES vlan 10')))
      .toBe(false);
  });

  it('`ip arp inspection filter` sans VLAN est incomplet', async () => {
    const cli = await commutateur();

    expect(await cli.executeCommand('ip arp inspection filter POSTES'))
      .toContain('Incomplete');
  });
});

describe('la confiance et la limite se posent sur le PORT', () => {
  it('`ip arp inspection trust` est accepte et rendu', async () => {
    const cli = await surUnPort('ip arp inspection trust');

    expect(await configuration(cli)).toContain('ip arp inspection trust');
  });

  it('`no ip arp inspection trust` la retire', async () => {
    const cli = await surUnPort('ip arp inspection trust', 'no ip arp inspection trust');

    expect(await configuration(cli)).not.toContain('ip arp inspection trust');
  });

  it('`ip arp inspection limit rate 50` est accepte et rendu', async () => {
    const cli = await surUnPort('ip arp inspection limit rate 50');

    expect(await configuration(cli)).toContain('ip arp inspection limit rate 50');
  });

  it('la confiance n existe PAS en configuration globale', async () => {
    const cli = await commutateur();

    expect(refuse(await cli.executeCommand('ip arp inspection trust'))).toBe(true);
  });
});

describe('la reprise apres err-disable', () => {
  it.each([
    'errdisable recovery cause arp-inspection',
    'errdisable recovery cause bpduguard',
    'errdisable recovery interval 60',
  ])('`%s` est accepte', async (ligne) => {
    const cli = await commutateur();

    expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
  });

  it('`show errdisable recovery` lit l intervalle pose', async () => {
    const cli = await commutateur('errdisable recovery interval 60');
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show errdisable recovery')).toContain('60');
  });
});

describe('les effacements', () => {
  it.each([
    'clear ip arp inspection statistics',
    'clear spanning-tree detected-protocols',
    'clear spanning-tree counters',
  ])('`%s` repond en EXEC privilegie', async (ligne) => {
    const cli = await commutateur();
    await cli.executeCommand('end');

    expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
  });
});

describe('l aide decrit ces places', () => {
  it('`ip arp inspection ?` annonce ses sous-commandes globales', async () => {
    const cli = await commutateur();
    const aide = cli.cliHelp('ip arp inspection ');

    for (const mot of ['filter', 'validate', 'vlan']) expect(aide, mot).toContain(mot);
  });

  it('`errdisable recovery ?` annonce `cause` et `interval`', async () => {
    const cli = await commutateur();
    const aide = cli.cliHelp('errdisable recovery ');

    for (const mot of ['cause', 'interval']) expect(aide, mot).toContain(mot);
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const cli = await commutateur();
    const nues: string[] = [];
    for (const amont of ['ip arp inspection ', 'errdisable ', 'errdisable recovery ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
