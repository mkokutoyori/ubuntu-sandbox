/**
 * Apres une expiration le RTO double reste en vigueur jusqu'a la prochaine
 * mesure valide : un ACK qui n'acquitte que des segments retransmis ne le
 * ramene pas (RFC 6298 §3 et §5, Karn).
 *
 * Mesure de depart (commit precedent), pair SCRIPTE : un ACK qui acquittait du
 * neuf ramenait toujours le RTO a l'estimation de SRTT (ou a la valeur
 * initiale), meme quand tout ce qu'il acquittait avait ete retransmis, c'est-a-dire
 * quand aucune mesure n'avait ete prise (Karn, et pas d'option Timestamps pour
 * lever l'ambiguite). Un hote Windows (arrondi d'une seconde) qui perdait deux
 * segments de suite attendait 1 s les deux fois, puis 1 s encore a chaque
 * episode : 1, 1, 1, 1 s, la ou la RFC garde le RTO double. Une machine Linux
 * sans horodatage attendait 200 ms puis 200 ms, le noyau 200 puis 400.
 *
 * Autorite : RFC 6298 §3 (Karn : aucune mesure sur un segment retransmis, sauf
 * quand l'option Timestamps leve l'ambiguite), §5.3 (« for the current value of
 * RTO »), §5.5 (le doublement) et la note qui clot le §5 (« once a new RTT
 * measurement is obtained ... may result in "collapsing" RTO back down after it
 * has been subject to exponential back off ») ; noyau 5.15, `net/ipv4/tcp_input.c`
 * (`tcp_ack_update_rtt` : « RFC6298: only reset backoff on valid RTT
 * measurement » ; `tcp_set_rto` n'a que cet appelant, et le doublement de
 * `tcp_retransmit_timer` ne se defait pas autrement), lus.
 *
 * Ce qui est construit : l'ACK qui acquitte du neuf ne touche plus le RTO, seule
 * une mesure le recalcule (`RttEstimator.sample`) ; `RttEstimator.reset()`, qui
 * n'avait plus d'appelant, disparait avec ses deux cas de test.
 *
 * Ce qui n'est PAS construit : la RFC 6298 §5 permet d'effacer SRTT et RTTVAR
 * apres plusieurs reculs (un MAY), la pile ne le fait pas.
 *
 * Discrimination (fichier copie sur le commit precedent) : TROIS cas sur cinq
 * tombent. Les deux autres passent des deux cotes et sont des TEMOINS : un
 * segment acquitte sans avoir jamais ete retransmis est une mesure valide et
 * ramene le RTO, et l'echo d'horodatage de la retransmission en est une aussi.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import type { TcpOption } from '@/network/tcp/types';

function dataSegments(peer: ScriptedPeer) {
  return peer.take().filter((segment) => String(segment.payload ?? '').length > 0);
}

function lostSegment(peer: ScriptedPeer, connection: OpenConnection, text: string): void {
  connection.socket.setNoDelay(true);
  peer.clear();
  connection.socket.send(text);
  expect(dataSegments(peer)).toHaveLength(1);
}

function firstRetransmissionAfter(peer: ScriptedPeer, untilMs: number): number | null {
  for (let elapsed = 10; elapsed <= untilMs; elapsed += 10) {
    peer.advance(10);
    if (dataSegments(peer).length > 0) return elapsed;
  }
  return null;
}

function acknowledgeAll(peer: ScriptedPeer, connection: OpenConnection, options: TcpOption[] = []): void {
  peer.send({
    flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.socket.sendNext, options,
  });
  peer.clear();
}

function episode(peer: ScriptedPeer, connection: OpenConnection, text: string, options: TcpOption[] = []): number | null {
  lostSegment(peer, connection, text);
  const waited = firstRetransmissionAfter(peer, 70_000);
  acknowledgeAll(peer, connection, options);
  return waited;
}

describe('after a timeout the doubled RTO stays until a valid RTT sample (RFC 6298 §5, Karn)', () => {
  it('Windows: the segment sent after an acknowledged retransmission waits the doubled RTO, 2 s', () => {
    const peer = scriptedPeer('windows');
    const connection = openActive(peer);
    expect(episode(peer, connection, 'a')).toBe(1_000);
    lostSegment(peer, connection, 'b');
    expect(firstRetransmissionAfter(peer, 5_000)).toBe(2_000);
  });

  it('the doubling goes on across episodes while no sample is taken: 1 s, 2 s, 4 s, 8 s', () => {
    const peer = scriptedPeer('windows');
    const connection = openActive(peer);
    const waits = [episode(peer, connection, 'a'), episode(peer, connection, 'b'), episode(peer, connection, 'c'),
      episode(peer, connection, 'd')];
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('Linux without timestamps keeps it too: 200 ms, then 400 ms', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_timestamps=0');
    const connection = openActive(peer);
    expect(episode(peer, connection, 'a')).toBe(200);
    lostSegment(peer, connection, 'b');
    expect(firstRetransmissionAfter(peer, 2_000)).toBe(400);
  });

  it('WITNESS: a segment that is acknowledged without ever being retransmitted is a valid sample and collapses the RTO', () => {
    const peer = scriptedPeer('windows');
    const connection = openActive(peer);
    expect(episode(peer, connection, 'a')).toBe(1_000);
    lostSegment(peer, connection, 'b');
    acknowledgeAll(peer, connection);
    expect(episode(peer, connection, 'c')).toBe(1_000);
  });

  it('WITNESS: with timestamps negotiated the echo of the retransmission is a valid sample and collapses the RTO', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'timestamp', tsVal: 100, tsEcr: 0 }]);
    lostSegment(peer, connection, 'a');
    peer.advance(200);
    const resent = dataSegments(peer);
    expect(resent).toHaveLength(1);
    const stamp = resent[0].options.find((option) => option.kind === 'timestamp');
    expect(stamp).toBeDefined();
    acknowledgeAll(peer, connection, [{ kind: 'timestamp', tsVal: 101, tsEcr: (stamp as { tsVal: number }).tsVal }]);
    lostSegment(peer, connection, 'b');
    expect(firstRetransmissionAfter(peer, 2_000)).toBe(200);
  });
});
