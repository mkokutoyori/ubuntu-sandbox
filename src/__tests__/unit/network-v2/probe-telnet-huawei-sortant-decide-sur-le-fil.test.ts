/*
 * Sonde — le `telnet` sortant d'un routeur Huawei decide d'apres le fil, pas d'apres le nom de la classe de la cible.
 *
 * Mesure AVANT : `telnet 10.0.0.20` depuis un AR1 vers un LinuxServer dont telnetd ecoute sur :23 repondait « Error: Failed to
 * connect to the remote host. » — `remoteAcceptsTelnet` ne connaissait que les equipements dont la classe s'appelle Router ou Switch.
 * Un telnetd arrete, lui, etait « accepte » ou refuse selon ce meme nom, jamais selon l'ecoute.
 *
 * UN cas sur trois tombe avant la correction (le serveur qui ecoute). Les deux autres sont NOMMES : le temoin (le meme serveur,
 * telnetd arrete, est refuse avant comme apres : la verite et l'heuristique coincident) et la non-regression (un routeur Cisco
 * cable est toujours atteint).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lan() {
  const huawei = new HuaweiRouter('AR1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV');
  const cisco = new CiscoRouter('R2', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  new Cable('a').connect(huawei.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  new Cable('c').connect(cisco.getPorts()[0], sw.getPorts()[2]);
  for (const cmd of ['system-view', 'interface GigabitEthernet0/0/0', 'ip address 10.0.0.1 255.255.255.0', 'undo shutdown', 'quit', 'quit']) await huawei.executeCommand(cmd);
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.30 255.255.255.0', 'no shutdown', 'end']) await cisco.executeCommand(cmd);
  return { huawei, server, cisco };
}

describe('telnet sortant depuis un routeur Huawei', () => {
  it('temoin : un telnetd arrete est refuse', async () => {
    const { huawei } = await lan();
    expect(await huawei.executeCommand('telnet 10.0.0.20')).toContain('Failed to connect to the remote host');
  });

  it('un telnetd qui ecoute est atteint', async () => {
    const { huawei, server } = await lan();
    await server.executeCommand('systemctl start telnet');
    const out = await huawei.executeCommand('telnet 10.0.0.20');
    expect(out).toContain('Connected to 10.0.0.20');
  });

  it('non-regression : un routeur Cisco cable est atteint', async () => {
    const { huawei } = await lan();
    expect(await huawei.executeCommand('telnet 10.0.0.30')).toContain('Connected to 10.0.0.30');
  });
});
