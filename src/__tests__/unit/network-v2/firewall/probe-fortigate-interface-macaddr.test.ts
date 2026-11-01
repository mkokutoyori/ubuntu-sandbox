/**
 * `config system interface` : `set macaddr <mac>` (FortiOS CLI Reference 7.4.12, « Change the interface's MAC address »). L'interface prend l'adresse : un voisin qui
 * resout la passerelle apprend ce MAC (et non celui d'usine), `get system interface` / `show` la rend, et `unset macaddr` ou `00:00:00:00:00:00` rend le MAC d'usine.
 * Le MAC « permanent » memorise pour le HA (mode standalone) est celui qu'on a pose.
 * Mesure de depart : « unknown attribute macaddr » ; 2 des 4 cas tombent avant (adoption du MAC, sauvegarde), ; le temoin (le voisin apprend le MAC d'usine) et le retour au MAC d'usine apres `unset` passent des deux cotes.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

interface Cli { executeCommand(command: string): Promise<string> }
type Fw = Cli & { getPort(name: string): { getMAC(): { toString(): string } } };

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab() {
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
  pc.powerOn();
  new Cable('c').connect(pc.getPort('eth0') as never, (fw as never as { getPort(n: string): unknown }).getPort('port1') as never);
  await type(fw, ['config system interface', 'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next', 'end']);
  await type(pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  return { pc, fw };
}

const learned = async (pc: LinuxPC) => {
  await pc.executeCommand('ping -c 1 -W 1 192.168.1.1');
  return (await pc.executeCommand('ip neigh show 192.168.1.1')).toLowerCase();
};

describe('system interface macaddr', () => {
  it('temoin : le voisin apprend le MAC d usine', async () => {
    const { pc, fw } = await lab();
    expect(await learned(pc)).toContain(fw.getPort('port1').getMAC().toString().toLowerCase());
  });

  it('le voisin apprend le MAC pose', async () => {
    const { pc, fw } = await lab();
    await type(fw, ['config system interface', 'edit port1', 'set macaddr 02:aa:bb:cc:dd:01', 'next', 'end']);
    expect(await learned(pc)).toContain('02:aa:bb:cc:dd:01');
    expect(fw.getPort('port1').getMAC().toString().toLowerCase()).toBe('02:aa:bb:cc:dd:01');
  });

  it('unset macaddr rend le MAC d usine', async () => {
    const { fw } = await lab();
    const factory = fw.getPort('port1').getMAC().toString().toLowerCase();
    await type(fw, ['config system interface', 'edit port1', 'set macaddr 02:aa:bb:cc:dd:01', 'next', 'end']);
    await type(fw, ['config system interface', 'edit port1', 'unset macaddr', 'next', 'end']);
    expect(fw.getPort('port1').getMAC().toString().toLowerCase()).toBe(factory);
  });

  it('le MAC pose survit a la sauvegarde du lab', async () => {
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(fw, ['config system interface', 'edit port1', 'set macaddr 02:aa:bb:cc:dd:01', 'next', 'end']);
    const saved = JSON.parse(JSON.stringify(exportTopology('lab', new Map<string, Equipment>([[fw.getId(), fw as Equipment]]), [])));
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const back = await importTopology(saved);
    const reopened = [...back.deviceInstances.values()][0] as FortiGate;
    expect(reopened.getPort('port1')!.getMAC().toString().toLowerCase()).toBe('02:aa:bb:cc:dd:01');
  });
});
