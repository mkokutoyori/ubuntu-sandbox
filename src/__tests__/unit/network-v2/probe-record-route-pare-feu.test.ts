/**
 * Le pare-feu n'inscrivait pas son adresse dans la route enregistree —
 * RFC 1812 §5.3.13.5, « Routers MUST support the Record Route option in
 * forwarded packets ».
 *
 * MESURE DE DEPART, et elle porte son propre temoin. Un paquet ICMP muni
 * d'un Record Route a quatre cases traverse UN pare-feu puis UN routeur,
 * dans cet ordre :
 *
 *   route notee : [ '10.0.2.1' ]                 <- le ROUTEUR seul
 *   attendu     : [ '10.0.1.1', '10.0.2.1' ]
 *   ihl 10, des deux cotes
 *
 * L'entree de R2 est ce qui rend la mesure concluante : l'option
 * TRAVERSE le pare-feu intacte — meme IHL, somme de controle valide —
 * elle n'est simplement jamais remplie. Ce n'est donc pas un paquet
 * perdu ni une option abimee, c'est un saut qui ne se nomme pas.
 * Troisieme equipement de niveau 3 du depot a avoir ce defaut, apres le
 * routeur et le commutateur, et le dernier.
 *
 * CE QUI N'EST PAS FAIT, et c'est une DECISION deja ecrite dans
 * `TODO.md` : le pare-feu n'honore toujours PAS le routage par la
 * source. L'inscription Record Route n'ouvre aucun contournement — elle
 * ne fait qu'ecrire une adresse dans une zone que l'emetteur a reservee.
 * Honorer une source route, en revanche, rendrait le pare-feu PLUS
 * PERMISSIF qu'aujourd'hui : un paquet vise sur son adresse repartirait
 * vers l'interieur au lieu d'etre livre localement, ce que la RFC 1812
 * §5.3.13.4 decrit en toutes lettres (« Packet filtering can be defeated
 * by source routing »). Le bouton FortiOS qui refuserait ces paquets
 * n'est pas attestable depuis ce reseau, donc on ne l'invente pas. Aucun
 * cas de cette sonde n'epingle cette limite comme un contrat : ce serait
 * fermer la porte au correctif du jour ou la source sera disponible.
 *
 * L'INSCRIPTION EST SUR LE CHEMIN DE TRANSIT SEUL, ce que la RFC dit
 * (« in forwarded packets ») : ni les erreurs ICMP que le pare-feu
 * emet lui-meme, ni les paquets qu'il origine ne passent par la.
 *
 * DISCRIMINATION (`git stash push -- src/network`) : 3 des 5 cas
 * tombent. Les DEUX temoins sont nommes avec leur raison — sans le
 * premier, une maquette ou rien ne traverse rendrait les trois refus
 * verts ; sans le second, on ne saurait pas que le correctif laisse en
 * paix un paquet qui ne demande rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4, createIPv4Packet,
  verifyIPv4Checksum, IP_PROTO_ICMP, IP_OPTION_RECORD_ROUTE,
  type EthernetFrame, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import { buildRecordRouteOption, routeAddressesOf } from '@/network/layers/internet/Ipv4Options';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function type(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

function watchIpv4(port: { receiveFrame(f: EthernetFrame): unknown }): () => IPv4Packet[] {
  const seen: IPv4Packet[] = [];
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) seen.push(f.payload as IPv4Packet);
    return original(f);
  };
  return () => seen;
}

async function lab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const r2 = new CiscoRouter('R2');
  const b = new LinuxPC('linux-pc', 'B', 400, 0);

  new Cable('a-fgt').connect(a.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('fgt-r2').connect(fgt.getPort('port3')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-b').connect(r2.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);

  await type(fgt, ['config system interface',
    'edit port2', 'set mode static', 'set ip 10.0.0.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit port3', 'set mode static', 'set ip 10.0.1.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.0.2.0 255.255.255.0',
    'set gateway 10.0.1.2', 'set device "port3"', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1', 'end']);
  await type(a, ['ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0',
    'ip route add default via 10.0.0.1']);
  await type(b, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0',
    'ip route add default via 10.0.2.1']);

  await a.executeCommand('ping -c 1 10.0.2.10');
  return { fgt, a, b, r2 };
}

function inject(fgt: FortiGate, a: LinuxPC, ipOptions: IPv4Option[]): void {
  const packet = createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'),
    IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions });
  fgt.getPort('port2')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: fgt.getPort('port2')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });
}

function optionOf(packet: IPv4Packet, optionType: number): IPv4Option | undefined {
  return packet.options?.find(o => o.type === optionType);
}

describe('the firewall names itself on a forwarded route', () => {
  it('a plain datagram crosses the firewall and the router — WITNESS', async () => {
    const { fgt, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(fgt, a, []);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].ihl).toBe(5);
    expect(arrived[0].options).toBeUndefined();
  });

  it('both hops insert their egress address, firewall first', async () => {
    const { fgt, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(fgt, a, [buildRecordRouteOption(4)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    const option = optionOf(arrived[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString()))
      .toEqual(['10.0.1.1', '10.0.2.1']);
    expect(verifyIPv4Checksum(arrived[0])).toBe(true);
  });

  it('a single slot is filled by the firewall, then left alone', async () => {
    const { fgt, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(fgt, a, [buildRecordRouteOption(1)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    const option = optionOf(arrived[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString())).toEqual(['10.0.1.1']);
  });

  it('a route area with room for less than an address is dropped, not relayed', async () => {
    const { fgt, a, r2 } = await lab();
    const atR2 = watchIpv4(r2.getPort('GigabitEthernet0/0')!);
    const before = atR2().length;
    inject(fgt, a, [{ type: IP_OPTION_RECORD_ROUTE, data: [6, 0, 0, 0, 0] }]);

    expect(atR2().length).toBe(before);
  });

  it('an option the firewall cannot fill still reaches the far end — WITNESS', async () => {
    const { fgt, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(fgt, a, [{ type: IP_OPTION_RECORD_ROUTE, data: [12, 10, 0, 9, 9, 10, 0, 9, 8] }]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    const option = optionOf(arrived[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString()))
      .toEqual(['10.0.9.9', '10.0.9.8']);
  });
});
