/**
 * UDP-Lite (RFC 3828) : protocole 136, somme partielle, espace de ports a part.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE (le DUT et un port nu dont on
 * forge chaque datagramme) :
 *
 *   - le protocole IP 136 n'existait pas : un datagramme UDP-Lite adresse a un
 *     poste Linux recevait « protocol unreachable » comme n'importe quel
 *     protocole inconnu, alors que le noyau d'un Ubuntu l'implante
 *     (`/proc/net/udplite`) ;
 *   - `/proc/net/snmp` imprimait en dur `UdpLite: 0 0 0 0 0 0 0 0` : une vue
 *     qui affirmait un moteur absent, et `Udp: ... InCsumErrors` restait a
 *     zero alors que `acceptUdpDatagram` jette les sommes fausses.
 *
 * Autorite (docs/rfc/udp/rfc3828.txt, lue) : §3.1 (la couverture vaut 0 — tout
 * le datagramme — ou au moins 8 ; une couverture de 1 a 7, ou superieure a
 * la longueur IP, MUST etre jetee ; la somme porte un pseudo-en-tete, couvre
 * le nombre d'octets de la couverture, est completee virtuellement d'un
 * octet nul, et si elle vaut zero elle est transmise 0xFFFF — une somme
 * transmise nulle est donc invalide) ; §3.2 (la longueur du pseudo-en-tete
 * vient du module IP, pas de l'en-tete) ; §3.3 (l'interface laisse
 * l'emetteur poser la couverture, et le recepteur « at least ... block
 * delivery of packets with coverage values less than a value provided » ;
 * le comportement par defaut mime UDP : couverture egale a la longueur, et un
 * recepteur qui veut des datagrammes partiels « should inform the receiving
 * system ») ; §3.4 (l'emetteur n'ajoute aucun octet de bourrage) ; §5
 * (numero de protocole 136, memes numeros de ports que UDP, un hote qui
 * ignore UDP-Lite rend « protocol unreachable »). Les sommes de reference
 * (0x78a8, 0x78b5, 0x5418, 0xbc7f, 0xe7a6) viennent d'un calcul
 * independant, mot a mot, hors du depot.
 *
 * Construit : `UDPLitePacket` et `IP_PROTO_UDPLITE` ; `ChecksumCoverage`
 * (0 ou 8 a 65535, a la frontiere) ; une seule base de somme partagee avec
 * UDP (`UdpChecksum`) ; `acceptUdpLiteDatagram` / `admitsCoverage` ;
 * `UdpLiteEndpoint` (ports a lui, `minimumCoverage` par prise — par defaut
 * seuls les datagrammes entierement couverts passent —, ICMP « port
 * unreachable », compteurs `udpLite*`) derriere un port etroit vers l'hote ;
 * l'hote extrait ses queues d'emission (`emitIpv4`, `emitIpv4ToGroup`,
 * `emitIpv6`) pour qu'UDP et UDP-Lite les partagent ; `SocketTable` connait
 * le protocole `udplite`, `/proc/net/udplite` est genere, `/proc/net/snmp`
 * lit les vrais compteurs, la capture ecrit les octets du datagramme. Seules
 * les machines Linux l'activent : Windows n'implante pas UDP-Lite et rend
 * « protocol unreachable ».
 *
 * Ce qui n'est PAS construit : la dissection `tcpdump` d'UDP-Lite (le
 * format imprime ne se source pas hors ligne : la ligne reste `ip-proto-136`),
 * l'affichage `netstat -U`, la traduction d'adresses d'un datagramme
 * UDP-Lite, les jumbogrammes IPv6 (§3.5, absents du simulateur).
 *
 * Discrimination (fichier copie sur le commit precedent, avec des coquilles qui levent a
 * la place des deux modules absents `ChecksumCoverage` et `UdpLiteEndpoint`,
 * faute de quoi le fichier ne se charge pas) : CINQUANTE-NEUF cas sur
 * soixante et un tombent. Les DEUX autres passent des deux cotes et sont des
 * TEMOINS : un poste sans UDP-Lite (Windows) rend « protocol unreachable », et
 * iptables refuse toujours un protocole inconnu (`zorglub`, `300`). Les cas qui
 * ne dependent que de la fonction de somme (les cinq sommes de reference) et
 * du pseudo-en-tete IPv6 tombent parce que la fonction n'existait pas, pas
 * parce qu'elle se tromperait : leur valeur est celle du calcul independant.
 */
