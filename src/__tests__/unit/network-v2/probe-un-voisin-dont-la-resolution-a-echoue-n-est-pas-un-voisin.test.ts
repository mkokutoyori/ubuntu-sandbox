/**
 * Une resolution de voisin qui a echoue ne laisse pas un voisin. Quand `ping` n'obtient aucune reponse a son ARP, la table garde l'entree
 * « FAILED » (c'est ce que `ip neigh` montre) ; l'entree n'a pas d'adresse de couche lien, et la pile y avait mis l'adresse de diffusion. Tout
 * lecteur de la table sauf un la prenait pour un voisin resolu. Le noyau fait autre chose : une entree FAILED qu'un paquet reveille repasse a
 * INCOMPLETE, emet un nouvel ARP et met le paquet en file (`__neigh_event_send`, net/core/neighbour.c : ce qui n'est ni connecte, ni retardement,
 * ni sonde, ni perime, ni deja incomplet recommence ses sondes), et un paquet ne part JAMAIS pour l'adresse de diffusion d'un voisin qui n'a
 * pas repondu.
 *
 * Mesure de depart (origin/mandeng portant le lot de l'echo et du datagramme brut ; une machine 10.0.0.2 sur un concentrateur, une autre, 10.0.0.9, pas
 * encore branchee) :
 *     ping -c 1 10.0.0.9 puis un datagramme UDP vers 10.0.0.9  ->  la trame part pour ff:ff:ff:ff:ff:ff, aucun ARP
 *     ping -c 1 10.0.0.9 puis `nc -zv -w 1 10.0.0.9 80`        ->  le SYN part, deux fois, pour ff:ff:ff:ff:ff:ff ; « Connection timed out » la ou la
 *                                              premiere tentative, sans entree FAILED, rend « No route to host »
 *     la passerelle de natGateway qui a une entree FAILED pour 10.0.0.9, puis un echo d'outside vers 10.0.0.9  ->  la passerelle le transmet pour
 *                                              ff:ff:ff:ff:ff:ff au lieu de demander 10.0.0.9
 *
 * Autorites : noyau Linux 6.1 -- net/core/neighbour.c (`__neigh_event_send`), net/ipv4/arp.c (`arp_solicit`), net/ipv4/ip_output.c
 * (`ip_finish_output2` : le voisin est cherche par `ip_neigh_for_gw`, la trame ne part que par `neigh_output`), net/ipv4/tcp_ipv4.c (`tcp_v4_err` :
 * une erreur d'hote injoignable pendant SYN_SENT rend EHOSTUNREACH a connect).
 *
 * Discrimination : 9 des 15 cas tombent contre l'arbre sans le lot (EndHost remis a son etat, sonde conservee) et 6 passent des deux cotes, NOMMES :
 * le TEMOIN (le ping qui echoue laisse bien une entree FAILED : le laboratoire est sain), « un voisin qui a repondu est utilise sans redemander » (le
 * chemin d'une entree resolue, que la lecture par l'accesseur ne doit pas casser), « une entree permanente est utilisee telle quelle » (idem pour une
 * entree statique, qui n'est jamais FAILED), le TEMOIN de la redirection (l'ancien code ecartait deja une entree FAILED dans ce lecteur, ecrit a la main ;
 * le cas garde que l'accesseur le fait aussi) et les deux TEMOINS de la sonde de connexion synchrone (un voisin jamais demande, puis un voisin apparu apres
 * un echec : la sonde le trouve ouvert des deux cotes, mais seule une resolution faite AVANT la lecture de la socket le permet).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, MACAddress, SubnetMask, resetCounters, ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP,
  type ARPPacket, type EthernetFrame, type IPv4Packet,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { framesSentOn } from '../../support/wireWatch';
import { natGateway, sudo, type Host } from '../../support/natGateway';
import { routerOnAStick, STICK_A_IP, STICK_B_IP } from '../../support/routerOnAStick';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const HOST_IP = '10.0.0.2';
const PEER_IP = '10.0.0.9';
const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

interface Lab {
  readonly host: LinuxServer;
  readonly peer: LinuxPC;
  plug(): void;
}

function lab(): Lab {
  const host = new LinuxServer('linux-server', 'HOST');
  const peer = new LinuxPC('linux-pc', 'PEER');
  const hub = new Hub('HUB', 4);
  host.configureInterface('eth0', new IPAddress(HOST_IP), new SubnetMask('255.255.255.0'));
  peer.configureInterface('eth0', new IPAddress(PEER_IP), new SubnetMask('255.255.255.0'));
  new Cable('host').connect(host.getPort('eth0')!, hub.getPort('eth0')!);
  return { host, peer, plug: () => { new Cable('peer').connect(peer.getPort('eth0')!, hub.getPort('eth1')!); } };
}

const failedResolution = (host: Host): Promise<string> => pingOnSimulatedClock(host, `ping -c 1 -W 1 ${PEER_IP}`);

const packetsOf = (frames: readonly EthernetFrame[], protocol: number): IPv4Packet[] =>
  frames.filter((frame) => frame.etherType === ETHERTYPE_IPV4).map((frame) => frame.payload as IPv4Packet).filter((packet) => packet.protocol === protocol);
const toBroadcastMac = (frames: readonly EthernetFrame[], protocol: number): number =>
  frames.filter((frame) => frame.etherType === ETHERTYPE_IPV4 && (frame.payload as IPv4Packet).protocol === protocol && frame.dstMAC.toString() === BROADCAST_MAC).length;
const arpRequestsFor = (frames: readonly EthernetFrame[], target: string): number =>
  frames.filter((frame) => frame.etherType === ETHERTYPE_ARP).map((frame) => frame.payload as ARPPacket)
    .filter((arp) => arp.operation === 'request' && arp.targetIP.toString() === target).length;

describe('a neighbour whose resolution failed is asked for again', () => {
  it('TEMOIN : the failed ping leaves a FAILED entry, and the lab keeps nobody at the address', async () => {
    const { host } = lab();
    await failedResolution(host);
    expect(await sudo(host, 'ip neigh show')).toContain(`${PEER_IP} dev eth0  FAILED`);
  });

  it('a datagram sent afterwards asks for the neighbour', async () => {
    const { host } = lab();
    await failedResolution(host);
    const sent = framesSentOn(host, 'eth0');
    host.sendUdpDatagram(new IPAddress(PEER_IP), 9, 5000, null, 10);
    expect(arpRequestsFor(sent, PEER_IP)).toBe(1);
  });

  it('and leaves for no broadcast address', async () => {
    const { host } = lab();
    await failedResolution(host);
    const sent = framesSentOn(host, 'eth0');
    host.sendUdpDatagram(new IPAddress(PEER_IP), 9, 5000, null, 10);
    expect(toBroadcastMac(sent, IP_PROTO_UDP)).toBe(0);
  });

  it('once the neighbour answers, the datagram goes to its own address and the entry is reachable', async () => {
    const { host, peer, plug } = lab();
    await failedResolution(host);
    plug();
    const sent = framesSentOn(host, 'eth0');
    host.sendUdpDatagram(new IPAddress(PEER_IP), 9, 5000, null, 10);
    const datagram = sent.find((frame) => frame.etherType === ETHERTYPE_IPV4 && (frame.payload as IPv4Packet).protocol === IP_PROTO_UDP);
    expect(datagram!.dstMAC.toString()).toBe(peer.getPort('eth0')!.getMAC().toString());
    expect(await sudo(host, 'ip neigh show')).toContain(`${PEER_IP} dev eth0 lladdr ${peer.getPort('eth0')!.getMAC().toString()} REACHABLE`);
  });

  it('a neighbour that answered is used without asking again', async () => {
    const { host, plug } = lab();
    await failedResolution(host);
    plug();
    host.sendUdpDatagram(new IPAddress(PEER_IP), 9, 5000, null, 10);
    const sent = framesSentOn(host, 'eth0');
    host.sendUdpDatagram(new IPAddress(PEER_IP), 9, 5000, null, 10);
    expect(arpRequestsFor(sent, PEER_IP)).toBe(0);
    expect(packetsOf(sent, IP_PROTO_UDP)).toHaveLength(1);
  });

  it('a permanent entry is used as it is', async () => {
    const { host } = lab();
    await sudo(host, `ip neigh add ${PEER_IP} lladdr 02:00:00:00:00:99 dev eth0 nud permanent`);
    const sent = framesSentOn(host, 'eth0');
    host.sendUdpDatagram(new IPAddress(PEER_IP), 9, 5000, null, 10);
    expect(arpRequestsFor(sent, PEER_IP)).toBe(0);
    const datagram = sent.find((frame) => frame.etherType === ETHERTYPE_IPV4);
    expect(datagram!.dstMAC.toString()).toBe('02:00:00:00:00:99');
  });
});

describe('a connection attempt to a neighbour whose resolution failed', () => {
  it('asks for the neighbour again and sends no segment to the broadcast address', async () => {
    const { host } = lab();
    await failedResolution(host);
    const sent = framesSentOn(host, 'eth0');
    await pingOnSimulatedClock(host, `nc -zv -w 1 ${PEER_IP} 80`);
    expect(arpRequestsFor(sent, PEER_IP)).toBeGreaterThan(0);
    expect(toBroadcastMac(sent, IP_PROTO_TCP)).toBe(0);
  });

  it('ends as the first attempt does : no route to the host', async () => {
    const { host } = lab();
    const first = await pingOnSimulatedClock(host, `nc -zv -w 1 ${PEER_IP} 80`);
    await failedResolution(host);
    const second = await pingOnSimulatedClock(host, `nc -zv -w 1 ${PEER_IP} 80`);
    expect(first).toContain('No route to host');
    expect(second).toBe(first);
  });
});

describe('a gateway that forwards to a host whose resolution failed', () => {
  it('asks for the host and floods nothing', async () => {
    const { gateway, outside } = await natGateway();
    await pingOnSimulatedClock(gateway, `ping -c 1 -W 1 ${PEER_IP}`);
    expect(await sudo(gateway, 'ip neigh show')).toContain(`${PEER_IP} dev eth0  FAILED`);
    const sent = framesSentOn(gateway, 'eth0');
    await pingOnSimulatedClock(outside, `ping -c 1 -W 1 ${PEER_IP}`);
    expect(toBroadcastMac(sent, IP_PROTO_ICMP)).toBe(0);
    expect(arpRequestsFor(sent, PEER_IP)).toBe(1);
  });
});

describe('the other readers of the neighbour table', () => {
  it('the address probe asks again after a failed resolution, and addresses its echo to the host that appeared since', async () => {
    const { host, peer, plug } = lab();
    await failedResolution(host);
    plug();
    const sent = framesSentOn(host, 'eth0');
    expect(host.addressAnswersOnLink('eth0', new IPAddress(PEER_IP))).toBe(true);
    expect(arpRequestsFor(sent, PEER_IP)).toBe(1);
    const echo = sent.find((frame) => frame.etherType === ETHERTYPE_IPV4 && (frame.payload as IPv4Packet).protocol === IP_PROTO_ICMP);
    expect(echo!.dstMAC.toString()).toBe(peer.getPort('eth0')!.getMAC().toString());
  });

  it('the address probe sends no echo for the address of a host that stays silent after a failed resolution', async () => {
    const { host } = lab();
    await failedResolution(host);
    const sent = framesSentOn(host, 'eth0');
    expect(host.addressAnswersOnLink('eth0', new IPAddress(PEER_IP))).toBe(false);
    expect(arpRequestsFor(sent, PEER_IP)).toBe(1);
    expect(packetsOf(sent, IP_PROTO_ICMP)).toHaveLength(0);
  });

  it('the TCP stack still counts a failed neighbour as unresolved', async () => {
    const { host } = lab();
    await failedResolution(host);
    expect(host.getTcpStack().awaitsUnresolvedNeighbour(PEER_IP)).toBe(true);
  });

  it('TEMOIN : a redirect toward a host whose resolution failed is not followed before the sender has asked for it again', async () => {
    const stick = await routerOnAStick();
    stick.b.getPort('eth0')!.getCable()!.disconnect();
    await sudo(stick.a, `ip route add ${STICK_B_IP}/32 dev eth0`);
    await pingOnSimulatedClock(stick.a, `ping -c 1 -W 1 ${STICK_B_IP}`);
    await sudo(stick.a, `ip route del ${STICK_B_IP}/32 dev eth0`);
    expect(await sudo(stick.a, 'ip neigh show')).toContain(`${STICK_B_IP} dev eth0  FAILED`);
    new Cable('b-again').connect(stick.b.getPort('eth0')!, stick.hub.getPort('eth4')!);
    await pingOnSimulatedClock(stick.a, `ping -c 1 -W 1 ${STICK_B_IP}`, [stick.b, stick.gateway]);
    expect(await sudo(stick.a, `ip route get ${STICK_B_IP}`)).not.toContain('<redirected>');
    expect(STICK_A_IP).toBe('10.0.0.2');
  });
});

describe('the synchronous connect probe resolves the neighbour before it reads the socket', () => {
  it('TEMOIN : it sees the open port of a neighbour it never asked for', () => {
    const { host, plug } = lab();
    plug();
    expect(host.tcpConnectOutcome(new IPAddress(PEER_IP), 22)).toBe('open');
  });

  it('TEMOIN : it sees the open port of a host that appeared after a failed resolution', async () => {
    const { host, plug } = lab();
    await failedResolution(host);
    plug();
    expect(host.tcpConnectOutcome(new IPAddress(PEER_IP), 22)).toBe('open');
  });
});
