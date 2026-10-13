/**
 * Une machine compte ce qu'elle voit passer en IPv6, comme elle compte l'IPv4 : `Ip6InReceives`, `Ip6OutRequests`, les
 * octets, le multicast, l'ECN, les messages ICMPv6 PAR TYPE, `Udp6*`, `UdpLite6*` et le TCP de chaque famille.
 *
 * Mesure de depart (a7e9f551f, un LinuxPC et un WindowsPC relies par `fd00::/64`, `ping -6 -c 3` puis `ping -c 2`) :
 * `netstat -s` de Linux voyait 5 paquets recus -- les deux echos IPv4 et trois datagrammes UDP multicast de fond --, rien
 * des trois echos IPv6, des sollicitations de voisin ni de leurs annonces ; Windows ne decrivait que les quatre blocs
 * IPv4 ; `/proc/net/snmp6` n'existait pas. Le trafic IPv6 etait invisible, et le TCP IPv6 s'ajoutait aux compteurs
 * IPv4 de Windows (un seul jeu de compteurs `tcp*` pour les deux familles). Autre mesure : `ping -c 1 127.0.0.1`
 * laisse tout a zero (la machine fabrique le resultat sans paquet : tache a part) et un datagramme UDP vers
 * `127.0.0.1:9999` sans ecouteur laisse `Ip: InReceives` et `OutRequests` a zero alors que `Icmp: InMsgs` et
 * `Udp: NoPorts` valent un.
 *
 * Autorites : `net/ipv6/ip6_input.c` du noyau 5.15 (`ip6_rcv_core` : InReceives et InOctets d'abord, puis les erreurs
 * d'en-tete -- adresse de bouclage hors `lo`, portee 0 ou 1 d'un groupe, source multicast --, `ip6_protocol_deliver_rcu` :
 * InDelivers, InUnknownProtos), `net/ipv6/proc.c` (la liste des compteurs de `/proc/net/snmp6`), RFC 4291 §2.5.3 et §2.7,
 * RFC 4293 (IP-MIB), RFC 4443. Un paquet filtre par netfilter n'est PAS un `InDiscards` : le noyau ne le compte nulle part
 * dans la MIB ; l'ancien code IPv4 le comptait et ne le fait plus. Un datagramme UDP multicast ou diffuse sans ecouteur
 * est un `IgnoredMulti` (`__udp4_lib_mcast_deliver`), pas un `NoPorts`.
 *
 * Ce qui est construit : les compteurs `ip6*`, `icmp6*` (par type), `udp6*`, `udpLite6*` et `tcp6*` de `ProtocolCounters`,
 * le compte a la sortie unique de trame (`EndHost.sendFrame`) et a l'entree unique (`handleIPv6`), `ipv6HeaderProblem`
 * dans `layers/internet`, le `TcpMibSink` qui recoit la famille, les etapes de bouclage des paquets reels (UDP, TCP,
 * erreurs ICMP vers soi).
 *
 * Discrimination : 37 cas contre b5568dec5 (avant tout compteur IPv6) : 34 tombent. 3 passent des deux cotes : les deux
 * temoins du banc (le ping IPv6 et IPv4 aboutit, une trame IPv6 traverse le cable dans les deux sens -- ils prouvent que
 * le banc est sain) et la non-regression « une connexion IPv4 deplace les compteurs TCP IPv4 et aucun compteur IPv6 »
 * (les compteurs IPv4 comptaient deja ; l'absence de mouvement IPv6 est vraie par vacuite avant, par construction apres).
 * Mutation : 45 mutants (comptes a l'entree et a la sortie, octets, multicast, ECN, ICMPv6 par type, UDP et TCP par
 * famille, regles d'en-tete, bouclage des paquets reels, netfilter qui n'est pas un rejet de la MIB), 45 tues.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPv6Address, IPAddress, createIPv6Packet, ETHERTYPE_IPV6, ETHERTYPE_IPV4 } from '@/network/core/types';
import type { EthernetFrame, IPv6Packet, ICMPv6Packet } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import type { ProtocolCounters } from '@/network/layers/internet/ProtocolCounters';
import { ipv6PacketBytes } from '@/network/layers/internet/Ipv6Ingress';
import { framesSentOn, framesReceivedOn } from '../../support/wireWatch';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const ECHO_REQUEST = 128;
const ECHO_REPLY = 129;
const NEIGHBOR_SOLICITATION = 135;
const NEIGHBOR_ADVERTISEMENT = 136;
const DEST_UNREACHABLE = 1;

type Snapshot = ProtocolCounters;

const snapshot = (host: LinuxPC | WindowsPC): Snapshot => {
  const c = host.getProtocolCounters();
  return { ...c, icmp6InTypes: [...c.icmp6InTypes], icmp6OutTypes: [...c.icmp6OutTypes] };
};

type Delta = { [K in keyof ProtocolCounters]: ProtocolCounters[K] extends number ? number : number[] };

const difference = (before: Snapshot, after: Snapshot): Delta => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof ProtocolCounters)[]) {
    const now = after[key];
    const then = before[key];
    out[key] = Array.isArray(now)
      ? now.map((value, index) => value - (then as number[])[index])
      : (now as number) - (then as number);
  }
  return out as Delta;
};

const ipv6Of = (frame: EthernetFrame): IPv6Packet | null =>
  frame.etherType === ETHERTYPE_IPV6 ? (frame.payload as IPv6Packet) : null;

const icmp6Of = (frame: EthernetFrame): ICMPv6Packet | null => {
  const packet = ipv6Of(frame);
  const payload = packet?.payload as ICMPv6Packet | undefined;
  return payload?.type === 'icmpv6' ? payload : null;
};

const TYPE_NUMBER: Record<string, number> = {
  'echo-request': 128, 'echo-reply': 129, 'neighbor-solicitation': 135, 'neighbor-advertisement': 136,
  'router-solicitation': 133, 'router-advertisement': 134, 'destination-unreachable': 1,
  'packet-too-big': 2, 'time-exceeded': 3,
};

const ofType = (frames: readonly EthernetFrame[], type: number): number =>
  frames.filter((frame) => {
    const icmp = icmp6Of(frame);
    return icmp !== null && TYPE_NUMBER[icmp.icmpType] === type;
  }).length;

const ipv6Frames = (frames: readonly EthernetFrame[]): IPv6Packet[] =>
  frames.map(ipv6Of).filter((packet): packet is IPv6Packet => packet !== null);

const ipv4Frames = (frames: readonly EthernetFrame[]): EthernetFrame[] =>
  frames.filter((frame) => frame.etherType === ETHERTYPE_IPV4);

interface Bench {
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
  readonly linuxSent: EthernetFrame[];
  readonly linuxReceived: EthernetFrame[];
  readonly windowsSent: EthernetFrame[];
  readonly windowsReceived: EthernetFrame[];
  measure(action: () => Promise<unknown>): Promise<{ linux: Delta; windows: Delta }>;
}

async function bench(): Promise<Bench> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await linux.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  await windows.executeCommand('netsh interface ipv6 add address "Ethernet0" fd00::7/64');
  const linuxSent = framesSentOn(linux, 'eth0');
  const linuxReceived = framesReceivedOn(linux, 'eth0');
  const windowsSent = framesSentOn(windows, 'eth0');
  const windowsReceived = framesReceivedOn(windows, 'eth0');
  return {
    linux, windows, linuxSent, linuxReceived, windowsSent, windowsReceived,
    measure: async (action) => {
      for (const frames of [linuxSent, linuxReceived, windowsSent, windowsReceived]) frames.length = 0;
      const before = { linux: snapshot(linux), windows: snapshot(windows) };
      await action();
      await settle();
      return {
        linux: difference(before.linux, snapshot(linux)),
        windows: difference(before.windows, snapshot(windows)),
      };
    },
  };
}

describe('the bench is sound (witness)', () => {
  it('Linux pings Windows over IPv6 and over IPv4', async () => {
    const { linux } = await bench();
    expect(await linux.executeCommand('ping -6 -c 2 fd00::7')).toContain('2 received');
    expect(await linux.executeCommand('ping -c 2 10.0.0.7')).toContain('2 received');
  });

  it('an IPv6 frame crosses the cable in both directions', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    expect(ipv6Frames(b.linuxSent).length).toBeGreaterThan(0);
    expect(ipv6Frames(b.windowsSent).length).toBeGreaterThan(0);
  });
});

describe('ICMPv6 is counted by type, as many as the cable carried', () => {
  it('three echo requests: the sender counts 3 requests out and 3 replies in, the target the opposite', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 3 fd00::7'));
    expect(ofType(b.linuxSent, ECHO_REQUEST)).toBe(3);
    expect(d.linux.icmp6OutTypes[ECHO_REQUEST]).toBe(3);
    expect(d.linux.icmp6InTypes[ECHO_REPLY]).toBe(3);
    expect(d.windows.icmp6InTypes[ECHO_REQUEST]).toBe(3);
    expect(d.windows.icmp6OutTypes[ECHO_REPLY]).toBe(3);
  });

  it('the neighbour solicitations and advertisements that resolve the peer are counted too', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const solicited = ofType(b.linuxSent, NEIGHBOR_SOLICITATION);
    expect(solicited).toBeGreaterThan(0);
    expect(d.linux.icmp6OutTypes[NEIGHBOR_SOLICITATION]).toBe(solicited);
    expect(d.windows.icmp6InTypes[NEIGHBOR_SOLICITATION]).toBe(solicited);
    expect(d.windows.icmp6OutTypes[NEIGHBOR_ADVERTISEMENT]).toBe(ofType(b.windowsSent, NEIGHBOR_ADVERTISEMENT));
    expect(d.linux.icmp6InTypes[NEIGHBOR_ADVERTISEMENT]).toBe(ofType(b.linuxReceived, NEIGHBOR_ADVERTISEMENT));
  });

  it('the message total is the sum of the types, on both machines, in both directions', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 2 fd00::7'));
    for (const side of [d.linux, d.windows]) {
      expect(side.icmp6OutMsgs).toBe(side.icmp6OutTypes.reduce((sum, n) => sum + n, 0));
      expect(side.icmp6InMsgs).toBe(side.icmp6InTypes.reduce((sum, n) => sum + n, 0));
      expect(side.icmp6OutMsgs).toBeGreaterThan(0);
    }
  });

  it('a datagram to a closed UDP port is answered "destination unreachable", counted on both ends', async () => {
    const b = await bench();
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram6(new IPv6Address('fd00::7'), 40123, 40000, 'x', 1);
    });
    expect(d.windows.icmp6OutTypes[DEST_UNREACHABLE]).toBe(1);
    expect(d.linux.icmp6InTypes[DEST_UNREACHABLE]).toBe(1);
  });
});

describe('the IPv6 layer counts packets and octets, as many as the cable carried', () => {
  it('Ip6OutRequests equals the IPv6 frames each side put on the cable; Ip6InReceives the unicast ones plus the groups it joined', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 3 fd00::7'));
    const unicast = (frames: readonly EthernetFrame[]) =>
      ipv6Frames(frames).filter((packet) => !packet.destinationIP.isMulticast()).length;
    const toGroups = (frames: readonly EthernetFrame[]) =>
      ipv6Frames(frames).filter((packet) => packet.destinationIP.isMulticast()).length;
    expect(d.linux.ip6OutRequests).toBe(ipv6Frames(b.linuxSent).length);
    expect(d.windows.ip6OutRequests).toBe(ipv6Frames(b.windowsSent).length);
    for (const [side, received] of [[d.linux, b.linuxReceived], [d.windows, b.windowsReceived]] as const) {
      expect(side.ip6InReceives).toBe(unicast(received) + side.ip6InMcastPkts);
      expect(side.ip6InMcastPkts).toBeLessThanOrEqual(toGroups(received));
      expect(unicast(received)).toBeGreaterThan(0);
    }
  });

  it('the octets are the header plus the payload of each packet', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 3 fd00::7'));
    const bytes = (frames: readonly EthernetFrame[]) =>
      ipv6Frames(frames).reduce((sum, packet) => sum + ipv6PacketBytes(packet), 0);
    expect(d.linux.ip6OutOctets).toBe(bytes(b.linuxSent));
    expect(d.windows.ip6InOctets).toBe(bytes(b.windowsReceived));
    expect(d.linux.ip6OutOctets).toBeGreaterThan(0);
  });

  it('multicast packets are counted apart: the neighbour solicitation goes to the solicited-node group', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const toGroups = ipv6Frames(b.linuxSent).filter((packet) => packet.destinationIP.isMulticast());
    expect(toGroups.length).toBeGreaterThan(0);
    expect(d.linux.ip6OutMcastPkts).toBe(toGroups.length);
    expect(d.linux.ip6OutMcastOctets).toBe(toGroups.reduce((sum, packet) => sum + ipv6PacketBytes(packet), 0));
    expect(d.windows.ip6InMcastPkts).toBe(toGroups.length);
    expect(d.windows.ip6InMcastOctets).toBe(d.linux.ip6OutMcastOctets);
  });

  it('a datagram with no route to its destination is an output no-route, and nothing leaves the machine', async () => {
    const b = await bench();
    let sent = true;
    const d = await b.measure(async () => {
      sent = b.linux.sendUdpDatagram6(new IPv6Address('2001:db8:9::1'), 40123, 40000, 'x', 1);
    });
    expect(sent).toBe(false);
    expect(d.linux.ip6OutNoRoutes).toBe(1);
    expect(ipv6Frames(b.linuxSent).some((packet) => packet.destinationIP.toString() === '2001:db8:9::1')).toBe(false);
  });

  it('every packet that reaches the upper layer is delivered: InDelivers equals InReceives on a clean cable', async () => {
    const b = await bench();
    const d = await b.measure(() => b.linux.executeCommand('ping -6 -c 3 fd00::7'));
    expect(d.windows.ip6InDelivers).toBe(d.windows.ip6InReceives);
    expect(d.linux.ip6InDelivers).toBe(d.linux.ip6InReceives);
    expect(d.windows.ip6InReceives).toBeGreaterThan(0);
  });

  it('the two families keep their own books: an IPv6 ping moves no IPv4 ICMP counter, an IPv4 ping no ICMPv6 one', async () => {
    const b = await bench();
    const six = await b.measure(() => b.linux.executeCommand('ping -6 -c 2 fd00::7'));
    expect(six.linux.ipOutRequests).toBe(ipv4Frames(b.linuxSent).length);
    expect(six.linux.icmpOutMsgs).toBe(0);
    expect(six.windows.icmpInMsgs).toBe(0);
    const four = await b.measure(() => b.linux.executeCommand('ping -c 2 10.0.0.7'));
    expect(four.linux.ip6OutRequests).toBe(ipv6Frames(b.linuxSent).length);
    expect(four.windows.icmp6InTypes[ECHO_REQUEST]).toBe(0);
    expect(four.windows.icmpInEchos).toBe(2);
  });

  it('the Explicit Congestion Notification bits of the traffic class are counted per codepoint', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => {
      for (const trafficClass of [0, 1, 2, 2, 3]) {
        b.linux.sendUdpDatagram6(new IPv6Address('fd00::7'), 40123, 40000, 'x', 1, { trafficClass });
      }
    });
    expect(d.windows.ip6InNoECTPkts).toBe(1);
    expect(d.windows.ip6InECT1Pkts).toBe(1);
    expect(d.windows.ip6InECT0Pkts).toBe(2);
    expect(d.windows.ip6InCEPkts).toBe(1);
  });
});

describe('UDP over IPv6', () => {
  it('a datagram to a served port: Udp6OutDatagrams on the sender, Udp6InDatagrams on the target, nothing in the IPv4 books', async () => {
    const b = await bench();
    const seen: string[] = [];
    b.windows.udpBind(40200, ({ udp }) => { seen.push(String(udp.payload)); });
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram6(new IPv6Address('fd00::7'), 40200, 40000, 'hello', 5);
    });
    expect(seen).toEqual(['hello']);
    expect(d.linux.udp6OutDatagrams).toBe(1);
    expect(d.windows.udp6InDatagrams).toBe(1);
    expect(d.linux.udpOutDatagrams).toBe(0);
    expect(d.windows.udpInDatagrams).toBe(0);
  });

  it('a datagram to a port nobody serves is a "no port" on the target, which answers once', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram6(new IPv6Address('fd00::7'), 40123, 40000, 'x', 1);
    });
    expect(d.windows.udp6NoPorts).toBe(1);
    expect(d.windows.udp6InDatagrams).toBe(0);
    expect(ofType(b.windowsSent, DEST_UNREACHABLE)).toBe(1);
  });

  it('a datagram with a wrong checksum is a receive error and a checksum error, never a delivery', async () => {
    const b = await bench();
    b.windows.udpBind(40200, () => undefined);
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => {
      const udp = { type: 'udp' as const, sourcePort: 40000, destinationPort: 40200, length: 9, checksum: 1, payload: 'x' };
      const packet = createIPv6Packet(
        new IPv6Address('fd00::1'), new IPv6Address('fd00::7'), 17, 64, udp, 9);
      b.windows.getPort('eth0')!.receiveFrame({
        srcMAC: b.linux.getPort('eth0')!.getMAC(), dstMAC: b.windows.getPort('eth0')!.getMAC(),
        etherType: ETHERTYPE_IPV6, payload: packet,
      });
    });
    expect(d.windows.udp6InErrors).toBe(1);
    expect(d.windows.udp6InCsumErrors).toBe(1);
    expect(d.windows.udp6InDatagrams).toBe(0);
  });

  it('a multicast datagram nobody listens for is ignored, not a "no port", and never answered (IPv6)', async () => {
    const b = await bench();
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram6(new IPv6Address('ff02::1'), 40123, 40000, 'x', 1);
    });
    expect(d.windows.udp6IgnoredMulti).toBe(1);
    expect(d.windows.udp6NoPorts).toBe(0);
    expect(ofType(b.windowsSent, DEST_UNREACHABLE)).toBe(0);
  });

  it('a multicast datagram nobody listens for is ignored, not a "no port" (IPv4)', async () => {
    const b = await bench();
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram(new IPAddress('224.0.0.1'), 40123, 40000, 'x', 1);
    });
    expect(d.windows.udpIgnoredMulti).toBe(1);
    expect(d.windows.udpNoPorts).toBe(0);
  });
});

describe('TCP keeps one set of counters per family', () => {
  const connect6 = async (b: Bench, port: number): Promise<boolean> => {
    let opened = false;
    const socket = b.linux.getTcpStack().connect('fd00::7', port, { onOpen: () => { opened = true; } })!;
    await settle();
    if (opened) socket.close();
    await settle();
    return opened;
  };

  it('a connection over IPv6 moves the IPv6 TCP counters on both ends and no IPv4 one', async () => {
    const b = await bench();
    let opened = false;
    const d = await b.measure(async () => { opened = await connect6(b, 22); });
    expect(opened).toBe(true);
    expect(d.linux.tcp6ActiveOpens).toBe(1);
    expect(d.windows.tcp6PassiveOpens).toBe(1);
    expect(d.linux.tcp6OutSegs).toBeGreaterThan(0);
    expect(d.windows.tcp6InSegs).toBeGreaterThan(0);
    for (const side of [d.linux, d.windows]) {
      expect(side.tcpActiveOpens).toBe(0);
      expect(side.tcpPassiveOpens).toBe(0);
      expect(side.tcpInSegs).toBe(0);
      expect(side.tcpOutSegs).toBe(0);
    }
  });

  it('a connection over IPv4 moves the IPv4 TCP counters and no IPv6 one', async () => {
    const b = await bench();
    const d = await b.measure(async () => {
      let opened = false;
      const socket = b.linux.getTcpStack().connect('10.0.0.7', 22, { onOpen: () => { opened = true; } })!;
      await settle();
      if (opened) socket.close();
    });
    expect(d.linux.tcpActiveOpens).toBe(1);
    expect(d.windows.tcpPassiveOpens).toBe(1);
    expect(d.linux.tcp6ActiveOpens).toBe(0);
    expect(d.windows.tcp6PassiveOpens).toBe(0);
    expect(d.windows.tcp6InSegs).toBe(0);
  });

  it('the established connections are counted per family, and leave when the connection closes', async () => {
    const b = await bench();
    let socket: { close(): void } | undefined;
    await b.measure(async () => {
      socket = b.linux.getTcpStack().connect('fd00::7', 22, {})!;
      await settle();
    });
    expect(b.linux.getProtocolCounters().tcp6CurrEstab).toBe(1);
    expect(b.linux.getProtocolCounters().tcpCurrEstab).toBe(0);
    socket!.close();
    await settle();
    await settle();
    expect(b.linux.getProtocolCounters().tcp6CurrEstab).toBe(0);
  });

  it('a refused connection over IPv6 is an attempt that failed, counted as IPv6, with a reset sent', async () => {
    const b = await bench();
    const d = await b.measure(async () => { await connect6(b, 3389); });
    expect(d.linux.tcp6ActiveOpens).toBe(1);
    expect(d.linux.tcp6AttemptFails).toBe(1);
    expect(d.windows.tcp6OutRsts).toBe(1);
    expect(d.windows.tcpOutRsts).toBe(0);
  });

  it('/proc/net/snmp on Linux counts the TCP of both families together, as the kernel does', async () => {
    const b = await bench();
    await b.measure(async () => { await connect6(b, 22); });
    const snmp = await b.linux.executeCommand('cat /proc/net/snmp');
    const names = snmp.split('\n').find((line) => line.startsWith('Tcp: ') && line.includes('ActiveOpens'))!.split(' ');
    const values = snmp.split('\n').filter((line) => line.startsWith('Tcp: ') && !line.includes('ActiveOpens'))[0].split(' ');
    expect(Number(values[names.indexOf('ActiveOpens')])).toBe(1);
    expect(b.linux.getProtocolCounters().tcpActiveOpens).toBe(0);
  });
});

describe('what the IPv6 layer refuses on arrival (net/ipv6/ip6_input.c, ip6_rcv_core)', () => {
  const inject = (b: Bench, packet: IPv6Packet): void => {
    b.windows.getPort('eth0')!.receiveFrame({
      srcMAC: b.linux.getPort('eth0')!.getMAC(), dstMAC: b.windows.getPort('eth0')!.getMAC(),
      etherType: ETHERTYPE_IPV6, payload: packet,
    });
  };
  const echoFrom = (source: string, destination: string, hopLimit = 64): IPv6Packet => createIPv6Packet(
    new IPv6Address(source), new IPv6Address(destination), 58, hopLimit,
    { type: 'icmpv6', icmpType: 'echo-request', code: 0, id: 1, sequence: 1, dataSize: 8 }, 16);

  it('WITNESS: a well-formed echo request is delivered and answered', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => { inject(b, echoFrom('fd00::1', 'fd00::7')); });
    expect(d.windows.ip6InHdrErrors).toBe(0);
    expect(d.windows.ip6InDelivers).toBe(1);
    expect(d.windows.icmp6InTypes[ECHO_REQUEST]).toBe(1);
  });

  it.each([
    ['a loopback source address from the wire', '::1', 'fd00::7'],
    ['a loopback destination address from the wire', 'fd00::1', '::1'],
    ['a multicast source address', 'ff02::5', 'fd00::7'],
    ['a destination multicast of interface-local scope', 'fd00::1', 'ff01::1'],
    ['a destination multicast of reserved scope 0', 'fd00::1', 'ff00::1'],
  ])('%s is a header error: counted, dropped, never delivered', async (_name, source, destination) => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => { inject(b, echoFrom(source, destination)); });
    expect(d.windows.ip6InReceives).toBe(1);
    expect(d.windows.ip6InHdrErrors).toBe(1);
    expect(d.windows.ip6InDelivers).toBe(0);
    expect(d.windows.icmp6InMsgs).toBe(0);
  });

  it('a packet addressed to someone else is an address error on a host that does not forward', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => { inject(b, echoFrom('fd00::1', 'fd00::99')); });
    expect(d.windows.ip6InAddrErrors).toBe(1);
    expect(d.windows.ip6InDelivers).toBe(0);
    expect(ofType(b.windowsSent, ECHO_REPLY)).toBe(0);
  });

  it('a packet reaching an interface that has IPv6 switched off is received and then discarded, never delivered', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    b.windows.getPort('eth0')!.disableIPv6();
    const d = await b.measure(async () => { inject(b, echoFrom('fd00::1', 'fd00::7')); });
    expect(d.windows.ip6InReceives).toBe(1);
    expect(d.windows.ip6InDiscards).toBe(1);
    expect(d.windows.ip6InDelivers).toBe(0);
    expect(d.windows.icmp6InMsgs).toBe(0);
  });

  it('a next header nothing handles is counted as an unknown protocol and not delivered', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    const d = await b.measure(async () => {
      inject(b, createIPv6Packet(new IPv6Address('fd00::1'), new IPv6Address('fd00::7'), 200, 64, null, 8));
    });
    expect(d.windows.ip6InUnknownProtos).toBe(1);
    expect(d.windows.ip6InDelivers).toBe(0);
  });

  it('a firewall that drops a packet leaves the discard counters alone: netfilter is not a MIB discard', async () => {
    const b = await bench();
    await b.measure(() => b.linux.executeCommand('ping -6 -c 1 fd00::7'));
    await b.linux.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-reply -j DROP');
    await b.linux.executeCommand('sudo iptables -A INPUT -p icmp -j DROP');
    const six = await b.measure(() => b.linux.executeCommand('ping -6 -c 1 -W 1 fd00::7'));
    expect(six.linux.ip6InReceives).toBeGreaterThan(0);
    expect(six.linux.icmp6InTypes[ECHO_REPLY]).toBe(0);
    expect(six.linux.ip6InDiscards).toBe(0);
    const four = await b.measure(() => b.linux.executeCommand('ping -c 1 -W 1 10.0.0.7'));
    expect(four.linux.ipInReceives).toBe(1);
    expect(four.linux.ipInDiscards).toBe(0);
  });
});

describe('traffic that never leaves the machine is still traffic (real packets only)', () => {
  it('a UDP datagram to ::1 is one packet out and one in, with no frame on the cable', async () => {
    const b = await bench();
    b.linux.udpBind(40300, () => undefined);
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram6(new IPv6Address('::1'), 40300, 40301, 'x', 1);
    });
    expect(d.linux.ip6OutRequests).toBe(1);
    expect(d.linux.ip6InReceives).toBe(1);
    expect(d.linux.ip6InDelivers).toBe(1);
    expect(d.linux.udp6OutDatagrams).toBe(1);
    expect(d.linux.udp6InDatagrams).toBe(1);
    expect(ipv6Frames(b.linuxSent)).toHaveLength(0);
  });

  it('a UDP datagram to 127.0.0.1 is one packet out and one in, in the IPv4 books', async () => {
    const b = await bench();
    b.linux.udpBind(40300, () => undefined);
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram(new IPAddress('127.0.0.1'), 40300, 40301, 'x', 1);
    });
    expect(d.linux.ipOutRequests).toBe(1);
    expect(d.linux.ipInReceives).toBe(1);
    expect(d.linux.ipInDelivers).toBe(1);
    expect(d.linux.ip6OutRequests).toBe(0);
    expect(b.linuxSent.filter((frame) => frame.etherType === ETHERTYPE_IPV4)).toHaveLength(0);
  });

  it('a TCP connection to ::1 counts its segments in the IPv6 books on both legs', async () => {
    const b = await bench();
    b.linux.getTcpStack().listen(40400, { onAccept: () => undefined }, '::');
    const d = await b.measure(async () => {
      let opened = false;
      const socket = b.linux.getTcpStack().connect('::1', 40400, { onOpen: () => { opened = true; } })!;
      await settle();
      if (opened) socket.close();
    });
    expect(d.linux.tcp6ActiveOpens).toBe(1);
    expect(d.linux.tcp6PassiveOpens).toBe(1);
    expect(d.linux.ip6OutRequests).toBe(d.linux.tcp6OutSegs);
    expect(d.linux.ip6InReceives).toBe(d.linux.tcp6InSegs);
    expect(d.linux.ip6InDelivers).toBe(d.linux.ip6InReceives);
    expect(d.linux.tcp6OutSegs).toBeGreaterThan(2);
  });

  it('a datagram to a closed local port: the ICMP error is sent and received by the same machine, both counted', async () => {
    const b = await bench();
    const d = await b.measure(async () => {
      b.linux.sendUdpDatagram(new IPAddress('127.0.0.1'), 40999, 40301, 'x', 1);
    });
    expect(d.linux.udpNoPorts).toBe(1);
    expect(d.linux.icmpOutDestUnreachs).toBe(1);
    expect(d.linux.icmpInDestUnreachs).toBe(1);
    expect(d.linux.ipOutRequests).toBe(2);
    expect(d.linux.ipInReceives).toBe(2);
  });
});