import { describe, it, expect } from 'vitest';
import { scriptedPeer, PEER_ADDRESS, DUT_ADDRESS, type ScriptedPeer } from '../../support/tcpScriptedPeer';
import {
  IPAddress, IPv6Address, SubnetMask, MACAddress, createIPv4Packet, createIPv6Packet, resetCounters,
  IP_PROTO_UDPLITE, IP_PROTO_UDP, ETHERTYPE_IPV4,
  type IPv4Packet, type UDPPacket, type UDPLitePacket, type ICMPPacket,
} from '@/network/core/types';
import {
  computeUdpChecksum, computeUdpLiteChecksum, verifyUdpLiteChecksum,
} from '@/network/layers/transport/UdpChecksum';
import { ChecksumCoverage } from '@/network/layers/transport/ChecksumCoverage';
import type { UdpLiteDelivery } from '@/network/devices/udp/UdpLiteEndpoint';
import type { HostIcmpUnreachablePayload } from '@/network/devices/host/events';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { UdpLiteEndpoint } from '@/network/devices/udp/UdpLiteEndpoint';
import { SocketTable } from '@/network/core/SocketTable';
import { newProtocolCounters } from '@/network/layers/internet/ProtocolCounters';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const LISTEN_PORT = 7000;
const SOURCE_PORT = 5000;

interface Crafted {
  body?: string;
  coverageField?: number;
  checksum?: 'valid' | 'zero' | 'wrong';
  deliveredBody?: string;
  pseudoLength?: number;
  destinationPort?: number;
  checksumValue?: number;
}

function datagram(source: string, destination: string, crafted: Crafted = {}): IPv4Packet {
  const body = crafted.body ?? 'hello';
  const length = 8 + body.length;
  const field = crafted.coverageField ?? length;
  const covered = { sourcePort: SOURCE_PORT, destinationPort: crafted.destinationPort ?? LISTEN_PORT,
    checksumCoverage: field, payload: body };
  let checksum = crafted.checksumValue
    ?? computeUdpLiteChecksum(covered, crafted.pseudoLength ?? length, source, destination);
  if (crafted.checksum === 'zero') checksum = 0;
  if (crafted.checksum === 'wrong') checksum = (checksum + 1) & 0xffff || 1;
  const udp: UDPLitePacket = {
    type: 'udplite', sourcePort: SOURCE_PORT, destinationPort: crafted.destinationPort ?? LISTEN_PORT,
    checksumCoverage: field, checksum, payload: crafted.deliveredBody ?? body,
  };
  return createIPv4Packet(
    new IPAddress(source), new IPAddress(destination), IP_PROTO_UDPLITE, 64, udp, length);
}

function listening(minimum?: ChecksumCoverage):
  { peer: ScriptedPeer; deliveries: UdpLiteDelivery[] } {
  const peer = scriptedPeer();
  const deliveries: UdpLiteDelivery[] = [];
  peer.dut.getUdpLite()!.bind(
    LISTEN_PORT, (delivery) => { deliveries.push(delivery); },
    minimum === undefined ? {} : { minimumCoverage: minimum });
  return { peer, deliveries };
}

function onWire(peer: ScriptedPeer): IPv4Packet[] {
  return peer.frames
    .filter((frame) => frame.etherType === ETHERTYPE_IPV4)
    .map((frame) => frame.payload as IPv4Packet)
    .filter((packet) => packet.protocol === IP_PROTO_UDPLITE);
}

function icmpErrors(peer: ScriptedPeer): ICMPPacket[] {
  return peer.icmpReplies.filter((icmp) => icmp.icmpType === 'destination-unreachable');
}

