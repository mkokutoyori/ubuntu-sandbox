/*
 * VTP pruning ne suivait pas l'etat des ports d'acces.
 *
 * Mesure de depart, sur le lab de l'utilisateur : un poste branche sur un
 * port d'acces du VLAN 10 d'un commutateur voisin n'etait jamais atteint
 * par une diffusion du VLAN 10. Le voisin avait elague le VLAN au moment
 * ou `vtp pruning` avait ete tape, quand aucun port d'acces du VLAN 10
 * n'etait encore actif ; le branchement du poste n'envoyait aucun Join, le
 * VLAN restait elague. A l'inverse, un poste debranche laissait le VLAN
 * ouvert sur le trunk. Et `show interfaces trunk` n'en disait rien : sa
 * section « not pruned » recopiait la liste des VLANs autorises, sans
 * consulter l'agent VTP.
 *
 * L'AUTORITE EST CISCO (VTP est proprietaire). « VTP Pruning » (Catalyst
 * configuration guides) : un commutateur annonce par des messages Join les
 * VLANs pour lesquels il a des ports actifs ; un voisin n'inonde sur le
 * trunk que les VLANs ainsi demandes. `show interfaces trunk` en rend
 * compte dans sa derniere section, « Vlans in spanning tree forwarding
 * state and not pruned ».
 *
 * Ecrite a l'aveugle contre ce fait, avant de lire l'agent.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 6 cas tombent. Passent des deux cotes : le TEMOIN (un poste deja
 * branche quand l'elagage est active est atteint — la demande part avec
 * `vtp pruning`), et « plugging a host … opens VLAN 10 », parce que la
 * section « not pruned » affichait deja 1,10 quoi qu'il arrive ; c'est le
 * ping du cas suivant qui porte ce fait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab {
  left: CiscoSwitch;
  right: CiscoSwitch;
  near: LinuxPC;
  far: LinuxPC;
  plugFar(): Cable;
}

async function type(device: CiscoSwitch | LinuxPC, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab(farPluggedBeforePruning: boolean): Promise<Lab> {
  const left = new CiscoSwitch('switch-cisco', 'LEFT', 8);
  const right = new CiscoSwitch('switch-cisco', 'RIGHT', 8);
  const near = new LinuxPC('linux-pc', 'NEAR');
  const far = new LinuxPC('linux-pc', 'FAR');
  for (const sw of [left, right]) {
    await type(sw, [
      'enable', 'configure terminal', 'vtp mode transparent', 'vlan 10', 'exit',
      'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/8', 'switchport mode trunk', 'exit', 'end',
    ]);
  }
  new Cable('near').connect(near.getPort('eth0')!, left.getPort('FastEthernet0/1')!);
  new Cable('trunk').connect(left.getPort('FastEthernet0/8')!, right.getPort('FastEthernet0/8')!);
  await near.executeCommand('sudo ip addr add 10.0.0.1/24 dev eth0');
  await far.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  const plugFar = (): Cable => {
    const cable = new Cable('far');
    cable.connect(far.getPort('eth0')!, right.getPort('FastEthernet0/1')!);
    return cable;
  };
  if (farPluggedBeforePruning) plugFar();
  for (const sw of [left, right]) await type(sw, ['configure terminal', 'vtp pruning', 'end']);
  return { left, right, near, far, plugFar };
}

async function notPruned(sw: CiscoSwitch): Promise<string> {
  const out = await sw.executeCommand('show interfaces trunk');
  const section = out.split('Vlans in spanning tree forwarding state and not pruned')[1] ?? '';
  return section.split('\n').find((l) => l.startsWith('Fa0/8'))?.slice(12).trim() ?? '';
}

const reaches = async (from: LinuxPC, to: string): Promise<boolean> =>
  /1 received/.test(await from.executeCommand(`ping -c 1 -W 1 ${to}`));

describe('VTP pruning follows the access ports behind the trunk', () => {
  it('a host already plugged when pruning starts is reached — WITNESS', async () => {
    const { near } = await lab(true);

    expect(await reaches(near, '10.0.0.2')).toBe(true);
  });

  it('VLAN 10 is pruned on the trunk while nobody behind it wants it', async () => {
    const { left } = await lab(false);

    expect(await notPruned(left)).toBe('1');
  });

  it('plugging a host into VLAN 10 behind the trunk opens VLAN 10 on it', async () => {
    const { left, plugFar } = await lab(false);
    plugFar();

    expect(await notPruned(left)).toBe('1,10');
  });

  it('and a broadcast from the near side then reaches that host', async () => {
    const { near, plugFar } = await lab(false);
    plugFar();

    expect(await reaches(near, '10.0.0.2')).toBe(true);
  });

  it('unplugging the last host of VLAN 10 prunes it again', async () => {
    const { left, right } = await lab(true);
    right.getPort('FastEthernet0/1')!.getCable()!.disconnect();

    expect(await notPruned(left)).toBe('1');
  });

  it('shutting down that access port prunes it too', async () => {
    const { left, right } = await lab(true);
    await type(right, ['configure terminal', 'interface FastEthernet0/1', 'shutdown', 'end']);

    expect(await notPruned(left)).toBe('1');
  });
});
