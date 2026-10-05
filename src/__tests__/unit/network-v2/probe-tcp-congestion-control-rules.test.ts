/**
 * Les regles de la RFC 5681 que la pile n'appliquait pas : la fenetre
 * initiale exacte, la fenetre d'un seul segment apres un SYN perdu, ce qui
 * est un ACK duplique, l'envoi limite des deux premiers, le redemarrage
 * apres une longue inactivite, et la fenetre qui suit la taille de segment.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - la fenetre initiale etait `min(4 SMSS, max(2 SMSS, 4380))`, la formule
 *     de la RFC 3390, que la RFC 5681 §3.1 remplace par trois cas : 2 SMSS
 *     au-dela de 2190 octets, 3 SMSS de 1096 a 2190, 4 SMSS jusqu'a 1095.
 *     Pour un SMSS de 1500 la pile ouvrait 4380 octets au lieu de 4500 (la
 *     premiere volee finissait par un segment de 1380 octets), pour 1096 elle
 *     en ouvrait 4380 au lieu de 3288, pour 2190 4380 au lieu de 6570 ;
 *   - apres un SYN ou un SYN-ACK retransmis, la fenetre initiale etait celle
 *     d'une connexion saine (trois segments) ;
 *   - tout ACK sans donnee portant le numero de SND.UNA etait un « ACK
 *     duplique », meme quand il annoncait une autre fenetre : trois mises a
 *     jour de fenetre de suite declenchaient une retransmission rapide ;
 *   - aux deux premiers ACK dupliques, rien ne partait ; un emetteur SACK n'avait
 *     de toute facon aucun moyen de savoir si l'ACK dupliquait de
 *     l'information neuve, puisque les blocs SACK recus n'etaient pas lus ;
 *   - une connexion restee muette plus longtemps que le RTO repartait avec
 *     la fenetre de congestion qu'elle avait laissee, pleine volee comprise ;
 *   - un MSS reduit par la decouverte de MTU de chemin laissait la fenetre de
 *     congestion et le pas de croissance de l'ancienne taille.
 *
 * Autorite : RFC 5681 §3.1 (« IW, the initial value of cwnd, MUST be set
 * using the following guidelines as an upper bound » ; « if the SYN or
 * SYN/ACK is lost, the initial window used by a sender after a correctly
 * transmitted SYN MUST be one segment consisting of at most SMSS bytes » ;
 * « cwnd SHOULD be reduced by the ratio of the old segment size to the new
 * segment size » quand le MSS est ramene par la decouverte de MTU de chemin),
 * §2 (un ACK duplique : l'emetteur a des donnees en transit, l'ACK n'en porte
 * pas, SYN et FIN sont leves, son numero est le plus grand recu, et « the
 * advertised window in the incoming acknowledgment equals the advertised
 * window in the last incoming acknowledgment »), §3.2 etape 1 (« On the first
 * and second duplicate ACKs received at a sender, a TCP SHOULD send a segment
 * of previously unsent data per [RFC3042] provided that the receiver's
 * advertised window allows, the total FlightSize would remain less than or
 * equal to cwnd plus 2*SMSS » ; « a sender using SACK [RFC2018] MUST NOT send
 * new data unless the incoming duplicate acknowledgment contains new SACK
 * information » ; l'envoi limite ne change pas cwnd), §4.1 (« a TCP SHOULD
 * set cwnd to no more than RW before beginning transmission if the TCP has
 * not sent data in an interval exceeding the retransmission timeout », RW =
 * min(IW, cwnd)) ; RFC 2018 (les blocs SACK recus doivent etre effaces a un
 * RTO : le recepteur peut les avoir retires).
 *
 * Ce qui est construit : `initialCongestionWindow` exacte et `initialize(mss,
 * handshakeLost)` ; le critere de l'ACK duplique complete (SYN leve, fenetre
 * inchangee) ; `SackScoreboard`, qui retient les plages acquittees
 * selectivement, signale une information neuve, se purge a mesure que SND.UNA
 * avance et se vide au RTO ; l'envoi limite (`limitedTransmit` : un credit par
 * ACK duplique, au plus deux, depense sous cwnd + 2 SMSS, rendu a zero a la fin
 * de la rafale — la livraison etant synchrone, l'ACK arrive DANS la boucle
 * d'envoi, d'ou un credit plutot qu'un appel) ; `restartAfterIdle` ;
 * `setSegmentSize`.
 *
 * Ce qui n'est PAS construit, et pourquoi : la reprise sur pertes par SACK
 * (retransmettre les trous, RFC 6675) et NewReno (RFC 6582) — ni l'une ni
 * l'autre n'est fournie, la pile garde la retransmission rapide de la seule
 * tete de file de la RFC 5681 ; l'ECN (RFC 3168, absente ; la RFC 8311, qui
 * la relache, n'a pas de sens sans elle) ; la fenetre initiale de 10 segments
 * de la RFC 6928, non fournie.
 *
 * Discrimination (fichier copie sur le commit precedent) : DOUZE cas sur vingt-deux
 * tombent. Les DIX autres passent des deux cotes : les cinq TEMOINS de la
 * fonction de fenetre initiale (536, 1095, 1460, 2191 et 9000 octets, ou la
 * formule de la RFC 3390 et celle de la RFC 5681 s'accordent), le TEMOIN
 * d'une poignee de main sans perte (fenetre pleine), le TEMOIN de trois
 * doublons identiques qui retransmettent, les deux cas d'un emetteur SACK qui
 * n'envoie rien sur un doublon sans information neuve — vrais avant parce
 * que rien n'envoyait jamais —, et le TEMOIN d'une connexion qui n'a pas ete
 * silencieuse et garde la fenetre qu'elle a gagnee.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, lettersOf, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import { initialCongestionWindow, TcpCongestionControl } from '@/network/tcp/TcpCongestionControl';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import type { TcpOption, TcpSegment } from '@/network/tcp/types';

const MSS = 1460;
const SACK_OFFER: TcpOption[] = [{ kind: 'mss', value: MSS }, { kind: 'sack-permitted' }];

function dataOf(segments: TcpSegment[]): TcpSegment[] {
  return segments.filter((s) => s.payload !== undefined);
}

function sizesOf(segments: TcpSegment[]): number[] {
  return dataOf(segments).map((s) => payloadBytes(s.payload).length);
}

function sender(options: TcpOption[] = [{ kind: 'mss', value: MSS }], backlog = 20000): {
  peer: ScriptedPeer; connection: OpenConnection; firstFlight: TcpSegment[];
} {
  const peer = scriptedPeer();
  const connection = openActive(peer, options);
  connection.socket.setNoDelay(true);
  connection.socket.write('a'.repeat(backlog));
  return { peer, connection, firstFlight: dataOf(peer.take()) };
}

function acknowledge(
  peer: ScriptedPeer, connection: OpenConnection, ack: number, window = 65535, options: TcpOption[] = [],
): void {
  peer.send({
    flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: ack, window, options,
  });
}

describe('the initial window is the one RFC 5681 §3.1 gives', () => {
  it.each([[1096, 3288], [1500, 4500], [2190, 6570]])(
    'a segment size of %s opens %s bytes, which the RFC 3390 formula did not give', (mss, expected) => {
      expect(initialCongestionWindow(mss)).toBe(expected);
    });

  it.each([[536, 2144], [1095, 4380], [1460, 4380], [2191, 4382], [9000, 18000]])(
    'WITNESS: a segment size of %s opens %s bytes', (mss, expected) => {
      expect(initialCongestionWindow(mss)).toBe(expected);
    });

  it('a 1500-byte segment size sends three full segments in the first flight', () => {
    const peer = scriptedPeer();
    peer.dut.getPort('eth0')!.setMTU(1540);
    const connection = openActive(peer, [{ kind: 'mss', value: 1500 }]);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(20000));
    expect(sizesOf(peer.take())).toEqual([1500, 1500, 1500]);
  });
});

describe('after a lost SYN the window is one segment (RFC 5681 §3.1)', () => {
  it('active open: the SYN is retransmitted, the first flight is one segment', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect('10.0.0.2', peer.ports.peer)!;
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    peer.advance(1100);
    expect(peer.take().filter((s) => lettersOf(s.flags) === 'S').length).toBeGreaterThan(0);
    peer.send({
      flags: 'SA', sequence: 7_000_000, acknowledgement: syn.sequence + 1,
      options: [{ kind: 'mss', value: MSS }],
    });
    peer.clear();
    socket.setNoDelay(true);
    socket.write('a'.repeat(20000));
    expect(sizesOf(peer.take())).toEqual([MSS]);
  });

  it('passive open: the SYN-ACK is retransmitted, the first flight is one segment', () => {
    const peer = scriptedPeer();
    const accepted: { socket: import('@/network/tcp/TcpStack').TcpSocket }[] = [];
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (socket) => { accepted.push({ socket }); } });
    peer.send({ flags: 'S', sequence: 7_000_000, options: [{ kind: 'mss', value: MSS }] });
    const synAck = peer.last()!;
    peer.advance(1100);
    expect(peer.take().filter((s) => lettersOf(s.flags) === 'SA').length).toBeGreaterThan(0);
    peer.send({ flags: 'A', sequence: 7_000_001, acknowledgement: synAck.sequence + 1 });
    peer.clear();
    accepted[0].socket.setNoDelay(true);
    accepted[0].socket.write('a'.repeat(20000));
    expect(sizesOf(peer.take())).toEqual([MSS]);
  });

  it('WITNESS: a handshake without loss opens the full window', () => {
    const { firstFlight } = sender();
    expect(firstFlight.map((s) => payloadBytes(s.payload).length)).toEqual([MSS, MSS, MSS]);
  });
});

describe('what a duplicate acknowledgement is (RFC 5681 §2)', () => {
  it('three acknowledgements at SND.UNA that each announce another window are not duplicates', () => {
    const { peer, connection } = sender();
    const start = connection.dutIsn + 1;
    acknowledge(peer, connection, start, 65000);
    acknowledge(peer, connection, start, 64000);
    acknowledge(peer, connection, start, 63000);
    expect(dataOf(peer.take()).filter((s) => s.sequence === start)).toHaveLength(0);
  });

  it('WITNESS: three identical duplicates retransmit the lost segment', () => {
    const { peer, connection } = sender();
    const start = connection.dutIsn + 1;
    acknowledge(peer, connection, start);
    acknowledge(peer, connection, start);
    acknowledge(peer, connection, start);
    expect(dataOf(peer.take()).filter((s) => s.sequence === start)).toHaveLength(1);
  });
});

describe('the first two duplicates release new data (RFC 5681 §3.2 step 1, RFC 3042)', () => {
  it('each of the first two duplicate ACKs sends one segment of unsent data', () => {
    const { peer, connection, firstFlight } = sender();
    const start = connection.dutIsn + 1;
    const next = start + firstFlight.reduce((sum, s) => sum + payloadBytes(s.payload).length, 0);
    acknowledge(peer, connection, start);
    const afterFirst = dataOf(peer.take());
    expect(afterFirst.map((s) => s.sequence)).toEqual([next]);
    acknowledge(peer, connection, start);
    const afterSecond = dataOf(peer.take());
    expect(afterSecond.map((s) => s.sequence)).toEqual([next + MSS]);
    acknowledge(peer, connection, start);
    expect(dataOf(peer.take()).map((s) => s.sequence)).toEqual([start]);
  });

  it('a SACK sender sends nothing on a duplicate that carries no new SACK information', () => {
    const { peer, connection } = sender(SACK_OFFER);
    const start = connection.dutIsn + 1;
    acknowledge(peer, connection, start);
    expect(dataOf(peer.take())).toHaveLength(0);
  });

  it('a SACK sender sends one segment on a duplicate that reports a new block', () => {
    const { peer, connection, firstFlight } = sender(SACK_OFFER);
    const start = connection.dutIsn + 1;
    const next = start + firstFlight.reduce((sum, s) => sum + payloadBytes(s.payload).length, 0);
    acknowledge(peer, connection, start, 65535, [
      { kind: 'sack', blocks: [{ start: start + MSS, end: start + 2 * MSS }] },
    ]);
    expect(dataOf(peer.take()).map((s) => s.sequence)).toEqual([next]);
  });

  it('a SACK block already known is not new information', () => {
    const { peer, connection } = sender(SACK_OFFER);
    const start = connection.dutIsn + 1;
    const block: TcpOption = { kind: 'sack', blocks: [{ start: start + MSS, end: start + 2 * MSS }] };
    acknowledge(peer, connection, start, 65535, [block]);
    peer.take();
    acknowledge(peer, connection, start, 65535, [block]);
    expect(dataOf(peer.take())).toHaveLength(0);
  });
});

describe('a connection silent for longer than the RTO restarts from the restart window (RFC 5681 §4.1)', () => {
  it('after growing, going quiet for 2 s, the first flight is the initial window again', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }]);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(60000));
    let acknowledged = connection.dutIsn + 1;
    for (let round = 0; round < 4; round++) {
      const flight = dataOf(peer.take());
      if (flight.length === 0) break;
      for (const segment of flight) {
        acknowledged = segment.sequence + payloadBytes(segment.payload).length;
        acknowledge(peer, connection, acknowledged);
      }
    }
    peer.take();
    peer.advance(2000);
    connection.socket.write('b'.repeat(60000));
    expect(sizesOf(peer.take()).reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(initialCongestionWindow(MSS));
  });

  it('WITNESS: a connection that has not been quiet keeps the window it grew', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }]);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(60000));
    let acknowledged = connection.dutIsn + 1;
    let largest = 0;
    for (let round = 0; round < 4; round++) {
      const flight = dataOf(peer.take());
      if (flight.length === 0) break;
      largest = Math.max(largest, flight.reduce((sum, s) => sum + payloadBytes(s.payload).length, 0));
      for (const segment of flight) {
        acknowledged = segment.sequence + payloadBytes(segment.payload).length;
        acknowledge(peer, connection, acknowledged);
      }
    }
    expect(largest).toBeGreaterThan(initialCongestionWindow(MSS));
  });
});

describe('the window follows the segment size (RFC 5681 §3.1)', () => {
  it('a segment size cut from 1460 to 960 cuts cwnd by the same ratio', () => {
    const control = new TcpCongestionControl(MSS);
    control.setSegmentSize(960);
    expect(control.cwnd).toBe(Math.floor((initialCongestionWindow(MSS) * 960) / MSS));
  });

  it('a larger segment size does not grow cwnd', () => {
    const control = new TcpCongestionControl(960);
    const before = control.cwnd;
    control.setSegmentSize(1460);
    expect(control.cwnd).toBe(before);
  });
});