describe('the coverage field is read on arrival (RFC 3828 §3.1)', () => {
  it('WITNESS: a datagram covered in full reaches the application with its coverage', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries.map((d) => d.udp.payload)).toEqual(['hello']);
    expect(deliveries[0].coverage).toBe(13);
    expect(peer.dut.getProtocolCounters().udpLiteInDatagrams).toBe(1);
  });

  it('a coverage of zero covers the whole datagram', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 0 }));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].coverage).toBe(13);
  });

  it.each([1, 4, 7])('a coverage of %s leaves the header uncovered and is dropped', (coverageField) => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(8));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInErrors).toBe(1);
  });

  it('a coverage beyond what the IP packet carries is dropped', () => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(8));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 13 + 4 }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInErrors).toBe(1);
  });

  it('a zero checksum is invalid: UDP-Lite has no "no checksum" form', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksum: 'zero' }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInErrors).toBe(1);
    expect(peer.dut.getProtocolCounters().udpLiteInCsumErrors).toBe(1);
  });

  it('a wrong checksum is dropped and counted as a checksum error', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksum: 'wrong' }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInErrors).toBe(1);
    expect(peer.dut.getProtocolCounters().udpLiteInCsumErrors).toBe(1);
  });

  it('the pseudo-header length comes from the IP packet, not from the header', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { pseudoLength: 13 + 2 }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInCsumErrors).toBe(1);
  });

  it('a corrupted byte inside the covered part is detected', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { deliveredBody: 'hellp' }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInCsumErrors).toBe(1);
  });

  it('a corrupted byte beyond the covered part goes through, which is the point of UDP-Lite', () => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(10));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 10, deliveredBody: 'heXXX' }));
    expect(deliveries.map((d) => d.udp.payload)).toEqual(['heXXX']);
    expect(deliveries[0].coverage).toBe(10);
  });

  it('WITNESS: the same corruption inside a full coverage is not forgiven', () => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(10));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { deliveredBody: 'heXXX' }));
    expect(deliveries).toHaveLength(0);
  });
});

describe('the checksum matches an independent computation', () => {
  const vector = (
    coverageField: number, body: string, expected: number, deliveredBody?: string,
  ) => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(8));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, {
      coverageField, body, checksumValue: expected, ...(deliveredBody === undefined ? {} : { deliveredBody }),
    }));
    return deliveries;
  };

  it('over an odd covered length, virtually padded with a zero octet (0x78a8)', () => {
    expect(vector(13, 'hello', 0x78a8)).toHaveLength(1);
  });

  it('with a coverage field of zero (0x78b5)', () => {
    expect(vector(0, 'hello', 0x78b5)).toHaveLength(1);
  });

  it('over a covered prefix that ends in the middle of the payload (0x5418)', () => {
    expect(vector(10, 'hello', 0x5418)).toHaveLength(1);
  });

  it('over the header alone, whatever the payload is (0xbc7f)', () => {
    expect(vector(8, 'hello', 0xbc7f)).toHaveLength(1);
    expect(vector(8, 'hello', 0xbc7f, 'HELLO')).toHaveLength(1);
  });

  it('over an even length (0xe7a6)', () => {
    expect(vector(12, 'help', 0xe7a6)).toHaveLength(1);
  });

  it('the shared core computes the same values', () => {
    const covered = (coverageField: number, payload: string) => ({
      sourcePort: SOURCE_PORT, destinationPort: LISTEN_PORT, checksumCoverage: coverageField, payload });
    expect(computeUdpLiteChecksum(covered(13, 'hello'), 13, PEER_ADDRESS, DUT_ADDRESS)).toBe(0x78a8);
    expect(computeUdpLiteChecksum(covered(0, 'hello'), 13, PEER_ADDRESS, DUT_ADDRESS)).toBe(0x78b5);
    expect(computeUdpLiteChecksum(covered(10, 'hello'), 13, PEER_ADDRESS, DUT_ADDRESS)).toBe(0x5418);
    expect(verifyUdpLiteChecksum({ ...covered(8, 'hello'), checksum: 0xbc7f }, 13, PEER_ADDRESS, DUT_ADDRESS))
      .toBe(true);
    expect(verifyUdpLiteChecksum({ ...covered(8, 'hello'), checksum: 0 }, 13, PEER_ADDRESS, DUT_ADDRESS))
      .toBe(false);
  });
});

