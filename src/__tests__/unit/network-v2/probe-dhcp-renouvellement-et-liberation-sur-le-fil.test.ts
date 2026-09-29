/*
 * Un client DHCP renouvelle, relie et libere son bail comme RFC 2131 le
 * demande, et la trame le montre : le renouvellement est un unicast vers le
 * serveur, la reprise de lien une diffusion, et l'un comme l'autre portent
 * l'adresse du client dans `ciaddr`.
 *
 * Mesure de depart, sur un FortiGate client d'un serveur ISC dont le bail
 * dure 600 s : a T1 la requete part de 0.0.0.0 vers 255.255.255.255, en
 * diffusion, avec `ciaddr` a 0.0.0.0 et l'option 50 remplie, et l'ACK revient
 * lui aussi en diffusion. Les emetteurs de trames client du FortiGate, du
 * routeur, du poste et du SVI codent chacun 0.0.0.0 vers 255.255.255.255.
 *
 * L'AUTORITE — RFC 2131 :
 * - §4.3.2, tableau 5 : dans RENEWING et REBINDING, `ciaddr` porte l'adresse
 *   du client, l'option 50 (adresse demandee) et l'option 54 (identifiant du
 *   serveur) ne sont PAS remplies ; en INIT-REBOOT, au contraire, `ciaddr`
 *   est nul et l'option 50 remplie ;
 * - §4.4.5 : en RENEWING le client envoie sa requete EN UNICAST au serveur
 *   qui a accorde le bail ; en REBINDING, en diffusion, faute de reponse ;
 * - §4.1 : le serveur repond a un `ciaddr` non nul en unicast a cette
 *   adresse ;
 * - §4.4.6 : DHCPRELEASE est envoye en unicast au serveur, `ciaddr` a
 *   l'adresse liberee.
 *
 * Ecrite a l'aveugle. Le laboratoire compte les trames sur le port du
 * serveur par `Port.attachTap`. T1 vaut la moitie du bail (300 s), T2 les
 * sept huitiemes (525 s). Trois clients : un FortiGate, un poste Linux et un
 * routeur Cisco, chacun avec son propre emetteur de trames, face a un
 * serveur ISC ; puis un poste Linux face a un FortiGate et a un routeur
 * Cisco serveurs. Un serveur silencieux — `systemctl stop`, pas un cable
 * debranche, qui ferait tomber le bail du routeur avec le lien — sert au
 * T2.
 *
 * 20 des 36 cas tombent avant. Passent des deux cotes : les TEMOINS (le
 * DORA en quatre trames et le bail encore tenu apres son echeance
 * d'origine, pour les cinq laboratoires), la requete qui part bien a T1, et
 * la diffusion du T2, que l'ancien code faisait deja.
 *
 * Trouve en chemin : seul le serveur du FortiGate repondait selon
 * `dhcpReplyRoute` ; le dhcpd de Linux, le routeur, le serveur Windows et la
 * SVI d'un commutateur repondaient toujours en diffusion, si bien qu'un
 * client qui renouvelle en unicast recevait son ACK en diffusion. Les cinq
 * servent maintenant l'adressage de `dhcpReplyRoute`, et les quatre
 * emetteurs client (FortiGate, routeur, poste, SVI) celui de
 * `dhcpClientAddressing`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetCounters, MACAddress, ETHERTYPE_IPV4, type EthernetFrame, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

interface DhcpFrame {
  readonly direction: 'in' | 'out';
  readonly frame: EthernetFrame;
  readonly ip: IPv4Packet;
  readonly dhcp: DHCPPacket;
  readonly kind: string;
}

function recordDhcp(port: Port): DhcpFrame[] {
  const seen: DhcpFrame[] = [];
  port.attachTap(({ direction, frame }) => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || !(udp.payload instanceof DHCPPacket)) return;
    seen.push({ direction, frame, ip, dhcp: udp.payload, kind: udp.payload.getMessageType() ?? '?' });
  });
  return seen;
}

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };

async function elapse(seconds: number): Promise<void> {
  clock.advance(seconds * 1000);
  await settle();
}

const ISC_CONFIG = "printf 'default-lease-time 600;\\nmax-lease-time 600;\\nsubnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.50 203.0.113.60;\\n  option routers 203.0.113.1;\\n}\\n' > /etc/dhcp/dhcpd.conf";

async function iscServer(): Promise<{ server: LinuxServer; seen: DhcpFrame[]; mac: string }> {
  const server = new LinuxServer('linux-server', 'ISP', -200, 0);
  await type(server, ['ip addr add 203.0.113.1/24 dev eth0', 'ip link set eth0 up', ISC_CONFIG, 'systemctl restart isc-dhcp-server']);
  return { server, seen: recordDhcp(server.getPort('eth0')!), mac: server.getPort('eth0')!.getMAC().toString() };
}

interface Lab {
  readonly seen: DhcpFrame[];
  readonly serverMac: string;
  readonly serverAddress: string;
  readonly clientAddress: () => string;
  readonly clientMac: () => string;
  readonly holds: () => Promise<boolean>;
  readonly silenceServer: () => Promise<void>;
  readonly reviveServer: () => Promise<void>;
}

async function fortiClientLab(): Promise<Lab> {
  const { server, seen, mac } = await iscServer();
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  new Cable('wan').connect(server.getPort('eth0')!, fgt.getPort('port1')!);
  await type(fgt, ['config system interface', 'edit port1', 'set mode dhcp', 'next', 'end']);
  return {
    seen, serverMac: mac, serverAddress: '203.0.113.1',
    clientAddress: () => seen.find(f => f.kind === 'DHCPACK')!.dhcp.yiaddr,
    clientMac: () => seen.find(f => f.kind === 'DHCPDISCOVER')!.frame.srcMAC.toString(),
    holds: async () => (await fgt.executeCommand('get router info routing-table all')).includes('203.0.113.0/24 is directly connected, port1'),
    silenceServer: () => type(server, ['systemctl stop isc-dhcp-server']),
    reviveServer: () => type(server, ['systemctl start isc-dhcp-server']),
  };
}

async function linuxClientLab(): Promise<Lab & { readonly pc: LinuxPC }> {
  const { server, seen, mac } = await iscServer();
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  new Cable('lan').connect(server.getPort('eth0')!, pc.getPort('eth0')!);
  await type(pc, ['sudo dhclient eth0']);
  return {
    pc, seen, serverMac: mac, serverAddress: '203.0.113.1',
    clientAddress: () => seen.find(f => f.kind === 'DHCPACK')!.dhcp.yiaddr,
    clientMac: () => seen.find(f => f.kind === 'DHCPDISCOVER')!.frame.srcMAC.toString(),
    holds: async () => (await pc.executeCommand('ip -4 addr show eth0')).includes('inet 203.0.113.50'),
    silenceServer: () => type(server, ['systemctl stop isc-dhcp-server']),
    reviveServer: () => type(server, ['systemctl start isc-dhcp-server']),
  };
}

async function ciscoClientLab(): Promise<Lab> {
  const { server, seen, mac } = await iscServer();
  const router = new CiscoRouter('R1');
  new Cable('wan').connect(server.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  await type(router, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address dhcp', 'no shutdown', 'end']);
  return {
    seen, serverMac: mac, serverAddress: '203.0.113.1',
    clientAddress: () => seen.find(f => f.kind === 'DHCPACK')!.dhcp.yiaddr,
    clientMac: () => seen.find(f => f.kind === 'DHCPDISCOVER')!.frame.srcMAC.toString(),
    holds: async () => (await router.executeCommand('show ip interface brief')).includes('203.0.113.50'),
    silenceServer: () => type(server, ['systemctl stop isc-dhcp-server']),
    reviveServer: () => type(server, ['systemctl start isc-dhcp-server']),
  };
}

async function linuxClientOf(server: { getPort(name: string): Port | undefined }, portName: string, serverAddress: string): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  new Cable('lan').connect(server.getPort(portName)!, pc.getPort('eth0')!);
  const seen = recordDhcp(server.getPort(portName)!);
  await type(pc, ['sudo dhclient eth0']);
  return {
    seen, serverMac: server.getPort(portName)!.getMAC().toString(), serverAddress,
    clientAddress: () => seen.find(f => f.kind === 'DHCPACK')!.dhcp.yiaddr,
    clientMac: () => seen.find(f => f.kind === 'DHCPDISCOVER')!.frame.srcMAC.toString(),
    holds: async () => /inet 10\.\d+\.\d+\.\d+/.test(await pc.executeCommand('ip -4 addr show eth0')),
    silenceServer: async () => undefined,
    reviveServer: async () => undefined,
  };
}

async function fortiServerLab(): Promise<Lab> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  await type(fgt, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"', 'set lease-time 600',
    'set default-gateway 10.1.0.1', 'set netmask 255.255.255.0',
    'config ip-range', 'edit 1', 'set start-ip 10.1.0.100', 'set end-ip 10.1.0.110', 'next', 'end', 'next', 'end',
  ]);
  return linuxClientOf(fgt, 'port2', '10.1.0.1');
}

async function ciscoServerLab(): Promise<Lab> {
  const router = new CiscoRouter('R1');
  await type(router, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 10.1.0.1',
    'ip dhcp pool LAN', 'network 10.1.0.0 255.255.255.0', 'default-router 10.1.0.1', 'lease 0 0 10', 'end',
  ]);
  return linuxClientOf(router, 'GigabitEthernet0/1', '10.1.0.1');
}

const SERVERS: ReadonlyArray<readonly [string, () => Promise<Lab>]> = [
  ['a FortiGate', fortiServerLab],
  ['a Cisco router', ciscoServerLab],
];

const CLIENTS: ReadonlyArray<readonly [string, () => Promise<Lab>]> = [
  ['a FortiGate', fortiClientLab],
  ['a Linux host', linuxClientLab],
  ['a Cisco router', ciscoClientLab],
];

async function renewedAt(buildLab: () => Promise<Lab>): Promise<{ lab: Lab; renewal: DhcpFrame; acknowledgement: DhcpFrame }> {
  const lab = await buildLab();
  const before = lab.seen.length;
  await elapse(301);
  const later = lab.seen.slice(before);
  return {
    lab,
    renewal: later.find(f => f.kind === 'DHCPREQUEST' && f.direction === 'in')!,
    acknowledgement: later.find(f => f.kind === 'DHCPACK' && f.direction === 'out')!,
  };
}

describe.each(CLIENTS)('%s that renews its lease at T1', (_name, buildLab) => {
  const renewed = () => renewedAt(buildLab);

  it('takes the address on the wire in four steps — WITNESS', async () => {
    const lab = await buildLab();

    expect(lab.seen.map(f => f.kind)).toEqual(['DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST', 'DHCPACK']);
  });

  it('sends a REQUEST at T1', async () => {
    const { renewal } = await renewed();

    expect(renewal).toBeDefined();
  });

  it('sends it in unicast to the server that granted the lease', async () => {
    const { lab, renewal } = await renewed();

    expect(renewal.ip.destinationIP.toString()).toBe(lab.serverAddress);
    expect(renewal.frame.dstMAC.toString()).toBe(lab.serverMac);
  });

  it('writes its own address as the source of the datagram', async () => {
    const { lab, renewal } = await renewed();

    expect(renewal.ip.sourceIP.toString()).toBe(lab.clientAddress());
  });

  it('carries its address in ciaddr and neither the requested address nor the server identifier', async () => {
    const { lab, renewal } = await renewed();

    expect(renewal.dhcp.ciaddr).toBe(lab.clientAddress());
    expect(renewal.dhcp.getOption(50)).toBeUndefined();
    expect(renewal.dhcp.getOption(54)).toBeUndefined();
  });

  it('is answered in unicast to its address', async () => {
    const { lab, acknowledgement } = await renewed();

    expect(acknowledgement.ip.destinationIP.toString()).toBe(lab.clientAddress());
    expect(acknowledgement.frame.dstMAC.toString()).toBe(lab.clientMac());
  });

  it('still holds its address once the original lease would have run out — WITNESS', async () => {
    const { lab } = await renewed();
    await elapse(400);

    expect(await lab.holds()).toBe(true);
  });
});

describe.each(SERVERS)('a Linux host that renews its lease at T1 with %s as its server', (_name, buildLab) => {
  it('takes the address on the wire in four steps — WITNESS', async () => {
    const lab = await buildLab();

    expect(lab.seen.map(f => f.kind)).toEqual(['DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST', 'DHCPACK']);
  });

  it('sends its REQUEST in unicast to the server, with ciaddr set', async () => {
    const { lab, renewal } = await renewedAt(buildLab);

    expect(renewal.ip.destinationIP.toString()).toBe(lab.serverAddress);
    expect(renewal.frame.dstMAC.toString()).toBe(lab.serverMac);
    expect(renewal.dhcp.ciaddr).toBe(lab.clientAddress());
  });

  it('is answered in unicast to its address', async () => {
    const { lab, acknowledgement } = await renewedAt(buildLab);

    expect(acknowledgement.ip.destinationIP.toString()).toBe(lab.clientAddress());
    expect(acknowledgement.frame.dstMAC.toString()).toBe(lab.clientMac());
  });

  it('still holds its address once the original lease would have run out — WITNESS', async () => {
    const { lab } = await renewedAt(buildLab);
    await elapse(400);

    expect(await lab.holds()).toBe(true);
  });
});

describe('a client whose server went silent at T1', () => {
  async function rebinding(build: () => Promise<Lab>): Promise<{ lab: Lab; request: DhcpFrame }> {
    const lab = await build();
    await lab.silenceServer();
    await elapse(301);
    await lab.reviveServer();
    const before = lab.seen.length;
    await elapse(230);
    return { lab, request: lab.seen.slice(before).find(f => f.kind === 'DHCPREQUEST' && f.direction === 'in')! };
  }

  it.each(CLIENTS)('%s rebinds at T2 by a broadcast REQUEST', async (_name, build) => {
    const { request } = await rebinding(build);

    expect(request).toBeDefined();
    expect(request.ip.destinationIP.toString()).toBe('255.255.255.255');
    expect(request.frame.dstMAC.isBroadcast()).toBe(true);
  });

  it.each(CLIENTS)('%s writes its address in ciaddr and as source, without option 50 or 54', async (_name, build) => {
    const { lab, request } = await rebinding(build);

    expect(request.dhcp.ciaddr).toBe(lab.clientAddress());
    expect(request.ip.sourceIP.toString()).toBe(lab.clientAddress());
    expect(request.dhcp.getOption(50)).toBeUndefined();
    expect(request.dhcp.getOption(54)).toBeUndefined();
  });
});

describe('a Linux host that releases its lease', () => {
  it('sends DHCPRELEASE in unicast to the server, from its address, with ciaddr set', async () => {
    const lab = await linuxClientLab();
    const before = lab.seen.length;
    await lab.pc.executeCommand('sudo dhclient -r eth0');
    const release = lab.seen.slice(before).find(f => f.kind === 'DHCPRELEASE')!;

    expect(release).toBeDefined();
    expect(release.ip.destinationIP.toString()).toBe(lab.serverAddress);
    expect(release.frame.dstMAC.toString()).toBe(lab.serverMac);
    expect(release.ip.sourceIP.toString()).toBe(lab.clientAddress());
    expect(release.dhcp.ciaddr).toBe(lab.clientAddress());
  });
});
