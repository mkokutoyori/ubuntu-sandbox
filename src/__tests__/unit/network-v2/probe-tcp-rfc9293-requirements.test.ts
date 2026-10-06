/**
 * Les exigences de la RFC 9293 (annexe B), de la RFC 2018 §4 et de la RFC 6298
 * qu'aucune autre sonde ne porte.
 *
 * Chaque cas porte, dans son titre, le numero de l'exigence qu'il mesure.
 * Pair SCRIPTE : le DUT et un port nu dont on forge chaque segment.
 *
 * Mesure de depart (commit precedent) : les exigences de l'annexe B qu'aucune sonde
 * ne portait ont ete mesurees contre la pile. Celles deja tenues sont
 * epinglees ici (non-regression) ; deux ecarts ont ete mesures et sont fermes
 * dans le meme changement :
 *
 *   - SACK (RFC 2018 §4) : le recepteur rendait TOUS ses blocs dans l'ordre
 *     des numeros de sequence, sans les borner a la place de l'option. Le
 *     segment qui venait de declencher l'ACK n'etait donc pas le premier bloc
 *     — le seul que l'emetteur est sur de lire — et un cinquieme bloc
 *     depassait les 40 octets d'options (quatre blocs au plus, trois quand
 *     l'option Timestamps en prend douze) ;
 *   - sonde de fenetre nulle (RFC 9293 §3.8.6.1, MUST-36, SHLD-29, SHLD-30) :
 *     deux minuteries portaient la meme donnee — celle de persistance et celle
 *     de retransmission — et toutes deux emettaient une sonde ; chaque sonde
 *     sans reponse comptait en outre comme une perte de donnee, la fenetre de
 *     congestion tombait a un segment et ssthresh etait divise par deux, alors
 *     que la RFC en fait un simple controle de fenetre.
 *
 * Autorite (docs/rfc/tcp/rfc9293.txt, rfc2018.txt et rfc6298.txt, lues) :
 * RFC 9293 §3.4 (MUST-1 : les numeros de sequence sont des entiers de 32 bits
 * SANS signe, qui bouclent) ; §3.5.1 (MUST-10 : l'ouverture simultanee,
 * SYN-SENT recevant un SYN nu entre en SYN-RECEIVED et repond SYN-ACK ;
 * §3.10.7.4 premier controle, MUST-11 : un RST en SYN-RECEIVED renvoie a
 * LISTEN si l'ouverture etait passive, ferme si elle etait active) ; §3.5.2
 * (SHLD-2 : un RST peut porter des donnees) ; §3.7.4 et §3.8.6.3 (MUST-58 et
 * MUST-59 : les ACK s'agregent, tous les segments en file sont traites avant
 * l'ACK ; SHLD-18, MUST-40, SHLD-19 : ACK differe sous une demi-seconde, tous
 * les deux segments pleins) ; §3.9.1.2 (MUST-61 : PSH sur le dernier segment) ;
 * §3.8.4 (MUST-24 a MUST-29, SHLD-12 : keep-alive, desactive par defaut,
 * jamais avant la fin de l'inactivite, sonde sans donnee a SND.NXT - 1,
 * tolerant aux ACK perdus) ; §3.9.2.1 et §3.9.2.2 (MUST-50 : une option IP
 * inconnue est ignoree) ; §3.9.1.3 (MUST-55 : un Source Quench est jete en
 * silence — le simulateur n'a pas de Source Quench, type deprecie par la
 * RFC 6633, donc rien a jeter) ; §3.8.6.1 (MUST-35, MUST-36, SHLD-29,
 * SHLD-30, MUST-37 : la sonde de fenetre nulle part une RTO apres le refus,
 * double son attente a chaque absence de reponse, et une fenetre qui reste
 * nulle ne fait pas expirer la connexion) ; §3.8.6.1 encore (MUST-66 : un RST
 * est traite meme fenetre nulle) ; §3.5 (MUST-42 : plusieurs connexions sur un
 * meme port d'ecoute). RFC 2018 §4 (le premier bloc est le segment qui a
 * declenche l'ACK, les blocs precedents sont repetes du plus recent au plus
 * ancien, quatre blocs au plus ou trois avec Timestamps) ; RFC 6298 §2.2 a
 * §2.4 et §5.2 a §5.5 (SRTT et RTTVAR de la premiere mesure puis des suivantes,
 * plancher d'une seconde, doublement a chaque retransmission, minuterie
 * redemarree par un ACK qui acquitte du neuf, rien a retransmettre une fois
 * tout acquitte).
 *
 * Discrimination (fichier execute sur le commit precedent, sources TCP remises a
 * l'etat valide par `git stash`) : QUATRE cas sur trente-trois tombent — les
 * deux cas SACK (blocs precedents repetes du plus recent au plus ancien ;
 * pas plus de blocs que l'option n'en porte) et les deux cas de sonde de
 * fenetre nulle (doublement de l'attente sans autre segment entre deux sondes ;
 * fenetre de congestion intacte apres une sonde perdue). Les VINGT-NEUF autres
 * passent des deux cotes et sont nommes ici plutot que laisses a decouvrir :
 * les DEUX TEMOINS du laboratoire (une ouverture active aboutit contre le pair
 * scripte ; sans SACK-permitted dans le SYN du pair aucun ACK ne porte de
 * bloc), et les VINGT-SEPT cas de NON-REGRESSION des exigences deja tenues —
 * MUST-1 (2), MUST-10, MUST-11 (2), SHLD-2, delai, agregation et completude des
 * ACK (3), MUST-61, keep-alive (4), MUST-50, premier bloc SACK et bloc couvert
 * par l'ACK cumulatif (2), la minuterie de la RFC 6298 (6), la premiere sonde
 * de fenetre nulle une RTO apres le refus, MUST-37 et MUST-66 (3), MUST-42.
 *
 * Les cas de la minuterie de la RFC 6298 (arrondi a une seconde) et de la sonde
 * de fenetre nulle tournent sur une machine Windows, qui garde l'arrondi de la
 * RFC ; le plancher de 200 ms d'une machine Linux est mesure par
 * `probe-linux-tcp-rto-floor`.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, openActive, sackBlocksOf, PEER_ISN, PEER_ADDRESS, DUT_ADDRESS,
  type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import {
  IPAddress, createIPv4Packet, IP_PROTO_TCP, IP_OPTION_RECORD_ROUTE,
} from '@/network/core/types';
import { computeTcpChecksum, noFlags, type TcpSegment } from '@/network/tcp/types';
import { TCP_DELAYED_ACK_MS, type TcpSocket } from '@/network/tcp/TcpStack';

const FULL = 1460;

function acks(segments: TcpSegment[]): number[] {
  return segments.filter((s) => s.flags.ack && !s.flags.syn && !s.flags.fin && !s.flags.rst
    && (s.payload === undefined || String(s.payload).length === 0)).map((s) => s.acknowledgement);
}

describe('sequence numbers are unsigned 32-bit values that wrap (MUST-1)', () => {
  it('data that crosses 2^32 is accepted and acknowledged with the wrapped number', () => {
    const peer = scriptedPeer();
    const peerIsn = 0xfffffff0;
    const connection = openPassive(peer, [], peerIsn);
    expect(connection.socket.recvNext).toBe(0xfffffff1);
    peer.send({
      flags: 'PA', sequence: 0xfffffff1, acknowledgement: connection.socket.sendNext,
      payload: 'abcdefghijklmnopqrstuvwxyz'.slice(0, 20),
    });
    peer.advance(TCP_DELAYED_ACK_MS);
    expect(connection.socket.recvNext).toBe((0xfffffff1 + 20) >>> 0);
    expect(peer.last()!.acknowledgement).toBe(5);
  });

  it('an ACK whose number wrapped past our own send point is still acceptable', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [], 0xfffffff0);
    peer.clear();
    connection.socket.send('hello');
    const data = peer.take().find((s) => String(s.payload ?? '') === 'hello')!;
    peer.send({
      flags: 'A', sequence: 0xfffffff1, acknowledgement: (data.sequence + 5) >>> 0,
    });
    expect(connection.socket.sendUnacked).toBe((data.sequence + 5) >>> 0);
  });
});

describe('a simultaneous open completes (MUST-10)', () => {
  it('a bare SYN in SYN-SENT is answered by a SYN-ACK that keeps our ISS, and the ACK establishes', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    peer.clear();
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(socket.state).toBe('syn-received');
    const reply = peer.last()!;
    expect(reply.flags.syn && reply.flags.ack).toBe(true);
    expect(reply.sequence).toBe(syn.sequence);
    expect(reply.acknowledgement).toBe(PEER_ISN + 1);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: syn.sequence + 1 });
    expect(socket.state).toBe('established');
  });
});

describe('SYN-RECEIVED remembers how it was reached (MUST-11)', () => {
  it('a RST after a passive open returns to LISTEN: the listener still answers a new SYN', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    const synAck = peer.last()!;
    expect(peer.dut.getTcpStack().listSockets().map((s) => s.state)).toEqual(['syn-received']);
    peer.send({ flags: 'R', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    expect(peer.dut.getTcpStack().listSockets()).toHaveLength(0);
    peer.clear();
    peer.send({ flags: 'S', sequence: PEER_ISN + 100 });
    expect(peer.last()!.flags.syn && peer.last()!.flags.ack).toBe(true);
  });

  it('a RST after an active open that went through a simultaneous open refuses the connection', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    const reasons: string[] = [];
    socket.onClose((reason) => reasons.push(reason));
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(socket.state).toBe('syn-received');
    peer.send({ flags: 'R', sequence: PEER_ISN + 1, acknowledgement: syn.sequence + 1 });
    expect(socket.state).toBe('closed');
    expect(reasons).toEqual(['rst']);
    expect(socket.connectRefused).toBe(true);
  });
});

describe('a RST may carry data (SHLD-2)', () => {
  it('the connection is reset and the data is not delivered as stream data', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    const delivered: string[] = [];
    connection.socket.onData((data) => delivered.push(String(data)));
    peer.send({
      flags: 'RA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext, payload: 'because',
    });
    expect(connection.socket.state).toBe('closed');
    expect(delivered).toEqual([]);
  });
});

describe('ACKs are delayed, aggregated and complete (SHLD-18, MUST-40, MUST-58, MUST-59, SHLD-19)', () => {
  const segment = (peer: ScriptedPeer, connection: ReturnType<typeof openPassive>, index: number, length = FULL) =>
    peer.send({
      flags: 'A', sequence: PEER_ISN + 1 + index * FULL, acknowledgement: connection.socket.sendNext,
      payload: 'x'.repeat(length),
    });

  it('a lone full-sized segment is acknowledged after the delay, and the delay is under half a second', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    segment(peer, connection, 0);
    expect(acks(peer.take())).toEqual([]);
    expect(TCP_DELAYED_ACK_MS).toBeLessThan(500);
    peer.advance(TCP_DELAYED_ACK_MS);
    expect(acks(peer.take())).toEqual([PEER_ISN + 1 + FULL]);
  });

  it('every second full-sized segment is acknowledged at once, by one ACK for both', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    segment(peer, connection, 0);
    segment(peer, connection, 1);
    expect(acks(peer.take())).toEqual([PEER_ISN + 1 + 2 * FULL]);
  });

  it('a segment that fills a gap is acknowledged once for everything queued behind it', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    segment(peer, connection, 1);
    segment(peer, connection, 2);
    peer.take();
    segment(peer, connection, 0);
    expect(acks(peer.take())).toEqual([PEER_ISN + 1 + 3 * FULL]);
  });
});

describe('PUSH marks the last segment of a write (MUST-61)', () => {
  it('a write of three segments pushes only the last', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'mss', value: FULL }]);
    connection.socket.setNoDelay(true);
    peer.clear();
    connection.socket.send('y'.repeat(2 * FULL + 80));
    const data = peer.take().filter((s) => String(s.payload ?? '').length > 0);
    expect(data.map((s) => String(s.payload).length)).toEqual([FULL, FULL, 80]);
    expect(data.map((s) => s.flags.psh)).toEqual([false, false, true]);
  });
});

describe('keep-alive (MUST-24 to MUST-29, SHLD-12)', () => {
  it('is off by default: a silent connection sends nothing for hours', () => {
    const peer = scriptedPeer();
    openPassive(peer);
    peer.clear();
    peer.advance(3 * 3600 * 1000);
    expect(peer.take().filter((s) => !s.flags.fin)).toEqual([]);
  });

  it('sends nothing before the idle period, then a probe with no data at SND.NXT - 1', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    connection.socket.enableKeepAlive(60_000, 10_000, 3);
    peer.clear();
    peer.advance(59_999);
    expect(peer.take()).toEqual([]);
    peer.advance(1);
    const probes = peer.take();
    expect(probes).toHaveLength(1);
    expect(String(probes[0].payload ?? '')).toBe('');
    expect(probes[0].sequence).toBe((connection.socket.sendNext - 1) >>> 0);
    expect(probes[0].flags.ack).toBe(true);
  });

  it('an answered probe leaves the connection up and restarts the idle period', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    connection.socket.enableKeepAlive(60_000, 10_000, 3);
    peer.advance(60_000);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    peer.clear();
    peer.advance(59_999);
    expect(peer.take()).toEqual([]);
    expect(connection.socket.state).toBe('established');
  });

  it('tolerates lost ACKs: three unanswered probes, then the connection times out', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    const reasons: string[] = [];
    connection.socket.onClose((reason) => reasons.push(reason));
    connection.socket.enableKeepAlive(60_000, 10_000, 3);
    peer.clear();
    peer.advance(60_000);
    peer.advance(10_000);
    expect(connection.socket.state).toBe('established');
    peer.advance(10_000);
    peer.advance(10_000);
    expect(peer.take().filter((s) => s.sequence === ((connection.socket.sendNext - 1) >>> 0))).toHaveLength(3);
    expect(connection.socket.state).toBe('closed');
    expect(reasons).toEqual(['timeout']);
  });
});

describe('an IP option TCP does not understand is ignored (MUST-50)', () => {
  it('a SYN carrying a Record Route option opens the connection', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
    const flags = noFlags(); flags.syn = true;
    const seg: TcpSegment = {
      type: 'tcp', sourcePort: peer.ports.peer, destinationPort: peer.ports.dut, sequence: PEER_ISN,
      acknowledgement: 0, dataOffset: 5, flags, window: 65535, checksum: 0, urgentPointer: 0,
      options: [], payload: undefined,
    };
    seg.checksum = computeTcpChecksum(seg, PEER_ADDRESS, DUT_ADDRESS);
    peer.sendIpv4(createIPv4Packet(
      new IPAddress(PEER_ADDRESS), new IPAddress(DUT_ADDRESS), IP_PROTO_TCP, 64, seg, 20,
      { ipOptions: [{ type: IP_OPTION_RECORD_ROUTE, data: [4, 0, 0, 0, 0] }] }));
    const reply = peer.last();
    expect(reply).toBeDefined();
    expect(reply!.flags.syn && reply!.flags.ack).toBe(true);
  });
});

describe('the receiver reports what it holds, newest first (RFC 2018 §4)', () => {
  const SEGMENT = 100;
  const hole = (index: number) => PEER_ISN + 1 + 1000 * index;

  function lab() {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'sack-permitted' }, { kind: 'mss', value: FULL }]);
    expect(connection.socket.sackEnabled).toBe(true);
    return { peer, connection };
  }

  const outOfOrder = (peer: ScriptedPeer, connection: ReturnType<typeof openPassive>, index: number) => {
    peer.clear();
    peer.send({
      flags: 'A', sequence: hole(index), acknowledgement: connection.socket.sendNext,
      payload: 'z'.repeat(SEGMENT),
    });
    return peer.last()!;
  };

  it('the first block is the segment that triggered the ACK', () => {
    const { peer, connection } = lab();
    const ack = outOfOrder(peer, connection, 1);
    expect(ack.acknowledgement).toBe(PEER_ISN + 1);
    expect(sackBlocksOf(ack)).toEqual([{ start: hole(1), end: hole(1) + SEGMENT }]);
  });

  it('earlier blocks are repeated behind it, the newest first', () => {
    const { peer, connection } = lab();
    outOfOrder(peer, connection, 1);
    const ack = outOfOrder(peer, connection, 3);
    expect(sackBlocksOf(ack)).toEqual([
      { start: hole(3), end: hole(3) + SEGMENT },
      { start: hole(1), end: hole(1) + SEGMENT },
    ]);
  });

  it('no more blocks than the option can hold are reported', () => {
    const { peer, connection } = lab();
    let ack = outOfOrder(peer, connection, 1);
    for (let i = 2; i <= 6; i++) ack = outOfOrder(peer, connection, i);
    const blocks = sackBlocksOf(ack);
    expect(blocks.length).toBeLessThanOrEqual(connection.socket.timestampsEnabled ? 3 : 4);
    expect(blocks[0]).toEqual({ start: hole(6), end: hole(6) + SEGMENT });
  });

  it('a block that the cumulative ACK has covered is no longer reported', () => {
    const { peer, connection } = lab();
    outOfOrder(peer, connection, 1);
    peer.clear();
    peer.send({
      flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext,
      payload: 'q'.repeat(1000 + SEGMENT),
    });
    peer.advance(TCP_DELAYED_ACK_MS);
    const ack = peer.last()!;
    expect(ack.acknowledgement).toBe(hole(1) + SEGMENT);
    expect(sackBlocksOf(ack)).toEqual([]);
  });

  it('WITNESS: without SACK-permitted in the peer SYN no ACK carries a block', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'mss', value: FULL }]);
    expect(connection.socket.sackEnabled).toBe(false);
    const ack = outOfOrder(peer, connection, 1);
    expect(sackBlocksOf(ack)).toEqual([]);
  });
});

describe('the retransmission timer follows RFC 6298', () => {
  function clocked(handshakeRttMs: number) {
    const peer = scriptedPeer('windows');
    const accepted: TcpSocket[] = [];
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (socket) => { accepted.push(socket); } });
    peer.send({ flags: 'S', sequence: PEER_ISN, options: [{ kind: 'mss', value: FULL }] });
    const synAck = peer.last()!;
    peer.advance(handshakeRttMs);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    peer.clear();
    const socket = accepted[0];
    socket.setNoDelay(true);
    return { peer, socket };
  }

  const dataOf = (peer: ScriptedPeer, text: string) =>
    peer.take().filter((s) => String(s.payload ?? '') === text);

  const sendAndAck = (peer: ScriptedPeer, socket: TcpSocket, text: string, rttMs: number) => {
    peer.clear();
    socket.send(text);
    const [data] = dataOf(peer, text);
    peer.advance(rttMs);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: (data.sequence + text.length) >>> 0 });
    peer.clear();
  };

  const retransmitsAfter = (peer: ScriptedPeer, socket: TcpSocket, text: string, timeoutMs: number) => {
    peer.clear();
    socket.send(text);
    peer.take();
    peer.advance(timeoutMs - 1);
    const early = dataOf(peer, text).length;
    peer.advance(1);
    return { early, onTime: dataOf(peer, text).length };
  };

  it('after the handshake sample of 400 ms the timeout is SRTT + 4 x RTTVAR = 1200 ms (§2.2)', () => {
    const { peer, socket } = clocked(400);
    expect(retransmitsAfter(peer, socket, 'b', 1200)).toEqual({ early: 0, onTime: 1 });
  });

  it('a second sample of 1000 ms moves it to 1675 ms (§2.3)', () => {
    const { peer, socket } = clocked(400);
    sendAndAck(peer, socket, 'a', 1000);
    expect(retransmitsAfter(peer, socket, 'b', 1675)).toEqual({ early: 0, onTime: 1 });
  });

  it('a tiny sample still leaves a timeout of one second (§2.4)', () => {
    const { peer, socket } = clocked(50);
    expect(retransmitsAfter(peer, socket, 'b', 1000)).toEqual({ early: 0, onTime: 1 });
  });

  it('a retransmission doubles the timeout (§5.5)', () => {
    const { peer, socket } = clocked(0);
    peer.clear();
    socket.send('b');
    peer.take();
    peer.advance(1000);
    expect(dataOf(peer, 'b')).toHaveLength(1);
    peer.advance(1999);
    expect(dataOf(peer, 'b')).toHaveLength(0);
    peer.advance(1);
    expect(dataOf(peer, 'b')).toHaveLength(1);
  });

  it('an ACK of new data restarts the timer for what remains, with the updated timeout (§5.3)', () => {
    const { peer, socket } = clocked(400);
    peer.clear();
    socket.send('a');
    socket.send('b');
    const [first] = peer.take().filter((s) => String(s.payload ?? '').length > 0);
    peer.advance(900);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: (first.sequence + 1) >>> 0 });
    peer.clear();
    peer.advance(1562);
    expect(dataOf(peer, 'b')).toHaveLength(0);
    peer.advance(1);
    expect(dataOf(peer, 'b')).toHaveLength(1);
  });

  it('nothing is retransmitted once everything is acknowledged (§5.2)', () => {
    const { peer, socket } = clocked(0);
    sendAndAck(peer, socket, 'a', 100);
    peer.advance(120_000);
    expect(peer.take().filter((s) => String(s.payload ?? '').length > 0)).toEqual([]);
  });
});

describe('a zero window is probed on the retransmission timer, then less and less often (MUST-36, SHLD-29, SHLD-30)', () => {
  function closed() {
    const peer = scriptedPeer('windows');
    const connection = openPassive(peer, [{ kind: 'mss', value: FULL }], PEER_ISN, 0);
    connection.socket.setNoDelay(true);
    peer.clear();
    connection.socket.send('hello');
    expect(peer.take().filter((s) => String(s.payload ?? '').length > 0)).toEqual([]);
    return { peer, connection };
  }

  const probes = (peer: ScriptedPeer) => peer.take().filter((s) => String(s.payload ?? '').length > 0);

  it('the first probe leaves one retransmission timeout after the data was refused', () => {
    const { peer } = closed();
    peer.advance(999);
    expect(probes(peer)).toEqual([]);
    peer.advance(1);
    const first = probes(peer);
    expect(first).toHaveLength(1);
    expect(String(first[0].payload).length).toBe(1);
  });

  it('each unanswered probe doubles the wait for the next, and nothing else is sent between them', () => {
    const { peer } = closed();
    const times: number[] = [];
    for (let now = 100; now <= 17_000; now += 100) {
      peer.advance(100);
      if (probes(peer).length > 0) times.push(now);
    }
    expect(times).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it('a lost probe is not a loss of data: the congestion window is left alone', () => {
    const { peer, connection } = closed();
    const before = connection.socket.cc.cwnd;
    peer.advance(20_000);
    expect(connection.socket.cc.cwnd).toBe(before);
    expect(connection.socket.cc.ssthresh).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('a window that stays zero does not time the connection out while the peer keeps answering (MUST-37)', () => {
    const { peer, connection } = closed();
    for (let i = 0; i < 40; i++) {
      peer.advance(60_000);
      const sent = probes(peer);
      for (const probe of sent) {
        peer.send({
          flags: 'A', sequence: PEER_ISN + 1, acknowledgement: probe.sequence >>> 0, window: 0,
        });
      }
    }
    expect(connection.socket.state).toBe('established');
  });

  it('a RST is processed even when the window is zero (MUST-66)', () => {
    const { peer, connection } = closed();
    peer.send({ flags: 'R', sequence: PEER_ISN + 1 });
    expect(connection.socket.state).toBe('closed');
  });
});

describe('several connections share a listening port (MUST-42)', () => {
  it('two peers reaching the same listener each get their own connection', () => {
    const peer = scriptedPeer();
    const accepted: TcpSocket[] = [];
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (socket) => { accepted.push(socket); } });
    for (const [port, isn] of [[41000, 1000], [41001, 2000]]) {
      peer.send({ flags: 'S', sequence: isn, sourcePort: port });
      const synAck = peer.last()!;
      peer.send({ flags: 'A', sequence: isn + 1, acknowledgement: synAck.sequence + 1, sourcePort: port });
    }
    expect(accepted.map((socket) => socket.remotePort).sort()).toEqual([41000, 41001]);
    expect(accepted.every((socket) => socket.state === 'established')).toBe(true);
  });
});

describe('WITNESS: the lab itself', () => {
  it('an active open still completes against the scripted peer', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer);
    expect(socket.state).toBe('established');
  });
});