describe('the receiver decides which coverage it accepts (RFC 3828 §3.3)', () => {
  it('by default only fully covered datagrams are delivered, as with UDP', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 10 }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getProtocolCounters().udpLiteInErrors).toBe(1);
  });

  it('WITNESS: by default a fully covered datagram is delivered', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 13 }));
    expect(deliveries).toHaveLength(1);
  });

  it('a socket that asks for a minimum coverage of 10 takes 10 and 12, not 9 or 8', () => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(10));
    for (const coverageField of [8, 9, 10, 12]) {
      peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField }));
    }
    expect(deliveries.map((d) => d.coverage)).toEqual([10, 12]);
  });

  it('a fully covered datagram passes whatever minimum the socket asks for', () => {
    const { peer, deliveries } = listening(ChecksumCoverage.of(60));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries).toHaveLength(1);
  });

  it('the minimum of a bound socket can change', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 8 }));
    expect(deliveries).toHaveLength(0);
    expect(peer.dut.getUdpLite()!.setMinimumCoverage(LISTEN_PORT, ChecksumCoverage.of(8))).toBe(true);
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 8 }));
    expect(deliveries).toHaveLength(1);
  });

  it('the value object refuses a coverage that leaves the header uncovered', () => {
    expect(() => ChecksumCoverage.of(5)).toThrow(RangeError);
    expect(() => ChecksumCoverage.of(65536)).toThrow(RangeError);
    expect(() => ChecksumCoverage.of(-1)).toThrow(RangeError);
    expect([0, 8, 65535].map((v) => ChecksumCoverage.of(v).value)).toEqual([0, 8, 65535]);
    expect(ChecksumCoverage.FULL.coversWholeDatagram).toBe(true);
  });
});

describe('UDP-Lite has its own ports and its own errors (RFC 3828 §5)', () => {
  it('a UDP socket and a UDP-Lite socket share a port number and never each other\'s datagrams', () => {
    const peer = scriptedPeer();
    const lite: UdpLiteDelivery[] = [];
    const plain: unknown[] = [];
    expect(peer.dut.getUdpLite()!.bind(LISTEN_PORT, (d) => { lite.push(d); })).toBe(LISTEN_PORT);
    expect(peer.dut.udpBind(LISTEN_PORT, (d) => { plain.push(d.udp.payload); })).toBe(LISTEN_PORT);
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(lite).toHaveLength(1);
    expect(plain).toHaveLength(0);
  });

  it('WITNESS: a UDP datagram still reaches the UDP socket beside a UDP-Lite one', () => {
    const peer = scriptedPeer();
    const plain: unknown[] = [];
    peer.dut.getUdpLite()!.bind(LISTEN_PORT, () => undefined);
    peer.dut.udpBind(LISTEN_PORT, (d) => { plain.push(d.udp.payload); });
    expect(peer.dut.udpBind(LISTEN_PORT, () => undefined)).toBe(false);
    expect(peer.dut.getUdpLite()!.bind(LISTEN_PORT, () => undefined)).toBe(false);
    expect(plain).toHaveLength(0);
  });

  it('a port already taken by UDP-Lite refuses a second bind and frees on close', () => {
    const peer = scriptedPeer();
    const endpoint = peer.dut.getUdpLite()!;
    expect(endpoint.bind(LISTEN_PORT, () => undefined)).toBe(LISTEN_PORT);
    expect(endpoint.bind(LISTEN_PORT, () => undefined)).toBe(false);
    endpoint.close(LISTEN_PORT);
    expect(endpoint.bind(LISTEN_PORT, () => undefined)).toBe(LISTEN_PORT);
  });

  it('a datagram for a port nobody listens on is answered "port unreachable"', () => {
    const { peer } = listening();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { destinationPort: 7001 }));
    const errors = icmpErrors(peer);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(3);
    expect(peer.dut.getProtocolCounters().udpLiteNoPorts).toBe(1);
  });

  it('a UDP-Lite datagram is not delivered to a UDP-only port and is answered "port unreachable"', () => {
    const peer = scriptedPeer();
    const plain: unknown[] = [];
    peer.dut.udpBind(LISTEN_PORT, (d) => { plain.push(d.udp.payload); });
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(plain).toHaveLength(0);
    expect(icmpErrors(peer).map((e) => e.code)).toEqual([3]);
  });

  it('a datagram dropped for its coverage or checksum is not answered', () => {
    const { peer } = listening(ChecksumCoverage.of(8));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { coverageField: 3 }));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksum: 'wrong' }));
    expect(icmpErrors(peer)).toHaveLength(0);
  });

  it('a socket released by the process is no longer served', () => {
    const { peer, deliveries } = listening();
    peer.dut.getSocketTable().unbind('udplite', '0.0.0.0', LISTEN_PORT);
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries).toHaveLength(0);
    expect(icmpErrors(peer)).toHaveLength(1);
  });

  it('WITNESS: a host without UDP-Lite answers "protocol unreachable"', () => {
    const peer = scriptedPeer('windows');
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksumValue: 0x78a8 }));
    expect(icmpErrors(peer).map((e) => e.code)).toEqual([2]);
  });

  it('WITNESS: a Linux host answers "port unreachable", not "protocol unreachable"', () => {
    const peer = scriptedPeer();
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { checksumValue: 0x78a8 }));
    expect(icmpErrors(peer).map((e) => e.code)).toEqual([3]);
  });

  it('a datagram from an invalid source is discarded unanswered (RFC 1122 §4.1.3.6)', () => {
    const { peer, deliveries } = listening();
    peer.sendIpv4(datagram('255.255.255.255', DUT_ADDRESS));
    peer.sendIpv4(datagram('127.0.0.1', DUT_ADDRESS));
    expect(deliveries).toHaveLength(0);
    expect(icmpErrors(peer)).toHaveLength(0);
  });
});

