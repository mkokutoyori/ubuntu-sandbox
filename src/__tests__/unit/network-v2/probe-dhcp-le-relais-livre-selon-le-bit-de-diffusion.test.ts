/*
 * Un agent de relais DHCP livre la reponse au client selon le bit de
 * DIFFUSION de la requete : bit leve, diffusion ; bit baisse, unicast vers
 * `yiaddr` et vers l'adresse materielle `chaddr`.
 *
 * Mesure de depart : le relais d'un routeur Cisco, celui d'un FortiGate et
 * celui d'une SVI de commutateur diffusent TOUJOURS la reponse sur le reseau
 * du client, quel que soit `flags`. Le relais de la SVI est de plus une
 * seconde copie complete du relais partage (`relayDhcpToHelpers` et
 * `relayDhcpReplyToClientVlan` a cote de `DhcpRelay.ts`) : il n'emet aucun
 * evenement, ne compte rien et ne borne pas les sauts de la meme facon.
 *
 * L'AUTORITE — RFC 2131 §4.1 : « Un serveur ou un agent de relais qui envoie
 * ou relaie un message DHCP directement a un client SHOULD examiner le bit
 * BROADCAST. S'il vaut 1, le message SHOULD partir en diffusion IP et en
 * diffusion de couche liaison. S'il vaut 0, il SHOULD partir en unicast IP
 * vers `yiaddr` et vers l'adresse de couche liaison `chaddr`. » Un DHCPNAK
 * relaye part en diffusion (§4.3.2, bit de diffusion leve par le serveur).
 *
 * Aucun client du simulateur ne baisse le bit : tous emettent 0x8000, alors
 * que l'ISC dhclient reel le laisse a zero. Le client est donc un DISCOVER
 * fabrique et pose sur le fil du poste par `Port.sendFrame`, et les trames
 * comptees sont celles que le cable du client porte, par `Port.attachTap`.
 *
 * Ecrite a l'aveugle. 13 des 26 cas tombent avant, mesures avec `git stash
 * push -- src/network` : le bit baisse, trois fois deux cas ; l'annonce de la
 * requete et celle de la reponse sur le bus de la SVI, que l'ancienne copie
 * n'emettait pas ; et les cinq cas de la regle partagee, qui tombent parce que
 * `dhcpDirectRoute` n'existait pas. Passent des deux cotes les TEMOINS : le
 * DISCOVER a bit leve, diffuse par chacun des trois relais ; l'interface
 * d'emission, le port client et giaddr ; le DORA complet d'un client ordinaire
 * derriere chacun ; et l'annonce sur le bus du routeur et du FortiGate, dont
 * le relais etait deja le relais partage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket, DHCP_WIRE_BYTES } from '@/network/dhcp/DHCPPacket';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from '@/network/core/WellKnownPorts';
import { buildUdpOverIpv4 } from '@/network/layers/transport/UdpEgress';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { IEventBus } from '@/events/EventBus';
import { dhcpDirectRoute } from '@/network/dhcp/DhcpServerExchange';

beforeEach(() => {
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

interface Delivered {
  readonly kind: string;
  readonly frame: EthernetFrame;
  readonly ip: IPv4Packet;
  readonly udp: UDPPacket;
  readonly dhcp: DHCPPacket;
}

function recordInbound(port: Port): Delivered[] {
  const seen: Delivered[] = [];
  port.attachTap(({ direction, frame }) => {
    if (direction !== 'in' || frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || !(udp.payload instanceof DHCPPacket)) return;
    seen.push({ kind: udp.payload.getMessageType() ?? '?', frame, ip, udp, dhcp: udp.payload });
  });
  return seen;
}

function discoverFrom(port: Port, flags: number): void {
  const discover = DHCPPacket.createDiscover(port.getMAC().toString(), 0x2bad);
  discover.flags = flags;
  port.sendFrame({
    srcMAC: port.getMAC(),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: buildUdpOverIpv4(new IPAddress('0.0.0.0'), {
      destination: new IPAddress('255.255.255.255'),
      sourcePort: DHCP_CLIENT_PORT, destinationPort: DHCP_SERVER_PORT,
      payload: discover, payloadBytes: DHCP_WIRE_BYTES,
    }),
  });
}

const ISC_CONFIG = (clientNetwork: string, first: string, last: string, router: string, transit: string): string =>
  `printf 'subnet ${transit}.0 netmask 255.255.255.0 {\\n}\\nsubnet ${clientNetwork} netmask 255.255.255.0 {\\n  range ${first} ${last};\\n  option routers ${router};\\n}\\n' > /etc/dhcp/dhcpd.conf`;

interface Lab {
  readonly client: LinuxPC;
  readonly onClientWire: Delivered[];
  readonly relayBus: IEventBus;
}

async function serverBehind(transitAddress: string, clientNetwork: string, relayAddress: string,
  first: string, last: string, router: string): Promise<LinuxServer> {
  const server = new LinuxServer('linux-server', 'SRV1', 0, 0);
  const transit = transitAddress.split('.').slice(0, 3).join('.');
  await type(server, [
    `ip addr add ${transitAddress}/24 dev eth0`, 'ip link set eth0 up',
    `ip route add ${clientNetwork}/24 via ${relayAddress}`,
    ISC_CONFIG(clientNetwork, first, last, router, transit),
    'systemctl restart isc-dhcp-server',
  ]);
  return server;
}

async function ciscoRouterLab(): Promise<Lab> {
  const router = new CiscoRouter('R1');
  const client = new LinuxPC('linux-pc', 'PC1', -200, 0);
  new Cable('lan').connect(client.getPort('eth0')!, router.getPort('GigabitEthernet0/1')!);
  await type(client, ['ip link set eth0 up']);
  await type(router, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.20.1 255.255.255.0',
    'ip helper-address 10.0.0.1', 'no shutdown', 'end',
  ]);
  const server = await serverBehind('10.0.0.1', '192.168.20.0', '10.0.0.2', '192.168.20.100', '192.168.20.110', '192.168.20.1');
  new Cable('transit').connect(router.getPort('GigabitEthernet0/0')!, server.getPort('eth0')!);
  return { client, onClientWire: recordInbound(client.getPort('eth0')!), relayBus: router.getBus() };
}

async function fortiGateLab(): Promise<Lab> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const client = new LinuxPC('linux-pc', 'PC1', -200, 0);
  new Cable('lan').connect(client.getPort('eth0')!, fgt.getPort('port3')!);
  await type(client, ['ip link set eth0 up']);
  await type(fgt, [
    'config system interface',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0',
    'set dhcp-relay-service enable', 'set dhcp-relay-ip "10.0.0.1"', 'next',
    'edit port2', 'set mode static', 'set ip 10.0.0.2 255.255.255.0', 'next', 'end',
  ]);
  const server = await serverBehind('10.0.0.1', '192.168.20.0', '10.0.0.2', '192.168.20.100', '192.168.20.110', '192.168.20.1');
  new Cable('transit').connect(fgt.getPort('port2')!, server.getPort('eth0')!);
  return { client, onClientWire: recordInbound(client.getPort('eth0')!), relayBus: fgt.getBus() };
}

async function ciscoSwitchLab(): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'L3SW', 26, 0, 0);
  const client = new LinuxPC('linux-pc', 'PC1', -200, 0);
  new Cable('lan').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  await type(client, ['ip link set eth0 up']);
  await type(sw, [
    'enable', 'configure terminal', 'ip routing',
    'vlan 10', 'exit', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Vlan10', 'ip address 192.168.20.1 255.255.255.0', 'ip helper-address 10.0.0.1', 'no shutdown', 'exit',
    'vlan 100', 'exit', 'interface GigabitEthernet0/1', 'switchport mode access', 'switchport access vlan 100', 'exit',
    'interface Vlan100', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', 'end',
  ]);
  const server = await serverBehind('10.0.0.1', '192.168.20.0', '10.0.0.2', '192.168.20.100', '192.168.20.110', '192.168.20.1');
  new Cable('transit').connect(sw.getPort('GigabitEthernet0/1')!, server.getPort('eth0')!);
  return { client, onClientWire: recordInbound(client.getPort('eth0')!), relayBus: sw.getBus() };
}

const RELAYS: ReadonlyArray<readonly [string, () => Promise<Lab>]> = [
  ['a Cisco router', ciscoRouterLab],
  ['a FortiGate', fortiGateLab],
  ['a Cisco L3 switch', ciscoSwitchLab],
];

describe.each(RELAYS)('%s relaying a DISCOVER', (_name, build) => {
  it('broadcasts the OFFER when the client raised the BROADCAST bit — WITNESS', async () => {
    const { client, onClientWire } = await build();
    discoverFrom(client.getPort('eth0')!, 0x8000);
    const offer = onClientWire.find(entry => entry.kind === 'DHCPOFFER')!;

    expect(offer).toBeDefined();
    expect(offer.ip.destinationIP.toString()).toBe('255.255.255.255');
    expect(offer.frame.dstMAC.isBroadcast()).toBe(true);
  });

  it('unicasts the OFFER to yiaddr when the client cleared the BROADCAST bit', async () => {
    const { client, onClientWire } = await build();
    discoverFrom(client.getPort('eth0')!, 0);
    const offer = onClientWire.find(entry => entry.kind === 'DHCPOFFER')!;

    expect(offer).toBeDefined();
    expect(offer.ip.destinationIP.toString()).toBe(offer.dhcp.yiaddr);
    expect(offer.ip.destinationIP.toString()).toBe('192.168.20.100');
  });

  it('addresses the link layer of that unicast to chaddr', async () => {
    const { client, onClientWire } = await build();
    discoverFrom(client.getPort('eth0')!, 0);
    const offer = onClientWire.find(entry => entry.kind === 'DHCPOFFER')!;

    expect(offer.frame.dstMAC.isBroadcast()).toBe(false);
    expect(offer.frame.dstMAC.toString()).toBe(client.getPort('eth0')!.getMAC().toString());
  });

  it('sends it from the interface that faces the client, to the DHCP client port', async () => {
    const { client, onClientWire } = await build();
    discoverFrom(client.getPort('eth0')!, 0);
    const offer = onClientWire.find(entry => entry.kind === 'DHCPOFFER')!;

    expect(offer.ip.sourceIP.toString()).toBe('192.168.20.1');
    expect(offer.udp.destinationPort).toBe(68);
    expect(offer.dhcp.giaddr).toBe('192.168.20.1');
  });

  it('still lets an ordinary client lease an address through it — WITNESS', async () => {
    const { client } = await build();
    await client.executeCommand('dhclient eth0');

    expect(await client.executeCommand('ip -4 addr show eth0')).toContain('inet 192.168.20.100');
  });
});

describe.each(RELAYS)('%s relaying, as seen on its own bus', (_name, build) => {
  it('announces each relayed request once, with the client and the helper', async () => {
    const { client, relayBus } = await build();
    const forwarded: Array<{ clientMac: string; giaddr: string; helpers: string[] }> = [];
    relayBus.subscribe('dhcp.relay.forwarded', event => {
      forwarded.push(event.payload as { clientMac: string; giaddr: string; helpers: string[] });
    });
    discoverFrom(client.getPort('eth0')!, 0);

    expect(forwarded.length).toBe(1);
    expect(forwarded[0].giaddr).toBe('192.168.20.1');
    expect(forwarded[0].helpers).toEqual(['10.0.0.1']);
  });

  it('announces the reply it hands back to the client', async () => {
    const { client, relayBus } = await build();
    const replies: unknown[] = [];
    relayBus.subscribe('dhcp.relay.reply-forwarded', event => { replies.push(event.payload); });
    discoverFrom(client.getPort('eth0')!, 0);

    expect(replies.length).toBe(1);
  });
});

describe('the rule every relay shares', () => {
  const reply = (type: 'DHCPOFFER' | 'DHCPNAK', flags: number, yiaddr: string, ciaddr = '0.0.0.0'): DHCPPacket => {
    const packet = type === 'DHCPNAK'
      ? DHCPPacket.createNak('02:00:00:00:00:77', 1, '10.0.0.1', 'wrong network')
      : DHCPPacket.createOffer('02:00:00:00:00:77', 1, yiaddr, '10.0.0.1', {
        mask: '255.255.255.0', router: '192.168.20.1', dns: [], leaseDuration: 600,
      });
    packet.flags = flags;
    packet.ciaddr = ciaddr;
    return packet;
  };

  it('unicasts to yiaddr when the bit is cleared', () => {
    expect(dhcpDirectRoute(reply('DHCPOFFER', 0, '192.168.20.100'), '0.0.0.0'))
      .toEqual({ kind: 'unicast', address: '192.168.20.100' });
  });

  it('broadcasts when the bit is raised — WITNESS', () => {
    expect(dhcpDirectRoute(reply('DHCPOFFER', 0x8000, '192.168.20.100'), '0.0.0.0')).toEqual({ kind: 'broadcast' });
  });

  it('broadcasts a NAK whatever the bit says', () => {
    expect(dhcpDirectRoute(reply('DHCPNAK', 0, '0.0.0.0'), '0.0.0.0')).toEqual({ kind: 'broadcast' });
  });

  it('broadcasts when there is no address to unicast to', () => {
    expect(dhcpDirectRoute(reply('DHCPOFFER', 0, '0.0.0.0'), '0.0.0.0')).toEqual({ kind: 'broadcast' });
  });

  it('unicasts to ciaddr when the client already holds an address', () => {
    expect(dhcpDirectRoute(reply('DHCPOFFER', 0x8000, '0.0.0.0', '192.168.20.55'), '192.168.20.55'))
      .toEqual({ kind: 'unicast', address: '192.168.20.55' });
  });
});
