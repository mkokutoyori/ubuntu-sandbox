/*
 * Un FortiGate qui sert du DHCP ne propose pas une adresse qu'un autre poste
 * porte deja : il la sonde avant de l'offrir, par une vraie requete ARP, et
 * passe a la suivante si quelqu'un repond.
 *
 * L'AUTORITE :
 * - RFC 2131 §3.1.2 : « le serveur qui alloue une adresse DEVRAIT sonder
 *   l'adresse avant de l'allouer, par exemple par un ICMP echo request »,
 *   et « si la sonde reussit, le serveur ne propose pas cette adresse » ;
 * - RFC 826 : la requete ARP est diffusee, le porteur de l'adresse repond ;
 * - le schema FortiOS de `system dhcp server` (le module Ansible
 *   `fortios_system_dhcp_server` de Fortinet) : `conflicted-ip-timeout` est
 *   le delai avant qu'une adresse conflictuelle retirée de la plage soit de
 *   nouveau utilisable — le serveur detecte donc les conflits.
 *
 * Ecrite a l'aveugle, avant de lire l'appel de `buildDhcpServerReply` par
 * `FirewallDhcp`. Le porteur de l'adresse est un poste a adresse statique ;
 * les requetes ARP du FortiGate se comptent sur son port par `Port.attachTap`.
 * 3 des 5 cas tombent avant. Passent des deux cotes les TEMOINS : la premiere
 * adresse libre, et l'absence de voisin laisse par un candidat que personne
 * ne porte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, ETHERTYPE_ARP, type ARPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const owner = new LinuxPC('linux-pc', 'OWNER', -200, 0);
  const client = new LinuxPC('linux-pc', 'PC1', -200, 100);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  new Cable('up').connect(sw.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('o').connect(owner.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c').connect(client.getPort('eth0')!, sw.getPort('eth2')!);
  await type(owner, ['ip link set eth0 up']);
  await type(client, ['ip link set eth0 up']);
  await type(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"',
    'set default-gateway 192.168.10.1', 'set netmask 255.255.255.0',
    'config ip-range', 'edit 1', 'set start-ip 192.168.10.100', 'set end-ip 192.168.10.110',
    'next', 'end', 'next', 'end',
  ]);
  const arpRequests: string[] = [];
  const firewallMac = fgt.getPort('port2')!.getMAC().toString();
  owner.getPort('eth0')!.attachTap(({ direction, frame }) => {
    if (direction !== 'in' || frame.etherType !== ETHERTYPE_ARP) return;
    const arp = frame.payload as ARPPacket;
    if (arp.operation === 'request' && arp.senderMAC.toString() === firewallMac) {
      arpRequests.push(arp.targetIP.toString());
    }
  });
  return { fgt, owner, client, arpRequests };
}

const address = async (pc: LinuxPC): Promise<string> =>
  /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';

describe('an address another host already carries is not offered', () => {
  it('the first free address goes to the client when nobody holds it — WITNESS', async () => {
    const { client } = await lab();
    await client.executeCommand('dhclient -v eth0');

    expect(await address(client)).toBe('192.168.10.100');
  });

  it('the address held statically by another host is skipped', async () => {
    const { owner, client } = await lab();
    await type(owner, ['ip addr add 192.168.10.100/24 dev eth0']);
    await client.executeCommand('dhclient -v eth0');

    expect(await address(client)).toBe('192.168.10.101');
  });

  it('two addresses held in a row are both skipped', async () => {
    const { owner, client } = await lab();
    await type(owner, ['ip addr add 192.168.10.100/24 dev eth0', 'ip addr add 192.168.10.101/24 dev eth0']);
    await client.executeCommand('dhclient -v eth0');

    expect(await address(client)).toBe('192.168.10.102');
  });

  it('the probe is a real ARP request that crosses the wire', async () => {
    const { owner, client, arpRequests } = await lab();
    await type(owner, ['ip addr add 192.168.10.100/24 dev eth0']);
    await client.executeCommand('dhclient -v eth0');

    expect(arpRequests).toContain('192.168.10.100');
  });

  it('a candidate nobody holds leaves no neighbour entry behind', async () => {
    const { fgt, client } = await lab();
    await client.executeCommand('dhclient -v eth0');
    const neighbours = await fgt.executeCommand('diagnose ip arp list');

    expect(neighbours.split('\n').filter(line => line.includes('192.168.10.101'))).toEqual([]);
  });
});
