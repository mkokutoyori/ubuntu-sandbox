/**
 * Un datagramme UDP est juge a l'arrivee comme la RFC 768 et la RFC 1122
 * le jugent, et il part comme un socket UDP ordinaire le fait : somme de
 * controle posee, fragmente quand il depasse la MTU, refuse au-dela de la
 * taille maximale.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - le champ `length` n'etait pas lu : 4, 0 ou 108 pour 13 octets reels
 *     arrivaient tous a l'application, et `length` plus court que la
 *     charge laissait la charge entiere ;
 *   - un datagramme de source 255.255.255.255, 224.0.0.1, 10.0.0.255,
 *     240.0.0.1, 127.0.0.1, 0.0.0.0 (vers une adresse unicast) ou de notre
 *     propre adresse arrivait a l'application ;
 *   - un datagramme de plus de 1472 octets de charge disparaissait : DF
 *     etait pose par defaut, la pile se renvoyait a elle-meme un « frag
 *     needed » et `sendUdpDatagram` repondait `true`. Rien ne partait ;
 *     65 508 et 70 000 octets recevaient la meme reponse ;
 *   - un datagramme UDP partait avec DF, la ou un socket Linux ou Windows
 *     ordinaire n'en pose pas (une requete DNS de `dig` porte
 *     `flags [none]`) ;
 *   - `buildUdpOverIpv4`, qui construit les datagrammes de DHCP, RIP, NTP,
 *     syslog, BFD et des interfaces virtuelles de commutateur, posait une
 *     somme nulle (« pas de somme ») ; il posait aussi DF d'office et ne
 *     lisait ni `dontFragment` ni d'options IP ;
 *   - ni l'envoi ni la reception ne portaient d'options IP jusqu'a
 *     l'application.
 *
 * Autorite : RFC 768 (« Length is the length in octets of this user
 * datagram including this header and the data. (This means the minimum
 * value of the length is eight.) ») ; RFC 1122 §4.1.3.4 (une somme nulle
 * non calculee est le defaut a eviter : « it MUST default to checksumming
 * on » ; une somme non nulle fausse est jetee en silence) ; §4.1.3.6 (« A
 * UDP datagram received with an invalid IP source address (e.g., a
 * broadcast or multicast address) must be discarded by UDP or by the IP
 * layer ») ; §4.1.3.2 (« UDP MUST pass any IP option that it receives from
 * the IP layer transparently to the application layer. An application MUST
 * be able to specify IP options to be sent in its UDP datagrams ») ;
 * RFC 791 §3.2 (fragmentation) ; RFC 8085 §3.2 (la fragmentation IP d'un
 * datagramme UDP trop grand est permise, a eviter cote application). La
 * borne de 65 507 octets est celle du champ de longueur : 65 535 - 20 - 8.
 * Le comportement par defaut de DF et le rognage d'un datagramme plus long
 * que `length` sont ceux de Linux (`udp_rcv` : « ulen < sizeof(*uh) » et
 * `pskb_trim_rcsum`), rappeles de memoire du code du noyau, source non
 * joignable d'ici.
 *
 * Ce qui est construit : `UdpInput.acceptUdpDatagram` (longueur, rognage,
 * somme, une seule fois, lu par `EndHost.deliverUDP`, `deliverUDP6` et la
 * branche UDP du routeur, qui portaient deux copies de la verification de
 * somme) ; `InternetLayer.invalidSourceFor` (martienne, nulle hors diffusion
 * limitee, diffusion dirigee ; la meme regle que la pile TCP) plus
 * l'adresse locale ; `buildUdpOverIpv4` pose la somme et lit `dontFragment`
 * et `ipOptions` ; `emitUdpDatagram` ne pose DF que si on le lui demande,
 * refuse plus de 65 507 octets (`EMSGSIZE` sur la prise connectee) et porte
 * les options IP ; la livraison porte `ipOptions`.
 *
 * Ce qui n'est PAS construit : la remontee des erreurs ICMP aux prises NON
 * connectees (le texte de la RFC 1122 §4.1.3.3 le demande pour toutes ;
 * Linux ne le fait que pour les prises connectees ou `IP_RECVERR`, et
 * `reportUdpSocketError` fait de meme) ; l'option du recepteur « exiger une
 * somme » (MAY).
 *
 * Discrimination (fichier copie sur le commit precedent, avec l'aide
 * `tcpScriptedPeer.ts`) : VINGT-TROIS cas sur trente-quatre tombent. Les
 * ONZE autres passent des deux cotes : les TEMOINS du laboratoire (datagramme
 * bien forme livre, somme nulle acceptee, forme DHCP livree, pair valide,
 * port source 0, 1472 octets en une trame, aucune option remontee), les
 * NON-REGRESSIONS (somme fausse jetee, taille declaree d'un libelle court :
 * `'charge'` declare a 1400 octets fait un datagramme de 1408, idiome des
 * laboratoires de fragmentation ; DF demande et datagramme trop grand
 * refuse sur place) et un cas STRUCTUREL — la somme d'un datagramme de forme
 * DHCP se verifie contre son pseudo-en-tete ; sur la base elle est nulle et
 * `verifyUdpChecksum` tient une somme nulle pour « aucune somme ».
 */
