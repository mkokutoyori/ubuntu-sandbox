/*
 * Un routeur client DHCP gardait l'adresse qu'il avait avant de demander
 * un bail, et l'export la rangeait comme une adresse STATIQUE.
 *
 * Mesure de depart, sur la topologie de l'utilisateur rechargee
 * (`lan_with_firewall_fortigate.topology (1).json`) : R4 porte
 * `ip address dhcp-alloc` sur GE0/0/0, et l'export avait range son bail
 * (192.168.30.3) dans `interfaces[]` comme une adresse fixe. Au
 * rechargement, GE0/0/0 reprenait .3 en statique, PUIS redemandait un
 * bail en la gardant ; R3 sondait .3 avant de l'offrir, R4 lui-meme
 * repondait, et
 *
 *   R3 : show ip dhcp conflict   192.168.30.3   ping
 *   R4 : display ip routing-table   192.168.30.7   GE0/0/0
 *
 * R4 changeait d'adresse a chaque rechargement, et chaque rechargement
 * brulait une adresse du pool.
 *
 * L'AUTORITE : RFC 2131 §4.4.1 — un client en INIT n'a pas d'adresse, il
 * emet DHCPDISCOVER depuis 0.0.0.0 ; et IOS, ou `ip address dhcp`
 * REMPLACE l'adresse de l'interface (une interface n'a qu'une adresse
 * primaire, la derniere commande `ip address` l'emporte). Le bail
 * appartient au serveur qui l'a donne : il ne se sauvegarde pas comme
 * une adresse fixe, la configuration porte `ip address dhcp-alloc` et
 * cela suffit.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le client.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network src/store`) :
 * 3 des 4 cas tombent. Le TEMOIN, R4 obtenant .3 au premier bail, passe
 * des deux cotes : c'est le rechargement et le remplacement d'une adresse
 * fixe qui etaient faux, pas le premier echange.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import { buildConnection, type Connection } from '@/store/networkStore';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

type Cli = { executeCommand(c: string): Promise<string> };

async function type(device: Cli, commands: string[]): Promise<void> {
  for (const c of commands) await device.executeCommand(c);
}

interface Lab {
  r3: CiscoRouter;
  r4: HuaweiRouter;
  devices: Map<string, Equipment>;
  connections: Connection[];
}

async function lab(): Promise<Lab> {
  const r3 = new CiscoRouter('R3', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 6, 0, 0);
  const squatter = new LinuxPC('linux-pc', 'H2', 0, 0);
  const r4 = new HuaweiRouter('R4', 0, 0);
  const connections = [
    buildConnection(r3, r3.getPorts()[0].getName(), sw, sw.getPorts()[0].getName(), 'ethernet'),
    buildConnection(squatter, 'eth0', sw, sw.getPorts()[1].getName(), 'ethernet'),
    buildConnection(r4, 'GE0/0/0', sw, sw.getPorts()[2].getName(), 'ethernet'),
  ].filter((c): c is Connection => c !== null);
  await type(r3, [
    'enable', 'configure terminal',
    `interface ${r3.getPorts()[0].getName()}`, 'ip address 192.168.30.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool HQ', 'network 192.168.30.0 255.255.255.0', 'default-router 192.168.30.1', 'exit', 'end',
  ]);
  await squatter.executeCommand('sudo ip addr add 192.168.30.2/24 dev eth0');
  await type(r4, ['system-view', 'interface GigabitEthernet0/0/0', 'undo shutdown', 'ip address dhcp-alloc', 'return']);
  const devices = new Map<string, Equipment>([r3, sw, squatter, r4].map((d) => [d.getId(), d as unknown as Equipment]));
  return { r3, r4, devices, connections };
}

const addressOf = (r4: HuaweiRouter): string | undefined => r4.getPort('GE0/0/0')?.getIPAddress()?.toString();

describe('a lease stays a lease', () => {
  it('R4 obtains .3, the first free address — WITNESS', async () => {
    const { r4 } = await lab();

    expect(addressOf(r4)).toBe('192.168.30.3');
  }, 30000);

  it('the export does not store the lease as a fixed address', async () => {
    const { devices, connections } = await lab();

    const exported = exportTopology('lab', devices, connections);
    const ge = exported.devices.find((d) => d.name === 'R4')?.interfaces.find((i) => i.name === 'GE0/0/0');
    expect(ge?.ipAddress).toBeUndefined();
  }, 30000);

  it('reloaded, the topology gives R4 the same address, without a conflict', async () => {
    const { devices, connections } = await lab();
    const exported = JSON.parse(JSON.stringify(exportTopology('lab', devices, connections))) as TopologyExport;
    EquipmentRegistry.resetInstance();

    const imported = await importTopology(exported);
    const byName = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d]));
    const r3 = byName.get('R3') as unknown as CiscoRouter;
    const r4 = byName.get('R4') as unknown as HuaweiRouter;

    expect(addressOf(r4)).toBe('192.168.30.3');
    expect(await r3.executeCommand('show ip dhcp conflict')).not.toMatch(/192\.168\.30\.3\b/);
  }, 30000);
});

describe('`ip address dhcp` replaces the interface address', () => {
  it('a router holding .2 statically gives it up, and the server hands it back without a conflict', async () => {
    const { r3 } = await lab();
    const r5 = new CiscoRouter('R5', 0, 0);
    const lan = new GenericSwitch('switch-generic', 'SW5', 4, 0, 0);
    buildConnection(r3, r3.getPorts()[1].getName(), lan, lan.getPorts()[0].getName(), 'ethernet');
    buildConnection(r5, r5.getPorts()[0].getName(), lan, lan.getPorts()[1].getName(), 'ethernet');
    await type(r3, [
      'enable', 'configure terminal',
      `interface ${r3.getPorts()[1].getName()}`, 'ip address 192.168.31.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp pool BRANCH', 'network 192.168.31.0 255.255.255.0', 'default-router 192.168.31.1', 'exit', 'end',
    ]);
    const iface = r5.getPorts()[0].getName();
    await type(r5, [
      'enable', 'configure terminal', `interface ${iface}`,
      'ip address 192.168.31.2 255.255.255.0', 'no shutdown', 'ip address dhcp', 'end',
    ]);

    expect(r5.getPort(iface)?.getIPAddress()?.toString()).toBe('192.168.31.2');
    expect(await r3.executeCommand('show ip dhcp conflict')).not.toMatch(/192\.168\.31\.2\b/);
  }, 30000);
});
