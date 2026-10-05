/*
 * Les trames DHCP d'un FortiGate — serveur, client, derriere un relais —
 * sont celles que RFC 2131 decrit, comptees sur le cable.
 *
 * L'AUTORITE :
 * - RFC 2131 §2 et RFC 951 : un message DHCP porte l'en-tete BOOTP de 236
 *   octets, le cookie et les options, et les clients comme les serveurs le
 *   bourrent a 300 octets de charge UDP au moins ; la longueur du
 *   datagramme UDP est celle de sa charge plus huit octets ;
 * - RFC 2131 §4.1 : « si giaddr est non nul, le serveur envoie toute reponse
 *   au port serveur DHCP de l'agent de relais dont l'adresse figure dans
 *   giaddr » ; sans relais, un DHCPNAK part en diffusion, un OFFER ou un ACK
 *   suit le bit de diffusion du client ;
 * - RFC 2131 §4.3.1 et tableau 3 : la reponse recopie `flags` et `giaddr` du
 *   message du client ;
 * - RFC 2131 §3.1.2 : le serveur DEVRAIT sonder une adresse avant de
 *   l'offrir.
 *
 * Ecrite a l'aveugle, avant de lire l'emission des trames de
 * `FirewallDhcp`. Le laboratoire compte les trames sur le port du poste, par
 * `Port.attachTap`, et non par la sortie d'un renifleur : c'est ce que le
 * cable porte qui compte. 8 des 11 cas tombent avant. Passent des deux
 * cotes les TEMOINS : le deroule DISCOVER, OFFER, REQUEST, ACK en direct,
 * le FortiGate client d'un serveur Linux, et le serveur Linux derriere le
 * relais Cisco, qui prouve que le laboratoire du relais est sain.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetCounters, MACAddress, ETHERTYPE_IPV4, type EthernetFrame, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

interface DhcpFrame {
  readonly direction: 'in' | 'out';
  readonly frame: EthernetFrame;
  readonly ip: IPv4Packet;
  readonly udp: UDPPacket;
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
    seen.push({ direction, frame, ip, udp, dhcp: udp.payload, kind: udp.payload.getMessageType() ?? '?' });
  });
  return seen;
}

const scope = (id: number, iface: string, first: string, last: string, gateway: string): string[] => [
  'config system dhcp server', `edit ${id}`, `set interface "${iface}"`,
  `set default-gateway ${gateway}`, 'set netmask 255.255.255.0',
  'config ip-range', 'edit 1', `set start-ip ${first}`, `set end-ip ${last}`, 'next', 'end',
  'next', 'end',
];

const address = async (pc: LinuxPC): Promise<string> =>
  /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';

async function directLab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await type(pc, ['ip link set eth0 up']);
  await type(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    ...scope(1, 'port2', '192.168.10.100', '192.168.10.110', '192.168.10.1'),
  ]);
  return { fgt, pc, seen: recordDhcp(pc.getPort('eth0')!) };
}

async function relayLab(server: 'fortigate' | 'linux') {
  const router = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/1')!);
  await type(pc, ['ip link set eth0 up']);
  await type(router, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.20.1 255.255.255.0',
    'ip helper-address 10.0.0.1', 'no shutdown', 'end',
  ]);
  if (server === 'fortigate') {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    new Cable('transit').connect(router.getPort('GigabitEthernet0/0')!, fgt.getPort('port2')!);
    await type(fgt, [
      'config system interface', 'edit port2', 'set mode static',
      'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
      'config router static', 'edit 1', 'set dst 192.168.20.0 255.255.255.0',
      'set gateway 10.0.0.2', 'set device port2', 'next', 'end',
      ...scope(1, 'port2', '192.168.20.100', '192.168.20.110', '192.168.20.1'),
    ]);
    return { pc, router, seenAtServer: recordDhcp(fgt.getPort('port2')!), seenAtRouter: recordDhcp(router.getPort('GigabitEthernet0/0')!) };
  }
  const srv = new LinuxServer('linux-server', 'SRV1', 0, 0);
  new Cable('transit').connect(router.getPort('GigabitEthernet0/0')!, srv.getPort('eth0')!);
  await type(srv, [
    'ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 up', 'ip route add 192.168.20.0/24 via 10.0.0.2',
    "printf 'subnet 10.0.0.0 netmask 255.255.255.0 {\\n}\\nsubnet 192.168.20.0 netmask 255.255.255.0 {\\n  range 192.168.20.100 192.168.20.110;\\n  option routers 192.168.20.1;\\n}\\n' > /etc/dhcp/dhcpd.conf",
    'systemctl restart isc-dhcp-server',
  ]);
  return { pc, router, seenAtServer: recordDhcp(srv.getPort('eth0')!), seenAtRouter: recordDhcp(router.getPort('GigabitEthernet0/0')!) };
}

const payloadBytes = (frame: DhcpFrame): number => frame.ip.totalLength - 20 - 8;

describe('a FortiGate that serves a directly attached client', () => {
  it('runs the four steps in order — WITNESS', async () => {
    const { pc, seen } = await directLab();
    await pc.executeCommand('dhclient -v eth0');

    expect(seen.map(frame => frame.kind)).toEqual(['DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST', 'DHCPACK']);
    expect(await address(pc)).toBe('192.168.10.100');
  });

  it('pads its replies to the 300 bytes every DHCP message carries', async () => {
    const { pc, seen } = await directLab();
    await pc.executeCommand('dhclient -v eth0');
    const replies = seen.filter(frame => frame.dhcp.op === 2);

    expect(replies.length).toBe(2);
    for (const reply of replies) expect(payloadBytes(reply)).toBeGreaterThanOrEqual(300);
  });

  it('writes a UDP length that matches the datagram it sits in', async () => {
    const { pc, seen } = await directLab();
    await pc.executeCommand('dhclient -v eth0');

    for (const reply of seen.filter(frame => frame.dhcp.op === 2)) {
      expect(reply.udp.length).toBe(reply.ip.totalLength - 20);
    }
  });

  it('copies a clear broadcast flag of the client into its reply (RFC 2131 table 3)', async () => {
    const { pc, seen } = await directLab();
    await pc.executeCommand('dhclient -v eth0');
    const discover = seen.find(frame => frame.kind === 'DHCPDISCOVER')!;
    const offer = seen.find(frame => frame.kind === 'DHCPOFFER')!;

    expect(discover.dhcp.flags).toBe(0);
    expect(offer.dhcp.flags).toBe(0);
  });

  it('copies a set broadcast flag of the client into its reply (RFC 2131 table 3)', async () => {
    const { pc, seen } = await directLab();
    pc.getDHCPClient().setBroadcastFlag(true);
    await pc.executeCommand('dhclient -v eth0');
    const discover = seen.find(frame => frame.kind === 'DHCPDISCOVER')!;
    const offer = seen.find(frame => frame.kind === 'DHCPOFFER')!;

    expect(discover.dhcp.flags).toBe(0x8000);
    expect(offer.dhcp.flags).toBe(0x8000);
  });

  it('a refused renewal is answered by a NAK sent to the broadcast address', async () => {
    const { fgt, pc, seen } = await directLab();
    await pc.executeCommand('dhclient -v eth0');
    await type(fgt, [
      'config system interface', 'edit port2', 'set ip 192.168.30.1 255.255.255.0', 'next', 'end',
      'config system dhcp server', 'delete 1', 'end',
      ...scope(2, 'port2', '192.168.30.100', '192.168.30.110', '192.168.30.1'),
    ]);
    seen.length = 0;
    await pc.executeCommand('dhclient -v eth0');
    const nak = seen.find(frame => frame.kind === 'DHCPNAK');

    expect(nak).toBeDefined();
    expect(nak!.ip.destinationIP.toString()).toBe('255.255.255.255');
    expect(nak!.frame.dstMAC.isBroadcast()).toBe(true);
    expect(await address(pc)).toBe('192.168.30.100');
  });
});

describe('a FortiGate that is a DHCP client', () => {
  it('pads its requests to 300 bytes and writes a matching UDP length', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const srv = new LinuxServer('linux-server', 'ISP', -200, 0);
    new Cable('wan').connect(srv.getPort('eth0')!, fgt.getPort('port1')!);
    await type(srv, [
      'ip addr add 203.0.113.1/24 dev eth0', 'ip link set eth0 up',
      "printf 'subnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.50 203.0.113.60;\\n  option routers 203.0.113.1;\\n}\\n' > /etc/dhcp/dhcpd.conf",
      'systemctl restart isc-dhcp-server',
    ]);
    const seen = recordDhcp(srv.getPort('eth0')!);
    await type(fgt, ['config system interface', 'edit port1', 'set mode dhcp', 'next', 'end']);
    const requests = seen.filter(frame => frame.dhcp.op === 1);

    expect(requests.map(frame => frame.kind)).toEqual(['DHCPDISCOVER', 'DHCPREQUEST']);
    for (const request of requests) {
      expect(payloadBytes(request)).toBeGreaterThanOrEqual(300);
      expect(request.udp.length).toBe(request.ip.totalLength - 20);
    }
  });

  it('obtains its address from the Linux server — WITNESS', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const srv = new LinuxServer('linux-server', 'ISP', -200, 0);
    new Cable('wan').connect(srv.getPort('eth0')!, fgt.getPort('port1')!);
    await type(srv, [
      'ip addr add 203.0.113.1/24 dev eth0', 'ip link set eth0 up',
      "printf 'subnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.50 203.0.113.60;\\n  option routers 203.0.113.1;\\n}\\n' > /etc/dhcp/dhcpd.conf",
      'systemctl restart isc-dhcp-server',
    ]);
    await type(fgt, ['config system interface', 'edit port1', 'set mode dhcp', 'next', 'end']);

    expect(await fgt.executeCommand('get system interface physical')).toContain('ip: 203.0.113.50 255.255.255.0');
  });
});

describe('a Linux DHCP server behind a Cisco relay — WITNESS of the laboratory', () => {
  it('serves the client of the far subnet', async () => {
    const { pc } = await relayLab('linux');
    await pc.executeCommand('dhclient -v eth0');

    expect(await address(pc)).toMatch(/^192\.168\.20\.1[01]\d$/);
  });
});

describe('a FortiGate that serves a client through a relay', () => {
  it('the client obtains an address of the relayed subnet', async () => {
    const { pc } = await relayLab('fortigate');
    await pc.executeCommand('dhclient -v eth0');

    expect(await address(pc)).toMatch(/^192\.168\.20\.1[01]\d$/);
  });

  it('the reply goes to the relay agent, port 67, not to the broadcast address', async () => {
    const { pc, seenAtRouter } = await relayLab('fortigate');
    await pc.executeCommand('dhclient -v eth0');
    const offer = seenAtRouter.find(frame => frame.kind === 'DHCPOFFER' && frame.direction === 'in');

    expect(offer).toBeDefined();
    expect(offer!.ip.destinationIP.toString()).toBe('192.168.20.1');
    expect(offer!.udp.destinationPort).toBe(67);
    expect(offer!.dhcp.giaddr).toBe('192.168.20.1');
  });

  it('the reply is pinned to the relay at layer 2 too', async () => {
    const { pc, router, seenAtRouter } = await relayLab('fortigate');
    await pc.executeCommand('dhclient -v eth0');
    const offer = seenAtRouter.find(frame => frame.kind === 'DHCPOFFER' && frame.direction === 'in');

    expect(offer!.frame.dstMAC.toString()).toBe(router.getPort('GigabitEthernet0/0')!.getMAC().toString());
  });
});