import { describe, it, expect } from 'vitest';
import { scriptedPeer, PEER_ADDRESS, DUT_ADDRESS, type ScriptedPeer } from '../../support/tcpScriptedPeer';
import {
  IPAddress, createIPv4Packet, IP_PROTO_UDP, IP_PROTO_ICMP, ETHERTYPE_IPV4, IP_OPTION_RECORD_ROUTE,
  type UDPPacket, type IPv4Packet, type IPv4Option, type ICMPPacket,
} from '@/network/core/types';
import { computeUdpChecksum, verifyUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import { buildUdpOverIpv4 } from '@/network/layers/transport/UdpEgress';
import type { UdpDelivery } from '@/network/devices/EndHost';

const LISTEN_PORT = 7000;
const MORE_FRAGMENTS = 0b001;
const DONT_FRAGMENT = 0b010;

interface Crafted {
  length?: number;
  body?: string;
  checksum?: 'valid' | 'zero' | 'wrong';
  options?: IPv4Option[];
  sourcePort?: number;
}

function datagram(source: string, destination: string, crafted: Crafted = {}): IPv4Packet {
  const body = crafted.body ?? 'hello';
  const declared = crafted.length ?? 8 + body.length;
  const covered = declared >= 8 ? body.slice(0, declared - 8) : body;
  const udp: UDPPacket = {
    type: 'udp', sourcePort: crafted.sourcePort ?? 5000, destinationPort: LISTEN_PORT,
    length: declared, checksum: 0, payload: body,
  };
  if (crafted.checksum !== 'zero') {
    udp.checksum = computeUdpChecksum({ ...udp, payload: covered }, source, destination);
    if (crafted.checksum === 'wrong') udp.checksum = (udp.checksum + 1) & 0xffff || 1;
  }
  return createIPv4Packet(
    new IPAddress(source), new IPAddress(destination), IP_PROTO_UDP, 64, udp, 8 + body.length,
    crafted.options === undefined ? {} : { ipOptions: crafted.options });
}

function listening(): { peer: ScriptedPeer; deliveries: UdpDelivery[] } {
  const peer = scriptedPeer();
  const deliveries: UdpDelivery[] = [];
  peer.dut.udpBind(LISTEN_PORT, (delivery) => { deliveries.push(delivery); });
  return { peer, deliveries };
}

function fragmentationNeeded(peer: ScriptedPeer, quoted: IPv4Packet, mtu: number): void {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'destination-unreachable', code: 4, id: 0, sequence: 0, dataSize: 28,
    originalPacket: quoted, mtu,
  };
  peer.sendIpv4(createIPv4Packet(
    new IPAddress(PEER_ADDRESS), new IPAddress(DUT_ADDRESS), IP_PROTO_ICMP, 64, icmp, 8 + 28));
}

function udpOnWire(peer: ScriptedPeer): IPv4Packet[] {
  return peer.frames
    .filter((frame) => frame.etherType === ETHERTYPE_IPV4)
    .map((frame) => frame.payload as IPv4Packet)
    .filter((packet) => packet.protocol === IP_PROTO_UDP);
}

describe('the length field is read on arrival (RFC 768)', () => {
  it('WITNESS: a well-formed datagram reaches the application', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries.map((d) => d.udp.payload)).toEqual(['hello']);
  });

  it.each([0, 4, 7])('a length of %s is below the 8-byte header and is dropped', (length) => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { length }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpInErrors).toBe(1);
  });

  it('a length beyond what the IP packet carries is dropped', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { length: 8 + 100 }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpInErrors).toBe(1);
  });

  it('a length shorter than the payload trims the payload to what it declares', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { length: 8 + 2, body: 'abcdefghij' }));
    expect(deliveries.map((d) => d.udp.payload)).toEqual(['ab']);
  });

  it('NON-REGRESSION: a non-zero wrong checksum is dropped', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksum: 'wrong' }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpInErrors).toBe(1);
  });

  it('WITNESS: a zero checksum over IPv4 means "none" and is accepted', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksum: 'zero' }));
    expect(deliveries).toHaveLength(1);
  });
});