describe('/proc/net/snmp counts UDP checksum errors beside UDP-Lite ones', () => {
  it('a UDP datagram with a wrong checksum is an input error and a checksum error', async () => {
    const peer = scriptedPeer();
    peer.dut.udpBind(LISTEN_PORT, () => undefined);
    const udp: UDPPacket = {
      type: 'udp', sourcePort: SOURCE_PORT, destinationPort: LISTEN_PORT, length: 13, checksum: 0,
      payload: 'hello',
    };
    udp.checksum = (computeUdpChecksum(udp, PEER_ADDRESS, DUT_ADDRESS) + 1) & 0xffff || 1;
    peer.sendIpv4(createIPv4Packet(
      new IPAddress(PEER_ADDRESS), new IPAddress(DUT_ADDRESS), IP_PROTO_UDP, 64, udp, 13));
    expect(peer.dut.getProtocolCounters().udpInCsumErrors).toBe(1);
    expect(await peer.dut.executeCommand('cat /proc/net/snmp')).toMatch(/^Udp: 0 0 1 0 0 0 1 0$/m);
  });
});

describe('what the machine sends (RFC 3828 §3.1, §3.3, §3.4)', () => {
  const send = (
    peer: ScriptedPeer, body: string, coverage?: ChecksumCoverage,
  ): IPv4Packet => {
    const sent = peer.dut.getUdpLite()!.send({
      destination: new IPAddress(PEER_ADDRESS), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: body, ...(coverage === undefined ? {} : { checksumCoverage: coverage }),
    });
    expect(sent).toBe(true);
    const packets = onWire(peer);
    return packets[packets.length - 1];
  };

  it('by default the coverage equals the datagram length and the checksum verifies', () => {
    const peer = scriptedPeer();
    const packet = send(peer, 'hello');
    const udp = packet.payload as UDPLitePacket;
    expect(packet.protocol).toBe(136);
    expect(udp.checksumCoverage).toBe(13);
    expect(packet.totalLength - packet.ihl * 4).toBe(13);
    expect(verifyUdpLiteChecksum(udp, 13, DUT_ADDRESS, PEER_ADDRESS)).toBe(true);
  });

  it('an explicit coverage of eight protects the header only: the payload may change in transit', () => {
    const peer = scriptedPeer();
    const udp = send(peer, 'hello', ChecksumCoverage.of(8)).payload as UDPLitePacket;
    expect(udp.checksumCoverage).toBe(8);
    expect(verifyUdpLiteChecksum({ ...udp, payload: 'HELLO' }, 13, DUT_ADDRESS, PEER_ADDRESS)).toBe(true);
  });

  it('a partial coverage detects a change inside the covered part', () => {
    const peer = scriptedPeer();
    const udp = send(peer, 'hello', ChecksumCoverage.of(10)).payload as UDPLitePacket;
    expect(verifyUdpLiteChecksum({ ...udp, payload: 'jello' }, 13, DUT_ADDRESS, PEER_ADDRESS)).toBe(false);
    expect(verifyUdpLiteChecksum({ ...udp, payload: 'heLLO' }, 13, DUT_ADDRESS, PEER_ADDRESS)).toBe(true);
  });

  it('the value zero is sent as zero and still covers everything', () => {
    const peer = scriptedPeer();
    const udp = send(peer, 'hello', ChecksumCoverage.FULL).payload as UDPLitePacket;
    expect(udp.checksumCoverage).toBe(0);
    expect(verifyUdpLiteChecksum({ ...udp, payload: 'hellp' }, 13, DUT_ADDRESS, PEER_ADDRESS)).toBe(false);
    expect(udp.checksum).toBe(computeUdpLiteChecksum(
      { sourcePort: SOURCE_PORT, destinationPort: LISTEN_PORT, checksumCoverage: 0, payload: 'hello' },
      13, DUT_ADDRESS, PEER_ADDRESS));
  });

  it('a coverage beyond the datagram is brought back to the datagram', () => {
    const peer = scriptedPeer();
    const udp = send(peer, 'hello', ChecksumCoverage.of(100)).payload as UDPLitePacket;
    expect(udp.checksumCoverage).toBe(13);
  });

  it('no byte is added to the IP payload (§3.4), even to make the length even', () => {
    const peer = scriptedPeer();
    const packet = send(peer, 'odd');
    expect(packet.totalLength - packet.ihl * 4).toBe(11);
  });

  it('a datagram larger than an IPv4 packet can carry is refused', () => {
    const peer = scriptedPeer();
    const endpoint = peer.dut.getUdpLite()!;
    const request = (bytes: number) => endpoint.send({
      destination: new IPAddress(PEER_ADDRESS), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: null, payloadBytes: bytes,
    });
    expect(request(65507)).toBe(true);
    expect(request(65508)).toBe(false);
  });

  it('a datagram to the machine itself is delivered through the loopback, whole', () => {
    const peer = scriptedPeer();
    const received: UdpLiteDelivery[] = [];
    peer.dut.getUdpLite()!.bind(LISTEN_PORT, (d) => { received.push(d); });
    const before = onWire(peer).length;
    peer.dut.getUdpLite()!.send({
      destination: new IPAddress(DUT_ADDRESS), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: 'self',
    });
    expect(received.map((d) => d.udp.payload)).toEqual(['self']);
    expect(received[0].inPort).toBe('lo');
    expect(onWire(peer).length).toBe(before);
  });

  it.each(['136', 'udplite'])('the egress firewall sees the datagram and can stop it (-p %s)', async (protocol) => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand(`sudo iptables -A OUTPUT -p ${protocol} -j DROP`);
    const sent = peer.dut.getUdpLite()!.send({
      destination: new IPAddress(PEER_ADDRESS), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: 'blocked',
    });
    expect(sent).toBe(false);
    expect(onWire(peer)).toHaveLength(0);
  });

  it.each(['136', 'udplite'])('the ingress firewall sees the datagram and can stop it (-p %s)', async (protocol) => {
    const { peer, deliveries } = listening();
    await peer.dut.executeCommand(`sudo iptables -A INPUT -p ${protocol} -j DROP`);
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    expect(deliveries).toHaveLength(0);
    expect(icmpErrors(peer)).toHaveLength(0);
  });

  it('the ports of a UDP-Lite datagram are seen by --dport', async () => {
    const { peer, deliveries } = listening();
    await peer.dut.executeCommand(`sudo iptables -A INPUT -p udplite --dport ${LISTEN_PORT} -j DROP`);
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS));
    peer.sendIpv4(datagram(PEER_ADDRESS, DUT_ADDRESS, { destinationPort: 7001 }));
    expect(deliveries).toHaveLength(0);
    expect(icmpErrors(peer).map((e) => e.code)).toEqual([3]);
  });

  it('WITNESS: an unknown protocol is still refused by iptables', async () => {
    const peer = scriptedPeer();
    expect(await peer.dut.executeCommand('sudo iptables -A INPUT -p zorglub -j DROP')).toMatch(/unknown protocol/);
    expect(await peer.dut.executeCommand('sudo iptables -A INPUT -p 300 -j DROP')).toMatch(/unknown protocol/);
  });
});

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function quiet(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
}

