import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

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
}

let serial = 0;

async function enConfig(): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  for (const c of ['enable', 'configure terminal']) await device.executeCommand(c);
  return device;
}

/*
 * IP SLA de mode `config` : la porte des sous-modes deja migres, plus
 * l'ordonnancement, les reactions et le repondeur. Formes relevees sur
 * les gestionnaires, passees sur le code NON MIGRE avant de l'etre.
 *
 * Plusieurs commandes n'ont de sens qu'apres une operation definie —
 * `ip sla schedule 1` repond « % IP SLAs entry 1 does not exist » sinon
 * — donc le laboratoire en definit une d'abord.
 */
async function avecOperation(): Promise<Cli> {
  const device = await enConfig();
  await device.executeCommand('ip sla 1');
  await device.executeCommand('icmp-echo 10.0.0.9');
  await device.executeCommand('exit');
  return device;
}

const SANS_OPERATION: ReadonlyArray<string> = [
  'ip sla 1',
  'ip sla enable reaction-alerts',
  'no ip sla enable reaction-alerts',
  'ip sla logging traps',
  'no ip sla logging traps',
  'ip sla responder',
  'ip sla responder udp-echo ipaddress 10.0.0.1 port 5000',
  'no ip sla responder',
  'ip sla key-chain KC',
  'no ip sla key-chain',
  'no ip sla 1',
];

const AVEC_OPERATION: ReadonlyArray<string> = [
  'ip sla schedule 1 life forever start-time now',
  'ip sla schedule 1 start-time after 00:05:00',
  'ip sla schedule 1 ageout 3600 recurring',
  'ip sla group schedule G1 1 life forever',
  'ip sla restart 1',
  'ip sla reaction-configuration 1 react timeout threshold-type immediate action-type trapOnly',
  'ip sla reaction-trigger 1 2',
  'no ip sla schedule 1',
  'no ip sla reaction-configuration 1',
  'no ip sla reaction-trigger 1',
];

describe('IP SLA global reste accepte', () => {
  it.each(SANS_OPERATION)('`%s`', async (commande) => {
    expect(await (await enConfig()).executeCommand(commande))
      .not.toContain('Invalid input');
  });

  it.each(AVEC_OPERATION)('avec une operation definie › `%s`', async (commande) => {
    expect(await (await avecOperation()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('le gestionnaire garde ses refus, qui EXPLIQUENT', () => {
  it('ordonnancer une operation inexistante la NOMME', async () => {
    expect(await (await enConfig()).executeCommand('ip sla schedule 42 start-time now'))
      .toContain('IP SLAs entry 42 does not exist');
  });

  it('redemarrer une operation non ordonnancee le dit', async () => {
    expect(await (await avecOperation()).executeCommand('ip sla restart 1'))
      .toContain('not scheduled');
  });

  it('un protocole de repondeur inconnu est refuse au caret', async () => {
    expect(await (await enConfig()).executeCommand('ip sla responder zorglub'))
      .toContain('Invalid input detected');
  });
});

describe('`ip sla <n>` entre toujours dans le sous-mode migre', () => {
  it('puis on y choisit un type d\'operation', async () => {
    const device = await enConfig();
    await device.executeCommand('ip sla 7');
    expect(await device.executeCommand('udp-jitter 10.0.0.9 5000'))
      .not.toContain('Invalid input');
  });
});

describe('l\'arbre IP SLA de configTrie se vide', () => {
  it('aucun chemin `ip sla` ne reste', () => {
    const d = new CiscoRouter('RZ', 0, 0) as unknown as Cli;
    d.powerOn();
    const shell = (d as unknown as { shell: Record<string, unknown> }).shell;
    const restants = (shell.configTrie as CommandTrie).enumerateExecutablePaths()
      .filter(p => /^(no )?ip sla\b/.test(p));
    expect(restants).toEqual([]);
  });
});