describe('a datagram with an invalid source is discarded (RFC 1122 §4.1.3.6)', () => {
  it.each(['255.255.255.255', '224.0.0.1', '10.0.0.255', '240.0.0.1', '127.0.0.1', DUT_ADDRESS, '0.0.0.0'])(
    'a datagram from %s does not reach the application', (source) => {
      const { peer, deliveries } = listening();
      peer.sendIpv4(datagram(source, DUT_ADDRESS));
      expect(deliveries).toHaveLength(0);
      expect(peer.dut.getProtocolCounters().ipInAddrErrors).toBe(1);
    });

  it('WITNESS: a DHCP-shaped datagram, from 0.0.0.0 to the limited broadcast, is delivered', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram('0.0.0.0', '255.255.255.255'));
    expect(deliveries).toHaveLength(1);
  });

  it('WITNESS: a datagram from the valid peer is delivered', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries).toHaveLength(1);
    expect(peer.dut.getProtocolCounters().ipInAddrErrors).toBe(0);
  });

  it('WITNESS: source port 0 is legal and delivered (RFC 768, "If not used, a value of zero is inserted")', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { sourcePort: 0 }));
    expect(deliveries).toHaveLength(1);
  });
});

describe('a socket sends what its size allows (RFC 8085 §3.2, RFC 791 §3.2)', () => {
  function send(size: number, options?: Parameters<ScriptedPeer['dut']['sendUdpDatagram']>[5]): { peer: ScriptedPeer; returned: boolean } {
    const peer = scriptedPeer();
    const returned = peer.dut.sendUdpDatagram(
      new IPAddress(PEER_ADDRESS), 9, 9, 'x'.repeat(size), size, options);
    return { peer, returned };
  }

  it('WITNESS: a 1472-byte datagram, the largest that fits an Ethernet MTU, leaves in one frame', () => {
    const { peer } = send(1472);
    expect(udpOnWire(peer)).toHaveLength(1);
  });

  it('NON-REGRESSION: a short label with a declared size is a datagram of the declared size', () => {
    const peer = scriptedPeer();
    const returned = peer.dut.sendUdpDatagram(
      new IPAddress(PEER_ADDRESS), 9, 9, 'charge', 1400, { df: false });
    const packets = udpOnWire(peer);
    expect(returned).toBe(true);
    expect(packets).toHaveLength(1);
    expect((packets[0].payload as UDPPacket).length).toBe(1408);
  });

  it('a payload sent without a declared size is a datagram of its own length', () => {
    const peer = scriptedPeer();
    peer.dut.sendUdpDatagram(new IPAddress(PEER_ADDRESS), 9, 9, 'hello');
    expect((udpOnWire(peer)[0].payload as UDPPacket).length).toBe(13);
  });

  it('a 3000-byte datagram leaves as three fragments', () => {
    const { peer, returned } = send(3000);
    const packets = udpOnWire(peer);
    expect(returned).toBe(true);
    expect(packets.map((p) => p.totalLength)).toEqual([1500, 1500, 68]);
    expect(packets.map((p) => p.fragmentOffset)).toEqual([0, 185, 370]);
    expect(packets.map((p) => (p.flags & MORE_FRAGMENTS) !== 0)).toEqual([true, true, false]);
  });

  it('a Linux datagram that fits the path MTU carries DF (IP_PMTUDISC_WANT)', () => {
    const { peer } = send(1472);
    expect(udpOnWire(peer)[0].flags & DONT_FRAGMENT).toBe(DONT_FRAGMENT);
  });

  it('a Linux datagram one byte past the path MTU leaves in two fragments, none carrying DF', () => {
    const { peer } = send(1473);
    const packets = udpOnWire(peer);
    expect(packets).toHaveLength(2);
    expect(packets.map((p) => p.flags & DONT_FRAGMENT)).toEqual([0, 0]);
  });

  it('NON-REGRESSION: a Linux socket that asks for no DF sends none', () => {
    const { peer } = send(100, { df: false });
    expect(udpOnWire(peer)[0].flags & DONT_FRAGMENT).toBe(0);
  });

  it('a Windows datagram carries no DF unless the socket asks for one (IP_DONTFRAGMENT)', () => {
    const peer = scriptedPeer('windows');
    peer.dut.sendUdpDatagram(new IPAddress(PEER_ADDRESS), 9, 9, 'x'.repeat(100), 100);
    peer.dut.sendUdpDatagram(new IPAddress(PEER_ADDRESS), 9, 9, 'x'.repeat(100), 100, { df: true });
    expect(udpOnWire(peer).map((p) => p.flags & DONT_FRAGMENT)).toEqual([0, DONT_FRAGMENT]);
  });

  it('a path MTU reported by ICMP bounds what takes DF', () => {
    const { peer } = send(100);
    fragmentationNeeded(peer, udpOnWire(peer)[0], 1400);
    peer.dut.sendUdpDatagram(new IPAddress(PEER_ADDRESS), 9, 9, 'x'.repeat(1372), 1372);
    peer.dut.sendUdpDatagram(new IPAddress(PEER_ADDRESS), 9, 9, 'x'.repeat(1373), 1373);
    const packets = udpOnWire(peer).slice(1);
    expect(packets.map((p) => [p.totalLength, p.flags & DONT_FRAGMENT])).toEqual([
      [1400, DONT_FRAGMENT], [1396, 0], [25, 0],
    ]);
  });

  it('a path MTU below the kernel minimum locks the route, and a locked route takes no DF', () => {
    const { peer } = send(100);
    fragmentationNeeded(peer, udpOnWire(peer)[0], 400);
    expect(peer.dut.routeException(new IPAddress(PEER_ADDRESS))?.locked).toBe(true);
    peer.dut.sendUdpDatagram(new IPAddress(PEER_ADDRESS), 9, 9, 'x'.repeat(100), 100);
    expect(udpOnWire(peer).at(-1)!.flags & DONT_FRAGMENT).toBe(0);
  });

  it('NON-REGRESSION: with DF requested, an oversize datagram is refused locally and nothing leaves', () => {
    const { peer } = send(3000, { df: true });
    expect(udpOnWire(peer)).toHaveLength(0);
  });

  it('the largest datagram, 65 507 bytes, leaves as fragments', () => {
    const { peer, returned } = send(65507);
    expect(returned).toBe(true);
    expect(udpOnWire(peer)).toHaveLength(45);
  });

  it.each([65508, 70000])('a %s-byte datagram is refused and nothing leaves', (size) => {
    const { peer, returned } = send(size);
    expect(returned).toBe(false);
    expect(udpOnWire(peer)).toHaveLength(0);
  });

  it('a connected socket reports EMSGSIZE for a datagram past the maximum', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.udpConnect(new IPAddress(PEER_ADDRESS), 9);
    if (typeof socket === 'string') throw new Error(socket);
    expect(socket.send(new Uint8Array(65508))).toBe('EMSGSIZE');
  });
});

