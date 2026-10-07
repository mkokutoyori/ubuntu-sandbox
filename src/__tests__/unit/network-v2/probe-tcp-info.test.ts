/**
 * Une connexion TCP sait dire ce qu'elle est : ses files, son temporisateur
 * actif, ses compteurs et ses estimations. `ss`, `netstat` et `/proc/net/tcp`
 * n'ont de quoi le dire que si la pile le rend ; ce fichier mesure ce qu'elle
 * rend, `TcpStack.infoOf` (les champs de `tcp_get_info`), `queuesOf` (Recv-Q et
 * Send-Q) et `timerOf` (`timer:(on|persist|keepalive|timewait,...)`).
 *
 * Mesure de depart (commit precedent), un hote LINUX face a un pair SCRIPTE : la
 * pile ne rendait RIEN de tout cela. Aucune file, aucun compteur de segments ou
 * d'octets, aucun temporisateur nomme, ni la phase de congestion, ni le nombre
 * d'expirations d'affilee ; l'estimateur de RTT ne gardait ni son minimum ni le
 * nombre de doublements. Un `ss` ne pouvait donc que recopier l'etat de la table
 * des prises, avec deux zeros en dur dans les colonnes Recv-Q et Send-Q.
 *
 * Autorite : noyau 5.15, lu. `tcp_get_info` (`net/ipv4/tcp.c`) fixe les champs ;
 * `tcp_snd_una_update` et `tcp_rcv_nxt_update` (`tcp_input.c`) font de bytes_acked
 * et bytes_received les AVANCES de SND.UNA et de RCV.NXT, si bien que le SYN est
 * acquitte (1) cote actif ; `tcp_create_openreq_child` (`tcp_minisocks.c`) pose
 * SND.UNA et RCV.NXT d'un coup, `segs_in = 1` et reprend `num_retrans` de la
 * requete : cote passif le SYN-ACK n'est ni envoye ni acquitte par la prise (il
 * l'est par la `request_sock`), bytes_acked reste a 0, segs_out a 0 et segs_in
 * vaut 2 une fois l'ACK final recu ; `tcp_segs_in` compte tout segment recu par
 * une prise non-LISTEN, `tcp_transmit_skb` tout segment emis, retransmissions
 * comprises ; `icsk_retransmits` ne compte que les expirations du RTO d'affilee
 * (`tcp_retransmit_timer`) et revient a 0 des que SND.UNA avance (`tcp_ack`) : une
 * retransmission rapide ne le touche pas ; `icsk_backoff` suit les doublements et
 * ne revient a 0 que sur une mesure de RTT valide (`tcp_ack_update_rtt`) ;
 * `inet_sk_diag_fill` et `get_tcp4_sock` donnent le temporisateur actif (1
 * retransmission, 4 sonde de fenetre nulle, 2 keep-alive, 3 TIME-WAIT) et sa
 * troisieme valeur (`icsk_retransmits`, ou `icsk_probes_out` pour 2 et 4) ; Recv-Q
 * est RCV.NXT - copied_seq, Send-Q est write_seq - SND.UNA, qui compte le SYN et
 * le FIN tant qu'ils ne sont pas acquittes.
 *
 * Ce qui est construit : `TcpInfo`, `TcpQueues` et `TcpTimer` (types), les trois
 * methodes de `TcpStack`, les compteurs par prise (segments, octets, retransmissions,
 * delivered, expirations d'affilee, sondes) tenus aux points ou la pile emet, recoit
 * et acquitte, `RttEstimator.minimumMs/backoffCount`, `TcpEcn.markedSeen` et
 * `reductionInProgress`, et le nom de l'algorithme de congestion que la pile execute
 * (`reno`, la RFC 5681 avec le NewReno de la RFC 6582 et la reprise SACK de la RFC
 * 6675 : le noyau appelle cela reno, jamais cubic).
 *
 * Ce qui n'est PAS construit : l'estimation de RTT du recepteur (rcv_rtt), le debit de
 * livraison et le pacing (aucun pacer), les statistiques chronometrees de busy/rwnd/sndbuf,
 * dsack_dups et reord_seen ; la fenetre initiale reste celle de la RFC 5681 (le noyau
 * demarre a 10 segments), l'arrondi au jiffy du RTO et l'ATO de 40 ms (pile d'ACK
 * differes plate a 200 ms) non plus.
 *
 * Discrimination (fichier copie sur le commit precedent) : TOUS les cas qui lisent la
 * pile tombent (l'API n'existait pas), VINGT-QUATRE sur vingt-six. Les deux autres
 * passent des deux cotes et sont des TEMOINS du banc : le pair scripte voit exactement un
 * SYN-ACK et la prise passive atteint ESTABLISHED, et le nombre de segments que le banc
 * compte sur le fil est celui qu'il a emis. Les cas de comparaison au fil (segs_out et
 * segs_in contre ce que le banc a vu passer) ne valent que par ce second temoin.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, openPassive, PEER_ISN, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import { ETHERTYPE_IPV4, IP_PROTO_TCP, type IPv4Packet } from '@/network/core/types';
import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import type { TcpOption } from '@/network/tcp/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';

const NEGOTIATED: TcpOption[] = [
  { kind: 'mss', value: 1460 }, { kind: 'sack-permitted' }, { kind: 'window-scale', shift: 7 },
];

function tcpSegmentsFromDut(peer: ScriptedPeer): number {
  return peer.frames.filter((frame) => frame.etherType === ETHERTYPE_IPV4
    && (frame.payload as IPv4Packet).protocol === IP_PROTO_TCP).length;
}

function view(peer: ScriptedPeer, socket: TcpSocket) {
  const stack = peer.dut.getTcpStack();
  return { info: stack.infoOf(socket), queues: stack.queuesOf(socket), timer: stack.timerOf(socket) };
}

describe('the bench is sound (witnesses)', () => {
  it('a passive open reaches ESTABLISHED after exactly one SYN-ACK', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => {} });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(peer.take().map((segment) => segment.flags.syn && segment.flags.ack)).toEqual([true]);
    const connection = openPassive(scriptedPeer());
    expect(connection.socket.state).toBe('established');
  });

  it('the bench counts on the wire what the DUT emitted', () => {
    const peer = scriptedPeer();
    openActive(peer);
    expect(tcpSegmentsFromDut(peer)).toBe(2);
  });
});

describe('the counters follow tcp_get_info', () => {
  it('an active open: the SYN is acknowledged (bytes_acked 1), two segments out, one in, one delivered', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer, NEGOTIATED);
    const { info, queues, timer } = view(peer, socket);
    expect(info).toMatchObject({
      state: 'established', caState: 'Open', congestionControl: 'reno',
      bytesAcked: 1, bytesReceived: 0, bytesSent: 0, bytesRetrans: 0,
      segmentsOut: 2, segmentsIn: 1, dataSegmentsOut: 0, dataSegmentsIn: 0,
      delivered: 1, unacked: 0, retrans: 0, totalRetrans: 0, retransmits: 0, backoff: 0, probes: 0,
    });
    expect(queues).toEqual({ receive: 0, send: 0 });
    expect(timer).toBeNull();
  });

  it('a passive open: the SYN-ACK belongs to the request, so bytes_acked and segs_out stay at 0 and segs_in is 2', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer);
    const { info } = view(peer, socket);
    expect(info).toMatchObject({
      state: 'established', bytesAcked: 0, bytesReceived: 0, segmentsOut: 0, segmentsIn: 2,
      dataSegmentsOut: 0, dataSegmentsIn: 0, delivered: 1, totalRetrans: 0,
    });
  });

  it('segs_out and segs_in agree with what crossed the wire, one segment at a time', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer);
    socket.setNoDelay(true);
    socket.send('hello');
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 6 });
    peer.send({ flags: 'PA', sequence: peerIsn + 1, acknowledgement: dutIsn + 6, payload: 'abc' });
    socket.send('x');
    peer.advance(250);
    const { info } = view(peer, socket);
    expect(info.segmentsOut).toBe(tcpSegmentsFromDut(peer));
    expect(info.segmentsIn).toBe(1 + 2);
    expect(info.dataSegmentsOut).toBe(3);
    expect(info.dataSegmentsIn).toBe(1);
  });

  it('data sent and acknowledged: bytes_sent, bytes_acked (SYN included), delivered, and one segment each way', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer);
    socket.setNoDelay(true);
    socket.send('hello');
    peer.advance(5);
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 6 });
    const { info, queues, timer } = view(peer, socket);
    expect(info).toMatchObject({
      bytesSent: 5, bytesAcked: 6, dataSegmentsOut: 1, segmentsOut: 3, segmentsIn: 2,
      delivered: 2, unacked: 0, lastDataSentMs: 5, lastAckReceivedMs: 0,
    });
    expect(queues).toEqual({ receive: 0, send: 0 });
    expect(timer).toBeNull();
  });

  it('data received: bytes_received counts the payload only, and Recv-Q holds it until the application reads', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer);
    peer.send({ flags: 'PA', sequence: peerIsn + 1, acknowledgement: dutIsn + 1, payload: 'abc' });
    const unread = view(peer, socket);
    expect(unread.info).toMatchObject({ bytesReceived: 3, dataSegmentsIn: 1, segmentsIn: 2 });
    expect(unread.queues.receive).toBe(3);
    const received: unknown[] = [];
    socket.onData((chunk) => received.push(chunk));
    expect(view(peer, socket).queues.receive).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('a FIN received and not yet read is one octet of Recv-Q, and the FIN counts as received', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer, [], PEER_ISN, 65535, { allowHalfOpen: true });
    socket.onData(() => {});
    peer.send({ flags: 'FA', sequence: peerIsn + 1, acknowledgement: dutIsn + 1 });
    const { info, queues } = view(peer, socket);
    expect(info.state).toBe('close-wait');
    expect(info.bytesReceived).toBe(1);
    expect(queues.receive).toBe(1);
    socket.onEnd(() => {});
    expect(view(peer, socket).queues.receive).toBe(0);
  });

  it('a FIN sent and not yet acknowledged is one octet of Send-Q, and its acknowledgement is acked bytes', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer);
    socket.close();
    expect(view(peer, socket).queues.send).toBe(1);
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 2 });
    const { info, queues } = view(peer, socket);
    expect(info).toMatchObject({ state: 'fin-wait-2', bytesAcked: 2 });
    expect(queues.send).toBe(0);
  });
});

describe('the files: Recv-Q is unread octets, Send-Q is everything written and not yet acknowledged', () => {
  it('written data that the peer window keeps back is Send-Q and not_sent, with no octet in flight', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer, [], PEER_ISN, 0);
    socket.send('hello');
    const { info, queues } = view(peer, socket);
    expect(queues.send).toBe(5);
    expect(info).toMatchObject({ notSentBytes: 5, unacked: 0, sendWindow: 0 });
  });

  it('data in flight is Send-Q and one unacked segment, with the retransmission timer armed at the RTO', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer);
    socket.setNoDelay(true);
    socket.send('hello');
    const { info, queues, timer } = view(peer, socket);
    expect(queues.send).toBe(5);
    expect(info).toMatchObject({ notSentBytes: 0, unacked: 1 });
    expect(timer).toEqual({ kind: 'on', expiresInMs: 200, retransmits: 0 });
  });

  it('a connection in SYN-RECV belongs to the request: both files empty, and the SYN-ACK timer is the one armed', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => {} });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    const request = peer.dut.getTcpStack().listSockets()[0];
    const { queues, timer } = view(peer, request);
    expect(request.state).toBe('syn-received');
    expect(queues).toEqual({ receive: 0, send: 0 });
    expect(timer).toEqual({ kind: 'on', expiresInMs: 1000, retransmits: 0 });
  });
});

describe('the timers: which one is armed, when it expires, and its third value', () => {
  it('the persist timer is armed against a zero window and its third value counts the probes sent', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer, [], PEER_ISN, 0);
    socket.send('hello');
    expect(view(peer, socket).timer).toEqual({ kind: 'persist', expiresInMs: 200, retransmits: 0 });
    peer.advance(250);
    const { info, timer } = view(peer, socket);
    expect(timer).toEqual({ kind: 'persist', expiresInMs: 350, retransmits: 1 });
    expect(info).toMatchObject({ probes: 1, backoff: 1, retransmits: 0 });
  });

  it('the keep-alive timer is armed on an idle connection and its third value counts the probes sent', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer);
    socket.enableKeepAlive(1000, 500, 3);
    expect(view(peer, socket).timer).toEqual({ kind: 'keepalive', expiresInMs: 1000, retransmits: 0 });
    peer.advance(1100);
    const { info, timer } = view(peer, socket);
    expect(timer).toEqual({ kind: 'keepalive', expiresInMs: 400, retransmits: 1 });
    expect(info.probes).toBe(1);
  });

  it('the TIME-WAIT timer counts down the 60 s the stack holds the connection', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer);
    socket.close();
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 2 });
    peer.send({ flags: 'FA', sequence: peerIsn + 1, acknowledgement: dutIsn + 2 });
    peer.advance(1000);
    const { info, queues, timer } = view(peer, socket);
    expect(info.state).toBe('time-wait');
    expect(timer).toEqual({ kind: 'timewait', expiresInMs: 59_000, retransmits: 0 });
    expect(queues).toEqual({ receive: 0, send: 0 });
  });

  it('an idle established connection with nothing in flight and no keep-alive has no timer', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer);
    peer.advance(30_000);
    expect(view(peer, socket).timer).toBeNull();
  });
});

describe('loss: expirations in a row, backoff, retransmitted segments, and the congestion state', () => {
  it('an RTO retransmits: Loss, retransmits and backoff 1, RTO doubled, one retransmitted segment, retransmitted bytes counted as sent', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer);
    socket.setNoDelay(true);
    socket.send('hello');
    peer.advance(210);
    const { info, timer } = view(peer, socket);
    expect(info).toMatchObject({
      caState: 'Loss', retransmits: 1, backoff: 1, rtoMs: 400, retrans: 1, totalRetrans: 1,
      bytesRetrans: 5, bytesSent: 10, dataSegmentsOut: 2, segmentsOut: 4, sendCwnd: 1, sendSsthresh: 2,
    });
    expect(timer).toEqual({ kind: 'on', expiresInMs: 390, retransmits: 1 });
  });

  it('an acknowledgement ends the run of expirations (retransmits 0) but keeps the backed-off RTO until a valid RTT sample', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer);
    socket.setNoDelay(true);
    socket.send('hello');
    peer.advance(210);
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 6 });
    const { info } = view(peer, socket);
    expect(info).toMatchObject({ retransmits: 0, backoff: 1, rtoMs: 400, unacked: 0, bytesAcked: 6 });
  });

  it('a fast retransmit is not an expiration: Recovery, one lost, one retransmitted, retransmits stays 0', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn } = openActive(peer, [{ kind: 'mss', value: 536 }, { kind: 'sack-permitted' }]);
    socket.setNoDelay(true);
    for (let i = 0; i < 4; i++) socket.send('x'.repeat(536));
    const first = peer.take()[0];
    const states: string[] = [];
    for (let i = 0; i < 3; i++) {
      peer.send({
        flags: 'A', sequence: peerIsn + 1, acknowledgement: first.sequence,
        options: [{ kind: 'sack', blocks: [{ start: first.sequence + 536, end: first.sequence + 536 * (i + 2) }] }],
      });
      states.push(view(peer, socket).info.caState);
    }
    expect(states).toEqual(['Disorder', 'Disorder', 'Recovery']);
    const { info, timer } = view(peer, socket);
    expect(info).toMatchObject({ sacked: 3, lost: 1, retrans: 1, totalRetrans: 1, retransmits: 0, unacked: 4 });
    expect(timer).toEqual({ kind: 'on', expiresInMs: 200, retransmits: 0 });
  });

  it('slow start opens the window by one segment per segment acknowledged', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer, [{ kind: 'mss', value: 536 }]);
    socket.setNoDelay(true);
    socket.send('x'.repeat(536));
    const before = view(peer, socket).info.sendCwnd;
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 1 + 536 });
    expect(view(peer, socket).info.sendCwnd).toBe(before + 1);
  });
});

describe('the estimates and the options the connection negotiated', () => {
  it('a handshake that takes 30 ms gives srtt 30, variance 15, min rtt 30 and an RTO of srtt plus the 200 ms floor', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer)!;
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    peer.advance(30);
    peer.send({ flags: 'SA', sequence: PEER_ISN, acknowledgement: syn.sequence + 1 });
    const { info } = view(peer, socket);
    expect(info).toMatchObject({ rttMs: 30, rttVarianceMs: 15, minRttMs: 30, rtoMs: 230 });
  });

  it('the options the peer accepted are reported: SACK, the window scale shift, the send window unscaled in the SYN and scaled after', () => {
    const peer = scriptedPeer();
    const { socket, peerIsn, dutIsn } = openActive(peer, NEGOTIATED);
    const { info } = view(peer, socket);
    expect(info.sack).toBe(true);
    expect(info.windowScale?.send).toBe(7);
    expect(info.sendWindow).toBe(65535);
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 1 });
    expect(view(peer, socket).info.sendWindow).toBe(65535 * 128);
    expect(info.sendMss).toBe(1460);
    expect(info.advertisedMss).toBe(1460);
  });

  it('options the peer did not accept are reported absent', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer);
    const { info } = view(peer, socket);
    expect(info).toMatchObject({ sack: false, timestamps: false, windowScale: null, ecn: false, ecnSeen: false });
  });

  it('timestamps are reported when the peer echoed the option', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer, [{ kind: 'timestamp', tsVal: 1000, tsEcr: 0 }]);
    expect(view(peer, socket).info.timestamps).toBe(true);
  });

  it('ECN: negotiated at the handshake, seen only once an ECT-marked data segment arrives, and CWR while a reduction is open', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const { socket, peerIsn, dutIsn } = openActive(peer, [], PEER_ISN, 65535, {}, 'SAE');
    socket.setNoDelay(true);
    expect(view(peer, socket).info).toMatchObject({ ecn: true, ecnSeen: false });
    peer.send({ flags: 'PA', sequence: peerIsn + 1, acknowledgement: dutIsn + 1, payload: 'abc', ecn: EcnCodepoint.ECT_0 });
    expect(view(peer, socket).info.ecnSeen).toBe(true);
    socket.send('x'.repeat(100));
    socket.send('y'.repeat(100));
    peer.send({ flags: 'AE', sequence: peerIsn + 4, acknowledgement: dutIsn + 101 });
    expect(view(peer, socket).info.caState).toBe('CWR');
    peer.send({ flags: 'A', sequence: peerIsn + 4, acknowledgement: dutIsn + 201 });
    expect(view(peer, socket).info.caState).toBe('Open');
  });
});

describe('a request that had to be retransmitted hands its count to the connection', () => {
  it('the SYN-ACK retransmitted once is a retransmission of the connection, not a segment it sent', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => {} });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    const synAck = peer.last()!;
    const request = peer.dut.getTcpStack().listSockets()[0];
    peer.advance(1100);
    expect(view(peer, request).timer).toEqual({ kind: 'on', expiresInMs: 1900, retransmits: 1 });
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    const { info, timer } = view(peer, request);
    expect(info).toMatchObject({ state: 'established', totalRetrans: 1, segmentsOut: 0, bytesAcked: 0, retransmits: 0 });
    expect(timer).toBeNull();
  });
});
