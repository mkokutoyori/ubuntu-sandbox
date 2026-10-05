/**
 * `tc qdisc ... netem loss P% ecn` : le premier producteur de CE du
 * simulateur. Un paquet que netem perdrait part marque CE s'il porte ECT, et
 * est perdu sinon ; et la qdisc agit sur la SORTIE de l'interface qu'elle
 * nomme, pas sur le cable.
 *
 * Mesure de depart (commit precedent), deux machines sur un cable :
 *
 *   - `tc qdisc add dev eth0 root netem loss 20%` posait la perte sur le
 *     CABLE : les trames du pair la subissaient aussi, et `tc qdisc show dev
 *     eth0` rendu par le PAIR affichait la meme qdisc, alors qu'une qdisc de
 *     sortie n'existe que sur son interface ;
 *   - le mot `ecn` etait accepte et ignore : `netem loss 10% ecn` perdait le
 *     paquet ECT que netem marque CE, et `netem delay 10ms ecn` etait accepte
 *     la ou tc refuse « ecn requested without loss model » ;
 *   - `change` gardait ce que la commande ne repetait pas, la ou tc remplace
 *     toute la qdisc ;
 *   - la perte s'appliquait dans le cable, APRES le point de capture de
 *     l'interface : un `tcpdump` sur la machine qui emet voyait les trames
 *     que netem venait de perdre, et ne pouvait voir aucune marque.
 *
 * Autorite : Linux 5.15, source lue (raw.githubusercontent.com) :
 * `sch_netem.c` (`netem_enqueue` : sur un evenement de perte, `q->ecn &&
 * INET_ECN_set_ce(skb)` marque le paquet, sinon il est retire),
 * `inet_ecn.h` (`INET_ECN_set_ce` marque ECT(0) et ECT(1), rend vrai pour
 * un paquet deja CE, faux pour un non-ECT ; `IP_ECN_set_ce` remet l'en-tete
 * IPv4 a jour, `IP6_ECN_set_ce` n'en a pas besoin), `dev.c` (`xmit_one` :
 * `dev_queue_xmit_nit` — la capture — tourne a la sortie de la qdisc, donc
 * apres netem). iproute2 5.15.0, le paquet que la base de paquets du
 * simulateur annonce, `tc/q_netem.c` : `ecn` exige un modele de perte (« ecn
 * requested without loss model », puis l'usage), la sortie de `show` se
 * termine par « ecn » et une espace, une commande `add` ou `change` envoie
 * TOUS les parametres de la qdisc.
 *
 * Ce qui est construit : `Cable.setEgressNetem` / `getEgressNetem` (un
 * `NetemSpec` par interface emettrice : perte, delai, ecn), evalue par
 * `Cable.applyEgressNetem` que `Port.sendFrame` appelle AVANT la capture et
 * le compteur de sortie ; `markCongestionExperienced` (une copie de la trame
 * avec CE, l'en-tete IPv4 recalcule, la meme position dans la file de
 * capture) ; l'evenement `cable.frame.marked` et `CableStats.framesMarked` ;
 * `tc` lit et ecrit cette table par interface ; le RTT d'un ping ajoute le
 * delai des DEUX sorties (`roundTripDelayMs`), le test de la liaison RAC lit
 * `isDegraded()` ; l'export de topologie ecrit la qdisc de chaque extremite.
 * La perte, la corruption et le delai du CABLE (`setPacketLossRate`,
 * `setCorruptionRate`, `setArtificialDelayMs`) restent la propriete du cable,
 * celle de l'interface graphique : le defaut qu'elle posait sur `tc` seul est
 * ferme.
 *
 * Ce qui n'est PAS construit : les mots de netem qui exigent un delai reel
 * ou un autre modele de perte (`reorder`, `rate`, `slot`, la gigue et les
 * distributions, `loss state` et `gemodel`), ainsi que `duplicate`,
 * `corrupt` et `limit`, restent acceptes sans effet, comme avant : la
 * livraison des trames est synchrone, aucune file n'existe pour porter un
 * delai. Les tunnels ne propagent pas CE vers l'en-tete interieur (RFC
 * 6040 §4).
 *
 * Discrimination (fichier copie sur le commit precedent) : ONZE cas sur
 * treize tombent, ainsi que les quatre cas de `tc-packet-loss` que la
 * sortie a oblige a corriger et le cas ajoute a `topology-roundtrip-physical`.
 * Les DEUX autres passent des deux cotes :
 * les TEMOINS qu'une perte sans `ecn` perd ses donnees sans rien marquer, et
 * qu'un paquet non ECN reste perdu meme avec `ecn` — le laboratoire de
 * bout en bout, lui, ne passe que si `ecn` marque.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import {
  ETHERTYPE_IPV4, ETHERTYPE_IPV6, IP_PROTO_TCP, verifyIPv4Checksum,
  type EthernetFrame, type IPv4Packet, type IPv6Packet,
} from '@/network/core/types';
import type { TcpSegment } from '@/network/tcp/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';

const PORT = 5001;

interface Lab {
  readonly a: LinuxPC;
  readonly b: LinuxPC;
  readonly cable: Cable;
  readonly bus: EventBus;
  readonly marked: EthernetFrame[];
  readonly lost: string[];
}

async function lab(family: 'ipv4' | 'ipv6' = 'ipv4'): Promise<Lab> {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  const cable = new Cable('wire');
  const bus = new EventBus();
  cable.setEventBus(bus);
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  if (family === 'ipv6') {
    await a.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
    await b.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
  } else {
    await a.executeCommand('ip addr add 192.168.1.1/24 dev eth0');
    await b.executeCommand('ip addr add 192.168.1.2/24 dev eth0');
  }
  const marked: EthernetFrame[] = [];
  const lost: string[] = [];
  bus.subscribe('cable.frame.marked', (event) => { marked.push(event.payload.frame); });
  bus.subscribe('cable.frame.lost', (event) => { lost.push(event.payload.reason); });
  return { a, b, cable, bus, marked, lost };
}

function serve(b: LinuxPC): string[] {
  const received: string[] = [];
  b.getTcpStack().listen(PORT, { onAccept: (socket) => { socket.onData((data) => { received.push(String(data)); }); } });
  return received;
}

async function connected(l: Lab, address: string): Promise<TcpSocket> {
  const socket = l.a.getTcpStack().connect(address, PORT)!;
  expect(socket.state).toBe('established');
  return socket;
}

function segmentOf(frame: EthernetFrame): TcpSegment {
  const packet = frame.payload as IPv4Packet | IPv6Packet;
  return packet.payload as TcpSegment;
}

function ecnOf(frame: EthernetFrame): EcnCodepoint {
  if (frame.etherType === ETHERTYPE_IPV6) return EcnCodepoint.ofField((frame.payload as IPv6Packet).trafficClass);
  return EcnCodepoint.ofField((frame.payload as IPv4Packet).tos);
}

describe('tc netem acts on the egress of the interface it names, nowhere else', () => {
  it('the interface that carries the qdisc loses its frames, its peer does not', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100%');
    const delivered: string[] = [];
    l.bus.subscribe('cable.frame.delivered', (event) => { delivered.push(event.payload.from.deviceId); });
    await l.a.executeCommand('ping -c 1 192.168.1.2');
    await l.b.executeCommand('ping -c 1 192.168.1.1');
    const fromA = l.a.getPort('eth0')!.getEquipmentId();
    const fromB = l.b.getPort('eth0')!.getEquipmentId();
    expect(delivered.filter((id) => id === fromB).length).toBeGreaterThan(0);
    expect(delivered.filter((id) => id === fromA)).toHaveLength(0);
  });

  it('tc qdisc show names the qdisc on that interface only', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem delay 50ms loss 10%');
    expect(await l.a.executeCommand('tc qdisc show dev eth0')).toContain('netem');
    expect(await l.b.executeCommand('tc qdisc show dev eth0')).not.toContain('netem');
  });

  it('change replaces the whole qdisc: a parameter that is not repeated goes back to nothing', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 20%');
    await l.a.executeCommand('sudo tc qdisc change dev eth0 root netem delay 50ms');
    const spec = l.cable.getEgressNetem(l.a.getPort('eth0')!);
    expect(spec?.lossRate).toBe(0);
    expect(spec?.delayMs).toBe(50);
    expect(await l.a.executeCommand('tc qdisc show dev eth0')).not.toContain('loss');
  });

  it('the delay of both ends is added to the round trip a ping reports', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem delay 200ms');
    await l.b.executeCommand('sudo tc qdisc add dev eth0 root netem delay 100ms');
    expect(l.cable.roundTripDelayMs(l.a.getPort('eth0')!)).toBe(300);
    expect(l.cable.roundTripDelayMs(l.b.getPort('eth0')!)).toBe(300);
  });
});

describe('netem ecn marks CE instead of dropping an ECN-capable frame (sch_netem.c, netem_enqueue)', () => {
  it('shows ecn the way tc prints it, with its trailing space', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 10% ecn');
    expect(await l.a.executeCommand('tc qdisc show dev eth0'))
      .toBe('qdisc netem 8001: dev eth0 root refcnt 2 limit 1000 loss 10% ecn ');
  });

  it('refuses ecn without a loss model, in tc\'s words, and leaves the qdisc alone', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 10%');
    const out = await l.a.executeCommand('sudo tc qdisc change dev eth0 root netem delay 10ms ecn');
    expect(out.split('\n')[0]).toBe('ecn requested without loss model');
    expect(out).toContain('Usage: ... netem');
    expect(l.cable.getEgressNetem(l.a.getPort('eth0')!)?.lossRate).toBeCloseTo(0.1);
  });

  it('end to end: the receiver gets every byte, echoes ECE, the sender halves its window and answers CWR', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const received = serve(l.b);
    const socket = await connected(l, '192.168.1.2');
    const reactions: number[] = [];
    l.a.getBus().subscribe('tcp.ecn.reaction', (event) => { reactions.push(event.payload.congestionWindow); });
    const before = socket.cc.cwnd;
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100% ecn');
    socket.write('x'.repeat(40000));
    expect(received.join('')).toHaveLength(40000);
    expect(l.marked.length).toBeGreaterThan(0);
    expect(l.lost).toHaveLength(0);
    expect(reactions.length).toBeGreaterThan(0);
    expect(socket.cc.cwnd).toBeLessThan(before);
    expect(l.marked.some((frame) => segmentOf(frame).flags.cwr)).toBe(true);
  });

  it('WITNESS: the same loss without ecn drops the data, and nothing is marked', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const received = serve(l.b);
    const socket = await connected(l, '192.168.1.2');
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100%');
    socket.write('x'.repeat(4000));
    expect(received.join('')).toHaveLength(0);
    expect(l.marked).toHaveLength(0);
    expect(l.cable.getStats().framesLost).toBeGreaterThan(0);
  });

  it('a frame that is not ECN-capable is still dropped, even with ecn', async () => {
    const l = await lab();
    const received = serve(l.b);
    const socket = await connected(l, '192.168.1.2');
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100% ecn');
    socket.write('x'.repeat(4000));
    expect(received.join('')).toHaveLength(0);
    expect(l.marked).toHaveLength(0);
  });

  it('the IPv4 header checksum is recomputed for the mark', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    serve(l.b);
    const socket = await connected(l, '192.168.1.2');
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100% ecn');
    socket.write('x'.repeat(2000));
    expect(l.marked.length).toBeGreaterThan(0);
    for (const frame of l.marked) {
      const packet = frame.payload as IPv4Packet;
      expect(frame.etherType).toBe(ETHERTYPE_IPV4);
      expect(packet.protocol).toBe(IP_PROTO_TCP);
      expect(ecnOf(frame)).toBe(EcnCodepoint.CE);
      expect(verifyIPv4Checksum(packet)).toBe(true);
    }
  });

  it('marks over IPv6 through the traffic class', async () => {
    const l = await lab('ipv6');
    await l.a.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const received = serve(l.b);
    const socket = await connected(l, 'fd00::2');
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100% ecn');
    socket.write('x'.repeat(4000));
    expect(received.join('')).toHaveLength(4000);
    expect(l.marked.length).toBeGreaterThan(0);
    expect(l.marked.every((frame) => frame.etherType === ETHERTYPE_IPV6 && ecnOf(frame) === EcnCodepoint.CE))
      .toBe(true);
  });

  it('the capture on the sending interface sees the mark, as a capture behind a real qdisc does', async () => {
    const l = await lab();
    await l.a.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    serve(l.b);
    const socket = await connected(l, '192.168.1.2');
    await l.a.executeCommand('sudo tc qdisc add dev eth0 root netem loss 100% ecn');
    const seen: EcnCodepoint[] = [];
    l.a.getPort('eth0')!.attachTap((tapped) => {
      if (tapped.direction !== 'out') return;
      const segment = segmentOf(tapped.frame);
      if (segment.type === 'tcp' && segment.destinationPort === PORT && segment.payload !== undefined) {
        seen.push(ecnOf(tapped.frame));
      }
    });
    socket.write('x'.repeat(2000));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((codepoint) => codepoint === EcnCodepoint.CE)).toBe(true);
  });
});

describe('a router marks CE on the egress that faces the receiver', () => {
  it('client, router and server: the server gets every byte, the egress facing it marks, the client reacts', async () => {
    const client = new LinuxPC('linux-pc', 'C', 0, 0);
    const router = new LinuxPC('linux-pc', 'R', 0, 0);
    const server = new LinuxPC('linux-pc', 'S', 0, 0);
    const bus = new EventBus();
    const near = new Cable('near');
    const far = new Cable('far');
    near.setEventBus(bus);
    far.setEventBus(bus);
    near.connect(client.getPort('eth0')!, router.getPort('eth0')!);
    far.connect(router.getPort('eth1')!, server.getPort('eth0')!);
    await client.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
    await client.executeCommand('ip route add default via 192.168.1.1');
    await router.executeCommand('ip addr add 192.168.1.1/24 dev eth0');
    await router.executeCommand('ip addr add 10.0.0.1/24 dev eth1');
    await router.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
    await server.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
    await server.executeCommand('ip route add default via 10.0.0.1');
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const marked: EthernetFrame[] = [];
    bus.subscribe('cable.frame.marked', (event) => { marked.push(event.payload.frame); });
    const received = serve(server);
    const socket = client.getTcpStack().connect('10.0.0.2', PORT)!;
    expect(socket.state).toBe('established');
    const reactions: number[] = [];
    client.getBus().subscribe('tcp.ecn.reaction', (event) => { reactions.push(event.payload.congestionWindow); });
    await router.executeCommand('sudo tc qdisc add dev eth1 root netem loss 100% ecn');
    socket.write('x'.repeat(20000));
    expect(received.join('')).toHaveLength(20000);
    expect(marked.length).toBeGreaterThan(0);
    expect(reactions.length).toBeGreaterThan(0);
    expect(near.getStats().framesMarked).toBe(0);
    expect(far.getStats().framesMarked).toBe(marked.length);
  });
});
