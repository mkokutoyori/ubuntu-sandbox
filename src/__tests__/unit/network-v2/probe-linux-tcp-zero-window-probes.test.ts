/**
 * Sur une machine Linux, une fenetre nulle est sondee par un ACK sans donnee, un
 * numero de sequence en arriere de SND.UNA, et l'attente double a chaque sonde
 * (tcp_send_probe0) ; la connexion ne meurt que si tcp_retries2 sondes restent
 * sans reponse.
 *
 * Mesure de depart (commit precedent), un LinuxPC dont le pair annonce une fenetre
 * nulle alors que « hello » attend d'etre envoye :
 *
 *   - la sonde etait le premier octet de la donnee, suivi en file comme un segment
 *     ordinaire : il partait a 200 ms, la minuterie de retransmission le renvoyait
 *     200 ms plus tard, puis les attentes doublaient (sondes a 200, 400, 800 et
 *     1600 ms). Le noyau envoie un ACK de zero octet a SND.UNA - 1 et attend 200 ms
 *     avant la premiere sonde, puis 400, 800... (200, 600, 1400 et 3000 ms) ;
 *   - une sonde sans reponse etait une donnee non acquittee, et la limite en temps de
 *     tcp_retries2 s'evaluait sur la file de retransmission ; le noyau compte les
 *     sondes (`icsk_probes_out >= tcp_retries2` a l'echeance) et les remet a zero a
 *     chaque ACK recu ;
 *   - un delai de l'utilisateur ne raccourcissait que le temporisateur de
 *     retransmission, pas celui des sondes.
 *
 * Autorite (noyau 5.15, lus) : `net/ipv4/tcp_output.c` (`tcp_write_wakeup` : fenetre
 * nulle, donc `tcp_xmit_probe_skb(sk, 0, ...)` : « Use a previous sequence. This
 * should cause the other end to send an ack. Don't queue or clone SKB, just send
 * it. » ; `tcp_send_probe0` : `icsk_probes_out++`, `icsk_backoff++`, attente
 * `tcp_probe0_when`), `net/ipv4/tcp_timer.c` (`tcp_probe_timer` : « RFC 1122
 * 4.2.2.17 requires the sender to stay open indefinitely as long as the receiver
 * continues to respond probes. We support this by default and reset
 * icsk_probes_out with incoming ACKs » ; `tcp_clamp_probe0_to_user_timeout`),
 * `include/net/tcp.h` (`tcp_probe0_base` = max(icsk_rto, TCP_RTO_MIN),
 * `tcp_probe0_when`). RFC 9293 §3.8.6.1 demande « at least one octet of new data (if
 * available), or retransmit » : l'octet de donnee est la forme que la RFC decrit, un
 * ACK sans donnee est celle du noyau. Sur une machine Linux la mesure du noyau
 * gouverne, parce que c'est elle que compare la capture d'un cours ; un hote
 * sans profil garde l'octet de donnee.
 *
 * Ce qui est construit : `TcpRetryPolicy.windowProbe` (`one-byte` pour la RFC,
 * `old-sequence` pour Linux, avec le nombre de sondes sans reponse tire de
 * tcp_retries2) ; la sonde du noyau, envoyee hors file, comptee, remise a zero par
 * tout segment recu et bornee par le delai de l'utilisateur (`setUserTimeout`) ;
 * l'attente suit la minuterie de persistance existante, qui part du RTO et double.
 *
 * Ce qui n'est PAS construit : la seconde sonde du noyau quand un pointeur urgent est
 * dans l'intervalle (`tcp_xmit_probe_skb(sk, 1, ...)`), la remise en route de la
 * minuterie a l'arrivee de la reponse (`tcp_ack_probe` : sans delai de livraison,
 * c'est le meme instant), le cas ou la fenetre se ferme avec des donnees en vol
 * (le noyau laisse alors la minuterie de retransmission faire office de sonde).
 *
 * Discrimination (fichier copie sur le commit precedent) : SIX cas sur dix tombent.
 * Les quatre autres passent des deux cotes : un TEMOIN (un pair qui repond toujours
 * ne fait jamais mourir la connexion), une NON-REGRESSION (le delai de l'utilisateur
 * termine la connexion a 1,2 s), et deux TEMOINS de laboratoire (une machine Windows
 * sonde toujours par un octet de donnee ; une sonde du pair, un numero en arriere de
 * RCV.NXT, recoit un ACK).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, PEER_ISN, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';

const SEGMENT_SIZE = 1460;

function refused(platform: 'linux' | 'windows' = 'linux'): { peer: ScriptedPeer; connection: OpenConnection } {
  const peer = scriptedPeer(platform);
  const connection = openPassive(peer, [{ kind: 'mss', value: SEGMENT_SIZE }], PEER_ISN, 0);
  connection.socket.setNoDelay(true);
  peer.clear();
  connection.socket.send('hello');
  expect(peer.take()).toEqual([]);
  return { peer, connection };
}

function probeTimes(peer: ScriptedPeer, untilMs: number, stepMs: number): number[] {
  const times: number[] = [];
  for (let elapsed = stepMs; elapsed <= untilMs; elapsed += stepMs) {
    peer.advance(stepMs);
    if (peer.take().length > 0) times.push(elapsed);
  }
  return times;
}

function probeTimesAnswered(peer: ScriptedPeer, connection: OpenConnection, untilMs: number, stepMs: number): number[] {
  const times: number[] = [];
  for (let elapsed = stepMs; elapsed <= untilMs; elapsed += stepMs) {
    peer.advance(stepMs);
    if (peer.take().length === 0) continue;
    times.push(elapsed);
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.socket.sendUnacked, window: 0,
    });
    peer.clear();
  }
  return times;
}

describe('a Linux machine probes a zero window with an ACK that carries no data, one sequence number behind SND.UNA (tcp_write_wakeup, tcp_xmit_probe_skb)', () => {
  it('the first probe leaves 200 ms after the refusal and carries no byte of the queued data', () => {
    const { peer, connection } = refused();
    peer.advance(199);
    expect(peer.take()).toEqual([]);
    peer.advance(1);
    const probes = peer.take();
    expect(probes).toHaveLength(1);
    expect(String(probes[0].payload ?? '')).toBe('');
    expect(probes[0].flags.ack).toBe(true);
    expect(probes[0].flags.psh).toBe(false);
    expect(probes[0].sequence).toBe((connection.socket.sendUnacked - 1) >>> 0);
    expect(connection.socket.sendNext).toBe(connection.socket.sendUnacked);
  });

  it('each unanswered probe doubles the wait for the next: probes at 200, 600, 1400, 3000 and 6200 ms', () => {
    const { peer } = refused();
    expect(probeTimes(peer, 6_300, 10)).toEqual([200, 600, 1_400, 3_000, 6_200]);
  });

  it('the wait stops doubling at 120 s, the RTO ceiling', () => {
    const { peer, connection } = refused();
    const times = probeTimesAnswered(peer, connection, 700_000, 100);
    expect(times.slice(9, 14)).toEqual([204_600, 324_600, 444_600, 564_600, 684_600]);
  });

  it('a peer that keeps answering with a zero window is probed for ever and never times the connection out (RFC 1122 §4.2.2.17)', () => {
    const { peer, connection } = refused();
    expect(probeTimesAnswered(peer, connection, 5_000_000, 1_000).length).toBeGreaterThan(30);
    expect(connection.socket.closed).toBe(false);
    expect(connection.socket.state).toBe('established');
  });

  it('a window that reopens in the answer to a probe releases the queued data at once', () => {
    const { peer, connection } = refused();
    peer.advance(200);
    peer.take();
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.socket.sendUnacked, window: 65535,
    });
    const sent = peer.take().filter((segment) => String(segment.payload ?? '').length > 0);
    expect(sent.map((segment) => String(segment.payload))).toEqual(['hello']);
  });
});

describe('probes nobody answers kill the connection once tcp_retries2 of them are out (tcp_probe_timer)', () => {
  it('default 15: fifteen probes, the sixteenth timeout at 924.6 s kills the connection', () => {
    const { peer, connection } = refused();
    const times = probeTimes(peer, 924_500, 100);
    expect(times).toHaveLength(15);
    expect(connection.socket.closed).toBe(false);
    peer.advance(100);
    expect(connection.socket.closed).toBe(true);
    expect(connection.socket.closeReason).toBe('timeout');
  });

  it('tcp_retries2=3: three probes, the fourth timeout at 3 s kills the connection', async () => {
    const { peer, connection } = refused();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_retries2=3');
    expect(probeTimes(peer, 2_900, 10)).toEqual([200, 600, 1_400]);
    expect(connection.socket.closed).toBe(false);
    peer.advance(100);
    expect(connection.socket.closed).toBe(true);
  });

  it('a user timeout of one second ends the probing 1 s after the first timeout, at 1.2 s: it shortens the wait that would pass it', () => {
    const { peer, connection } = refused();
    connection.socket.setUserTimeout(1_000);
    peer.advance(1_199);
    expect(connection.socket.closed).toBe(false);
    peer.advance(1);
    expect(connection.socket.closed).toBe(true);
  });
});

describe('a peer that is not Linux is probed with one byte of the queued data, as before', () => {
  it('WITNESS: a Windows machine sends the first byte of the data one second after the refusal', () => {
    const { peer } = refused('windows');
    peer.advance(999);
    expect(peer.take()).toEqual([]);
    peer.advance(1);
    const probes = peer.take();
    expect(probes).toHaveLength(1);
    expect(String(probes[0].payload)).toBe('h');
  });

  it('WITNESS: a probe from the peer, one behind RCV.NXT, is answered with an ACK that carries the window', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    peer.send({
      flags: 'A', sequence: connection.peerIsn, acknowledgement: connection.dutIsn + 1,
    });
    const answers = peer.take();
    expect(answers).toHaveLength(1);
    expect(answers[0].flags.ack).toBe(true);
    expect(answers[0].acknowledgement).toBe(connection.peerIsn + 1);
  });
});