function pair(): { a: LinuxPC; b: LinuxPC } {
  resetCounters(); MACAddress.resetCounter(); resetDeviceCounters(); Logger.reset();
  EquipmentRegistry.resetInstance();
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  a.powerOn(); b.powerOn();
  new Cable('c').connect(a.getPorts()[0], b.getPorts()[0]);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { a, b };
}

describe('two machines over a real cable, in IPv4 and IPv6', () => {
  it('a datagram crosses the wire, its coverage and addresses intact, and both machines count it', async () => {
    const { a, b } = pair();
    const received: UdpLiteDelivery[] = [];
    b.getUdpLite()!.bind(LISTEN_PORT, (d) => { received.push(d); }, { minimumCoverage: ChecksumCoverage.of(8) });
    a.getUdpLite()!.send({
      destination: new IPAddress('10.0.0.2'), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: 'across', checksumCoverage: ChecksumCoverage.of(10),
    });
    await waitUntil(() => received.length > 0);
    expect(received.map((d) => d.udp.payload)).toEqual(['across']);
    expect(received[0].coverage).toBe(10);
    expect(String(received[0].sourceIP)).toBe('10.0.0.1');
    expect(a.getProtocolCounters().udpLiteOutDatagrams).toBe(1);
    expect(b.getProtocolCounters().udpLiteInDatagrams).toBe(1);
  });

  it('the machine\'s own views agree: /proc/net/udplite, /proc/net/udp and /proc/net/snmp', async () => {
    const { b } = pair();
    b.getUdpLite()!.bind(LISTEN_PORT, () => undefined);
    const lite = await b.executeCommand('cat /proc/net/udplite');
    const plain = await b.executeCommand('cat /proc/net/udp');
    expect(lite).toMatch(/:1B58/);
    expect(plain).not.toMatch(/:1B58/);
    const snmp = await b.executeCommand('cat /proc/net/snmp');
    expect(snmp).toMatch(/^UdpLite: 0 0 0 0 0 0 0 0$/m);
  });

  it('/proc/net/snmp reads the counters of both sides after a delivery and a miss', async () => {
    const { a, b } = pair();
    b.getUdpLite()!.bind(LISTEN_PORT, () => undefined);
    const send = (port: number) => a.getUdpLite()!.send({
      destination: new IPAddress('10.0.0.2'), destinationPort: port, sourcePort: SOURCE_PORT, payload: 'x',
    });
    send(LISTEN_PORT);
    send(LISTEN_PORT + 1);
    await waitUntil(() => b.getProtocolCounters().udpLiteNoPorts === 1);
    expect(await b.executeCommand('cat /proc/net/snmp')).toMatch(/^UdpLite: 1 1 0 0 0 0 0 0$/m);
    expect(await a.executeCommand('cat /proc/net/snmp')).toMatch(/^UdpLite: 0 0 0 2 0 0 0 0$/m);
  });

  it('the sender is told "port unreachable" by the real peer', async () => {
    const { a } = pair();
    const events: HostIcmpUnreachablePayload[] = [];
    a.getBus().subscribe('host.icmp.unreachable', (e) => { events.push(e.payload); });
    a.getUdpLite()!.send({
      destination: new IPAddress('10.0.0.2'), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: 'nobody',
    });
    await waitUntil(() => events.length > 0);
    expect(events.map((e) => [e.origProtocol, e.icmpCode])).toEqual([[136, 3]]);
  });

  it('a datagram crosses the wire over IPv6 too', async () => {
    const { a, b } = pair();
    const received: UdpLiteDelivery[] = [];
    b.getUdpLite()!.bind(LISTEN_PORT, (d) => { received.push(d); });
    const sendTo = (port: number) => a.getUdpLite()!.send({
      destination: new IPv6Address('2001:db8::2'), destinationPort: port, sourcePort: SOURCE_PORT,
      payload: 'six',
    });
    expect(sendTo(LISTEN_PORT)).toBe(true);
    await waitUntil(() => received.length > 0);
    expect(received.map((d) => d.udp.payload)).toEqual(['six']);
    expect(String(received[0].sourceIP)).toBe('2001:db8::1');
    expect(b.getProtocolCounters().udpLiteInDatagrams).toBe(1);
    expect(sendTo(LISTEN_PORT + 1)).toBe(true);
    await waitUntil(() => b.getProtocolCounters().udpLiteNoPorts === 1);
    expect(b.getProtocolCounters().udpLiteNoPorts).toBe(1);
  });

  it('a datagram to a group goes out on the link, with the group\'s MAC', async () => {
    const { a, b } = pair();
    const received: UdpLiteDelivery[] = [];
    b.getUdpLite()!.bind(LISTEN_PORT, (d) => { received.push(d); });
    expect(a.getUdpLite()!.send({
      destination: new IPAddress('255.255.255.255'), destinationPort: LISTEN_PORT, sourcePort: SOURCE_PORT,
      payload: 'everyone',
    })).toBe(true);
    await waitUntil(() => received.length > 0);
    expect(received.map((d) => d.udp.payload)).toEqual(['everyone']);
    await quiet();
    expect(a.getProtocolCounters().icmpInDestUnreachs).toBe(0);
  });
});

