/*
 * Un serveur DHCP Cisco ou Huawei annonce, dans l'option 54, SA PROPRE adresse
 * sur l'interface qui a recu la requete — pas la passerelle de son pool, et
 * jamais 0.0.0.0.
 *
 * Mesure de depart : le routeur et le commutateur L3 ne donnaient jamais leur
 * adresse au moteur partage (`setServerIdentifier` n'avait aucun appelant
 * cote Router ni SVI, alors que le serveur Linux, le serveur Windows et le
 * FortiGate le font). Le moteur retombait donc sur le `default-router` du
 * pool, et sur 0.0.0.0 quand le pool n'en a pas. Trois effets, tous mesures :
 * un pool sans `default-router` offre un identifiant de serveur nul ; un pool
 * dont le `default-router` est une autre machine (le cas d'un serveur central
 * derriere un relais) annonce CETTE machine comme serveur ; et le client, qui
 * renouvelle depuis la section DHCP precedente en unicast vers l'identifiant
 * de serveur recu, n'avait plus nulle part ou envoyer sa requete T1 — le test
 * `dhcp_complete` « should renew lease at T1 » est tombe rouge avec ce
 * renouvellement (vert a 7471c1786, rouge a 6819cbde5).
 *
 * L'AUTORITE — RFC 2132 §9.7 : l'option 54 « identifie un serveur DHCP » et
 * un client s'en sert pour adresser un DHCPREQUEST a CE serveur ; RFC 2131
 * §4.3.1 : « le serveur DOIT inclure son identifiant dans l'option 54 » et
 * l'adresse choisie est celle de l'interface par laquelle il joint le
 * client. Chez Cisco, l'identifiant d'un serveur IOS est l'adresse de
 * l'interface de reception.
 *
 * Ecrite a l'aveugle, le client etant un poste Linux dont dhclient tient
 * l'identifiant recu, et les trames comptees sur le cable du serveur par
 * `Port.attachTap`. 5 des 9 cas tombent avant : l'identifiant du pool sans
 * default-router (0.0.0.0), celui du pool dont le default-router est une
 * autre machine, le renouvellement T1, l'identifiant derriere un relais, et
 * celui de la SVI. Passent des deux cotes les TEMOINS : le bail obtenu, par
 * le routeur seul comme derriere le relais ; l'option 3, qui reste la
 * passerelle du pool ; et le serveur Linux, qui donnait deja son adresse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import {
  resetCounters, MACAddress, ETHERTYPE_IPV4,
  type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

interface Seen {
  readonly direction: 'in' | 'out';
  readonly kind: string;
  readonly ip: IPv4Packet;
  readonly dhcp: DHCPPacket;
}

function recordDhcp(port: Port): Seen[] {
  const seen: Seen[] = [];
  port.attachTap(({ direction, frame }) => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || !(udp.payload instanceof DHCPPacket)) return;
    seen.push({ direction, kind: udp.payload.getMessageType() ?? '?', ip, dhcp: udp.payload });
  });
  return seen;
}

const serverIdentifierOf = (seen: Seen[], kind: string): unknown =>
  seen.find(entry => entry.kind === kind && entry.direction === 'out')?.dhcp.getOption(54);

async function routerServing(poolLines: readonly string[]) {
  const router = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  new Cable('lan').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  const seen = recordDhcp(router.getPort('GigabitEthernet0/0')!);
  await type(router, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 10.0.0.1',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', ...poolLines, 'end',
  ]);
  return { router, pc, seen };
}

describe('a Cisco router serving its own segment', () => {
  it('offers a client its address — WITNESS', async () => {
    const { pc } = await routerServing(['default-router 10.0.0.1', 'lease 0 0 10']);
    await pc.executeCommand('sudo dhclient eth0');

    expect(await pc.executeCommand('ip -4 addr show eth0')).toMatch(/inet 10\.0\.0\.\d+/);
  });

  it('names its interface address as server when the pool has no default-router', async () => {
    const { pc, seen } = await routerServing(['lease 0 0 10']);
    await pc.executeCommand('sudo dhclient eth0');

    expect(serverIdentifierOf(seen, 'DHCPOFFER')).toBe('10.0.0.1');
    expect(serverIdentifierOf(seen, 'DHCPACK')).toBe('10.0.0.1');
  });

  it('names its interface address, not the default-router, when they differ', async () => {
    const { pc, seen } = await routerServing(['default-router 10.0.0.254', 'lease 0 0 10']);
    await pc.executeCommand('sudo dhclient eth0');

    expect(serverIdentifierOf(seen, 'DHCPOFFER')).toBe('10.0.0.1');
    expect(serverIdentifierOf(seen, 'DHCPACK')).toBe('10.0.0.1');
  });

  it('still advertises the default-router as the gateway option (3)', async () => {
    const { pc, seen } = await routerServing(['default-router 10.0.0.254', 'lease 0 0 10']);
    await pc.executeCommand('sudo dhclient eth0');
    const offer = seen.find(entry => entry.kind === 'DHCPOFFER')!;

    expect(offer.dhcp.getOption(3)).toBe('10.0.0.254');
  });

  it('is reached by the unicast renewal at T1, even without a default-router', async () => {
    const { pc, seen } = await routerServing(['lease 0 0 2']);
    await pc.executeCommand('sudo dhclient eth0');
    const before = seen.length;
    clock.advance(61_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    const renewal = seen.slice(before).find(entry => entry.kind === 'DHCPREQUEST' && entry.direction === 'in');
    const answer = seen.slice(before).find(entry => entry.kind === 'DHCPACK' && entry.direction === 'out');

    expect(renewal?.ip.destinationIP.toString()).toBe('10.0.0.1');
    expect(answer).toBeDefined();
  });
});

describe('a central Cisco router reached through a relay', () => {
  async function relayedLab() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 26, 0, 0);
    const central = new CiscoRouter('CENTRAL');
    const pc = new LinuxPC('linux-pc', 'PC1');
    new Cable('lan').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('uplink').connect(sw.getPort('GigabitEthernet0/1')!, central.getPort('GigabitEthernet0/0')!);
    const seen = recordDhcp(central.getPort('GigabitEthernet0/0')!);
    await type(sw, [
      'enable', 'configure terminal', 'ip routing',
      'vlan 10', 'exit', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'ip helper-address 10.0.100.1', 'no shutdown', 'exit',
      'vlan 100', 'exit', 'interface GigabitEthernet0/1', 'switchport mode access', 'switchport access vlan 100', 'exit',
      'interface Vlan100', 'ip address 10.0.100.2 255.255.255.0', 'no shutdown', 'exit', 'end',
    ]);
    await type(central, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.100.1 255.255.255.0', 'no shutdown', 'exit',
      'ip route 10.0.10.0 255.255.255.0 10.0.100.2',
      'ip dhcp excluded-address 10.0.10.1 10.0.10.99',
      'ip dhcp pool VLAN10', 'network 10.0.10.0 255.255.255.0', 'default-router 10.0.10.1', 'lease 0 0 10', 'end',
    ]);
    return { pc, seen };
  }

  it('hands a lease to the client behind the relay — WITNESS', async () => {
    const { pc } = await relayedLab();
    await pc.executeCommand('sudo dhclient eth0');

    expect(await pc.executeCommand('ip -4 addr show eth0')).toMatch(/inet 10\.0\.10\.\d+/);
  });

  it('names the interface that faces the relay as server, not the relay that is the default-router', async () => {
    const { pc, seen } = await relayedLab();
    await pc.executeCommand('sudo dhclient eth0');

    expect(serverIdentifierOf(seen, 'DHCPOFFER')).toBe('10.0.100.1');
    expect(serverIdentifierOf(seen, 'DHCPACK')).toBe('10.0.100.1');
  });
});

describe('a Cisco L3 switch serving its own VLAN', () => {
  async function switchServing() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 26, 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC1');
    new Cable('lan').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    const seen = recordDhcp(sw.getPort('FastEthernet0/1')!);
    await type(sw, [
      'enable', 'configure terminal', 'ip routing',
      'vlan 10', 'exit', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 10.0.10.1',
      'ip dhcp pool V10', 'network 10.0.10.0 255.255.255.0', 'lease 0 0 10', 'end',
    ]);
    return { pc, seen };
  }

  it('names its SVI address as server when the pool has no default-router', async () => {
    const { pc, seen } = await switchServing();
    await pc.executeCommand('sudo dhclient eth0');

    expect(serverIdentifierOf(seen, 'DHCPOFFER')).toBe('10.0.10.1');
    expect(serverIdentifierOf(seen, 'DHCPACK')).toBe('10.0.10.1');
  });
});

describe('a Linux server, for comparison — WITNESS', () => {
  it('already names its interface address as server', async () => {
    const server = new LinuxServer('linux-server', 'SRV1');
    const pc = new LinuxPC('linux-pc', 'PC1');
    new Cable('lan').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
    const seen = recordDhcp(server.getPort('eth0')!);
    await type(server, [
      'ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 up',
      "printf 'subnet 10.0.0.0 netmask 255.255.255.0 {\\n  range 10.0.0.100 10.0.0.110;\\n}\\n' > /etc/dhcp/dhcpd.conf",
      'systemctl restart isc-dhcp-server',
    ]);
    await pc.executeCommand('sudo dhclient eth0');

    expect(serverIdentifierOf(seen, 'DHCPOFFER')).toBe('10.0.0.1');
  });
});
