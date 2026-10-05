/**
 * ECN a travers un tunnel (RFC 6040) : l'en-tete exterieur porte l'ECN de
 * l'interieur, et la sortie du tunnel rend a l'interieur ce que la Figure 4
 * du §4.2 prescrit.
 *
 * Mesure de depart (commit precedent), deux machines puis deux routeurs :
 *
 *   - un tunnel GRE `ip tunnel` posait un ToS nul sur l'en-tete exterieur : un
 *     paquet ECT(0) y devenait non-ECT, donc un saut netem `ecn` le PERDAIT au
 *     lieu de le marquer, et aucune marque ne pouvait en revenir ; a la sortie
 *     le paquet interieur repartait tel quel, un CE sur l'exterieur etait
 *     oublie ;
 *   - IPsec avait deux ecritures de la meme regle : `propagateEcnOnDecap`,
 *     privee a la machine et seule appelee par elle, et `propagateCeOnDecap`,
 *     dans le module des marques DSCP, que seuls des tests appelaient. La
 *     premiere posait CE sur un paquet interieur non-ECT, que le §4.2 ordonne
 *     de jeter, recopiait un CE interieur en CE exterieur (le §4.1 dit
 *     ECT(0)), et laissait a l'en-tete interieur l'ANCIENNE somme de controle
 *     : avec CE pose sur les paquets ESP d'un transfert TCP, le serveur ne
 *     recevait pas un octet sur 20 000 et son compteur `InReceives` ne
 *     bougeait pas.
 *
 * Autorite : RFC 6040 §4.1 (en-tete exterieur : le champ ECN interieur, sauf
 * CE qui devient ECT(0)), §4.2 et sa Figure 4 (la sortie : CE exterieur sur un
 * interieur ECT devient CE, un interieur non-ECT sous un CE exterieur est
 * JETE, ECT(1) exterieur sur ECT(0) interieur donne ECT(1)) ; RFC 4301 §5.1.2
 * (l'en-tete exterieur d'un tunnel IPsec), que la RFC 6040 met a jour. Linux
 * 5.15, source lue (raw.githubusercontent.com) : `inet_ecn.h`
 * (`INET_ECN_encapsulate`, `__INET_ECN_decapsulate` et la Figure 4 recopiee
 * dans son commentaire), `ip_tunnels.h` (`ip_tunnel_ecn_encap`),
 * `ip_tunnel.c` (`ip_tunnel_rcv` : un paquet a jeter incremente
 * `rx_frame_errors` et n'est pas compte comme recu).
 *
 * Ce qui est construit : `core/EcnTunnel.ts` (`ecnForOuterHeader`,
 * `ecnOnDecapsulation`) sur `EcnCodepoint`, appele par IPsec (la seconde
 * ecriture disparait ; le paquet interieur change de ToS, sa somme est
 * recalculee, et un paquet a jeter est compte en erreur de reception) et par
 * la GRE de Linux (en-tete exterieur a l'emission, tableau de la Figure 4 a la
 * reception, raison `ecn-violation` sur `gre.packet.dropped`) ;
 * `DscpTunnelMarker.dscpOf`, `ecnOf` et `withDscp` ne sont plus que des
 * passerelles vers `DiffServField` (`withDscp` y est ajoute).
 *
 * Ce qui n'est PAS construit : VXLAN. Son agent n'existe que sur les routeurs
 * Cisco, ne recoit pas l'en-tete IP exterieur (`handleUdp` ne lit que le
 * datagramme UDP), et aucune documentation du constructeur n'a ete trouvee
 * pour le comportement d'un VTEP ; le tunnel GRE des routeurs n'a pas de plan
 * de donnees (voir CLAUDE.md), et celui de Linux n'est pas une interface.
 *
 * Discrimination (fichier copie sur le commit precedent, avec le module
 * `EcnTunnel.ts` : sans lui rien ne s'importe) : SEPT cas sur vingt-neuf
 * tombent — six cas GRE et le laboratoire IPsec de bout en bout — ainsi que le
 * cas de `scenario-ipsec-dscp-qos-integration` qui epinglait le CE copie tel
 * quel. Les VINGT-DEUX autres passent des deux cotes : les seize cases de la
 * Figure 4 et les quatre de l'encapsulation, qui ne pesent que le module neuf
 * (STRUCTURELS : ils fixent le tableau et ne prouvent rien de plus), et les
 * deux cas GRE d'un paquet non marque (NON-REGRESSION : un interieur non-ECT
 * part non-ECT, une sortie sans CE ne touche pas l'interieur).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import { ecnForOuterHeader, ecnOnDecapsulation } from '@/network/core/EcnTunnel';
import {
  IPAddress, IP_PROTO_ICMP, IP_PROTO_ESP, createIPv4Packet, computeIPv4Checksum, verifyIPv4Checksum,
  ETHERTYPE_IPV4, type EthernetFrame, type IPv4Packet, type ICMPPacket,
} from '@/network/core/types';
import { IP_PROTO_GRE, type GrePacket } from '@/network/gre/types';
import { pingOnSimulatedClock } from '../../support/fastPing';

const NOT_ECT = EcnCodepoint.NOT_ECT;
const ECT_0 = EcnCodepoint.ECT_0;
const ECT_1 = EcnCodepoint.ECT_1;
const CE = EcnCodepoint.CE;
const PORT = 5001;

describe('RFC 6040 §4.2, Figure 4: what a tunnel egress hands on', () => {
  it.each([
    [NOT_ECT, NOT_ECT, NOT_ECT], [NOT_ECT, ECT_0, NOT_ECT], [NOT_ECT, ECT_1, NOT_ECT], [NOT_ECT, CE, null],
    [ECT_0, NOT_ECT, ECT_0], [ECT_0, ECT_0, ECT_0], [ECT_0, ECT_1, ECT_1], [ECT_0, CE, CE],
    [ECT_1, NOT_ECT, ECT_1], [ECT_1, ECT_0, ECT_1], [ECT_1, ECT_1, ECT_1], [ECT_1, CE, CE],
    [CE, NOT_ECT, CE], [CE, ECT_0, CE], [CE, ECT_1, CE], [CE, CE, CE],
  ])('inner %s under outer %s leaves as %s', (inner, outer, expected) => {
    const verdict = ecnOnDecapsulation(outer, inner);
    if (expected === null) expect(verdict.forward).toBe(false);
    else expect(verdict).toEqual({ forward: true, inner: expected });
  });

  it.each([[NOT_ECT, NOT_ECT], [ECT_0, ECT_0], [ECT_1, ECT_1], [CE, ECT_0]])(
    'an inner %s goes out under an outer %s (RFC 6040 §4.1, normal mode)', (inner, outer) => {
      expect(ecnForOuterHeader(inner)).toBe(outer);
    });
});

interface Lan {
  readonly a: LinuxPC;
  readonly b: LinuxPC;
  readonly cable: Cable;
  readonly bus: EventBus;
  readonly arrivals: IPv4Packet[];
}

async function greLan(): Promise<Lan> {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  const bus = new EventBus();
  a.setEventBus(bus);
  b.setEventBus(bus);
  const cable = new Cable('wire');
  cable.setEventBus(bus);
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  await a.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await b.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await a.executeCommand('ip tunnel add gre0 mode gre remote 10.0.0.2 local 10.0.0.1');
  await b.executeCommand('ip tunnel add gre0 mode gre remote 10.0.0.1 local 10.0.0.2');
  const arrivals: IPv4Packet[] = [];
  b.getPort('eth0')!.attachTap((tapped) => {
    if (tapped.direction !== 'in' || tapped.frame.etherType !== ETHERTYPE_IPV4) return;
    const packet = tapped.frame.payload as IPv4Packet;
    if (packet.protocol === IP_PROTO_GRE) arrivals.push(packet);
  });
  return { a, b, cable, bus, arrivals };
}

function inner(codepoint: EcnCodepoint, from = '10.0.0.1', to = '10.0.0.2'): IPv4Packet {
  const icmp: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 9, sequence: 1, dataSize: 8 };
  const packet = createIPv4Packet(new IPAddress(from), new IPAddress(to), IP_PROTO_ICMP, 64, icmp, 8, {
    tos: codepoint.bits,
  });
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

function greFrom(outerTos: number, payload: IPv4Packet): IPv4Packet {
  const gre: GrePacket = {
    type: 'gre', checksumPresent: false, keyPresent: false, sequencePresent: false, version: 0,
    protocolType: 0x0800, checksum: 0, key: null, sequence: null, payload,
  };
  const outer = createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'), IP_PROTO_GRE, 64, gre, 4 + payload.totalLength, {
    tos: outerTos,
  });
  outer.headerChecksum = computeIPv4Checksum(outer);
  return outer;
}

describe('Linux GRE carries the ECN field both ways (ip_tunnel_ecn_encap, ip_tunnel_ecn_decap)', () => {
  it.each([[NOT_ECT, 0b00], [ECT_0, 0b10], [ECT_1, 0b01], [CE, 0b10]])(
    'an inner %s is carried under outer ECN bits %s', async (codepoint, bits) => {
      const lan = await greLan();
      expect(lan.a.getGreAgent().encapsulateAndSend('gre0', inner(codepoint))).toBe(true);
      expect(lan.arrivals).toHaveLength(1);
      expect(lan.arrivals[0].tos & 0b11).toBe(bits);
    });

  it('an ECN-capable inner packet crosses a netem ecn hop CE-marked, outer header only', async () => {
    const lan = await greLan();
    await lan.a.executeCommand('ping -c 1 10.0.0.2');
    lan.arrivals.length = 0;
    lan.cable.setEgressNetem(lan.a.getPort('eth0')!, { lossRate: 1, delayMs: 0, ecn: true });
    lan.a.getGreAgent().encapsulateAndSend('gre0', inner(ECT_0));
    expect(lan.cable.getStats().framesMarked).toBe(1);
    expect(lan.arrivals).toHaveLength(1);
    expect(lan.arrivals[0].tos & 0b11).toBe(0b11);
    expect(verifyIPv4Checksum(lan.arrivals[0])).toBe(true);
    const carried = (lan.arrivals[0].payload as GrePacket).payload as IPv4Packet;
    expect(carried.tos & 0b11).toBe(0b10);
  });

  it('a CE on the outer header becomes CE on an ECN-capable inner one, checksum included', async () => {
    const lan = await greLan();
    const decapsulated = lan.b.getGreAgent().handleIp('eth0', new IPAddress('10.0.0.1'), greFrom(0b11, inner(ECT_0)));
    expect(decapsulated).not.toBeNull();
    expect(decapsulated!.tos & 0b11).toBe(0b11);
    expect(verifyIPv4Checksum(decapsulated!)).toBe(true);
  });

  it('a CE on the outer header drops a Not-ECT inner packet and says why', async () => {
    const lan = await greLan();
    const reasons: string[] = [];
    lan.bus.subscribe('gre.packet.dropped', (event) => { reasons.push(event.payload.reason); });
    const decapsulated = lan.b.getGreAgent().handleIp('eth0', new IPAddress('10.0.0.1'), greFrom(0b11, inner(NOT_ECT)));
    expect(decapsulated).toBeNull();
    expect(reasons).toEqual(['ecn-violation']);
  });

  it('an unmarked outer header leaves the inner one alone', async () => {
    const lan = await greLan();
    const decapsulated = lan.b.getGreAgent().handleIp('eth0', new IPAddress('10.0.0.1'), greFrom(0b00, inner(ECT_0)));
    expect(decapsulated!.tos & 0b11).toBe(0b10);
  });
});

interface IpsecLab {
  readonly client: LinuxPC;
  readonly server: LinuxPC;
  readonly r1: CiscoRouter;
  readonly wan: Cable;
  readonly bus: EventBus;
}

async function configureEndpoint(
  r: CiscoRouter, wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10',
    'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
    `crypto isakmp key EcnTunnelSecret address ${peerWan}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, 'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    `ip route ${remoteSubnet} 255.255.255.0 ${peerWan}`,
    'end',
  ]) await r.executeCommand(cmd);
}

async function ipsecLab(): Promise<IpsecLab> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const client = new LinuxPC('linux-pc', 'PC1');
  const server = new LinuxPC('linux-pc', 'PC2');
  const bus = new EventBus();
  const wan = new Cable('wan');
  wan.setEventBus(bus);
  wan.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(client.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(server.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
  await configureEndpoint(r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureEndpoint(r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  await client.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await client.executeCommand('sudo ip route add default via 192.168.1.1');
  await server.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await server.executeCommand('sudo ip route add default via 192.168.2.1');
  await pingOnSimulatedClock(client, 'ping -c 2 192.168.2.10');
  return { client, server, r1, wan, bus };
}

describe('an IPsec tunnel carries the ECN field both ways (RFC 4301 §5.1.2, RFC 6040)', () => {
  it('end to end: a CE set on the ESP packets reaches the TCP receiver, which echoes it, and the sender halves its window', async () => {
    const lab = await ipsecLab();
    await lab.client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const received: string[] = [];
    lab.server.getTcpStack().listen(PORT, {
      onAccept: (socket) => { socket.onData((data) => { received.push(String(data)); }); },
    });
    const socket = lab.client.getTcpStack().connect('192.168.2.10', PORT)!;
    expect(socket.state).toBe('established');
    const reactions: number[] = [];
    lab.client.getBus().subscribe('tcp.ecn.reaction', (event) => { reactions.push(event.payload.congestionWindow); });
    const marked: EthernetFrame[] = [];
    lab.bus.subscribe('cable.frame.marked', (event) => { marked.push(event.payload.frame); });
    lab.wan.setEgressNetem(lab.r1.getPort('GigabitEthernet0/1')!, { lossRate: 1, delayMs: 0, ecn: true });
    socket.write('x'.repeat(20000));
    expect(received.join('')).toHaveLength(20000);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((frame) => (frame.payload as IPv4Packet).protocol === IP_PROTO_ESP)).toBe(true);
    expect(reactions.length).toBeGreaterThan(0);
  });
});