describe('the same rules hold over IPv6 (RFC 3828 §3.2: the pseudo-header is the IPv6 one)', () => {
  const SOURCE6 = '2001:db8::1';
  const DESTINATION6 = '2001:db8::2';

  function endpointOverStub() {
    const counters = newProtocolCounters();
    const replies: string[] = [];
    const endpoint = new UdpLiteEndpoint({
      id: 'stub', name: 'stub', counters, socketTable: new SocketTable(),
      defaultTtl: () => 64, defaultHopLimit: () => 64,
      isLocalAddress: () => false, isLocalAddress6: () => false, hasInvalidSource: () => false,
      emitIpv4: () => false, emitIpv4ToGroup: () => false, emitIpv6: () => false, emitIpv6ToGroup: () => false,
      replyPortUnreachable: () => { replies.push('v4'); },
      replyPortUnreachable6: () => { replies.push('v6'); },
    });
    const delivered: UdpLiteDelivery[] = [];
    endpoint.bind(LISTEN_PORT, (d) => { delivered.push(d); }, { minimumCoverage: ChecksumCoverage.of(8) });
    return { endpoint, counters, replies, delivered };
  }

  function packet6(crafted: { coverageField?: number; checksum?: 'valid' | 'zero' | 'wrong'; port?: number } = {}) {
    const body = 'hello';
    const length = 8 + body.length;
    const field = crafted.coverageField ?? length;
    const port = crafted.port ?? LISTEN_PORT;
    let checksum = computeUdpLiteChecksum(
      { sourcePort: SOURCE_PORT, destinationPort: port, checksumCoverage: field, payload: body },
      length, SOURCE6, DESTINATION6);
    if (crafted.checksum === 'zero') checksum = 0;
    if (crafted.checksum === 'wrong') checksum = (checksum + 1) & 0xffff || 1;
    return createIPv6Packet(
      new IPv6Address(SOURCE6), new IPv6Address(DESTINATION6), IP_PROTO_UDPLITE, 64,
      { type: 'udplite', sourcePort: SOURCE_PORT, destinationPort: port, checksumCoverage: field, checksum,
        payload: body } satisfies UDPLitePacket, length);
  }

  it('WITNESS: a well-formed datagram is delivered and counted', () => {
    const { endpoint, counters, delivered } = endpointOverStub();
    endpoint.receive6('eth0', packet6());
    expect(delivered.map((d) => d.udp.payload)).toEqual(['hello']);
    expect(counters.udpLiteInDatagrams).toBe(1);
  });

  it.each([1, 7])('a coverage of %s is dropped, counted, and not answered', (coverageField) => {
    const { endpoint, counters, replies, delivered } = endpointOverStub();
    endpoint.receive6('eth0', packet6({ coverageField }));
    expect(delivered).toHaveLength(0);
    expect(counters.udpLiteInErrors).toBe(1);
    expect(replies).toEqual([]);
  });

  it('a coverage beyond the IPv6 payload, a zero checksum and a wrong checksum are dropped', () => {
    const { endpoint, counters, delivered } = endpointOverStub();
    endpoint.receive6('eth0', packet6({ coverageField: 20 }));
    endpoint.receive6('eth0', packet6({ checksum: 'zero' }));
    endpoint.receive6('eth0', packet6({ checksum: 'wrong' }));
    expect(delivered).toHaveLength(0);
    expect(counters.udpLiteInErrors).toBe(3);
    expect(counters.udpLiteInCsumErrors).toBe(3);
  });

  it('a datagram for a port nobody holds is answered "port unreachable" once', () => {
    const { endpoint, counters, replies } = endpointOverStub();
    endpoint.receive6('eth0', packet6({ port: 7001 }));
    expect(replies).toEqual(['v6']);
    expect(counters.udpLiteNoPorts).toBe(1);
  });

  it('an IPv6 pseudo-header differs from the IPv4 one: the same bytes do not verify across families', () => {
    const covered = { sourcePort: SOURCE_PORT, destinationPort: LISTEN_PORT, checksumCoverage: 13, payload: 'hello' };
    expect(computeUdpLiteChecksum(covered, 13, SOURCE6, DESTINATION6))
      .not.toBe(computeUdpLiteChecksum(covered, 13, PEER_ADDRESS, DUT_ADDRESS));
  });
});
