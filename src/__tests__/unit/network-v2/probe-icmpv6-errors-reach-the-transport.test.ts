/**
 * Une erreur ICMPv6 atteint la connexion TCP qu'elle cite, comme une erreur
 * ICMP : les codes durs la ferment, les codes doux la signalent, un Packet Too
 * Big reduit la taille des segments et la route en garde la trace.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE IPv6 qui forge les erreurs et
 * cite le segment que le DUT vient d'envoyer :
 *
 *   - `EndHost.handleICMPv6Error` ne faisait que reveiller un `ping6` en
 *     attente : aucune erreur ICMPv6 n'atteignait la pile TCP. Un « port
 *     unreachable » laissait la connexion en vie, un « no route » ne laissait
 *     aucune trace dans `onErrorReport`, et un « Packet Too Big » n'etait pas
 *     meme examine (le type n'etait pas dans l'aiguillage) ;
 *   - l'hote ne publiait pas `host.icmp.unreachable` pour ICMPv6 (le routeur
 *     le faisait deja), si bien que ni la capture ni un scanneur ne voyaient
 *     ces erreurs ;
 *   - aucune memoire de chemin : un deuxieme TCP vers la meme destination
 *     repartait sur la MTU du lien ;
 *   - cote IPv4 et IPv6, une erreur citant un numero de sequence hors de la
 *     fenetre d'emission (RFC 5927 §4.1) etait executee comme les autres :
 *     n'importe qui voyant le quadruplet fermait la connexion.
 *
 * Autorite (docs/rfc/tcp/rfc9293.txt, docs/rfc/icmp/rfc4443.txt et
 * rfc8200.txt, lues) : RFC 9293 §3.9.2.2 (« This applies to ICMPv6 in
 * addition to IPv4 ICMP » ; erreurs douces ICMPv6 : Destination Unreachable
 * codes 0 et 3, Time Exceeded codes 0 et 1 — « a TCP implementation MUST NOT
 * abort the connection (MUST-56), and it SHOULD make the information
 * available to the application (SHLD-25) » ; erreurs dures : « TCP
 * implementations SHOULD abort the connection (SHLD-26) ») ; RFC 4443 §2.4 (d)
 * et §3.1 a §3.3 (« Upper Layer Notification » : un Destination Unreachable,
 * un Packet Too Big, un Time Exceeded recus DOIVENT etre remis au processus de
 * la couche superieure) ; RFC 8200 §5 (MTU minimale de liaison de 1280
 * octets). Pour ce que la RFC laisse a l'implementation, la source du noyau
 * Linux (raw.githubusercontent.com, joignable) : `icmpv6_err_convert` classe
 * « no route » et « address unreachable » (et le code reserve 2) en erreurs non
 * fatales, « admin prohibited », « port unreachable », « policy failed » et
 * « reject route » en erreurs fatales ; `__ip6_rt_update_pmtu` ignore un MTU
 * inferieur a 1280 et un MTU qui n'est pas inferieur a celui deja connu, et
 * garde l'exception 600 s (`ip6_rt_mtu_expires`) ; `tcp_v6_err` ignore une
 * erreur dont le numero de sequence cite n'est pas entre SND.UNA et SND.NXT
 * (RFC 5927 §4.1) et un Packet Too Big annonce sous 1280.
 *
 * Choix assume, ecrit plutot que tu : les codes ICMPv6 inconnus (au-dela de 6)
 * sont traites comme doux, la RFC 9293 ne les classant pas ; et, comme pour
 * IPv4, une erreur douce en SYN-SENT n'abandonne pas l'ouverture (lettre de
 * MUST-56) alors que le noyau la fait echouer tout de suite.
 *
 * Discrimination (fichier copie sur le commit precedent, avec l'aide
 * `tcpScriptedPeer.ts` etendue) : VINGT ET UN cas sur vingt-neuf tombent. Les
 * HUIT autres passent des deux cotes : les TEMOINS (le laboratoire est IPv6 et
 * une connexion etablie y met ses donnees sur le fil ; les adresses du
 * laboratoire), la NON-REGRESSION d'une erreur qui ne cite aucune de nos
 * connexions, et cinq cas STRUCTURELS que la base passe parce qu'elle
 * n'execute aucune erreur ICMPv6 : une erreur dure dont le numero de sequence
 * est hors de la fenetre d'emission ou deja acquitte laisse la connexion en
 * vie (deux cas), un Packet Too Big n'est pas une erreur pour l'application,
 * un MTU sous 1280 et un MTU qui n'est pas plus petit que celui du lien ne
 * changent rien. Le cas « une connexion IPv4 est protegee de la meme facon »
 * tombe : l'erreur IPv4 citant une sequence hors fenetre fermait la
 * connexion.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, PEER_ADDRESS_V6, DUT_ADDRESS_V6, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import { IPv6Address, IP_PROTO_ICMPV6, IP_PROTO_TCP, createIPv6Packet, type ICMPv6Packet } from '@/network/core/types';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TcpSegment } from '@/network/tcp/types';

const FULL = 1440;
const MIN_IPV6_MTU = 1280;
const MSS_AT_MIN_MTU = MIN_IPV6_MTU - 40 - 20;

interface Reported { source: string; icmpType?: string; code?: number; from?: string }

function reportsOf(socket: TcpSocket): Reported[] {
  const reports: Reported[] = [];
  socket.onErrorReport((report) => reports.push(report as Reported));
  return reports;
}

function dataOf(peer: ScriptedPeer): TcpSegment[] {
  return peer.replies.filter((segment) => segment.payload !== undefined && String(segment.payload).length > 0);
}

function lastData(peer: ScriptedPeer): TcpSegment {
  return dataOf(peer).at(-1)!;
}

function established(): { peer: ScriptedPeer; socket: TcpSocket } {
  const peer = scriptedPeer('linux', 'ipv6');
  const connection = openPassive(peer, [{ kind: 'mss', value: FULL }]);
  connection.socket.setNoDelay(true);
  return { peer, socket: connection.socket };
}

function withUnackedData(): { peer: ScriptedPeer; socket: TcpSocket } {
  const lab = established();
  lab.socket.send('hello');
  return lab;
}

function withOversizedSegment(): { peer: ScriptedPeer; socket: TcpSocket; bounced: TcpSegment } {
  const lab = established();
  lab.peer.clear();
  lab.socket.send('x'.repeat(FULL));
  return { ...lab, bounced: lastData(lab.peer) };
}

describe('an ICMPv6 error reaches a connection by what it says (RFC 9293 §3.9.2.2, RFC 4443 §2.4 (d))', () => {
  it('WITNESS: the lab is IPv6 and an established connection puts its data on the wire', () => {
    const { peer, socket } = withUnackedData();
    expect(socket.family).toBe('ipv6');
    expect(socket.remoteIp).toBe(PEER_ADDRESS_V6);
    expect(String(lastData(peer).payload)).toBe('hello');
  });

  it.each([
    [1, 'administratively prohibited'],
    [4, 'port unreachable'],
    [5, 'source address failed policy'],
    [6, 'reject route'],
  ])('code %i (%s) is a hard error and closes an established connection (SHLD-26)', (code) => {
    const { peer, socket } = withUnackedData();
    peer.sendIcmpv6Error('destination-unreachable', code, lastData(peer));
    expect(socket.closed).toBe(true);
  });

  it.each([
    [0, 'no route to destination'],
    [2, 'beyond scope of source address'],
    [3, 'address unreachable'],
  ])('code %i (%s) is a soft error: the connection stays and the application is told (MUST-56, SHLD-25)', (code) => {
    const { peer, socket } = withUnackedData();
    const reports = reportsOf(socket);
    peer.sendIcmpv6Error('destination-unreachable', code, lastData(peer));
    expect(socket.state).toBe('established');
    expect(reports).toEqual([{
      source: 'icmp', icmpType: 'destination-unreachable', code, from: PEER_ADDRESS_V6,
    }]);
  });

  it.each([[0, 'hop limit exceeded in transit'], [1, 'fragment reassembly time exceeded']])(
    'time exceeded code %i (%s) is soft too, and reported', (code) => {
      const { peer, socket } = withUnackedData();
      const reports = reportsOf(socket);
      peer.sendIcmpv6Error('time-exceeded', code, lastData(peer));
      expect(socket.state).toBe('established');
      expect(reports.map((report) => [report.icmpType, report.code])).toEqual([['time-exceeded', code]]);
    });

  it('a connection attempt is refused by a port unreachable', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS_V6, peer.ports.peer)!;
    peer.sendIcmpv6Error('destination-unreachable', 4, peer.last()!);
    expect(socket.closed).toBe(true);
    expect(socket.connectRefused).toBe(true);
    expect(socket.connectProhibited).toBe(false);
  });

  it('a connection attempt met by an administrative prohibition is reported as prohibited', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS_V6, peer.ports.peer)!;
    peer.sendIcmpv6Error('destination-unreachable', 1, peer.last()!);
    expect(socket.closed).toBe(true);
    expect(socket.connectProhibited).toBe(true);
  });

  it('an error that quotes no connection of ours changes nothing', () => {
    const { peer, socket } = withUnackedData();
    const stranger: TcpSegment = { ...lastData(peer), sourcePort: 41234 };
    peer.sendIcmpv6Error('destination-unreachable', 4, stranger);
    expect(socket.state).toBe('established');
  });
});

describe('an error whose quoted sequence number is not in flight is ignored (RFC 5927 §4.1)', () => {
  it('a hard error quoting a sequence number far beyond SND.NXT leaves the connection up', () => {
    const { peer, socket } = withUnackedData();
    const forged: TcpSegment = { ...lastData(peer), sequence: (lastData(peer).sequence + 1_000_000) >>> 0 };
    peer.sendIcmpv6Error('destination-unreachable', 4, forged);
    expect(socket.state).toBe('established');
  });

  it('a hard error quoting data the peer already acknowledged leaves the connection up', () => {
    const { peer, socket } = withUnackedData();
    const sent = lastData(peer);
    peer.send({ flags: 'A', sequence: socket.recvNext, acknowledgement: (sent.sequence + 5) >>> 0 });
    peer.sendIcmpv6Error('destination-unreachable', 4, sent);
    expect(socket.state).toBe('established');
  });

  it('the drop is visible on the bus', () => {
    const { peer, socket } = withUnackedData();
    const drops: string[] = [];
    peer.bus.subscribe('tcp.segment.dropped', (event) => drops.push(event.payload.reason));
    peer.sendIcmpv6Error('destination-unreachable', 4, { ...lastData(peer), sequence: 12345 });
    expect(drops).toEqual(['icmp-out-of-window']);
    expect(socket.state).toBe('established');
  });

  it('an IPv4 connection is protected the same way', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    connection.socket.send('hello');
    const sent = peer.replies.at(-1)!;
    peer.sendIcmpError('destination-unreachable', 3, { ...sent, sequence: 12345 });
    expect(connection.socket.state).toBe('established');
    peer.sendIcmpError('destination-unreachable', 3, sent);
    expect(connection.socket.closed).toBe(true);
  });
});

describe('Packet Too Big shrinks the segments and the path remembers it (RFC 4443 §3.2, RFC 8200 §5)', () => {
  it('the bounced segment is sent again in pieces that fit, and nothing is lost', () => {
    const { peer, socket, bounced } = withOversizedSegment();
    expect(bounced.payload).toBeDefined();
    expect(String(bounced.payload).length).toBe(FULL);
    peer.clear();
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, MIN_IPV6_MTU);
    expect(socket.mss).toBe(MSS_AT_MIN_MTU);
    const resent = dataOf(peer);
    expect(resent.map((segment) => String(segment.payload).length)).toEqual([MSS_AT_MIN_MTU, FULL - MSS_AT_MIN_MTU]);
    expect(resent[0].sequence).toBe(bounced.sequence);
    expect((resent[0].sequence + MSS_AT_MIN_MTU) >>> 0).toBe(resent[1].sequence);
  });

  it('a Packet Too Big is no error for the application: nothing is reported and the connection stays', () => {
    const { peer, socket, bounced } = withOversizedSegment();
    const reports = reportsOf(socket);
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1400);
    expect(reports).toEqual([]);
    expect(socket.state).toBe('established');
  });

  it('a MTU below the IPv6 minimum of 1280 is ignored', () => {
    const { peer, socket, bounced } = withOversizedSegment();
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1000);
    expect(socket.mss).toBe(FULL);
    expect(peer.dut.routeException(new IPv6Address(PEER_ADDRESS_V6))).toBeNull();
  });

  it('a MTU that is not smaller than the link MTU changes nothing', () => {
    const { peer, socket, bounced } = withOversizedSegment();
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1500);
    expect(socket.mss).toBe(FULL);
    expect(peer.dut.routeException(new IPv6Address(PEER_ADDRESS_V6))).toBeNull();
  });

  it('the destination keeps the reported MTU for ten minutes, then forgets it', () => {
    const { peer, bounced } = withOversizedSegment();
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1400);
    const destination = new IPv6Address(PEER_ADDRESS_V6);
    const remembered = peer.dut.routeException(destination);
    expect(remembered?.mtu).toBe(1400);
    expect(remembered?.locked).toBe(false);
    expect(remembered?.expiresInMs).toBe(600_000);
    peer.advance(599_000);
    expect(peer.dut.routeException(destination)?.mtu).toBe(1400);
    peer.advance(2_000);
    expect(peer.dut.routeException(destination)).toBeNull();
  });

  it('a Packet Too Big quoting a destination with a zone is remembered for the destination without one', () => {
    const { peer, bounced } = withOversizedSegment();
    const quoted = createIPv6Packet(
      new IPv6Address(DUT_ADDRESS_V6), new IPv6Address(PEER_ADDRESS_V6).withScopeId('eth0'), IP_PROTO_TCP, 64,
      bounced, bounced.dataOffset * 4 + payloadBytes(bounced.payload).length);
    const report: ICMPv6Packet = { type: 'icmpv6', icmpType: 'packet-too-big', code: 0, invokingPacket: quoted, mtu: 1400 };
    peer.sendIpv6(createIPv6Packet(
      new IPv6Address(PEER_ADDRESS_V6), new IPv6Address(DUT_ADDRESS_V6), IP_PROTO_ICMPV6, 64, report, 48));
    expect(peer.dut.routeException(new IPv6Address(PEER_ADDRESS_V6))?.mtu).toBe(1400);
    expect(peer.dut.routeException(new IPv6Address(PEER_ADDRESS_V6).withScopeId('eth0'))?.mtu).toBe(1400);
  });

  it('a later report may only lower the remembered MTU', () => {
    const { peer, bounced } = withOversizedSegment();
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1400);
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1450);
    expect(peer.dut.routeException(new IPv6Address(PEER_ADDRESS_V6))?.mtu).toBe(1400);
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, 1300);
    expect(peer.dut.routeException(new IPv6Address(PEER_ADDRESS_V6))?.mtu).toBe(1300);
  });

  it('a connection opened afterwards starts with the segment size the path allows', () => {
    const { peer, bounced } = withOversizedSegment();
    peer.sendIcmpv6Error('packet-too-big', 0, bounced, MIN_IPV6_MTU);
    peer.clear();
    peer.send({ flags: 'S', sequence: 9_000_000, sourcePort: 41001, options: [{ kind: 'mss', value: FULL }] });
    const synAck = peer.last()!;
    const mss = synAck.options.find((option) => option.kind === 'mss');
    expect(mss).toEqual({ kind: 'mss', value: MSS_AT_MIN_MTU });
  });
});

describe('every ICMPv6 error is published on the machine bus (RFC 4443 §2.4 (d))', () => {
  function published(emit: (peer: ScriptedPeer, segment: TcpSegment) => void) {
    const { peer } = withUnackedData();
    const events: Array<{ fromIp: string; code: string; icmpCode?: number; mtu?: number; icmpType?: string }> = [];
    peer.bus.subscribe('host.icmp.unreachable', (event) => events.push(event.payload));
    emit(peer, lastData(peer));
    return events;
  }

  it('destination unreachable, with the code named the way the IPv4 event names it', () => {
    const events = published((peer, segment) => peer.sendIcmpv6Error('destination-unreachable', 4, segment));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromIp: PEER_ADDRESS_V6, code: 'port-unreachable', icmpCode: 4 });
  });

  it('time exceeded', () => {
    const events = published((peer, segment) => peer.sendIcmpv6Error('time-exceeded', 0, segment));
    expect(events[0]).toMatchObject({ code: 'ttl-exceeded', icmpType: 'time-exceeded' });
  });

  it('packet too big, with the reported MTU', () => {
    const events = published((peer, segment) => peer.sendIcmpv6Error('packet-too-big', 0, segment, 1400));
    expect(events[0]).toMatchObject({ code: 'frag-needed', mtu: 1400 });
  });
});

describe('WITNESS: the destination of the lab', () => {
  it('names the addresses the probe reasons about', () => {
    expect(new IPv6Address(DUT_ADDRESS_V6).toString()).toBe(DUT_ADDRESS_V6);
    expect(new IPv6Address(PEER_ADDRESS_V6).toString()).toBe(PEER_ADDRESS_V6);
  });
});