describe('a datagram built for a protocol agent is checksummed (RFC 1122 §4.1.3.4)', () => {
  const request = {
    destination: new IPAddress(DUT_ADDRESS), destinationPort: 9, sourcePort: 9, payload: 'x', payloadBytes: 1,
  };

  it('the checksum is set and verifies', () => {
    const packet = buildUdpOverIpv4(new IPAddress(PEER_ADDRESS), request);
    const udp = packet.payload as UDPPacket;
    expect(udp.checksum).not.toBe(0);
    expect(verifyUdpChecksum(udp, PEER_ADDRESS, DUT_ADDRESS)).toBe(true);
  });

  it('WITNESS: a DHCP-shaped datagram, from 0.0.0.0, verifies against the pseudo-header it was built for', () => {
    const packet = buildUdpOverIpv4(new IPAddress('0.0.0.0'), {
      ...request, destination: new IPAddress('255.255.255.255'),
    });
    expect(verifyUdpChecksum(packet.payload as UDPPacket, '0.0.0.0', '255.255.255.255')).toBe(true);
  });

  it('DF is the default, and the agent that asks for none gets none', () => {
    const plain = buildUdpOverIpv4(new IPAddress(PEER_ADDRESS), request);
    const unpinned = buildUdpOverIpv4(new IPAddress(PEER_ADDRESS), { ...request, dontFragment: false });
    expect(plain.flags & DONT_FRAGMENT).toBe(DONT_FRAGMENT);
    expect(unpinned.flags & DONT_FRAGMENT).toBe(0);
  });
});

describe('IP options travel with a datagram (RFC 1122 §4.1.3.2)', () => {
  const recordRoute: IPv4Option = { type: IP_OPTION_RECORD_ROUTE, data: [4, 0, 0, 0, 0] };

  it('an option given to the send is on the wire', () => {
    const peer = scriptedPeer();
    peer.dut.sendUdpDatagram({
      destination: new IPAddress(PEER_ADDRESS), destinationPort: 9, sourcePort: 9,
      payload: 'x', payloadBytes: 1, ipOptions: [recordRoute],
    });
    expect(udpOnWire(peer)[0].options).toEqual([recordRoute]);
  });

  it('an option that arrives is handed to the application', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { options: [recordRoute] }));
    expect(deliveries[0].ipOptions).toEqual([recordRoute]);
  });

  it('WITNESS: a datagram without options hands none up', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries[0].ipOptions ?? []).toEqual([]);
  });
});
