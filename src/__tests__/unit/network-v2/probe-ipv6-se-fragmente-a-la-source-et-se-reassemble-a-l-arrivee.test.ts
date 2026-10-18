/**
 * Un hote IPv6 fragmente a la source ce qui depasse le MTU du chemin, reassemble a l'arrivee AVANT de filtrer et de livrer,
 * et un routeur ne fragmente jamais : il repond Packet Too Big et la source s'adapte (RFC 8200 §4.5 et §5, RFC 8201).
 *
 * Mesure de depart (f4e83899f, un LinuxPC et un WindowsPC relies par `fd00::/64`, puis un routeur Cisco entre deux segments) :
 * un datagramme UDP de 3000 octets partait en UN paquet, sans en-tete Fragment, quel que soit le MTU ; un fragment recu
 * (prochain en-tete 44) n'etait ni mis en file, ni reassemble, ni chronometre : aucune livraison, aucun delai de 60 s, aucun
 * `Ip6Reasm*` ni `Ip6Frag*` -- le bloc IPv6 de `netstat -s` de Windows et `/proc/net/snmp6` les lisaient a zero parce que
 * rien ne les produisait ; `net.ipv6.ip6frag_*` n'existait pas ; un routeur dont l'interface de sortie porte `ipv6 mtu 1400`
 * ne disait jamais Packet Too Big ; `ipv6 mtu` etait une propriete posee a la volee (`port as unknown as { ipv6Mtu }`) que
 * deux vues relisaient et que le plan de donnees ignorait ; tcpdump ne decodait pas l'en-tete Fragment.
 *
 * Autorites : RFC 8200 §4.5 (en-tete Fragment, file de reassemblage, delai de 60 s, Time Exceeded code 1 seulement quand le
 * premier fragment est tenu, Parameter Problem pour une geometrie invalide) et §5 (MTU minimal 1280, un routeur ne
 * fragmente pas), lue dans `docs/rfc/icmp/rfc8200.txt`. RFC 8201 (Packet Too Big, MTU du chemin), RFC 5722 (un recouvrement
 * tue le datagramme) et RFC 3168 §5.3 (l'ECN des fragments) ne sont pas dans `docs/rfc` : leurs regles sont lues dans le
 * noyau 5.15 qui les applique -- `net/ipv6/ip6_output.c`, `net/ipv6/reassembly.c`, `include/net/ipv6_frag.h`,
 * `net/ipv4/inet_fragment.c` (doublon contre recouvrement dans `inet_frag_queue_insert`) et `ip_frag_ecn_table`, les sysctl
 * `ip6frag_*` -- et, pour les mots, dans `print-frag6.c`, `print-udp.c` et `print-icmp6.c` de tcpdump.
 *
 * Ce qui n'est pas porte, et ou c'est suivi : `Ip6FragFails` reste a zero sur les hotes (le noyau le compte quand
 * `ip6_forward` repond Packet Too Big ou quand `ip6_fragment` echoue ; ces hotes ne transmettent pas encore les paquets des
 * autres, #163, et ne peuvent pas echouer a fragmenter : zero est le vrai compte) ; le reassemblage des fragments adresses a un
 * routeur (#173) ; la citation de 48 octets que les erreurs ICMPv6 gardent en dur (#169) ; les vues du MTU appris du chemin,
 * `ip -6 route get` (#171) et `netsh interface ipv6 show destinationcache` (#172) ; le meme traitement des recouvrements et de
 * l'ECN pour IPv4 (#170) ; deux magasins de compteurs IPv6 sur les routeurs (#165).
 *
 * Discrimination : 90 cas contre f4e83899f (on n'y a recopie que les declarations additives -- constantes, types,
 * `FragmentEcn`, `Ipv6Fragmentation.ts`, champs de compteurs -- pour que la sonde se charge) : 67 tombent. 23 passent des deux
 * cotes : trois temoins (le banc, le fragment valide de meme taille, le paquet qui tient dans les 1400 du routeur) ; quatre
 * non-regressions (un datagramme qui tient ne cree aucun fragment, un segment TCP ne recoit jamais d'en-tete Fragment, un
 * paquet deja fragmente ne l'est pas deux fois, `ipv6 mtu` n'est dans la configuration que sur l'interface qui l'a recu) ;
 * un cas vrai par vacuite avant (un hote eteint oublie les datagrammes qu'il assemblait : il n'en assemblait aucun) ; et
 * quinze cas qui lisent des fonctions pures du module recopie (cinq pour la fusion de l'ECN, dix pour les regles de la file),
 * qui tombent par l'absence du module. Mutation : 121 mutants (identification, ajustement exact au MTU, bornes et trous de la
 * file, doublon contre recouvrement, minuteries et remises a zero, memoire, ECN, compteurs, mots des vues) ; 112 tues au premier
 * passage, neuf survivants : deux (le test « ca tient » existait deux fois, dans `fragmentIPv6` et a la sortie de l'hote) ont
 * fait supprimer la copie et rendre l'identification paresseuse ; quatre (fragment final sous la longueur connue, donnees
 * apres le fragment final, minuterie d'un datagramme tue) etaient couverts par un second chemin et ont recu un cas qui les
 * isole ; deux sont equivalents (`Ip6FragFails`, plus haut) ; un (la condition ECT de la fusion) etait redondante et a ete
 * retire du code. Les sept mutants relances apres correction sont tues.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetCounters, MACAddress, IPv6Address, ETHERTYPE_IPV6, IP_PROTO_UDP, IP_PROTO_TCP, IP_PROTO_IPV6_FRAGMENT,
  createIPv6Packet,
} from '@/network/core/types';
import { noFlags, type TcpSegment } from '@/network/tcp/types';
import type { EthernetFrame, ICMPv6Packet, IPv6Packet, UDPPacket } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { stampUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import {
  fragmentIPv6, ipv6FragmentOf, IPv6Reassembler, IPV6_REASSEMBLY_HIGH_THRESHOLD_BYTES,
  type IPv6FragmentHeader,
} from '@/network/layers/internet/Ipv6Fragmentation';
import type { ProtocolCounters } from '@/network/layers/internet/ProtocolCounters';
import { framesSentOn, framesReceivedOn } from '../../support/wireWatch';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const UDP_PORT = 9000;
const CAPACITY_AT_1500 = 1448;

type Host = LinuxPC | WindowsPC;

const snapshot = (host: Host): ProtocolCounters => {
  const c = host.getProtocolCounters();
  return { ...c, icmp6InTypes: [...c.icmp6InTypes], icmp6OutTypes: [...c.icmp6OutTypes] };
};

const growth = (before: ProtocolCounters, after: ProtocolCounters) => (field: keyof ProtocolCounters): number =>
  (after[field] as number) - (before[field] as number);

const ipv6Of = (frame: EthernetFrame): IPv6Packet | null =>
  frame.etherType === ETHERTYPE_IPV6 ? (frame.payload as IPv6Packet) : null;

const fragmentsIn = (frames: readonly EthernetFrame[]): IPv6Packet[] =>
  frames.map(ipv6Of).filter((p): p is IPv6Packet => p !== null && p.nextHeader === IP_PROTO_IPV6_FRAGMENT);

const headerOf = (packet: IPv6Packet): IPv6FragmentHeader => ipv6FragmentOf(packet)!;

const icmp6Errors = (frames: readonly EthernetFrame[], type: string): ICMPv6Packet[] =>
  frames.map(ipv6Of)
    .map((p) => p?.payload as ICMPv6Packet | undefined)
    .filter((icmp): icmp is ICMPv6Packet => icmp?.type === 'icmpv6' && icmp.icmpType === type);

interface Bench {
  linux: LinuxPC;
  windows: WindowsPC;
  linuxSent: EthernetFrame[];
  windowsSent: EthernetFrame[];
  linuxReceived: EthernetFrame[];
  windowsReceived: EthernetFrame[];
}

function withClock(host: Host): VirtualTimeScheduler {
  const clock = new VirtualTimeScheduler();
  host.setScheduler(clock);
  return clock;
}

async function bench(): Promise<Bench> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
  await windows.executeCommand('netsh interface ipv6 add address "Ethernet0" fd00::7/64');
  windows.udpListen(UDP_PORT, 'probe', {});
  linux.udpListen(UDP_PORT, 'probe', {});
  await linux.executeCommand('ping -6 -c 1 fd00::7');
  const b = {
    linux, windows,
    linuxSent: framesSentOn(linux, 'eth0'), windowsSent: framesSentOn(windows, 'eth0'),
    linuxReceived: framesReceivedOn(linux, 'eth0'), windowsReceived: framesReceivedOn(windows, 'eth0'),
  };
  quiet(b);
  return b;
}

function quiet(b: Bench): void {
  for (const frames of [b.linuxSent, b.windowsSent, b.linuxReceived, b.windowsReceived]) frames.length = 0;
}

const WINDOWS = new IPv6Address('fd00::7');
const LINUX = new IPv6Address('fd00::1');

function datagram(source: IPv6Address, destination: IPv6Address, size: number, port = UDP_PORT): IPv6Packet {
  const udp: UDPPacket = {
    type: 'udp', sourcePort: 40000, destinationPort: port, length: size, checksum: 0, payload: 'x',
  };
  return createIPv6Packet(
    source, destination, IP_PROTO_UDP, 64,
    stampUdpChecksum(udp, source.toString(), destination.toString()), size);
}

function inject(target: Host, sender: Host, packet: IPv6Packet): void {
  target.getPort('eth0')!.receiveFrame({
    srcMAC: sender.getPort('eth0')!.getMAC(), dstMAC: target.getPort('eth0')!.getMAC(),
    etherType: ETHERTYPE_IPV6, payload: packet,
  });
}

const fragmentsFor = (
  source: IPv6Address, destination: IPv6Address, size: number, identification = 77, mtu = 1500,
): IPv6Packet[] => fragmentIPv6(datagram(source, destination, size), mtu, () => identification);

const fragmentsOf = (size: number, identification = 77, mtu = 1500): IPv6Packet[] =>
  fragmentsFor(LINUX, WINDOWS, size, identification, mtu);

interface CraftedFragment {
  identification: number;
  offsetBytes: number;
  length: number;
  more: boolean;
  trafficClass?: number;
}

function crafted(source: IPv6Address, destination: IPv6Address, spec: CraftedFragment): IPv6Packet {
  const header: IPv6FragmentHeader = {
    type: 'ipv6-fragment', nextHeader: IP_PROTO_UDP, fragmentOffset: spec.offsetBytes / 8,
    moreFragments: spec.more, identification: spec.identification, length: spec.length,
    payload: spec.offsetBytes === 0
      ? datagram(source, destination, 3000).payload
      : { type: 'ipv6-fragment-data', length: spec.length },
  };
  return {
    ...createIPv6Packet(source, destination, IP_PROTO_IPV6_FRAGMENT, 64, header, 8 + spec.length),
    trafficClass: spec.trafficClass ?? 0,
  };
}

describe('the bench is sound (witness)', () => {
  it('a datagram that fits is delivered whole, without a fragment header', async () => {
    const b = await bench();
    const before = snapshot(b.windows);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 1000);
    await settle();
    expect(fragmentsIn(b.linuxSent)).toHaveLength(0);
    expect(growth(before, snapshot(b.windows))('udp6InDatagrams')).toBe(1);
    expect(growth(before, snapshot(b.windows))('ip6ReasmReqds')).toBe(0);
  });
});

describe('a host fragments what exceeds the path MTU (RFC 8200 §4.5)', () => {
  it('a 3000-byte UDP datagram leaves as three fragments of 1448, 1448 and 104 data bytes', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const fragments = fragmentsIn(b.linuxSent);
    expect(fragments.map((p) => headerOf(p).length)).toEqual([CAPACITY_AT_1500, CAPACITY_AT_1500, 104]);
    expect(fragments.map((p) => headerOf(p).fragmentOffset * 8)).toEqual([0, 1448, 2896]);
    expect(fragments.map((p) => headerOf(p).moreFragments)).toEqual([true, true, false]);
    expect(fragments.map((p) => p.payloadLength)).toEqual([1456, 1456, 112]);
  });

  it('every fragment names the Fragment header, quotes the real protocol and fits the 1500 link MTU', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const fragments = fragmentsIn(b.linuxSent);
    expect(fragments).toHaveLength(3);
    for (const fragment of fragments) {
      expect(fragment.nextHeader).toBe(IP_PROTO_IPV6_FRAGMENT);
      expect(headerOf(fragment).nextHeader).toBe(IP_PROTO_UDP);
      expect(40 + fragment.payloadLength).toBeLessThanOrEqual(1500);
    }
    expect(fragments.slice(0, 2).every((p) => headerOf(p).length % 8 === 0)).toBe(true);
  });

  it('the fragments of one datagram share one non-zero identification and the next datagram has another', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const ids = fragmentsIn(b.linuxSent).map((p) => headerOf(p).identification);
    expect(ids).toHaveLength(6);
    expect(new Set(ids.slice(0, 3)).size).toBe(1);
    expect(new Set(ids.slice(3)).size).toBe(1);
    expect(ids[0]).not.toBe(0);
    expect(ids[3]).not.toBe(ids[0]);
  });

  it('an identification is drawn only for a datagram that is fragmented', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 100);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const ids = fragmentsIn(b.linuxSent).map((p) => headerOf(p).identification);
    expect(ids).toHaveLength(6);
    expect(ids[3]).toBe(ids[0] + 1);
  });

  it('the first fragment carries the UDP header, the others only declare how many bytes they hold', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const [first, second, third] = fragmentsIn(b.linuxSent).map(headerOf);
    expect((first.payload as UDPPacket).type).toBe('udp');
    expect((first.payload as UDPPacket).destinationPort).toBe(UDP_PORT);
    expect(second.payload).toEqual({ type: 'ipv6-fragment-data', length: 1448 });
    expect(third.payload).toEqual({ type: 'ipv6-fragment-data', length: 104 });
  });

  it('a datagram of exactly the link MTU is not fragmented, one byte more is', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 1460 - 8);
    await settle();
    expect(fragmentsIn(b.linuxSent)).toHaveLength(0);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 1461 - 8);
    await settle();
    expect(fragmentsIn(b.linuxSent)).toHaveLength(2);
  });

  it('a smaller link MTU gives smaller fragments: 1280 leaves room for 1232 data bytes', async () => {
    const b = await bench();
    b.linux.getPort('eth0')!.setMTU(1280);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    expect(fragmentsIn(b.linuxSent).map((p) => headerOf(p).length)).toEqual([1232, 1232, 536]);
  });

  it('the sender counts ONE request for the datagram, one fragmented datagram and three fragments created', async () => {
    const b = await bench();
    const before = snapshot(b.linux);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const delta = growth(before, snapshot(b.linux));
    expect(delta('ip6OutRequests')).toBe(1);
    expect(delta('ip6OutOctets')).toBe(3040);
    expect(delta('udp6OutDatagrams')).toBe(1);
    expect(delta('ip6FragOKs')).toBe(1);
    expect(delta('ip6FragCreates')).toBe(3);
    expect(delta('ip6FragFails')).toBe(0);
  });

  it('a datagram that fits creates no fragment and moves no fragmentation counter', async () => {
    const b = await bench();
    const before = snapshot(b.linux);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 1000);
    await settle();
    const delta = growth(before, snapshot(b.linux));
    expect(delta('ip6FragOKs')).toBe(0);
    expect(delta('ip6FragCreates')).toBe(0);
    expect(delta('ip6OutRequests')).toBe(1);
  });

  it('a Windows host fragments like a Linux one, and its IPv6 block says so', async () => {
    const b = await bench();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    expect(fragmentsIn(b.windowsSent).map((p) => headerOf(p).length)).toEqual([1448, 1448, 104]);
    const block = await b.windows.executeCommand('netstat -s -p ipv6');
    expect(block).toMatch(/Datagrams Successfully Fragmented\s+= 1\b/);
    expect(block).toMatch(/Fragments Created\s+= 3\b/);
    expect(block).toMatch(/Datagrams Failing Fragmentation\s+= 0\b/);
  });
});

describe('the destination reassembles before it filters and delivers (RFC 8200 §4.5)', () => {
  it('three fragments make one datagram: one UDP delivery, three packets received, one reassembly', async () => {
    const b = await bench();
    const before = snapshot(b.windows);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(1);
    expect(delta('udp6InErrors')).toBe(0);
    expect(delta('udp6NoPorts')).toBe(0);
    expect(delta('ip6InReceives')).toBe(3);
    expect(delta('ip6InDelivers')).toBe(1);
    expect(delta('ip6ReasmReqds')).toBe(3);
    expect(delta('ip6ReasmOKs')).toBe(1);
    expect(delta('ip6ReasmFails')).toBe(0);
  });

  it('fragments that arrive in the reverse order still make the datagram', async () => {
    const b = await bench();
    const before = snapshot(b.windows);
    for (const fragment of fragmentsOf(3000).reverse()) inject(b.windows, b.linux, fragment);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(1);
    expect(delta('ip6ReasmOKs')).toBe(1);
  });

  it('a duplicated fragment is ignored: the datagram completes, nothing fails', async () => {
    const b = await bench();
    const [first, second, third] = fragmentsOf(3000);
    const before = snapshot(b.windows);
    for (const fragment of [first, second, second, third]) inject(b.windows, b.linux, fragment);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(1);
    expect(delta('ip6ReasmReqds')).toBe(4);
    expect(delta('ip6ReasmOKs')).toBe(1);
    expect(delta('ip6ReasmFails')).toBe(0);
  });

  it('without its last fragment the datagram waits: no delivery, no failure yet', async () => {
    const b = await bench();
    const before = snapshot(b.windows);
    for (const fragment of fragmentsOf(3000).slice(0, 2)) inject(b.windows, b.linux, fragment);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(0);
    expect(delta('ip6ReasmReqds')).toBe(2);
    expect(delta('ip6ReasmOKs')).toBe(0);
    expect(delta('ip6ReasmFails')).toBe(0);
  });

  it('two datagrams of one source reassemble independently, whatever the interleaving', async () => {
    const b = await bench();
    const first = fragmentsOf(3000, 100);
    const second = fragmentsOf(2500, 200);
    const before = snapshot(b.windows);
    for (const fragment of [first[0], second[0], first[1], second[1], second[2], first[2]]) {
      inject(b.windows, b.linux, fragment);
    }
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(2);
    expect(delta('ip6ReasmOKs')).toBe(2);
  });

  it('an atomic fragment (offset 0, no more fragments) is delivered and counted as one reassembly', async () => {
    const b = await bench();
    const whole = datagram(LINUX, WINDOWS, 600);
    const atomic: IPv6Packet = {
      ...whole,
      nextHeader: IP_PROTO_IPV6_FRAGMENT,
      payloadLength: 8 + 600,
      payload: {
        type: 'ipv6-fragment', nextHeader: IP_PROTO_UDP, fragmentOffset: 0, moreFragments: false,
        identification: 5, length: 600, payload: whole.payload,
      } satisfies IPv6FragmentHeader,
    };
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, atomic);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(1);
    expect(delta('ip6ReasmReqds')).toBe(1);
    expect(delta('ip6ReasmOKs')).toBe(1);
  });

  it('the Linux receiver reads the same facts in /proc/net/snmp6, the Windows sender in its IPv6 block', async () => {
    const b = await bench();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const snmp6 = await b.linux.executeCommand('cat /proc/net/snmp6');
    expect(snmp6).toMatch(/^Ip6ReasmReqds\s+3$/m);
    expect(snmp6).toMatch(/^Ip6ReasmOKs\s+1$/m);
    expect(snmp6).toMatch(/^Ip6ReasmFails\s+0$/m);
    expect(snmp6).toMatch(/^Ip6FragOKs\s+0$/m);
    const sender = await b.windows.executeCommand('netstat -s -p ipv6');
    expect(sender).toMatch(/Datagrams Successfully Fragmented\s+= 1\b/);
    const sent = await b.linux.executeCommand('cat /proc/net/snmp6');
    expect(sent).toMatch(/^Ip6InReceives\s+\d+$/m);
  });
});

describe('fragments that contradict each other kill the datagram (RFC 5722, Linux ip6_frag_queue)', () => {
  it('an overlapping fragment discards everything held for the datagram, even when the rest arrives', async () => {
    const b = await bench();
    const [first, second, third] = fragmentsOf(3000);
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, first);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 77, offsetBytes: 1000, length: 1448, more: true }));
    inject(b.windows, b.linux, second);
    inject(b.windows, b.linux, third);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(0);
    expect(delta('ip6ReasmFails')).toBe(1);
    expect(delta('ip6ReasmOKs')).toBe(0);
  });

  it('a final fragment that ends before data already held is a contradiction, at once', async () => {
    const b = await bench();
    const second = fragmentsOf(3000)[1];
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, second);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 77, offsetBytes: 8, length: 8, more: false }));
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('udp6InDatagrams')).toBe(0);
    expect(delta('ip6ReasmFails')).toBe(1);
  });

  it('a second, different final fragment is a contradiction', async () => {
    const b = await bench();
    const third = fragmentsOf(3000)[2];
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, third);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 77, offsetBytes: 1200, length: 8, more: false }));
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmFails')).toBe(1);
  });

  it('data beyond the end announced by the final fragment is a contradiction', async () => {
    const b = await bench();
    const third = fragmentsOf(3000)[2];
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, third);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 77, offsetBytes: 3008, length: 8, more: true }));
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmFails')).toBe(1);
  });

  it('a fragment that carries no data is discarded', async () => {
    const b = await bench();
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 91, offsetBytes: 0, length: 0, more: true }));
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('ip6ReasmReqds')).toBe(1);
    expect(delta('ip6ReasmFails')).toBe(1);
  });

  it('WITNESS: the same crafted fragments, without the contradiction, make the datagram', async () => {
    const b = await bench();
    const before = snapshot(b.windows);
    for (const fragment of fragmentsOf(3000)) inject(b.windows, b.linux, fragment);
    await settle();
    expect(growth(before, snapshot(b.windows))('udp6InDatagrams')).toBe(1);
  });
});

describe('a datagram that never completes expires after 60 s (RFC 8200 §4.5)', () => {
  it('59.999 s later nothing has happened, at 60 s the queue is dropped and counted as a timeout', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, fragmentsOf(3000)[0]);
    clock.advance(59_999);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(0);
    clock.advance(1);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('ip6ReasmTimeout')).toBe(1);
    expect(delta('ip6ReasmFails')).toBe(1);
  });

  it('with the first fragment held, the destination tells the source: Time Exceeded, code 1, quoting that fragment', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    quiet(b);
    inject(b.windows, b.linux, fragmentsOf(3000)[0]);
    clock.advance(60_000);
    await settle();
    const errors = icmp6Errors(b.windowsSent, 'time-exceeded');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(1);
    expect(errors[0].invokingPacket!.nextHeader).toBe(IP_PROTO_IPV6_FRAGMENT);
    expect(headerOf(errors[0].invokingPacket!).identification).toBe(77);
  });

  it('the error goes back to the source of the datagram, from the address it was sent to', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    quiet(b);
    inject(b.windows, b.linux, fragmentsOf(3000)[0]);
    clock.advance(60_000);
    await settle();
    const [packet] = b.windowsSent.map(ipv6Of).filter((p) => (p?.payload as ICMPv6Packet | undefined)?.icmpType === 'time-exceeded');
    expect(packet!.destinationIP.toString()).toBe('fd00::1');
    expect(packet!.sourceIP.toString()).toBe('fd00::7');
  });

  it('without the first fragment the queue expires in silence, but is still counted', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    quiet(b);
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, fragmentsOf(3000)[1]);
    clock.advance(60_000);
    await settle();
    expect(icmp6Errors(b.windowsSent, 'time-exceeded')).toHaveLength(0);
    const delta = growth(before, snapshot(b.windows));
    expect(delta('ip6ReasmTimeout')).toBe(1);
    expect(delta('ip6ReasmFails')).toBe(1);
  });

  it('a datagram that completed leaves no timer behind', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    quiet(b);
    const before = snapshot(b.windows);
    for (const fragment of fragmentsOf(3000)) inject(b.windows, b.linux, fragment);
    clock.advance(120_000);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('ip6ReasmOKs')).toBe(1);
    expect(delta('ip6ReasmTimeout')).toBe(0);
    expect(delta('ip6ReasmFails')).toBe(0);
    expect(icmp6Errors(b.windowsSent, 'time-exceeded')).toHaveLength(0);
  });

  it('the timer starts with the first fragment and is not pushed back by the next ones', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    const before = snapshot(b.windows);
    const [first, second] = fragmentsOf(3000);
    inject(b.windows, b.linux, first);
    clock.advance(40_000);
    inject(b.windows, b.linux, second);
    clock.advance(20_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(1);
  });

  it('a Linux host reads the delay in net.ipv6.ip6frag_time (60 by default)', async () => {
    const b = await bench();
    expect((await b.linux.executeCommand('sysctl -n net.ipv6.ip6frag_time')).trim()).toBe('60');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_time=5');
    const clock = withClock(b.linux);
    const before = snapshot(b.linux);
    inject(b.linux, b.windows, fragmentsFor(WINDOWS, LINUX, 3000, 88)[0]);
    clock.advance(4_999);
    await settle();
    expect(growth(before, snapshot(b.linux))('ip6ReasmTimeout')).toBe(0);
    clock.advance(1);
    await settle();
    expect(growth(before, snapshot(b.linux))('ip6ReasmTimeout')).toBe(1);
  });
});

describe('the memory held by fragments is bounded (net.ipv6.ip6frag_high_thresh)', () => {
  it('the defaults are the kernel\'s: 4 MiB high, 3 MiB low', async () => {
    const b = await bench();
    expect((await b.linux.executeCommand('sysctl -n net.ipv6.ip6frag_high_thresh')).trim()).toBe('4194304');
    expect((await b.linux.executeCommand('sysctl -n net.ipv6.ip6frag_low_thresh')).trim()).toBe('3145728');
  });

  it('above the threshold a new fragment is refused and counted as a reassembly failure', async () => {
    const b = await bench();
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_low_thresh=1000');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_high_thresh=2000');
    const before = snapshot(b.linux);
    for (const fragment of fragmentsFor(WINDOWS, LINUX, 3000, 88)) inject(b.linux, b.windows, fragment);
    await settle();
    const delta = growth(before, snapshot(b.linux));
    expect(delta('udp6InDatagrams')).toBe(0);
    expect(delta('ip6ReasmFails')).toBe(1);
    expect(delta('ip6ReasmReqds')).toBe(3);
  });

  it('a threshold of zero refuses every fragment', async () => {
    const b = await bench();
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_low_thresh=0');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_high_thresh=0');
    const before = snapshot(b.linux);
    for (const fragment of fragmentsFor(WINDOWS, LINUX, 3000, 88)) inject(b.linux, b.windows, fragment);
    await settle();
    const delta = growth(before, snapshot(b.linux));
    expect(delta('ip6ReasmFails')).toBe(3);
    expect(delta('udp6InDatagrams')).toBe(0);
  });

  it('the memory comes back when the datagram completes: the next one is accepted', async () => {
    const b = await bench();
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_low_thresh=1000');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_high_thresh=4000');
    const before = snapshot(b.linux);
    for (const fragment of fragmentsFor(WINDOWS, LINUX, 3000, 88)) inject(b.linux, b.windows, fragment);
    for (const fragment of fragmentsFor(WINDOWS, LINUX, 3000, 89)) inject(b.linux, b.windows, fragment);
    await settle();
    expect(growth(before, snapshot(b.linux))('udp6InDatagrams')).toBe(2);
  });

  it('the memory comes back when a queue expires', async () => {
    const b = await bench();
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_low_thresh=1000');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_high_thresh=2000');
    const clock = withClock(b.linux);
    const stuck = fragmentsFor(WINDOWS, LINUX, 3000, 88);
    inject(b.linux, b.windows, stuck[0]);
    inject(b.linux, b.windows, stuck[1]);
    clock.advance(60_000);
    await settle();
    const before = snapshot(b.linux);
    for (const fragment of fragmentsFor(WINDOWS, LINUX, 2000, 90)) inject(b.linux, b.windows, fragment);
    await settle();
    expect(growth(before, snapshot(b.linux))('udp6InDatagrams')).toBe(1);
  });

  it('the kernel refuses a high threshold under the low one, and a low threshold above the high one', async () => {
    const b = await bench();
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_high_thresh=1000');
    expect((await b.linux.executeCommand('sysctl -n net.ipv6.ip6frag_high_thresh')).trim()).toBe('4194304');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_low_thresh=9999999');
    expect((await b.linux.executeCommand('sysctl -n net.ipv6.ip6frag_low_thresh')).trim()).toBe('3145728');
    await b.linux.executeCommand('sudo sysctl -w net.ipv6.ip6frag_low_thresh=2000000');
    expect((await b.linux.executeCommand('sysctl -n net.ipv6.ip6frag_low_thresh')).trim()).toBe('2000000');
  });
});

describe('a fragment whose geometry is invalid is answered with Parameter Problem (RFC 8200 §4.5)', () => {
  it('a non-final fragment that does not end on an 8-byte boundary: code 0, pointer 4 (Payload Length)', async () => {
    const b = await bench();
    quiet(b);
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 61, offsetBytes: 0, length: 1001, more: true }));
    await settle();
    const [problem] = icmp6Errors(b.windowsSent, 'parameter-problem');
    expect(problem.code).toBe(0);
    expect(problem.pointer).toBe(4);
    expect(growth(before, snapshot(b.windows))('ip6InHdrErrors')).toBe(1);
  });

  it('a fragment that ends past 65535: code 0, pointer 42 (the Fragment Offset field)', async () => {
    const b = await bench();
    quiet(b);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 62, offsetBytes: 65520, length: 100, more: false }));
    await settle();
    const [problem] = icmp6Errors(b.windowsSent, 'parameter-problem');
    expect(problem.code).toBe(0);
    expect(problem.pointer).toBe(42);
  });

  it('the error is a counted ICMPv6 message of type 4 on the sender and the receiver', async () => {
    const b = await bench();
    const before = { windows: snapshot(b.windows), linux: snapshot(b.linux) };
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 63, offsetBytes: 0, length: 1001, more: true }));
    await settle();
    expect(b.windows.getProtocolCounters().icmp6OutTypes[4] - before.windows.icmp6OutTypes[4]).toBe(1);
    expect(b.linux.getProtocolCounters().icmp6InTypes[4] - before.linux.icmp6InTypes[4]).toBe(1);
  });

  it('WITNESS: a valid non-final fragment of the same size class raises no error', async () => {
    const b = await bench();
    quiet(b);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 64, offsetBytes: 0, length: 1008, more: true }));
    await settle();
    expect(icmp6Errors(b.windowsSent, 'parameter-problem')).toHaveLength(0);
  });
});

describe('the ECN field of the fragments decides the ECN field of the datagram (RFC 3168 §5.3, inet_fragment.c)', () => {
  const setup = () => new IPv6Reassembler({ highThresholdBytes: () => IPV6_REASSEMBLY_HIGH_THRESHOLD_BYTES });
  const withClass = (fragments: IPv6Packet[], classes: number[]): IPv6Packet[] =>
    fragments.map((fragment, index) => ({ ...fragment, trafficClass: classes[index] }));
  const feed = (classes: number[]) => {
    const reassembler = setup();
    const fragments = withClass(fragmentsOf(3000), classes);
    return fragments.map((fragment) => reassembler.add(fragment, 'eth0')).at(-1)!;
  };

  it('a fragment without ECN mixed with ECN-capable ones: the datagram is discarded', () => {
    expect(feed([0b00, 0b10, 0b10])).toMatchObject({ kind: 'discarded', reason: 'invalid-ecn' });
    expect(feed([0b10, 0b10, 0b00])).toMatchObject({ kind: 'discarded', reason: 'invalid-ecn' });
  });

  it('Congestion Experienced on one fragment and ECT on the others: the datagram is CE', () => {
    const outcome = feed([0b10, 0b11, 0b10]);
    expect(outcome.kind).toBe('complete');
    expect((outcome as { packet: IPv6Packet }).packet.trafficClass & 0b11).toBe(0b11);
  });

  it('CE keeps the DSCP of the head fragment', () => {
    const outcome = feed([0xb8 | 0b10, 0xb8 | 0b11, 0xb8 | 0b10]);
    expect((outcome as { packet: IPv6Packet }).packet.trafficClass).toBe(0xb8 | 0b11);
  });

  it('identical ECN codepoints change nothing', () => {
    const outcome = feed([0b10, 0b10, 0b10]);
    expect((outcome as { packet: IPv6Packet }).packet.trafficClass).toBe(0b10);
  });

  it('Not-ECT everywhere is not a contradiction', () => {
    expect(feed([0b00, 0b00, 0b00]).kind).toBe('complete');
  });
});

interface Routed {
  linux: LinuxPC;
  windows: WindowsPC;
  router: CiscoRouter;
  linuxSent: EthernetFrame[];
  linuxReceived: EthernetFrame[];
  windowsReceived: EthernetFrame[];
}

const RUN_TARGET = new IPv6Address('fd00:2::7');

async function routed(egressMtuCommands: string[] = ['ipv6 mtu 1400']): Promise<Routed> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 200, 0);
  const router = new CiscoRouter('R1', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('a').connect(linux.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(router.getPort('GigabitEthernet0/1')!, windows.getPort('eth0')!);
  for (const command of [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address fd00:1::1/64', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address fd00:2::1/64', ...egressMtuCommands, 'no shutdown', 'end',
  ]) await router.executeCommand(command);
  await linux.executeCommand('ip -6 addr add fd00:1::2/64 dev eth0');
  await linux.executeCommand('ip -6 route add default via fd00:1::1 dev eth0');
  await windows.executeCommand('netsh interface ipv6 add address "Ethernet0" fd00:2::7/64');
  await windows.executeCommand('netsh interface ipv6 add route ::/0 "Ethernet0" fd00:2::1');
  windows.udpListen(UDP_PORT, 'probe', {});
  await linux.executeCommand('ping -6 -c 1 fd00:2::7');
  const lab = {
    linux, windows, router,
    linuxSent: framesSentOn(linux, 'eth0'), linuxReceived: framesReceivedOn(linux, 'eth0'),
    windowsReceived: framesReceivedOn(windows, 'eth0'),
  };
  for (const frames of [lab.linuxSent, lab.linuxReceived, lab.windowsReceived]) frames.length = 0;
  return lab;
}

function sendRouted(lab: Routed, size: number): void {
  lab.linux.sendUdpDatagram6(RUN_TARGET, UDP_PORT, 40000, 'x', size - 8);
}

describe('a router never fragments IPv6: it answers Packet Too Big, and the source adapts (RFC 8200 §5, RFC 8201)', () => {
  it('WITNESS: a packet that fits the 1400 MTU of the egress crosses the router', async () => {
    const lab = await routed();
    const before = snapshot(lab.windows);
    sendRouted(lab, 1000);
    await settle();
    expect(growth(before, snapshot(lab.windows))('udp6InDatagrams')).toBe(1);
    expect(icmp6Errors(lab.linuxReceived, 'packet-too-big')).toHaveLength(0);
  });

  it('the first 3000-byte datagram is lost: each 1496-byte fragment draws a Packet Too Big announcing 1400', async () => {
    const lab = await routed();
    const before = snapshot(lab.windows);
    sendRouted(lab, 3000);
    await settle();
    const errors = icmp6Errors(lab.linuxReceived, 'packet-too-big');
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === 0 && e.mtu === 1400)).toBe(true);
    expect(growth(before, snapshot(lab.windows))('udp6InDatagrams')).toBe(0);
  });

  it('the error comes from the interface of the router that faces the sender and quotes the fragment that did not fit', async () => {
    const lab = await routed();
    sendRouted(lab, 3000);
    await settle();
    const [packet] = lab.linuxReceived.map(ipv6Of)
      .filter((p) => (p?.payload as ICMPv6Packet | undefined)?.icmpType === 'packet-too-big');
    expect(packet!.sourceIP.toString()).toBe('fd00:1::1');
    const quoted = (packet!.payload as ICMPv6Packet).invokingPacket!;
    expect(packet!.destinationIP.toString()).toBe(quoted.sourceIP.toString());
    expect(quoted.nextHeader).toBe(IP_PROTO_IPV6_FRAGMENT);
    expect(quoted.destinationIP.toString()).toBe('fd00:2::7');
  });

  it('the source remembers the path MTU: the next datagram leaves in fragments of 1352 bytes and arrives whole', async () => {
    const lab = await routed();
    sendRouted(lab, 3000);
    await settle();
    lab.linuxSent.length = 0;
    const before = snapshot(lab.windows);
    sendRouted(lab, 3000);
    await settle();
    expect(fragmentsIn(lab.linuxSent).map((p) => headerOf(p).length)).toEqual([1352, 1352, 296]);
    const delta = growth(before, snapshot(lab.windows));
    expect(delta('udp6InDatagrams')).toBe(1);
    expect(delta('ip6ReasmOKs')).toBe(1);
    expect(icmp6Errors(lab.linuxReceived, 'packet-too-big')).toHaveLength(2);
  });

  it('the router counts what it refused, and says so in show ipv6 traffic', async () => {
    const lab = await routed();
    sendRouted(lab, 3000);
    await settle();
    expect(lab.router.getIpv6Counters().outTooBig).toBe(2);
    expect(await lab.router.executeCommand('show ipv6 traffic')).toMatch(/2 too big/);
  });

  it('the router leaves a packet alone when the egress MTU is the default one', async () => {
    const lab = await routed([]);
    const before = snapshot(lab.windows);
    sendRouted(lab, 3000);
    await settle();
    expect(icmp6Errors(lab.linuxReceived, 'packet-too-big')).toHaveLength(0);
    expect(lab.router.getIpv6Counters().outTooBig).toBe(0);
    expect(growth(before, snapshot(lab.windows))('udp6InDatagrams')).toBe(1);
  });

  it('ipv6 mtu 1280 asks for the smallest fragments: 1232 data bytes', async () => {
    const lab = await routed(['ipv6 mtu 1280']);
    sendRouted(lab, 3000);
    await settle();
    lab.linuxSent.length = 0;
    sendRouted(lab, 3000);
    await settle();
    expect(fragmentsIn(lab.linuxSent).map((p) => headerOf(p).length)).toEqual([1232, 1232, 536]);
  });

  it('the IPv6 MTU of a port cannot exceed its link MTU and can be removed', async () => {
    const lab = await routed();
    const port = lab.router.getPort('GigabitEthernet0/1')!;
    expect(port.getIPv6MTU()).toBe(1400);
    port.setIPv6MTU(9000);
    expect(port.getIPv6MTU()).toBe(1500);
    await lab.router.executeCommand('configure terminal');
    await lab.router.executeCommand('interface GigabitEthernet0/1');
    await lab.router.executeCommand('no ipv6 mtu');
    expect(port.getIPv6MTU()).toBe(1500);
    expect(port.getIPv6MtuSetting()).toBeNull();
  });

  it('show running-config and the port agree about the IPv6 MTU', async () => {
    const lab = await routed();
    expect(await lab.router.executeCommand('show running-config')).toMatch(/ipv6 mtu 1400/);
    expect(lab.router.getPort('GigabitEthernet0/1')!.getIPv6MtuSetting()).toBe(1400);
  });
});

describe('the IPv6 MTU of an interface is one fact, read by the data plane and by every view', () => {
  it('show ipv6 interface prints the IPv6 MTU, not the link MTU', async () => {
    const lab = await routed();
    expect(await lab.router.executeCommand('show ipv6 interface GigabitEthernet0/1')).toMatch(/MTU is 1400 bytes/);
    expect(await lab.router.executeCommand('show ipv6 interface GigabitEthernet0/0')).toMatch(/MTU is 1500 bytes/);
  });

  it('a Huawei router evaluates ipv6 mtu the same way, and display ipv6 interface prints it', async () => {
    const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
    const windows = new WindowsPC('windows-pc', 'WIN', 200, 0);
    const router = new HuaweiRouter('R1', 100, 0);
    linux.powerOn();
    windows.powerOn();
    windows.setCurrentUser('Administrator');
    new Cable('a').connect(linux.getPort('eth0')!, router.getPort('GE0/0/0')!);
    new Cable('b').connect(router.getPort('GE0/0/1')!, windows.getPort('eth0')!);
    for (const command of [
      'system-view', 'ipv6',
      'interface GE0/0/0', 'ipv6 enable', 'ipv6 address fd00:1::1/64', 'quit',
      'interface GE0/0/1', 'ipv6 enable', 'ipv6 address fd00:2::1/64', 'ipv6 mtu 1400', 'quit', 'return',
    ]) await router.executeCommand(command);
    await linux.executeCommand('ip -6 addr add fd00:1::2/64 dev eth0');
    await linux.executeCommand('ip -6 route add default via fd00:1::1 dev eth0');
    await windows.executeCommand('netsh interface ipv6 add address "Ethernet0" fd00:2::7/64');
    await windows.executeCommand('netsh interface ipv6 add route ::/0 "Ethernet0" fd00:2::1');
    windows.udpListen(UDP_PORT, 'probe', {});
    await linux.executeCommand('ping -6 -c 1 fd00:2::7');
    const received = framesReceivedOn(linux, 'eth0');
    linux.sendUdpDatagram6(RUN_TARGET, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const errors = icmp6Errors(received, 'packet-too-big');
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.mtu === 1400)).toBe(true);
    expect(await router.executeCommand('display ipv6 interface GE0/0/1')).toMatch(/MTU is 1400 bytes/);
    expect(await router.executeCommand('display ipv6 interface GE0/0/0')).toMatch(/MTU is 1500 bytes/);
  });
});

describe('tcpdump dissects the Fragment header as the real tool does (print-frag6.c, print-udp.c)', () => {
  const lines = (text: string): string[] => text.split('\n').filter((l) => /IP6 /.test(l));

  it('the first fragment shows the identification, the offset, the data length and the UDP header', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 3 -nn -v -i eth0 ip6 and src fd00::7');
    await settle();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    const [first, second, third] = lines(await capture);
    expect(first).toMatch(/IP6 \(hlim 128, next-header Fragment \(44\) payload length: 1456\) fd00::7 > fd00::1: frag \(0x[0-9a-f]{8}:0\|1448\) 40000 > 9000: UDP, length 2992/);
    expect(second).toMatch(/frag \(0x[0-9a-f]{8}:1448\|1448\)$/);
    expect(third).toMatch(/payload length: 112\) fd00::7 > fd00::1: frag \(0x[0-9a-f]{8}:2896\|104\)$/);
  });

  it('without -v the identification disappears, as it does in tcpdump', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 2 -nn -i eth0 ip6 and src fd00::7');
    await settle();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    const [first, second] = lines(await capture);
    expect(first).toMatch(/IP6 fd00::7 > fd00::1: frag \(0\|1448\) 40000 > 9000: UDP, length 2992$/);
    expect(second).toMatch(/IP6 fd00::7 > fd00::1: frag \(1448\|1448\)$/);
  });

  it('an ICMPv6 echo request spread over fragments names its type on the first one only', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 2 -nn -i eth0 ip6 and src fd00::7');
    await settle();
    const echo = {
      type: 'icmpv6', icmpType: 'echo-request', code: 0, id: 4, sequence: 1, dataSize: 2992,
    } as ICMPv6Packet;
    const packet = createIPv6Packet(WINDOWS, LINUX, 58, 64, echo, 3000);
    for (const fragment of fragmentIPv6(packet, 1500, () => 5)) inject(b.linux, b.windows, fragment);
    const [first, second] = lines(await capture);
    expect(first).toMatch(/frag \(0\|1448\) ICMP6, echo request, id 4, seq 1, length 1448$/);
    expect(second).toMatch(/frag \(1448\|1448\)$/);
  });

  it('tcpdump udp does not match a fragment, as libpcap\'s ip6 proto test looks at the base header only', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 1 -nn -i eth0 udp');
    await settle();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 100);
    const output = await capture;
    expect(output).toMatch(/UDP, length 100/);
    expect(output).not.toMatch(/frag/);
  });

  it('tcpdump ip6 matches the fragments', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 3 -nn -i eth0 ip6 and src fd00::7');
    await settle();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    expect(lines(await capture)).toHaveLength(3);
  });

  it('a Packet Too Big shows the MTU it announces', async () => {
    const lab = await routed();
    const capture = lab.linux.executeCommand('sudo tcpdump -c 1 -nn -i eth0 icmp6');
    await settle();
    sendRouted(lab, 3000);
    expect(lines(await capture)[0]).toMatch(/fd00:1::1 > fd00:1::[0-9a-f:]+: ICMP6, packet too big, mtu 1400, length \d+$/);
  });

  it('a reassembly timeout shows as Time Exceeded (reassembly) and a bad fragment as Parameter Problem', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    const capture = b.linux.executeCommand('sudo tcpdump -c 2 -nn -i eth0 icmp6 and src fd00::7');
    await settle();
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 3, offsetBytes: 0, length: 1001, more: true }));
    inject(b.windows, b.linux, fragmentsOf(3000, 4)[0]);
    clock.advance(60_000);
    const [problem, expired] = lines(await capture);
    expect(problem).toMatch(/ICMP6, parameter problem, erroneous - octet 4, length \d+$/);
    expect(expired).toMatch(/ICMP6, time exceeded in-transit \(reassembly\), length \d+$/);
  });
});

describe('the reassembly queue follows the kernel\'s rules for what is a duplicate and what is an overlap (inet_frag_queue_insert)', () => {
  const setup = () => new IPv6Reassembler({ highThresholdBytes: () => IPV6_REASSEMBLY_HIGH_THRESHOLD_BYTES });
  const piece = (offsetBytes: number, length: number, more: boolean, identification = 5): IPv6Packet =>
    crafted(LINUX, WINDOWS, { identification, offsetBytes, length, more });

  it('a fragment contained in one already held is a duplicate and the queue survives', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    expect(queue.add(piece(8, 16, true), 'eth0')).toMatchObject({ kind: 'duplicate' });
    expect(queue.queuesHeld()).toBe(1);
  });

  it('a fragment spanning two fragments appended in order is contained in their run: a duplicate', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    queue.add(piece(1448, 1448, true), 'eth0');
    expect(queue.add(piece(1000, 1000, true), 'eth0')).toMatchObject({ kind: 'duplicate' });
  });

  it('the same span over two fragments that arrived out of order is an overlap, as in the kernel', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    queue.add(piece(4344, 56, false), 'eth0');
    queue.add(piece(1448, 1448, true), 'eth0');
    expect(queue.add(piece(1000, 1000, true), 'eth0')).toMatchObject({ kind: 'discarded', reason: 'overlap' });
    expect(queue.queuesHeld()).toBe(0);
  });

  it('a fragment that starts inside the last fragment and ends beyond it is an overlap', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    expect(queue.add(piece(1000, 1448, true), 'eth0')).toMatchObject({ kind: 'discarded', reason: 'overlap' });
  });

  it('a fragment that fills a hole between two held ones is accepted', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    queue.add(piece(2896, 104, false), 'eth0');
    expect(queue.add(piece(1448, 1448, true), 'eth0').kind).toBe('complete');
  });

  it('a hole bigger than the fragment that fills it leaves the queue incomplete', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    queue.add(piece(2896, 104, false), 'eth0');
    expect(queue.add(piece(1448, 800, true), 'eth0').kind).toBe('queued');
  });

  it('a second final fragment that ends further than the first one is a contradiction', () => {
    const queue = setup();
    queue.add(piece(2896, 104, false), 'eth0');
    expect(queue.add(piece(3000, 8, false), 'eth0')).toMatchObject({ kind: 'discarded', reason: 'inconsistent-end' });
  });

  it('the last byte of a datagram is 65535: a fragment ending there is queued, one ending at 65536 is malformed', () => {
    const queue = setup();
    expect(queue.add(piece(65520, 15, false), 'eth0').kind).toBe('queued');
    expect(setup().add(piece(65528, 8, false), 'eth0')).toMatchObject({ kind: 'malformed', pointer: 42 });
  });

  it('a datagram to a link-local or multicast destination is keyed by its interface, a global one is not', () => {
    const link = (iface: string) => {
      const queue = setup();
      const local = new IPv6Address('fe80::7');
      const first = crafted(LINUX, local, { identification: 9, offsetBytes: 0, length: 1448, more: true });
      const second = crafted(LINUX, local, { identification: 9, offsetBytes: 1448, length: 8, more: false });
      queue.add(first, 'eth0');
      return queue.add(second, iface).kind;
    };
    expect(link('eth0')).toBe('complete');
    expect(link('eth1')).toBe('queued');
    const global = setup();
    global.add(crafted(LINUX, WINDOWS, { identification: 9, offsetBytes: 0, length: 1448, more: true }), 'eth0');
    expect(global.add(crafted(LINUX, WINDOWS, { identification: 9, offsetBytes: 1448, length: 8, more: false }), 'eth1').kind)
      .toBe('complete');
  });

  it('the memory it holds is the wire size of the fragments, and is given back when a datagram completes', () => {
    const queue = setup();
    queue.add(piece(0, 1448, true), 'eth0');
    expect(queue.bytesHeld()).toBe(40 + 8 + 1448);
    queue.add(piece(1448, 8, false), 'eth0');
    expect(queue.bytesHeld()).toBe(0);
  });
});

describe('what the host does with its own packets and with its own timers', () => {
  it('a TCP segment is never given a Fragment header by the host', async () => {
    const b = await bench();
    const segment = createIPv6Packet(LINUX, WINDOWS, IP_PROTO_TCP, 64, {
      type: 'tcp', sourcePort: 50000, destinationPort: 9, sequence: 1, acknowledgement: 0, dataOffset: 5,
      flags: { ...noFlags(), ack: true }, window: 1000, checksum: 0, urgentPointer: 0, options: [], payload: 'x',
    } satisfies TcpSegment, 2000);
    b.linux.sendFrame('eth0', {
      srcMAC: b.linux.getPort('eth0')!.getMAC(), dstMAC: b.windows.getPort('eth0')!.getMAC(),
      etherType: ETHERTYPE_IPV6, payload: segment,
    });
    expect(fragmentsIn(b.linuxSent)).toHaveLength(0);
  });

  it('a packet that already carries a Fragment header is not fragmented again', async () => {
    const b = await bench();
    const [first] = fragmentsOf(3000);
    b.linux.getPort('eth0')!.setMTU(1280);
    const before = snapshot(b.linux);
    b.linux.sendFrame('eth0', {
      srcMAC: b.linux.getPort('eth0')!.getMAC(), dstMAC: b.windows.getPort('eth0')!.getMAC(),
      etherType: ETHERTYPE_IPV6, payload: first,
    });
    expect(fragmentsIn(b.linuxSent)).toHaveLength(1);
    expect(growth(before, snapshot(b.linux))('ip6FragOKs')).toBe(0);
  });

  it('the fragment size follows the IPv6 MTU of the port: 1400 gives 1352 data bytes', async () => {
    const b = await bench();
    b.linux.getPort('eth0')!.setIPv6MTU(1400);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    expect(fragmentsIn(b.linuxSent).map((p) => headerOf(p).length)).toEqual([1352, 1352, 296]);
  });

  it('the timer of a finished datagram does not expire a later one that reuses the identification', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    const before = snapshot(b.windows);
    for (const fragment of fragmentsOf(3000)) inject(b.windows, b.linux, fragment);
    clock.advance(30_000);
    inject(b.windows, b.linux, fragmentsOf(3000)[0]);
    clock.advance(31_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(0);
    clock.advance(30_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(1);
  });

  it('the timer of a datagram killed by a contradiction does not expire a later one that reuses the identification', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    const before = snapshot(b.windows);
    const [first, second] = fragmentsOf(3000);
    inject(b.windows, b.linux, first);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 77, offsetBytes: 1000, length: 1448, more: true }));
    clock.advance(30_000);
    inject(b.windows, b.linux, second);
    clock.advance(31_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(0);
    clock.advance(30_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(1);
  });

  it('a malformed fragment still opens a queue, which expires and is counted like any other', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    quiet(b);
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 66, offsetBytes: 0, length: 1001, more: true }));
    clock.advance(60_000);
    await settle();
    const delta = growth(before, snapshot(b.windows));
    expect(delta('ip6ReasmTimeout')).toBe(1);
    expect(delta('ip6ReasmFails')).toBe(1);
    expect(icmp6Errors(b.windowsSent, 'time-exceeded')).toHaveLength(0);
  });

  it('a host that was switched off forgets the datagrams it was assembling', async () => {
    const b = await bench();
    const [first, second, third] = fragmentsOf(3000);
    const before = snapshot(b.windows);
    inject(b.windows, b.linux, first);
    inject(b.windows, b.linux, second);
    b.windows.powerOff();
    b.windows.powerOn();
    inject(b.windows, b.linux, third);
    await settle();
    expect(growth(before, snapshot(b.windows))('udp6InDatagrams')).toBe(0);
  });
});

describe('the timers of a host that was switched off', () => {
  it('do not expire a datagram that the host assembles after it was switched on again', async () => {
    const b = await bench();
    const clock = withClock(b.windows);
    const [first, second] = fragmentsOf(3000);
    inject(b.windows, b.linux, first);
    b.windows.powerOff();
    b.windows.powerOn();
    const before = snapshot(b.windows);
    clock.advance(30_000);
    inject(b.windows, b.linux, second);
    clock.advance(31_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(0);
    clock.advance(30_000);
    await settle();
    expect(growth(before, snapshot(b.windows))('ip6ReasmTimeout')).toBe(1);
  });
});

describe('the other views of the same facts', () => {
  it('the receiver\'s Windows block counts what it required, completed and lost', async () => {
    const b = await bench();
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    const [first, second] = fragmentsOf(3000, 301);
    inject(b.windows, b.linux, first);
    inject(b.windows, b.linux, crafted(LINUX, WINDOWS, { identification: 301, offsetBytes: 1000, length: 1448, more: true }));
    inject(b.windows, b.linux, second);
    await settle();
    const block = await b.windows.executeCommand('netstat -s -p ipv6');
    expect(block).toMatch(/Reassembly Required\s+= 6\b/);
    expect(block).toMatch(/Reassembly Successful\s+= 1\b/);
    expect(block).toMatch(/Reassembly Failures\s+= 1\b/);
  });

  it('Linux /proc/net/snmp6 carries every fragmentation and reassembly column', async () => {
    const b = await bench();
    const clock = withClock(b.linux);
    b.linux.sendUdpDatagram6(WINDOWS, UDP_PORT, 40000, 'x', 3000 - 8);
    await settle();
    inject(b.linux, b.windows, fragmentsFor(WINDOWS, LINUX, 3000, 400)[0]);
    clock.advance(60_000);
    await settle();
    const snmp6 = await b.linux.executeCommand('cat /proc/net/snmp6');
    expect(snmp6).toMatch(/^Ip6ReasmTimeout\s+1$/m);
    expect(snmp6).toMatch(/^Ip6ReasmFails\s+1$/m);
    expect(snmp6).toMatch(/^Ip6FragOKs\s+1$/m);
    expect(snmp6).toMatch(/^Ip6FragCreates\s+3$/m);
    expect(snmp6).toMatch(/^Ip6FragFails\s+0$/m);
  });
});

describe('the router decides on the exact size, and never trusts an interface MTU below the IPv6 minimum', () => {
  it('a packet of exactly the egress MTU crosses, one byte more draws a Packet Too Big', async () => {
    const lab = await routed();
    const before = snapshot(lab.windows);
    lab.linux.sendUdpDatagram6(RUN_TARGET, UDP_PORT, 40000, 'x', 1400 - 40 - 8);
    await settle();
    expect(growth(before, snapshot(lab.windows))('udp6InDatagrams')).toBe(1);
    expect(icmp6Errors(lab.linuxReceived, 'packet-too-big')).toHaveLength(0);
    lab.linux.sendUdpDatagram6(RUN_TARGET, UDP_PORT, 40000, 'x', 1401 - 40 - 8);
    await settle();
    expect(icmp6Errors(lab.linuxReceived, 'packet-too-big')).toHaveLength(1);
  });

  it('a link MTU under 1280 is announced as 1280, the IPv6 minimum', async () => {
    const lab = await routed([]);
    lab.router.getPort('GigabitEthernet0/1')!.setMTU(1000);
    sendRouted(lab, 1500);
    await settle();
    const [error] = icmp6Errors(lab.linuxReceived, 'packet-too-big');
    expect(error.mtu).toBe(1280);
  });

  it('only an interface that was given an IPv6 MTU shows one in the running configuration', async () => {
    const lab = await routed();
    const config = await lab.router.executeCommand('show running-config');
    expect(config.match(/ipv6 mtu/g)).toHaveLength(1);
    expect(config).not.toMatch(/ipv6 mtu null/);
  });
});

describe('tcpdump words the ICMPv6 errors that fragmentation and routing produce (print-icmp6.c)', () => {
  const lines = (text: string): string[] => text.split('\n').filter((l) => /IP6 /.test(l));

  it('a datagram to a closed UDP port draws "unreachable port" naming the quoted destination and port', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 1 -nn -i eth0 icmp6');
    await settle();
    b.linux.sendUdpDatagram6(WINDOWS, 40123, 40000, 'x', 10);
    expect(lines(await capture)[0]).toMatch(/fd00::7 > fd00::1: ICMP6, destination unreachable, unreachable port, fd00::7 udp port 40123, length \d+$/);
  });

  it('a hop limit that expires in a router draws "time exceeded in-transit for" the destination', async () => {
    const lab = await routed();
    const capture = lab.linux.executeCommand('sudo tcpdump -c 1 -nn -i eth0 icmp6');
    await settle();
    lab.linux.sendUdpDatagram6(RUN_TARGET, UDP_PORT, 40000, 'x', 10, { hopLimit: 1 });
    expect(lines(await capture)[0]).toMatch(/ICMP6, time exceeded in-transit for fd00:2::7, length \d+$/);
  });

  it('the Fragment header is in the hex dump: next header 0x2c in the base header, the fragment header after it', async () => {
    const b = await bench();
    const capture = b.linux.executeCommand('sudo tcpdump -c 1 -nn -x -i eth0 ip6 and src fd00::7');
    await settle();
    b.windows.sendUdpDatagram6(LINUX, UDP_PORT, 40000, 'x', 3000 - 8);
    const dump = (await capture).replace(/\s+/g, ' ');
    expect(dump).toMatch(/0x0000: 6[0-9a-f]{3} [0-9a-f]{4} 05b0 2c80/);
    expect(dump).toMatch(/1100 0001 [0-9a-f]{4} [0-9a-f]{4}/);
  });
});
