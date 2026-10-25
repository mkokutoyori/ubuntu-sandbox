/**
 * Un flux que MASQUERADE a traduit garde l'interface par laquelle il est sorti, `masq_index` dans l'extension nat de la connexion
 * (`nf_nat_masquerade_ipv4`, net/netfilter/nf_nat_masquerade.c) ; trois choses en decoulent. Quand l'interface est fermee
 * (`masq_device_event`, NETDEV_DOWN) tous les flux qui en sont sortis disparaissent ; quand une adresse est retiree (`masq_inet_event`) seuls
 * disparaissent ceux de cette interface dont l'adresse traduite est la sienne (`inet_cmp` compare la destination du tuple de reponse) ;
 * et un paquet du sens d'origine qui sort par une autre interface que celle du flux est jete, le flux avec lui (`nf_nat_oif_changed`,
 * include/net/netfilter/nf_nat.h, puis `nf_ct_kill_acct` dans `nf_nat_inet_fn`). Une perte de porteuse n'est pas un NETDEV_DOWN, et seuls
 * les flux MASQUERADE portent `masq_index` : un flux SNAT survit a la fermeture de son interface.
 *
 * Mesure de depart (arbre portant les lots precedents ; inside -- GW -- deux fournisseurs, MASQUERADE sans `-o`) :
 *     un ping par fournisseur puis `ip link set eth1 down`  ->  `conntrack -L` garde les deux flux : rien ne les rattachait a leur interface
 *     `ip addr del` de l'adresse traduite  ->  le flux reste, traduit par une adresse que la machine ne porte plus
 *     la route par defaut deplacee sur eth2 puis le meme datagramme UDP  ->  le meme flux continue a traduire par l'adresse d'eth1, et part
 *     par eth2 sous une adresse qui n'est pas la sienne
 *
 * Discrimination : contre l'arbre sans le lot (sonde conservee), 7 des 16 cas tombent et 9 passent des deux cotes : trois TEMOINS (un flux par
 * fournisseur traduit par l'adresse de son interface ; un flux sort par l'interface factice ; la route inchangee garde le flux et l'adresse), le
 * temoin qui dit que l'interface fermee est bien tombee, et cinq absences ou non-regressions que la base tenait deja (fermer une interface par
 * laquelle aucun flux n'est sorti ; perdre la porteuse ; un flux SNAT ; retirer une autre adresse ; ce qui est publie sur le bus quitte). Les
 * deux fichiers voisins, connection-tracker-masquerade et masquerade-flow-projection, lisent le suivi et la projection seuls : les methodes et le
 * module qu'ils lisent n'existaient pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, IP_PROTO_UDP, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import type { EthernetFrame, IPv4Packet, UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { flows, sudo } from '../../support/natGateway';
import { framesSentOn } from '../../support/wireWatch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const MASK = new SubnetMask('255.255.255.0');
const INSIDE = '10.0.0.2';
const GATEWAY_INSIDE = '10.0.0.1';
const FIRST_UPLINK = '203.0.113.1';
const FIRST_PEER = '203.0.113.2';
const SECOND_UPLINK = '198.51.100.1';
const SECOND_PEER = '198.51.100.2';
const FAR = '192.0.2.77';

interface Lab {
  readonly inside: LinuxServer;
  readonly gateway: LinuxServer;
  readonly firstPeer: LinuxServer;
  readonly secondPeer: LinuxServer;
}

async function twoUplinks(rule = 'iptables -t nat -A POSTROUTING -j MASQUERADE'): Promise<Lab> {
  const inside = new LinuxServer('linux-server', 'IN');
  const gateway = new LinuxServer('linux-server', 'GW');
  const firstPeer = new LinuxServer('linux-server', 'P1');
  const secondPeer = new LinuxServer('linux-server', 'P2');
  inside.configureInterface('eth0', new IPAddress(INSIDE), MASK);
  gateway.configureInterface('eth0', new IPAddress(GATEWAY_INSIDE), MASK);
  gateway.configureInterface('eth1', new IPAddress(FIRST_UPLINK), MASK);
  gateway.configureInterface('eth2', new IPAddress(SECOND_UPLINK), MASK);
  firstPeer.configureInterface('eth0', new IPAddress(FIRST_PEER), MASK);
  secondPeer.configureInterface('eth0', new IPAddress(SECOND_PEER), MASK);
  inside.setDefaultGateway(new IPAddress(GATEWAY_INSIDE));
  new Cable('inside').connect(inside.getPort('eth0')!, gateway.getPort('eth0')!);
  new Cable('first').connect(gateway.getPort('eth1')!, firstPeer.getPort('eth0')!);
  new Cable('second').connect(gateway.getPort('eth2')!, secondPeer.getPort('eth0')!);
  await sudo(gateway, 'sysctl -w net.ipv4.ip_forward=1');
  await sudo(gateway, rule);
  return { inside, gateway, firstPeer, secondPeer };
}

const ping = (lab: Lab, peer: string): Promise<string> => pingOnSimulatedClock(lab.inside, `ping -c 1 -W 1 ${peer}`);
const pingBoth = async (lab: Lab): Promise<void> => {
  await ping(lab, FIRST_PEER);
  await ping(lab, SECOND_PEER);
};
const tracked = async (lab: Lab, protocol: 'icmp' | 'udp'): Promise<string[]> => {
  const lines = await flows(lab.gateway, '-p', protocol);
  return protocol === 'udp' ? lines.filter((line) => / dport=9 /.test(line)) : lines;
};
const translatedTo = (lines: readonly string[]): string[] => lines.map((line) => /src=\S+ dst=(\S+) type=0/.exec(line)?.[1] ?? '?').sort();

describe('a flow masqueraded onto an interface goes when that interface is closed', () => {
  it('TEMOIN : each uplink holds one flow, translated by the address of its own interface', async () => {
    const lab = await twoUplinks();
    await pingBoth(lab);
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([SECOND_UPLINK, FIRST_UPLINK].sort());
  });

  it('closing eth1 removes the flow that left by eth1, and only that one', async () => {
    const lab = await twoUplinks();
    await pingBoth(lab);
    await sudo(lab.gateway, 'ip link set dev eth1 down');
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([SECOND_UPLINK]);
  });

  it('the interface that was closed really is down, and opening it again brings it up', async () => {
    const lab = await twoUplinks();
    await sudo(lab.gateway, 'ip link set dev eth1 down');
    expect(await sudo(lab.gateway, 'ip -br link show dev eth1')).toMatch(/\bDOWN\b/);
    await sudo(lab.gateway, 'ip link set dev eth1 up');
    expect(await sudo(lab.gateway, 'ip -br link show dev eth1')).toMatch(/\bUP\b/);
  });

  it('opening it again does not bring the flow back, and a new ping makes a new one', async () => {
    const lab = await twoUplinks();
    await ping(lab, FIRST_PEER);
    await sudo(lab.gateway, 'ip link set dev eth1 down');
    await sudo(lab.gateway, 'ip link set dev eth1 up');
    expect(await tracked(lab, 'icmp')).toEqual([]);
    await ping(lab, FIRST_PEER);
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });

  it('closing an interface no flow left by changes nothing', async () => {
    const lab = await twoUplinks();
    await ping(lab, FIRST_PEER);
    await sudo(lab.gateway, 'ip link set dev eth2 down');
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });

  it('losing the carrier is not closing the interface : the flow stays', async () => {
    const lab = await twoUplinks();
    await ping(lab, FIRST_PEER);
    await sudo(lab.firstPeer, 'ip link set dev eth0 down');
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });

  it('a flow that SNAT translated does not follow its interface, only MASQUERADE records one', async () => {
    const lab = await twoUplinks(`iptables -t nat -A POSTROUTING -o eth1 -j SNAT --to-source ${FIRST_UPLINK}`);
    await ping(lab, FIRST_PEER);
    await sudo(lab.gateway, 'ip link set dev eth1 down');
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });
});

describe('a virtual interface that is deleted is closed first, and takes its flows', () => {
  async function withDummyUplink(): Promise<Lab> {
    const lab = await twoUplinks();
    await sudo(lab.gateway, 'ip link add dummy0 type dummy');
    await sudo(lab.gateway, 'ip addr add 192.0.2.1/24 dev dummy0');
    await sudo(lab.gateway, 'ip link set dev dummy0 up');
    await ping(lab, '192.0.2.50');
    return lab;
  }

  it('TEMOIN : a flow leaves by the dummy interface, translated by its address', async () => {
    const lab = await withDummyUplink();
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual(['192.0.2.1']);
  });

  it('deleting the interface removes that flow and not the flow of another interface', async () => {
    const lab = await withDummyUplink();
    await ping(lab, FIRST_PEER);
    await sudo(lab.gateway, 'ip link del dummy0');
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });
});

describe('the flows follow the bus the machine is on', () => {
  it('closing an interface still removes its flows after the bus was replaced', async () => {
    const lab = await twoUplinks();
    await ping(lab, FIRST_PEER);
    lab.gateway.setEventBus(new EventBus());
    await sudo(lab.gateway, 'ip link set dev eth1 down');
    expect(await tracked(lab, 'icmp')).toEqual([]);
  });

  it('what is published on the bus it left no longer reaches the flows', async () => {
    const lab = await twoUplinks();
    await ping(lab, FIRST_PEER);
    const left = lab.gateway.getBus();
    lab.gateway.setEventBus(new EventBus());
    left.publish({ topic: 'host.link.state-changed', payload: { deviceId: lab.gateway.id, iface: 'eth1', up: false } });
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });
});

describe('a flow masqueraded with an address goes when that address is removed', () => {
  it('removing the translating address removes the flow, and not the flow of the other interface', async () => {
    const lab = await twoUplinks();
    await pingBoth(lab);
    await sudo(lab.gateway, `ip addr del ${FIRST_UPLINK}/24 dev eth1`);
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([SECOND_UPLINK]);
  });

  it('removing another address of the same interface leaves the flow', async () => {
    const lab = await twoUplinks();
    await ping(lab, FIRST_PEER);
    await sudo(lab.gateway, 'ip addr add 192.0.2.9/24 dev eth1');
    await sudo(lab.gateway, 'ip addr del 192.0.2.9/24 dev eth1');
    expect(translatedTo(await tracked(lab, 'icmp'))).toEqual([FIRST_UPLINK]);
  });
});

describe('a packet that leaves by another interface than its flow is dropped, and the flow with it', () => {
  const datagram = (lab: Lab): Promise<string> =>
    pingOnSimulatedClock(lab.inside, `echo hello | nc -u -w 1 -p 5000 ${FAR} 9; echo rc=$?`);

  const datagramSources = (frames: EthernetFrame[]): string[] =>
    frames.map((frame) => frame.payload as IPv4Packet)
      .filter((packet) => packet.type === 'ipv4' && packet.protocol === IP_PROTO_UDP && (packet.payload as UDPPacket).destinationPort === 9)
      .map((packet) => packet.sourceIP.toString());

  async function labWithDefaultRoute(): Promise<Lab> {
    const lab = await twoUplinks();
    await sudo(lab.gateway, `ip route add default via ${FIRST_PEER} dev eth1`);
    return lab;
  }

  it('TEMOIN : with the route unchanged each datagram goes out by eth1 under the same address and keeps the one flow', async () => {
    const lab = await labWithDefaultRoute();
    const first = framesSentOn(lab.gateway, 'eth1');
    await datagram(lab);
    await datagram(lab);
    expect(datagramSources(first)).toEqual([FIRST_UPLINK, FIRST_UPLINK]);
    const kept = await tracked(lab, 'udp');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain(`dst=${FIRST_UPLINK} sport=`);
  });

  it('after the route moved to eth2 the next datagram goes out by neither interface, and its flow is gone', async () => {
    const lab = await labWithDefaultRoute();
    await datagram(lab);
    await sudo(lab.gateway, `ip route replace default via ${SECOND_PEER} dev eth2`);
    const first = framesSentOn(lab.gateway, 'eth1');
    const second = framesSentOn(lab.gateway, 'eth2');
    await datagram(lab);
    expect(datagramSources(first)).toEqual([]);
    expect(datagramSources(second)).toEqual([]);
    expect(await tracked(lab, 'udp')).toEqual([]);
  });

  it('the datagram after that opens a new flow and goes out by eth2 under its address', async () => {
    const lab = await labWithDefaultRoute();
    await datagram(lab);
    await sudo(lab.gateway, `ip route replace default via ${SECOND_PEER} dev eth2`);
    await datagram(lab);
    const second = framesSentOn(lab.gateway, 'eth2');
    await datagram(lab);
    expect(datagramSources(second)).toEqual([SECOND_UPLINK]);
    const fresh = await tracked(lab, 'udp');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain(`dst=${SECOND_UPLINK} sport=`);
  });
});
